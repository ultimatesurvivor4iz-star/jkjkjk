'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readRemoteFile, listRemoteDirectory } = require('./nitrado');

const STATE_PATH = path.resolve(__dirname, '..', 'data', 'adm-feed-state.json');
const LOGO_PATH = path.resolve(__dirname, '..', 'ultimatesurvivor2.png');
const LOGO_FILENAME = 'ultimatesurvivor2.png';
const FOOTER_TEXT = 'UltimateSurvivorDAYZ, making memories';

const POLL_MS = Math.max(30_000, Number(process.env.ADM_POLL_MS || 60_000));
const MAX_LINES_PER_POLL = 100;
const TAIL_LINES = 500;
const MAX_SEEN = 5000;

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  const tempPath = STATE_PATH + '.tmp';
  fs.writeFileSync(tempPath, JSON.stringify(state, null, 2));
  fs.renameSync(tempPath, STATE_PATH);
}

const DEFAULT_CHANNELS = {
  kills: '1565033135102763008',
  hits: '1565034230323486915',
  infected: '1565035415906553886',
  players: '1565035510856941699',
  locations: '1565034293187579995',
  medical: '1565035741703180378',
  emotes: '1565035700641075241',
  other: '1565035925623541780',

  building: '1565046910908108931',
  dismantling: '1565046951492456599',
  place: '1565046995394236566',
  pack: '1565047033092513792',
  mount: '1565048318512332800',
  dismount: '1565048357385150476',

  // Both flag events intentionally share the flags channel.
  flagraising: '1565047071613132831',
  flaglowering: '1565047071613132831',

  connects: '1565374634189393920',
  disconnects: '1565374682176290986',
  online: '1565374736027091105'
};

function parseChannels() {
  try {
    const configured = JSON.parse(process.env.ADM_FEED_CHANNELS || '{}');
    return { ...DEFAULT_CHANNELS, ...configured };
  } catch {
    console.error(
      '[adm-feed] ADM_FEED_CHANNELS is invalid JSON. Using default channel IDs.'
    );
    return { ...DEFAULT_CHANNELS };
  }
}

function classify(line) {
  if (
    /hit by Player\s+"/i.test(line) &&
    /for\s+[\d.]+\s+damage/i.test(line)
  ) {
    return 'hits';
  }

  if (/hit by (?:Infected|Zmb|Zombie)|Infected.*hit/i.test(line)) {
    return 'infected';
  }

  if (
    /\b(died|is dead|was killed|killed by|suicide|EmoteSuicide)\b/i.test(line)
  ) {
    return 'kills';
  }

  if (
    /\bhas been disconnected\b|\bis disconnected\b|\bdisconnected from server\b/i.test(line)
  ) {
    return 'disconnects';
  }

  if (
    /\bis connecting\b|\bis connected\b|\bconnected to server\b/i.test(line)
  ) {
    return 'connects';
  }

  // PlayerList markers are control lines, not individual feed events.
  // The complete snapshot is handled by updateOnlinePlayersMessage().
  if (/PlayerList|#####/i.test(line)) return null;

  if (
    /\b(?:built|building|construction|placed a|built a|build object)\b/i.test(line)
  ) {
    return 'building';
  }

  if (
    /\b(?:dismantled|dismantling|destroyed construction|deconstructed)\b/i.test(line)
  ) {
    return 'dismantling';
  }

  if (/\b(?:placed|place item|placed item)\b/i.test(line)) return 'place';
  if (/\b(?:packed|pack item|packed item)\b/i.test(line)) return 'pack';
  if (/\b(?:mounted|attached|mount)\b/i.test(line)) return 'mount';
  if (/\b(?:dismounted|detached|unmounted)\b/i.test(line)) return 'dismount';

  if (/\b(?:flag raised|raising flag|flagraising)\b/i.test(line)) {
    return 'flagraising';
  }

  if (/\b(?:flag lowered|lowering flag|flaglowering)\b/i.test(line)) {
    return 'flaglowering';
  }

  if (/unconscious|regained consciousness/i.test(line)) {
    return 'medical';
  }

  if (/performed Emote/i.test(line)) {
    return 'emotes';
  }

  if (/pos=<[-\d.]+,\s*[-\d.]+,\s*[-\d.]+>/.test(line)) {
    return 'locations';
  }

  if (/vehicle|truck|boat|helicopter|car\s+is/i.test(line)) {
    return 'other';
  }

  return null;
}

function parsePosition(line) {
  const match = line.match(
    /Player\s+"([^"]+)"\s*\(id=([^\s)]+).*?pos=<\s*([-\d.]+),\s*([-\d.]+),\s*([-\d.]+)\s*>/i
  );

  if (!match) return null;

  const values = match.slice(3, 6).map(Number);
  if (!values.every(Number.isFinite)) return null;

  return {
    playerName: match[1],
    playerId: match[2],
    x: values[0],
    y: values[1],
    z: values[2],
    time: (line.match(/^([^|]+)\|/) || [])[1]?.trim() || null,
    raw: line
  };
}

