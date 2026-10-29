const Database = require("better-sqlite3");
const path = require("node:path");
const fs = require("node:fs");

const dataFolder = path.join(__dirname, "..", "data");
fs.mkdirSync(dataFolder, { recursive: true });

const db = new Database(path.join(dataFolder, "dayz.sqlite"));

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    discord_id TEXT PRIMARY KEY,
    gamer_tag TEXT,
    coins INTEGER NOT NULL DEFAULT 100,
    bank INTEGER NOT NULL DEFAULT 0,
    kills INTEGER NOT NULL DEFAULT 0,
    deaths INTEGER NOT NULL DEFAULT 0,
    last_daily TEXT
  );

  CREATE TABLE IF NOT EXISTS purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    total_cost INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_id TEXT NOT NULL,
    amount INTEGER NOT NULL,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS processed_events (
    event_id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS dayz_links (
    discord_id TEXT PRIMARY KEY,
    player_name TEXT NOT NULL,
    player_id TEXT,
    server_id TEXT NOT NULL DEFAULT 'dayz-5',
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK(status IN ('pending','verified')),
    requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    verified_by TEXT,
    verified_at TEXT
  );
`);

// Safely add the bank balance to existing databases.
const playerColumns = db.prepare(
  "PRAGMA table_info(players)"
).all();

if (!playerColumns.some(column => column.name === "bank")) {
  db.exec(
    "ALTER TABLE players ADD COLUMN bank INTEGER NOT NULL DEFAULT 0"
  );
}

// Economy cooldowns, rolling action limits, and teleport purchases.
db.exec(`
  CREATE TABLE IF NOT EXISTS economy_cooldowns (
    discord_id TEXT NOT NULL,
    action TEXT NOT NULL,
    last_used INTEGER NOT NULL,
    PRIMARY KEY (discord_id, action)
  );

  CREATE TABLE IF NOT EXISTS economy_uses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_id TEXT NOT NULL,
    action TEXT NOT NULL,
    used_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_economy_uses_window
    ON economy_uses(discord_id, action, used_at);

  CREATE TABLE IF NOT EXISTS teleport_purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_id TEXT NOT NULL,
    server_id TEXT NOT NULL,
    resets INTEGER NOT NULL,
    start_json TEXT NOT NULL,
    end_json TEXT NOT NULL,
    area_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    total_cost INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    active_until INTEGER,
    error TEXT
  );
`);

// Add activated_at exactly once, preserving existing teleport purchases.
const teleportColumns = db
  .prepare("PRAGMA table_info(teleport_purchases)")
  .all();

if (!teleportColumns.some(column => column.name === "activated_at")) {
  db.exec(
    "ALTER TABLE teleport_purchases ADD COLUMN activated_at INTEGER"
  );
}

// Migrate existing DayZ link tables without resetting existing links.
const dayzLinkColumns = db.prepare(
  "PRAGMA table_info(dayz_links)"
).all();

if (!dayzLinkColumns.some(column => column.name === "server_id")) {
  db.exec(
    "ALTER TABLE dayz_links ADD COLUMN server_id TEXT NOT NULL DEFAULT 'dayz-5'"
  );
}

// If duplicate verified links exist, retain the newest row.
db.exec(`
  DELETE FROM dayz_links
  WHERE status = 'verified'
    AND player_id IS NOT NULL
    AND rowid NOT IN (
      SELECT MAX(rowid)
      FROM dayz_links
      WHERE status = 'verified'
        AND player_id IS NOT NULL
      GROUP BY server_id, player_id
    );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_dayz_links_server_player_unique
    ON dayz_links(server_id, player_id)
    WHERE status = 'verified' AND player_id IS NOT NULL;

  CREATE TABLE IF NOT EXISTS dayz_link_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_discord_id TEXT NOT NULL,
    target_discord_id TEXT NOT NULL,
    action TEXT NOT NULL,
    player_name TEXT,
    player_id TEXT,
    server_id TEXT NOT NULL DEFAULT 'dayz-5',
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

// Add server_id to older purchase tables when necessary.
const purchaseColumns = db.prepare(
  "PRAGMA table_info(purchases)"
).all();

