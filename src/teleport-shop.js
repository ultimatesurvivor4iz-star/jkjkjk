const crypto = require("node:crypto");
const {
  chargeTeleport,
  listPendingTeleports,
  listExpiredTeleports,
  activateTeleports,
  markTeleportExpired,
  markTeleportError,
  failTeleportPurchase
} = require("./db");
const { readRemoteFile, writeTeleportAreaFile, writeGameplayConfigFile, deleteRemoteFile, restartServer, getServerStatus } = require("./nitrado");

const BOX_SIZE = [2, 1.5, 2];
const BOX_ROTATION = [90, 0, 0];
const RESET_MS = 2 * 60 * 60 * 1000;
const EXPIRY_BUFFER_MS = 30 * 60 * 1000;

// Serialize every config read/modify/write to avoid losing concurrent updates.
const locks = new Map();
async function serialFor(key, work) {
  const previous = locks.get(key) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  locks.set(key, current);
  await previous;
  try { return await work(); }
  finally { release(); if (locks.get(key) === current) locks.delete(key); }
}

function validateCoords(coords, label) {
  if (!Array.isArray(coords) || coords.length !== 3 || !coords.every(n => Number.isFinite(n) && Math.abs(n) <= 100000)) {
    throw new Error(`${label} must contain three valid numeric coordinates (X, Y, Z).`);
  }
}
function requireTeleportConfig(server) {
  if (!server || server.teleportShopEnabled !== true) throw new Error('Teleport purchases are not enabled for this server.');
  for (const field of ['gameplayConfigPath', 'customFolderPath']) {
    if (typeof server[field] !== 'string' || !server[field].startsWith('/games/')) throw new Error(`Missing or invalid ${field} for ${server.name}.`);
  }
}
function areaPathFor(server, fileName) {
  return `${server.customFolderPath.replace(/\/+$/, '')}/${fileName}`;
}

async function editGameplayConfig(server, addPath, removePath) {
  return serialFor(`${server.serviceId}:${server.gameplayConfigPath}`, async () => {
    const raw = await readRemoteFile(server.serviceId, server.gameplayConfigPath);
    let config;
    try { config = JSON.parse(raw); } catch (e) { throw new Error(`Remote cfggameplay.json is invalid JSON: ${e.message}`); }
    if (!config || typeof config !== 'object') throw new Error('cfggameplay.json must be a JSON object.');
    config.WorldsData ||= {};
    if (!Array.isArray(config.WorldsData.playerRestrictedAreaFiles)) {
      config.WorldsData.playerRestrictedAreaFiles = [];
    }
    const paths = config.WorldsData.playerRestrictedAreaFiles;
    if (removePath) {
      config.WorldsData.playerRestrictedAreaFiles = paths.filter(p => p !== removePath);
    }
    if (addPath && !config.WorldsData.playerRestrictedAreaFiles.includes(addPath)) {
      config.WorldsData.playerRestrictedAreaFiles.push(addPath);
    }
    await writeGameplayConfigFile(server.serviceId, server.gameplayConfigPath, `${JSON.stringify(config, null, 2)}\n`);
  });
}

async function buyTeleport({ discordId, server, start, end, resets }) {
  requireTeleportConfig(server);
  validateCoords(start, 'Start coordinates');
  validateCoords(end, 'End coordinates');
  if (!Number.isSafeInteger(resets) || resets < 1 || resets > 10) throw new Error('Resets must be between 1 and 10.');

  const purchaseId = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  const areaName = `TELEPORT_${discordId}_${purchaseId}`;
  const fileName = `${areaName}.json`;
  const remoteFile = areaPathFor(server, fileName);
  const relativePath = `Custom/${fileName}`;
  const purchase = chargeTeleport(discordId, server.id, resets, start, end, areaName, remoteFile);
  const area = {
    areaName,
    PRABoxes: [[BOX_SIZE, BOX_ROTATION, start]],
    safePositions3D: [end]
  };

  try {
    await writeTeleportAreaFile(server.serviceId, remoteFile, `${JSON.stringify(area, null, 2)}\n`);
    await editGameplayConfig(server, relativePath, null);
    return { id: purchase.id, total: purchase.total_cost, resets, areaName, relativePath };
  } catch (error) {
	  console.log('first error: ');
	  console.log(error);
    // Best-effort cleanup so a partially written file cannot remain registered.
    try { await editGameplayConfig(server, null, relativePath); } catch (cleanupError) {
      console.error(`[teleport] Could not remove partial config for purchase #${purchase.id}:`, cleanupError.message || cleanupError);
    }
    try { await deleteRemoteFile(server.serviceId, remoteFile); } catch (cleanupError) {
      console.error(`[teleport] Could not delete partial file for purchase #${purchase.id}:`, cleanupError.message || cleanupError);
    }
    failTeleportPurchase(purchase.id, discordId, purchase.total_cost, String(error.message || error));
    throw new Error(`Teleport setup failed and ${purchase.total_cost.toLocaleString()} coins were refunded. ${error.message || error}`);
  }
}