// Accept only a complete PlayerList snapshot whose parsed player count
// matches the count in the header.
function parseLatestPlayerList(lines) {
  for (let start = lines.length - 1; start >= 0; start--) {
    const header = String(lines[start]).match(
      /#####\s*PlayerList log:\s*(\d+)\s*players/i
    );

    if (!header) continue;

    const expectedCount = Number(header[1]);
    const players = [];
    let closed = false;

    for (let i = start + 1; i < lines.length; i++) {
      const line = String(lines[i]);

      if (/\|\s*#####\s*$/.test(line) || /^\s*#####\s*$/.test(line)) {
        closed = true;
        break;
      }

      const player = parsePosition(line);
      if (player) players.push(player);
    }

    if (closed && players.length === expectedCount) {
      const unique = new Map();

      for (const player of players) {
        unique.set(player.playerId, player);
      }

      return {
        expectedCount,
        players: [...unique.values()].sort((a, b) =>
          a.playerName.localeCompare(b.playerName)
        )
      };
    }
  }

  return null;
}

// Remove player identifiers from displayed feed text only.
function cleanAdmLine(line) {
  return String(line)
    .replace(
      /\b(?:steam_?id|steamid|player_?id|playeruid|playerguid|uid|guid|id)\s*[:=]\s*[^,\s;)]+,?\s*/gi,
      ''
    )
    .replace(
      /\b(?:steam_?id|steamid|player_?id|playeruid|playerguid|uid|guid)\s+[^,\s;)]+,?\s*/gi,
      ''
    )
    .replace(/\(\s*,/g, '(')
    .replace(/,\s*\)/g, ')')
    .replace(/\(\s*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// X and Z are the horizontal game-map coordinates.
function linkCoordinates(line) {
  return String(line).replace(
    /pos=<\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*>/gi,
    (_match, x, _elevation, z) => {
      const url =
        `https://www.izurvive.com/?x=${encodeURIComponent(x)}&y=${encodeURIComponent(z)}`;

      return `[X: ${x}, Z: ${z}](${url})`;
    }
  );
}

function makeMessage(serverName, type, line) {
  const labels = {
    kills: '☠️ Kill / Death',
    hits: '🎯 Player Hit',
    infected: '🧟 Infected',
    connects: '🟢 Player Connected',
    disconnects: '🔴 Player Disconnected',
    online: '👥 Online Players List',
    building: '🧱 Building',
    dismantling: '🔨 Dismantling',
    place: '📦 Item Placed',
    pack: '📦 Item Packed',
    mount: '🔧 Mounted',
    dismount: '🔧 Dismounted',
    flagraising: '🚩 Flag Raised',
    flaglowering: '🚩 Flag Lowered',
    locations: '📍 Position Record',
    medical: '🩺 Medical',
    emotes: '🕺 Emote',
    other: '📋 Server Event'
  };

  const safe = linkCoordinates(cleanAdmLine(line))
    .replace(/```/g, "'''")
    .slice(0, 900);

  const embed = {
    color: type === 'hits' ? 0xE67E22 : 0xC9A227,
    title: `${labels[type] || 'ADM Event'} • ${serverName}`.slice(0, 256),
    description: safe.includes('](') ? safe : `\`\`\`${safe}\`\`\``,
    footer: { text: FOOTER_TEXT },
    timestamp: new Date().toISOString()
  };

  const message = { embeds: [embed] };

  if (fs.existsSync(LOGO_PATH)) {
    embed.thumbnail = { url: `attachment://${LOGO_FILENAME}` };
    message.files = [{ attachment: LOGO_PATH, name: LOGO_FILENAME }];
  }

  return message;
}

function relativeAge(value) {
  if (!value) return 'time unknown';

  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return 'time unknown';

  const minutes = Math.max(0, Math.floor((Date.now() - parsed) / 60000));

  if (minutes < 1) return 'just now';

  if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  }

  const hours = Math.floor(minutes / 60);

  if (hours < 24) {
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }

  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function locationTimestamp(value) {
  if (!value) return null;

  const normalized = String(value)
    .trim()
    .replace(
      /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}).*$/,
      '$1T$2Z'
    );

  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function makeLocationListMessage(serverName, locations) {
  const players = Object.values(locations || {})
    .filter(
      player =>
        player &&
        player.playerName &&
        Number.isFinite(Number(player.x)) &&
        Number.isFinite(Number(player.z))
    )
    .sort((a, b) =>
      String(a.playerName).localeCompare(String(b.playerName))
    );

  const lines = players.map(player => {
    const x = Number(player.x).toFixed(1).replace(/\.0$/, '');
    const z = Number(player.z).toFixed(1).replace(/\.0$/, '');

    const url =
      `https://www.izurvive.com/?x=${encodeURIComponent(x)}&y=${encodeURIComponent(z)}`;

    const updatedAt = locationTimestamp(player.time);

    const safeName = String(player.playerName).replace(
      /[\`*_{}\[\]()<>#+.!|~-]/g,
      '\\$&'
    );

    return `• **${safeName}** · ${relativeAge(updatedAt)}\n  [${x}, ${z}](${url})`;
  });

  let description = lines.length
    ? lines.join('\n')
    : 'No player locations recorded yet.';

  if (description.length > 3900) {
    description = `${description.slice(0, 3880)}\n… list shortened`;
  }

  return {
    embeds: [{
      color: 0xC9A227,
      title: `📍 ${players.length} User Location${players.length === 1 ? '' : 's'} • ${serverName}`.slice(0, 256),
      description,
      footer: { text: '+99LOOT' },
      timestamp: new Date().toISOString()
    }]
  };
}

// IMPORTANT: only player names are included in the online-player embed.
// Player IDs remain internal for identifying duplicate entries.
function makeOnlinePlayersMessage(serverName, players) {
  const names = (Array.isArray(players) ? players : [])
    .map(player => String(player.playerName || '').trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));

  const safeNames = names.map(name =>
    name.replace(/[\`*_{}\[\]()<>#+.!|~-]/g, '\\$&')
  );

  let description = safeNames.length
    ? safeNames.map(name => `• ${name}`).join('\n')
    : 'No players are currently online.';

  if (description.length > 3900) {
    description = `${description.slice(0, 3880)}\n… list shortened`;
  }

  return {
    embeds: [{
      color: 0x2ECC71,
      title: `👥 ${names.length} Player${names.length === 1 ? '' : 's'} Online • ${serverName}`.slice(0, 256),
      description,
      footer: { text: FOOTER_TEXT },
      timestamp: new Date().toISOString()
    }]
  };
}

function linesOf(text) {
  return String(text)
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter(Boolean);
}

function timestampFromAdmPath(value) {
  const base = path.posix.basename(String(value || '').replace(/\\/g, '/'));

  const match = base.match(
    /(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})\.ADM$/i
  );

  if (!match) return null;

  const [, year, month, day, hour, minute, second] = match;
  const parts = [year, month, day, hour, minute, second].map(Number);
  const [y, mo, d, h, mi, sec] = parts;

  const timestamp = Date.UTC(y, mo - 1, d, h, mi, sec);
  const date = new Date(timestamp);

  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== mo - 1 ||
    date.getUTCDate() !== d ||
    date.getUTCHours() !== h ||
    date.getUTCMinutes() !== mi ||
    date.getUTCSeconds() !== sec
  ) {
    return null;
  }

  return timestamp;
}

function normalizeModifiedAt(value) {
  if (value === undefined || value === null || value === '') return 0;

  const numeric = Number(value);

  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric < 100_000_000_000 ? numeric * 1000 : numeric;
  }

  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function collectAdmFiles(value, out = [], parentPath = '') {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectAdmFiles(item, out, parentPath);
    }

    return out;
  }

  if (!value || typeof value !== 'object') return out;

  const name = typeof value.name === 'string' ? value.name.trim() : '';
  const explicitPath = typeof value.path === 'string' ? value.path.trim() : '';
  const type = String(value.type || value.kind || '').toLowerCase();

  const isDirectory = type.includes('dir') || type === 'folder';
  const isFile = !isDirectory && (type === '' || type.includes('file'));

  let candidatePath = '';

  if (explicitPath && /\.ADM$/i.test(explicitPath)) {
    candidatePath = explicitPath;
  } else if (name && /\.ADM$/i.test(name)) {
    if (explicitPath && !/\.ADM$/i.test(explicitPath)) {
      candidatePath = `${explicitPath.replace(/\/$/, '')}/${name}`;
    } else {
      candidatePath = `${parentPath.replace(/\/$/, '')}/${name}`;
    }
  }

  const normalizedPath = candidatePath
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/');

  const modifiedAt = normalizeModifiedAt(
    value.modified_at ??
    value.modifiedAt ??
    value.created_at ??
    value.createdAt
  );

  const filenameTimestamp = timestampFromAdmPath(normalizedPath || name);
  const timestamp = filenameTimestamp ?? (modifiedAt || null);

  if (
    isFile &&
    normalizedPath &&
    !normalizedPath.includes('*') &&
    /\.ADM$/i.test(normalizedPath) &&
    timestamp !== null
  ) {
    out.push({
      path: normalizedPath.startsWith('/')
        ? normalizedPath
        : `/${normalizedPath}`,
      timestamp,
      modifiedAt
    });
  }

  const nextParent = isDirectory && name
    ? `${explicitPath || parentPath}/${name}`
    : (
        explicitPath && !/\.ADM$/i.test(explicitPath)
          ? explicitPath
          : parentPath
      );

  for (const item of Object.values(value)) {
    if (item && typeof item === 'object') {
      collectAdmFiles(item, out, nextParent);
    }
  }

  return out;
}

async function resolveAdmPaths(server) {
  const directory =
    server.admDirectory ||
    (server.admFilePath
      ? path.posix.dirname(server.admFilePath)
      : '');

  if (!directory) {
    return server.admFilePath && !server.admFilePath.includes('*')
      ? [server.admFilePath]
      : [];
  }

  const listings = [];

  for (const search of ['DayZServer_PS4_x64_', null]) {
    try {
      console.log(
        `[adm-feed] Scanning ${directory} for ${server.name} ADM files ` +
        `(filter=${JSON.stringify(search)}).`
      );

      const result = await listRemoteDirectory(
        server.serviceId,
        directory,
        search || undefined
      );

      listings.push(...collectAdmFiles(result));

      if (listings.length) break;
    } catch (error) {
      console.warn(
        `[adm-feed] Directory listing failed for ${server.name}: ${error.message}`
      );
    }
  }

  const unique = new Map();

  for (const file of listings) {
    unique.set(file.path, file);
  }

  const candidates = [...unique.values()].sort(
    (a, b) => b.timestamp - a.timestamp || b.modifiedAt - a.modifiedAt
  );

  console.log(
    `[adm-feed] ${server.name}: found ${candidates.length} ADM files.`
  );

  if (candidates.length) {
    console.log(
      `[adm-feed] ${server.name}: newest ADM is ${candidates[0].path}`
    );

    return candidates.map(file => file.path);
  }

  if (server.admFilePath && !server.admFilePath.includes('*')) {
    console.warn('[adm-feed] Falling back to the configured ADM file path.');
    return [server.admFilePath];
  }

  return [];
}

function findOverlap(oldLines, newLines) {
  for (
    let n = Math.min(oldLines.length, newLines.length, TAIL_LINES);
    n > 0;
    n--
  ) {
    let matches = true;

    for (let i = 0; i < n; i++) {
      if (oldLines[oldLines.length - n + i] !== newLines[i]) {
        matches = false;
        break;
      }
    }

    if (matches) return n;
  }

  return 0;
}

function getLatestLocations(serverId) {
  const state = loadState();
  const activePath = state.__paths?.[serverId];

  if (!activePath) return {};

  return state[`${serverId}:${activePath}`]?.locations || {};
}

function findPlayerById(serverId, playerId) {
  return getLatestLocations(serverId)[playerId] || null;
}

function findPlayersByName(serverId, playerName) {
  const wanted = String(playerName || '').trim().toLocaleLowerCase();

  if (!wanted) return [];

  return Object.values(getLatestLocations(serverId)).filter(
    player =>
      String(player.playerName || '').trim().toLocaleLowerCase() === wanted
  );
}

function startAdmFeedWatcher(client, listServers) {
  const channels = parseChannels();
  const state = loadState();

  let busy = false;

  async function updateLocationMessage(server) {
    const channelId =
      channels[`${server.id}.locations`] || channels.locations;

    if (!channelId || String(channelId).startsWith('YOUR_')) return;

    const channel = await client.channels
      .fetch(String(channelId))
      .catch(() => null);

    if (
      !channel ||
      !channel.isTextBased() ||
      typeof channel.send !== 'function'
    ) {
      console.warn(`[adm-feed] Invalid locations channel: ${channelId}`);
      return;
    }

    const merged = {};
    const mergedTimes = {};
    const prefix = `${server.id}:`;

    for (const [key, fileState] of Object.entries(state)) {
      if (!key.startsWith(prefix) || !fileState?.locations) continue;

      for (const [playerId, player] of Object.entries(fileState.locations)) {
        const updatedAt = locationTimestamp(player.time);
        const updatedMs = updatedAt ? Date.parse(updatedAt) : 0;

        if (
          !merged[playerId] ||
          updatedMs >= (mergedTimes[playerId] || 0)
        ) {
          merged[playerId] = player;
          mergedTimes[playerId] = updatedMs;
        }
      }
    }

    const payload = makeLocationListMessage(server.name, merged);

    state.__locationMessageIds ||= {};
    const messageId = state.__locationMessageIds[server.id];

    if (messageId && channel.messages?.fetch) {
      const existing = await channel.messages
        .fetch(String(messageId))
        .catch(() => null);

      if (existing && typeof existing.edit === 'function') {
        try {
          await existing.edit(payload);
          return;
        } catch (error) {
          // Only treat Discord's Unknown Message error as a stale message.
          // Other errors must be logged by the caller.
          if (
            Number(error.code) !== 10008 &&
            !/unknown message/i.test(error.message || '')
          ) {
            throw error;
          }

          console.warn(
            `[adm-feed] Saved location message for ${server.name} no longer exists; creating a replacement.`
          );

          delete state.__locationMessageIds[server.id];
        }
      } else {
        // The saved ID could not be fetched, so it is stale or inaccessible.
        delete state.__locationMessageIds[server.id];
      }
    }

    const sent = await channel.send(payload);
    state.__locationMessageIds[server.id] = sent.id;
  }

  async function updateOnlinePlayersMessage(server, players) {
    const channelId =
      channels[`${server.id}.online`] || channels.online || channels.players;

    if (!channelId || String(channelId).startsWith('YOUR_')) return;

    const channel = await client.channels
      .fetch(String(channelId))
      .catch(() => null);

    if (
      !channel ||
      !channel.isTextBased() ||
      typeof channel.send !== 'function'
    ) {
      console.warn(`[adm-feed] Invalid online players channel: ${channelId}`);
      return;
    }

    const payload = makeOnlinePlayersMessage(server.name, players);

    state.__onlineMessageIds ||= {};
    const messageId = state.__onlineMessageIds[server.id];

    if (messageId && channel.messages?.fetch) {
      const existing = await channel.messages
        .fetch(String(messageId))
        .catch(() => null);

      if (existing && typeof existing.edit === 'function') {
        try {
          await existing.edit(payload);
          return;
        } catch (error) {
          if (
            Number(error.code) !== 10008 &&
            !/unknown message/i.test(error.message || '')
          ) {
            throw error;
          }

          console.warn(
            `[adm-feed] Saved online-player message for ${server.name} no longer exists; creating a replacement.`
          );

          delete state.__onlineMessageIds[server.id];
        }
      } else {
        delete state.__onlineMessageIds[server.id];
      }
    }

    const sent = await channel.send(payload);
    state.__onlineMessageIds[server.id] = sent.id;
  }

  async function processFile(
    server,
    remotePath,
    isNewerFile,
    firstScan,
    maxLinesPerPoll = MAX_LINES_PER_POLL
  ) {
    const key = `${server.id}:${remotePath}`;

    console.log(
      `[adm-feed][DESTINATION] server=${server.name} ` +
      `action=readRemoteFile file=${JSON.stringify(remotePath)}`
    );

    const raw = await readRemoteFile(server.serviceId, remotePath);
    const current = linesOf(raw);

    console.log(
      `[adm-feed] ${server.name}/${path.posix.basename(remotePath)}: ` +
      `${Buffer.byteLength(raw, 'utf8')} bytes, ${current.length} lines.`
    );

    let previous = state[key];

    // On first startup, establish a baseline without replaying old events.
    if (!previous && firstScan) {
      previous = {
        lines: current.slice(-TAIL_LINES),
        totalLines: current.length,
        locations: {},
        seen: {}
      };

      for (const line of current) {
        const position = parsePosition(line);

        if (position) {
          previous.locations[position.playerId] = position;
        }
      }

      state[key] = previous;
      console.log('[adm-feed] Baseline established; historical lines skipped.');
      return current;
    }

    // Older logs discovered later are baselined rather than replayed.
    if (!previous && !isNewerFile) {
      previous = {
        lines: current.slice(-TAIL_LINES),
        totalLines: current.length,
        locations: {},
        seen: {}
      };

      for (const line of current) {
        const position = parsePosition(line);

        if (position) {
          previous.locations[position.playerId] = position;
        }
      }

      state[key] = previous;

      console.log(
        `[adm-feed] Older log baselined without replay: ${path.posix.basename(remotePath)}`
      );

      return current;
    }

    if (!previous) {
      previous = {
        lines: [],
        totalLines: 0,
        locations: {},
        seen: {}
      };

      state[key] = previous;
      console.log(`[adm-feed] Newer ADM detected: ${remotePath}`);
    }

    previous.lines ||= [];
    previous.locations ||= {};
    previous.seen ||= {};

    let fresh;
    let freshStartIndex;

    if (!previous.totalLines && !previous.lines.length) {
      fresh = current;
      freshStartIndex = 0;
    } else {
      const oldTail = previous.lines;
      const oldTotal = Number(previous.totalLines || oldTail.length);
      const expectedStart = Math.max(0, oldTotal - oldTail.length);

      const appendMatches =
        current.length >= oldTotal &&
        oldTail.every(
          (line, index) => current[expectedStart + index] === line
        );

      if (appendMatches) {
        freshStartIndex = oldTotal;
        fresh = current.slice(oldTotal);
      } else {
        const overlap = findOverlap(oldTail, current);
        fresh = current.slice(overlap);
        freshStartIndex = Math.max(0, current.length - fresh.length);
      }
    }

    // Update stored positions using the original ADM lines.
    for (const line of fresh) {
      const position = parsePosition(line);

      if (position) {
        previous.locations[position.playerId] = position;
      }
    }

    const batch = fresh.slice(0, maxLinesPerPoll);
    const typeCounts = {};

    let classified = 0;
    let sent = 0;
    let processedCount = 0;
    let deliveryBlocked = false;

    for (let i = 0; i < batch.length; i++) {
      const line = batch[i];
      const lineNumber = freshStartIndex + i;
      const type = classify(line);

      if (type) {
        classified++;
        typeCounts[type] = (typeCounts[type] || 0) + 1;

        const eventId = crypto
          .createHash('sha256')
          .update(`${server.id}\n${remotePath}\n${lineNumber}\n${line}`)
          .digest('hex');

        if (!previous.seen[eventId]) {
          // Location records update the persistent list rather than
          // creating individual Discord messages.
          if (type === 'locations') {
            previous.seen[eventId] = 1;
            processedCount++;
            continue;
          }

          const configuredChannelId =
            channels[`${server.id}.${type}`] || channels[type];

          const channelId =
            configuredChannelId &&
            !String(configuredChannelId).startsWith('YOUR_')
              ? configuredChannelId
              : (
                  ['connects', 'disconnects', 'online'].includes(type)
                    ? channels.players
                    : null
                );

          // Missing channels disable that category without blocking others.
          if (channelId) {
            const channel = await client.channels
              .fetch(String(channelId))
              .catch(() => null);

            if (
              !channel ||
              !channel.isTextBased() ||
              typeof channel.send !== 'function'
            ) {
              console.warn(
                `[adm-feed] Invalid ${type} channel: ${channelId}; will retry this line.`
              );

              deliveryBlocked = true;
              break;
            }

            try {
              await channel.send(makeMessage(server.name, type, line));
              previous.seen[eventId] = 1;
              sent++;
            } catch (error) {
              console.error(
                `[adm-feed] Discord send failed for ${type}; will retry this line: ${error.message}`
              );

              deliveryBlocked = true;
              break;
            }
          }
        }
      }

      processedCount++;
    }

    // Advance only through lines successfully handled.
    const nextTotalLines = Math.min(
      current.length,
      freshStartIndex + processedCount
    );

    previous.totalLines = nextTotalLines;
    previous.lines = current.slice(0, nextTotalLines).slice(-TAIL_LINES);
    previous.updatedAt = new Date().toISOString();

    previous.seen = Object.fromEntries(
      Object.entries(previous.seen).slice(-MAX_SEEN)
    );

    console.log(
      `[adm-feed] ${server.name}/${path.posix.basename(remotePath)}: ` +
      `fresh=${fresh.length}, processed=${processedCount}, ` +
      `classified=${classified}, sent=${sent}, ` +
      `retryPending=${deliveryBlocked}, types=${JSON.stringify(typeCounts)}.`
    );

    return current;
  }

  async function tick() {
    if (busy) {
      console.warn('[adm-feed] Skipping poll; previous poll is still running.');
      return;
    }

    busy = true;
    console.log(`[adm-feed] Poll started at ${new Date().toISOString()}.`);

    try {
      const servers = listServers().filter(
        server =>
          server.enabled &&
          server.configured &&
          (server.admDirectory || server.admFilePath)
      );

      for (const server of servers) {
        try {
          const paths = await resolveAdmPaths(server);

          if (!paths.length) {
            console.warn(`[adm-feed] No ADM files found for ${server.name}.`);
            continue;
          }

          const firstScan = !state.__initialized?.[server.id];
          const newestPath = paths[0];
          const newestTimestamp = timestampFromAdmPath(newestPath) || 0;
          const previouslyActivePath = state.__paths?.[server.id] || null;
          const previousNewestTimestamp = Number(
            state.__newestTimestamp?.[server.id] || 0
          );

          state.__paths ||= {};
          let newestLines = null;

          // On rotation, finish the previous active file before switching to
          // the newest file. Only this previous active file is eligible for a
          // drain; unrelated historical ADM files are never read.
          state.__pendingDrainPaths ||= {};
          const pendingDrain = new Set(state.__pendingDrainPaths[server.id] || []);

          if (
            !firstScan &&
            previouslyActivePath &&
            previouslyActivePath !== newestPath
          ) {
            pendingDrain.add(previouslyActivePath);
            console.log(
              `[adm-feed] ${server.name}: rotation detected; draining previous active ADM ${previouslyActivePath}.`
            );
          }

          for (const drainPath of pendingDrain) {
            try {
              const drainedLines = await processFile(
                server,
                drainPath,
                false,
                false,
                Infinity
              );

              const drainState = state[`${server.id}:${drainPath}`];

              if (
                drainState &&
                Number(drainState.totalLines) >= drainedLines.length
              ) {
                pendingDrain.delete(drainPath);
              }
            } catch (error) {
              console.warn(
                `[adm-feed] Could not drain previous active ADM ${drainPath}; will retry: ${error.message}`
              );
            }
          }

          state.__pendingDrainPaths[server.id] = [...pendingDrain];

          const isNewerFile =
            !firstScan &&
            newestPath !== previouslyActivePath &&
            (
              newestTimestamp > previousNewestTimestamp ||
              previouslyActivePath !== newestPath
            );

          newestLines = await processFile(
            server,
            newestPath,
            isNewerFile,
            firstScan
          );

          state.__paths[server.id] = newestPath;

          // Only update the online list when a complete PlayerList snapshot
          // is available in the newest ADM file.
          if (newestLines) {
            const snapshot = parseLatestPlayerList(newestLines);

            if (snapshot) {
              await updateOnlinePlayersMessage(server, snapshot.players).catch(error => {
                console.error(
                  `[adm-feed] Could not update ${server.name} online players list: ${error.message}`
                );
              });
            }
          }

          await updateLocationMessage(server).catch(error => {
            console.error(
              `[adm-feed] Could not update ${server.name} location list: ${error.message}`
            );
          });

          state.__newestTimestamp ||= {};

          state.__newestTimestamp[server.id] = Math.max(
            previousNewestTimestamp,
            newestTimestamp
          );

          state.__initialized ||= {};
          state.__initialized[server.id] = true;

          saveState(state);
        } catch (error) {
          console.error(
            `[adm-feed] Could not process ${server.name}: ${error.message}`
          );
        }
      }
    } catch (error) {
      console.error('[adm-feed] Poll failed:', error.message);
    } finally {
      busy = false;
    }
  }

  console.log(
    `[adm-feed] Watching only the newest ADM file every ${POLL_MS / 1000}s (draining the previous active file once on rotation).`
  );

  void tick();
  setInterval(() => void tick(), POLL_MS).unref?.();
}

module.exports = {
  startAdmFeedWatcher,

  FEED_KEYS: [
    'kills',
    'hits',
    'infected',
    'connects',
    'disconnects',
    'online',
    'building',
    'dismantling',
    'place',
    'pack',
    'mount',
    'dismount',
    'flagraising',
    'flaglowering',
    'locations',
    'medical',
    'emotes',
    'other'
  ],

  findPlayerById,
  findPlayersByName
};