if (!purchaseColumns.some(column => column.name === "server_id")) {
  db.exec(`
    ALTER TABLE purchases
    ADD COLUMN server_id TEXT NOT NULL DEFAULT 'dayz-1'
  `);
}

// Persistent item-delivery queue.
db.exec(`
  CREATE TABLE IF NOT EXISTS delivery_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    purchase_id INTEGER NOT NULL UNIQUE,
    server_id TEXT NOT NULL,
    discord_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 10),
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN (
        'pending', 'processing', 'delivered', 'failed'
      )),
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (purchase_id) REFERENCES purchases(id)
  );

  CREATE INDEX IF NOT EXISTS idx_delivery_jobs_status
    ON delivery_jobs(server_id, status);
`);

const ensurePlayer = db.prepare(`
  INSERT OR IGNORE INTO players (discord_id, coins)
  VALUES (?, ?)
`);

const getPlayer = db.prepare(`
  SELECT * FROM players WHERE discord_id = ?
`);

const addTransaction = db.prepare(`
  INSERT INTO transactions (discord_id, amount, reason)
  VALUES (?, ?, ?)
`);

// Add coins to a player's cash balance.
const grantCoins = db.transaction((id, amount, reason) => {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error("Amount must be a positive whole number.");
  }

  ensurePlayer.run(id, 100);

  db.prepare(`
    UPDATE players
    SET coins = coins + ?
    WHERE discord_id = ?
  `).run(amount, id);

  addTransaction.run(id, amount, reason);
});

// Purchase a shop item using cash or bank balance.
const purchase = db.transaction(
  (id, item, quantity, serverId = "dayz-1", paymentSource = "cash") => {
    if (
      !Number.isSafeInteger(quantity) ||
      quantity < 1 ||
      quantity > 10
    ) {
      throw new Error("Quantity must be between 1 and 10.");
    }

    if (
      typeof serverId !== "string" ||
      !/^[a-z0-9-]+$/.test(serverId)
    ) {
      throw new Error("Invalid server ID.");
    }

    if (
      !item ||
      typeof item.id !== "string" ||
      !Number.isSafeInteger(item.price) ||
      item.price <= 0
    ) {
      throw new Error("Invalid shop item.");
    }

    if (!["cash", "bank"].includes(paymentSource)) {
      throw new Error("Payment source must be cash or bank.");
    }

    const total = item.price * quantity;

    if (!Number.isSafeInteger(total)) {
      throw new Error("Invalid purchase total.");
    }

    ensurePlayer.run(id, 100);

    const player = getPlayer.get(id);
    const balanceColumn =
      paymentSource === "bank" ? "bank" : "coins";

    if (Number(player[balanceColumn] || 0) < total) {
      throw new Error(
        `Not enough ${
          paymentSource === "bank" ? "bank balance" : "cash"
        } for this purchase.`
      );
    }

    db.prepare(`
      UPDATE players
      SET ${balanceColumn} = ${balanceColumn} - ?
      WHERE discord_id = ?
    `).run(total, id);

    const result = db.prepare(`
      INSERT INTO purchases
        (discord_id, item_id, quantity, total_cost, server_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, item.id, quantity, total, serverId);

    const purchaseId = Number(result.lastInsertRowid);

    addTransaction.run(
      id,
      -total,
      `Purchase #${purchaseId} (${serverId}, ${paymentSource})`
    );

    db.prepare(`
      INSERT INTO delivery_jobs (
        purchase_id,
        server_id,
        discord_id,
        item_id,
        quantity,
        status
      )
      VALUES (?, ?, ?, ?, ?, 'pending')
    `).run(
      purchaseId,
      serverId,
      id,
      item.id,
      quantity
    );

    return {
      id: purchaseId,
      total,
      serverId,
      deliveryStatus: "pending"
    };
  }
);

// DayZ account linking statements.
const getDayzLink = db.prepare(
  "SELECT * FROM dayz_links WHERE discord_id = ?"
);