async function cleanupExpired(server, now = Date.now()) {
  requireTeleportConfig(server);
  const expired = listExpiredTeleports.all(server.id, now);
  const results = [];
  for (const purchase of expired) {
    try {
      // Remove the path first so the next config load cannot reference the expired area.
      await editGameplayConfig(server, null, `Custom/${purchase.file_path.split('/').pop()}`);
      await deleteRemoteFile(server.serviceId, purchase.file_path);
      markTeleportExpired.run(purchase.id);
      results.push({ id: purchase.id, ok: true });
    } catch (error) {
      markTeleportError.run(String(error.message || error).slice(0, 1000), purchase.id);
      console.error(`[teleport] Cleanup failed for purchase #${purchase.id}:`, error.message || error);
      results.push({ id: purchase.id, ok: false, error: error.message || String(error) });
    }
  }
  return results;
}

async function waitUntilStarted(server, timeoutMs = 12 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  let observedRestartingOrOffline = false;
  while (Date.now() < deadline) {
    const status = await getServerStatus(server.serviceId);
    const state = String(status.status || status.game_server_status || '').toLowerCase();
    if (state && !['started', 'running', 'online'].includes(state)) {
      observedRestartingOrOffline = true;
    }
    // Require seeing the server leave the running state before accepting 'started' again;
    // Nitrado can briefly report stale 'started' status immediately after a restart request.
    if (observedRestartingOrOffline && ['started', 'running', 'online'].includes(state)) return;
    await new Promise(resolve => setTimeout(resolve, 15000));
  }
  throw new Error(`Timed out waiting to observe ${server.name} stop and come back online after restart.`);
}

async function restartCycle(server) {
  requireTeleportConfig(server);
  // Expired areas are removed before restart. If cleanup fails, do not restart and risk reloading them.
  const cleanup = await cleanupExpired(server, Date.now());
  const failed = cleanup.filter(result => !result.ok);
  if (failed.length) throw new Error(`Restart aborted: cleanup failed for ${failed.length} expired teleport(s).`);

  await restartServer(server.serviceId);
  await waitUntilStarted(server);
  const activatedAt = Date.now();
  const pending = listPendingTeleports.all(server.id);
  for (const purchase of pending) {
    const activeDuration = purchase.resets * RESET_MS - EXPIRY_BUFFER_MS;
    activateTeleports.run(activatedAt, activatedAt + activeDuration, purchase.id);
  }
  console.log(`[teleport] Restart completed for ${server.name}; activated ${pending.length} pending teleport(s).`);
  return { activated: pending.length };
}

function nextEvenHourUtc(now = new Date()) {
  const next = new Date(now);
  next.setUTCMinutes(0, 0, 0);
  if (now.getUTCMinutes() !== 0 || now.getUTCSeconds() !== 0 || now.getUTCMilliseconds() !== 0) next.setUTCHours(next.getUTCHours() + 1);
  if (next.getUTCHours() % 2 !== 0) next.setUTCHours(next.getUTCHours() + 1);
  return next;
}

function startTeleportScheduler(getServerById) {
  let busy = false;
  let lastCycleKey = '';
  const run = async () => {
    if (busy) return;
    busy = true;
    try {
      const server = getServerById('dayz-5');
      if (!server || server.teleportShopEnabled !== true) return;
      await cleanupExpired(server);
      if (process.env.NITRADO_MANAGED_RESTARTS !== 'true' || server.restartManagementEnabled !== true) return;
      const now = new Date();
      const key = `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}-${now.getUTCHours()}`;
      if (now.getUTCMinutes() <= 5 && now.getUTCHours() % 2 === 0 && key !== lastCycleKey) {
        // Mark the cycle before issuing the request so a slow/stale status response cannot
        // trigger multiple restarts in the same scheduled window.
        lastCycleKey = key;
        await restartCycle(server);
      }
    } catch (error) {
      console.error('[teleport-scheduler] Cycle failed:', error.message || error);
    } finally { busy = false; }
  };
  void run();
  return setInterval(run, 15000);
}

module.exports = { buyTeleport, startTeleportScheduler, cleanupExpired, nextEvenHourUtc, BOX_SIZE, RESET_MS, EXPIRY_BUFFER_MS };
