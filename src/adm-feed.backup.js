
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

function parseChannels() {
  try {
    return JSON.parse(process.env.ADM_FEED_CHANNELS || '{}');
  } catch {
    console.error('[adm-feed] ADM_FEED_CHANNELS is invalid JSON.');
    return {};
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

  // Corrected player-activity regular expression.
  if (
    /\bis connecting\b|\bis connected\b|\bhas been disconnected\b|\bis disconnected\b|PlayerList|#####/i.test(line)
  ) {
    return 'players';
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

function makeMessage(serverName, type, line) {
  const labels = {
    kills: '☠️ Kill / Death',
    hits: '🎯 Player Hit',
    infected: '🧟 Infected',
    players: '👥 Player Activity',
    locations: '📍 Position Record',
    medical: '🩺 Medical',
    emotes: '🕺 Emote',
    other: '📋 Server Event'
  };

  const safe = line.replace(/```/g, "'''").slice(0, 900);

  const embed = {
    color: type === 'hits' ? 0xE67E22 : 0xC9A227,
    title: `${labels[type] || 'ADM Event'} • ${serverName}`.slice(0, 256),
    description: `\`\`\`${safe}\`\`\``,
    footer: { text: FOOTER_TEXT },
    timestamp: new Date().toISOString()
  };

  const message = { embeds: [embed] };

  if (fs.existsSync(LOGO_PATH)) {
    embed.thumbnail = { url: `attachment://${LOGO_FILENAME}` };
    message.files = [{
      attachment: LOGO_PATH,
      name: LOGO_FILENAME
    }];
  }

  return message;
}

function linesOf(text) {
  return String(text)
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter(Boolean);
}

function timestampFromAdmPath(value) {
  const base = path.posix.basename(String(value || ''));

  const match = base.match(
    /^DayZServer_PS4_x64_(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})\.ADM$/i
  );

  if (!match) return null;

  const [, year, month, day, hour, minute, second] = match;

  return Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second)
  );
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

  const timestamp = timestampFromAdmPath(normalizedPath || name);

  if (
    isFile &&
    normalizedPath &&
    !normalizedPath.includes('*') &&
    timestamp !== null &&
    /\.ADM$/i.test(normalizedPath)
  ) {
    out.push({
      path: normalizedPath.startsWith('/')
        ? normalizedPath
        : `/${normalizedPath}`,
      timestamp,
      modifiedAt: Number(
        value.modified_at ||
        value.modifiedAt ||
        value.created_at ||
        0
      )
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
  for (const file of listings) unique.set(file.path, file);

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
  for (let n = Math.min(oldLines.length, newLines.length, TAIL_LINES); n > 0; n--) {
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

  return Object.values(getLatestLocations(serverId))
    .filter(
      player =>
        String(player.playerName || '').trim().toLocaleLowerCase() === wanted
    );
}

function startAdmFeedWatcher(client, listServers) {
  const channels = parseChannels();
  const state = loadState();

  let busy = false;

  async function processFile(server, remotePath, isNewerFile, firstScan) {
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

    // On first startup, baseline existing logs to avoid replaying old events.
    if (!previous && firstScan) {
      previous = {
        lines: current.slice(-TAIL_LINES),
        totalLines: current.length,
        locations: {},
        seen: {}
      };

      for (const line of current) {
        const position = parsePosition(line);
        if (position) previous.locations[position.playerId] = position;
      }

      state[key] = previous;
      console.log(`[adm-feed] Baseline established; historical lines skipped.`);
      return;
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
        if (position) previous.locations[position.playerId] = position;
      }

      state[key] = previous;
      console.log(
        `[adm-feed] Older log baselined without replay: ${path.posix.basename(remotePath)}`
      );
      return;
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

    for (const line of fresh) {
      const position = parsePosition(line);
      if (position) previous.locations[position.playerId] = position;
    }

    const batch = fresh.slice(0, MAX_LINES_PER_POLL);
    const typeCounts = {};
    let classified = 0;
    let sent = 0;

    for (let i = 0; i < batch.length; i++) {
      const line = batch[i];
      const lineNumber = freshStartIndex + i;
      const type = classify(line);
      if (!type) continue;

      classified++;
      typeCounts[type] = (typeCounts[type] || 0) + 1;

      const eventId = crypto
        .createHash('sha256')
        .update(`${server.id}\n${remotePath}\n${lineNumber}\n${line}`)
        .digest('hex');

      if (previous.seen[eventId]) continue;

      const channelId = channels[`${server.id}.${type}`] || channels[type];
      if (!channelId) continue;

      const channel = await client.channels.fetch(String(channelId)).catch(() => null);

      if (!channel || !channel.isTextBased() || typeof channel.send !== 'function') {
        console.warn(`[adm-feed] Invalid ${type} channel: ${channelId}`);
        continue;
      }

      try {
        await channel.send(makeMessage(server.name, type, line));
        previous.seen[eventId] = 1;
        sent++;
      } catch (error) {
        console.error(`[adm-feed] Discord send failed: ${error.message}`);
      }
    }

    // Preserve unprocessed lines for the next poll.
    const remaining = fresh.slice(batch.length);

    if (remaining.length) {
      previous.totalLines = current.length - remaining.length;
      previous.lines = current.slice(0, previous.totalLines).slice(-TAIL_LINES);
    } else {
      previous.totalLines = current.length;
      previous.lines = current.slice(-TAIL_LINES);
    }

    previous.updatedAt = new Date().toISOString();
    previous.seen = Object.fromEntries(
      Object.entries(previous.seen).slice(-MAX_SEEN)
    );

    console.log(
      `[adm-feed] ${server.name}/${path.posix.basename(remotePath)}: ` +
      `fresh=${fresh.length}, classified=${classified}, sent=${sent}, ` +
      `types=${JSON.stringify(typeCounts)}.`
    );
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
          const previousKnown = new Set(state.__knownPaths?.[server.id] || []);
          const previousNewestTimestamp = Number(
            state.__newestTimestamp?.[server.id] || 0
          );

          const newestPath = paths[0];
          const newestTimestamp = timestampFromAdmPath(newestPath) || 0;

          state.__paths ||= {};
          state.__paths[server.id] = newestPath;

          for (const remotePath of paths) {
            const timestamp = timestampFromAdmPath(remotePath) || 0;
            const isKnown = previousKnown.has(remotePath);

            const isNewerFile =
              !isKnown &&
              timestamp > previousNewestTimestamp &&
              remotePath === newestPath;

            await processFile(server, remotePath, isNewerFile, firstScan);
          }

          state.__knownPaths ||= {};
          state.__knownPaths[server.id] = [
            ...new Set([...previousKnown, ...paths])
          ];

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
    `[adm-feed] Watching all discovered ADM files every ${POLL_MS / 1000}s.`
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
    'players',
    'locations',
    'medical',
    'emotes',
    'other'
  ],
  findPlayerById,
  findPlayersByName
};