const getDayzLinkByPlayerId = db.prepare(`
  SELECT *
  FROM dayz_links
  WHERE server_id = ?
    AND player_id = ?
    AND status = 'verified'
  LIMIT 1
`);

const deleteDayzLink = db.prepare(
  "DELETE FROM dayz_links WHERE discord_id = ?"
);

const deleteDayzLinkByPlayer = db.prepare(`
  DELETE FROM dayz_links
  WHERE server_id = ?
    AND player_id = ?
    AND discord_id <> ?
`);

const saveDayzLinkStatement = db.prepare(`
  INSERT INTO dayz_links (
    discord_id,
    player_name,
    player_id,
    server_id,
    status,
    requested_at,
    verified_by,
    verified_at
  )
  VALUES (
    ?, ?, ?, ?, 'verified',
    CURRENT_TIMESTAMP, ?, CURRENT_TIMESTAMP
  )
  ON CONFLICT(discord_id) DO UPDATE SET
    player_name = excluded.player_name,
    player_id = excluded.player_id,
    server_id = excluded.server_id,
    status = 'verified',
    requested_at = CURRENT_TIMESTAMP,
    verified_by = excluded.verified_by,
    verified_at = CURRENT_TIMESTAMP
`);

const addDayzLinkAudit = db.prepare(`
  INSERT INTO dayz_link_audit (
    actor_discord_id,
    target_discord_id,
    action,
    player_name,
    player_id,
    server_id,
    reason
  )
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const saveDayzLink = db.transaction(({
  discordId,
  playerName,
  playerId,
  serverId = "dayz-5",
  actorDiscordId = discordId
}) => {
  const existingOwner = getDayzLinkByPlayerId.get(
    serverId,
    playerId
  );

  if (existingOwner && existingOwner.discord_id !== discordId) {
    throw new Error(
      `That DayZ character is already linked to Discord user ${existingOwner.discord_id}. Ask an admin to resolve the conflict.`
    );
  }

  const existingForUser = getDayzLink.get(discordId);

  if (
    existingForUser?.status === "verified" &&
    existingForUser.player_id &&
    existingForUser.player_id !== playerId &&
    actorDiscordId === discordId
  ) {
    throw new Error(
      "Your Discord account is already linked to a different DayZ character. Use `/username unlink` before linking another character."
    );
  }

  saveDayzLinkStatement.run(
    discordId,
    playerName,
    playerId,
    serverId,
    actorDiscordId
  );

  addDayzLinkAudit.run(
    actorDiscordId,
    discordId,
    "link",
    playerName,
    playerId,
    serverId,
    actorDiscordId === discordId
      ? "self-service automatic link"
      : "admin force-link"
  );

  return getDayzLink.get(discordId);
});

const forceSaveDayzLink = db.transaction(({
  actorDiscordId,
  discordId,
  playerName,
  playerId,
  serverId = "dayz-5",
  replaceExisting = false
}) => {
  const owner = getDayzLinkByPlayerId.get(serverId, playerId);
  const targetCurrent = getDayzLink.get(discordId);

  if (
    owner &&
    owner.discord_id !== discordId &&
    !replaceExisting
  ) {
    throw new Error(
      `That DayZ character is already linked to Discord user ${owner.discord_id}. Set replaceExisting:true only after confirming the reassignment.`
    );
  }

  if (
    targetCurrent?.status === "verified" &&
    targetCurrent.player_id &&
    targetCurrent.player_id !== playerId &&
    !replaceExisting
  ) {
    throw new Error(
      "That Discord member is already linked to a different DayZ character. Set replaceExisting:true only after confirming the replacement."
    );
  }

  if (replaceExisting) {
    deleteDayzLinkByPlayer.run(
      serverId,
      playerId,
      discordId
    );
  }

  saveDayzLinkStatement.run(
    discordId,
    playerName,
    playerId,
    serverId,
    actorDiscordId
  );

  addDayzLinkAudit.run(
    actorDiscordId,
    discordId,
    "force-link",
    playerName,
    playerId,
    serverId,
    replaceExisting
      ? "admin force-link; existing link(s) reassigned"
      : "admin force-link"
  );

  return getDayzLink.get(discordId);
});

const selfDeleteDayzLink = db.transaction(({ discordId }) => {
  const link = getDayzLink.get(discordId);

  if (link) {
    addDayzLinkAudit.run(
      discordId,
      discordId,
      "unlink",
      link.player_name,
      link.player_id,
      link.server_id || "dayz-5",
      "self-service unlink"
    );

    deleteDayzLink.run(discordId);
  }

  return link || null;
});

const forceDeleteDayzLink = db.transaction(({
  actorDiscordId,
  discordId,
  reason = "No reason supplied"
}) => {
  const link = getDayzLink.get(discordId);

  if (link) {
    addDayzLinkAudit.run(
      actorDiscordId,
      discordId,
      "force-unlink",
      link.player_name,
      link.player_id,
      link.server_id || "dayz-5",
      reason
    );

    deleteDayzLink.run(discordId);
  }

  return link || null;
});

// Transfer cash between players.
const transferCoins = db.transaction((fromId, toId, amount) => {
  if (fromId === toId) {
    throw new Error("You cannot pay yourself.");
  }

  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error("Amount must be a positive whole number.");
  }

  ensurePlayer.run(fromId, 100);
  ensurePlayer.run(toId, 100);

  const sender = getPlayer.get(fromId);

  if (sender.coins < amount) {
    throw new Error("You do not have enough cash.");
  }

  db.prepare(`
    UPDATE players
    SET coins = coins - ?
    WHERE discord_id = ?
  `).run(amount, fromId);

  db.prepare(`
    UPDATE players
    SET coins = coins + ?
    WHERE discord_id = ?
  `).run(amount, toId);

  addTransaction.run(fromId, -amount, `Payment to ${toId}`);
  addTransaction.run(toId, amount, `Payment from ${fromId}`);

  return {
    amount,
    sender: getPlayer.get(fromId),
    recipient: getPlayer.get(toId)
  };
});

// Cooldown-based economy actions.
function useCooldown(id, action, cooldownMs) {
  const now = Date.now();

  ensurePlayer.run(id, 100);

  const row = db.prepare(`
    SELECT last_used
    FROM economy_cooldowns
    WHERE discord_id = ? AND action = ?
  `).get(id, action);

  if (row && now - row.last_used < cooldownMs) {
    const remaining = Math.ceil(
      (cooldownMs - (now - row.last_used)) / 1000
    );

    throw new Error(
      `You can use /${action} again in ${Math.ceil(remaining / 60)} minute(s).`
    );
  }

  db.prepare(`
    INSERT INTO economy_cooldowns (discord_id, action, last_used)
    VALUES (?, ?, ?)
    ON CONFLICT(discord_id, action)
    DO UPDATE SET last_used = excluded.last_used
  `).run(id, action, now);
}

const economyAction = db.transaction((
  id,
  action,
  minReward,
  maxReward,
  cooldownMs
) => {
  if (
    !Number.isSafeInteger(minReward) ||
    !Number.isSafeInteger(maxReward) ||
    minReward < 0 ||
    maxReward < minReward
  ) {
    throw new Error("Invalid reward range.");
  }

  useCooldown(id, action, cooldownMs);

  const amount =
    Math.floor(Math.random() * (maxReward - minReward + 1)) +
    minReward;

  db.prepare(`
    UPDATE players
    SET coins = coins + ?
    WHERE discord_id = ?
  `).run(amount, id);

  addTransaction.run(id, amount, `/${action} reward`);

  return {
    amount,
    player: getPlayer.get(id)
  };
});

// Rolling-window action limits.
function checkAndRecordUse(id, action, limit, windowMs) {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    !Number.isFinite(windowMs) ||
    windowMs <= 0
  ) {
    throw new Error("Invalid action limit or time window.");
  }

  const now = Date.now();
  const cutoff = now - windowMs;

  db.prepare(`
    DELETE FROM economy_uses
    WHERE discord_id = ?
      AND action = ?
      AND used_at <= ?
  `).run(id, action, cutoff);

  const row = db.prepare(`
    SELECT COUNT(*) AS count, MIN(used_at) AS oldest
    FROM economy_uses
    WHERE discord_id = ? AND action = ?
  `).get(id, action);

  if (row.count >= limit) {
    const remainingMs = Math.max(
      0,
      row.oldest + windowMs - now
    );

    const minutes = Math.max(
      1,
      Math.ceil(remainingMs / 60000)
    );

    throw new Error(
      `You've reached the ${limit}-use limit for /${action}. Try again in about ${minutes} minute(s).`
    );
  }

  db.prepare(`
    INSERT INTO economy_uses (discord_id, action, used_at)
    VALUES (?, ?, ?)
  `).run(id, action, now);

  return {
    used: row.count + 1,
    limit
  };
}

const limitedEconomyAction = db.transaction((
  id,
  action,
  minReward,
  maxReward,
  limit,
  windowMs
) => {
  if (
    !Number.isSafeInteger(minReward) ||
    !Number.isSafeInteger(maxReward) ||
    minReward < 0 ||
    maxReward < minReward
  ) {
    throw new Error("Invalid reward range.");
  }

  ensurePlayer.run(id, 100);

  const quota = checkAndRecordUse(
    id,
    action,
    limit,
    windowMs
  );

  const amount =
    Math.floor(Math.random() * (maxReward - minReward + 1)) +
    minReward;

  db.prepare(`
    UPDATE players
    SET coins = coins + ?
    WHERE discord_id = ?
  `).run(amount, id);

  addTransaction.run(id, amount, `/${action} reward`);

  return {
    amount,
    player: getPlayer.get(id),
    ...quota
  };
});

// Rob another player's cash. Five attempts per two-hour window.
const robPlayer = db.transaction((robberId, targetId) => {
  if (!targetId || robberId === targetId) {
    throw new Error("You must target another player.");
  }

  ensurePlayer.run(robberId, 100);
  ensurePlayer.run(targetId, 100);

  const target = getPlayer.get(targetId);

  if (!target || target.coins <= 0) {
    throw new Error("That player has no cash to rob.");
  }

  const quota = checkAndRecordUse(
    robberId,
    "rob",
    5,
    2 * 60 * 60 * 1000
  );

  const percent = Math.floor(Math.random() * 5) + 1;
  const amount = Math.min(
    target.coins,
    Math.max(1, Math.floor(target.coins * percent / 100))
  );

  db.prepare(`
    UPDATE players
    SET coins = coins - ?
    WHERE discord_id = ?
  `).run(amount, targetId);

  db.prepare(`
    UPDATE players
    SET coins = coins + ?
    WHERE discord_id = ?
  `).run(amount, robberId);

  addTransaction.run(
    targetId,
    -amount,
    `Robbed by ${robberId}`
  );

  addTransaction.run(
    robberId,
    amount,
    `Robbery from ${targetId} (${percent}%)`
  );

  return {
    amount,
    percent,
    player: getPlayer.get(robberId),
    target: getPlayer.get(targetId),
    ...quota
  };
});

// Deposit cash into the bank.
const depositCoins = db.transaction((id, amount) => {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error("Amount must be a positive whole number.");
  }

  ensurePlayer.run(id, 100);

  const player = getPlayer.get(id);

  if (player.coins < amount) {
    throw new Error("You do not have enough cash to deposit that amount.");
  }

  db.prepare(`
    UPDATE players
    SET coins = coins - ?, bank = bank + ?
    WHERE discord_id = ?
  `).run(amount, amount, id);

  addTransaction.run(id, -amount, "Cash deposit");

  return getPlayer.get(id);
});

// Withdraw bank balance into cash.
const withdrawCoins = db.transaction((id, amount) => {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error("Amount must be a positive whole number.");
  }

  ensurePlayer.run(id, 100);

  const player = getPlayer.get(id);

  if (player.bank < amount) {
    throw new Error("You do not have enough bank balance to withdraw that amount.");
  }

  db.prepare(`
    UPDATE players
    SET bank = bank - ?, coins = coins + ?
    WHERE discord_id = ?
  `).run(amount, amount, id);

  addTransaction.run(id, amount, "Bank withdrawal");

  return getPlayer.get(id);
});

// Charge cash for a teleport purchase.
const chargeTeleport = db.transaction((
  id,
  serverId,
  resets,
  start,
  end,
  areaName,
  filePath
) => {
  if (
    !Number.isSafeInteger(resets) ||
    resets < 1 ||
    resets > 10
  ) {
    throw new Error("Resets must be between 1 and 10.");
  }

  ensurePlayer.run(id, 100);

  const unitPrice = Number(
    process.env.TELEPORT_RESET_PRICE || 500
  );

  if (!Number.isSafeInteger(unitPrice) || unitPrice < 1) {
    throw new Error(
      "TELEPORT_RESET_PRICE must be a positive whole number."
    );
  }

  const total = unitPrice * resets;
  const player = getPlayer.get(id);

  if (player.coins < total) {
    throw new Error(
      `Teleport costs $${total}; you have $${player.coins} cash.`
    );
  }

  db.prepare(`
    UPDATE players
    SET coins = coins - ?
    WHERE discord_id = ?
  `).run(total, id);

  addTransaction.run(
    id,
    -total,
    `Teleport purchase (${serverId})`
  );

  const result = db.prepare(`
    INSERT INTO teleport_purchases (
      discord_id,
      server_id,
      resets,
      start_json,
      end_json,
      area_name,
      file_path,
      total_cost,
      status,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(
    id,
    serverId,
    resets,
    JSON.stringify(start),
    JSON.stringify(end),
    areaName,
    filePath,
    total,
    Date.now()
  );

  return {
    id: Number(result.lastInsertRowid),
    total_cost: total
  };
});

const listPendingTeleports = db.prepare(`
  SELECT *
  FROM teleport_purchases
  WHERE server_id = ? AND status = 'pending'
`);

const listExpiredTeleports = db.prepare(`
  SELECT *
  FROM teleport_purchases
  WHERE server_id = ?
    AND status = 'active'
    AND active_until <= ?
`);

// Matches teleport-shop.js: .run(activatedAt, expiryTime, purchase.id)
const activateTeleports = db.prepare(`
  UPDATE teleport_purchases
  SET status = 'active',
      activated_at = ?,
      active_until = ?,
      error = NULL
  WHERE id = ?
    AND status = 'pending'
`);

const markTeleportExpired = db.prepare(`
  UPDATE teleport_purchases
  SET status = 'expired'
  WHERE id = ?
    AND status = 'active'
`);

const markTeleportError = db.prepare(`
  UPDATE teleport_purchases
  SET error = ?
  WHERE id = ?
`);

const failTeleportPurchase = db.transaction((
  purchaseId,
  discordId,
  amount,
  error
) => {
  const result = db.prepare(`
    UPDATE teleport_purchases
    SET status = 'failed',
        error = ?
    WHERE id = ?
      AND status = 'pending'
  `).run(String(error).slice(0, 1000), purchaseId);

  // Refund only if this pending purchase was successfully marked failed.
  if (result.changes === 0) {
    return false;
  }

  ensurePlayer.run(discordId, 100);

  db.prepare(`
    UPDATE players
    SET coins = coins + ?
    WHERE discord_id = ?
  `).run(amount, discordId);

  addTransaction.run(
    discordId,
    amount,
    `Teleport refund #${purchaseId}`
  );

  return true;
});

module.exports = {
  db,

  // DayZ account linking
  getDayzLink,
  getDayzLinkByPlayerId,
  saveDayzLink,
  forceSaveDayzLink,
  forceDeleteDayzLink,
  selfDeleteDayzLink,
  deleteDayzLink,

  // Player accounts and shop
  ensurePlayer,
  getPlayer,
  grantCoins,
  purchase,
  transferCoins,

  // Economy commands
  economyAction,
  limitedEconomyAction,
  robPlayer,
  depositCoins,
  withdrawCoins,

  // Teleport purchase and scheduler functions
  chargeTeleport,
  listPendingTeleports,
  listExpiredTeleports,
  activateTeleports,
  markTeleportExpired,
  markTeleportError,
  failTeleportPurchase
};