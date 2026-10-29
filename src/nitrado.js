'use strict';

// Nitrado API helpers for the DayZ server.
// Requires NITRADO_TOKEN in the project .env file
// and a numeric serviceId in servers.json.

const API_BASE = 'https://api.nitrado.net';

// --------------------------------------------------
// Shared API helpers
// --------------------------------------------------

function requireToken() {
  const token = process.env.NITRADO_TOKEN;

  if (!token) {
    throw new Error(
      'Missing NITRADO_TOKEN in the project .env file.'
    );
  }

  return token;
}

function requireServiceId(serviceId) {
  if (!/^\d+$/.test(String(serviceId || ''))) {
    throw new Error('A numeric Nitrado service ID is required.');
  }

  return String(serviceId);
}

function normalizeRemotePath(remotePath) {
  if (
    typeof remotePath !== 'string' ||
    !remotePath.trim()
  ) {
    throw new Error('A remote file path is required.');
  }

  let normalized = remotePath.trim().replace(/\\/g, '/');

  // Collapse duplicate slashes without damaging a leading slash.
  normalized = normalized.replace(/\/{2,}/g, '/');

  return normalized;
}

async function apiRequest(url, options = {}) {
  const response = await fetch(url, {
    dispatcher: undefined,
    ...options,
    headers: {
      Authorization: `Bearer ${requireToken()}`,
      Accept: 'application/json',
      ...(options.headers || {})
    },
    signal: options.signal || AbortSignal.timeout(20000)
  });

  const text = await response.text();

  let body;

  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }

  if (!response.ok) {
    const detail =
      body.message ||
      body.error ||
      body.raw ||
      text ||
      response.statusText;

    throw new Error(
      `Nitrado API HTTP ${response.status}: ${String(detail).slice(0, 1000)}`
    );
  }

  return body.data ?? body;
}

// --------------------------------------------------
// Gameserver status
// --------------------------------------------------

async function getServerStatus(serviceId) {
  serviceId = requireServiceId(serviceId);

  const result = await apiRequest(
    `${API_BASE}/services/${serviceId}/gameservers`
  );

  return result.gameserver ?? result;
}

// --------------------------------------------------
// Read/download a remote file
// --------------------------------------------------

async function readRemoteFile(serviceId, remotePath) {
  serviceId = requireServiceId(serviceId);
  remotePath = normalizeRemotePath(remotePath);

  const url = new URL(
    `${API_BASE}/services/${serviceId}/gameservers/file_server/download`
  );

  url.searchParams.set('file', remotePath);

  console.log(
    `[nitrado] Requesting download token for: ${remotePath}`
  );

  let result;

  try {
    result = await apiRequest(url.toString());

    console.log(
      '[nitrado] Download-token response keys:',
      Object.keys(result || {})
    );
  } catch (error) {
    console.error(
      `[nitrado] Download-token request failed: ${error.message}`
    );

    throw error;
  }

  const tokenInfo = result.token ?? result;

  if (!tokenInfo.url || !tokenInfo.token) {
    throw new Error(
      `Nitrado returned no usable download URL/token for ${remotePath}.`
    );
  }

  const downloadUrl = new URL(tokenInfo.url);

  downloadUrl.searchParams.set('token', tokenInfo.token);

  console.log('[nitrado] Downloading remote file...');

  let response;

  try {
    // The temporary URL has its own token.
    // Never send the Nitrado API bearer token to the download host.
    response = await fetch(downloadUrl.toString(), {
      signal: AbortSignal.timeout(30000)
    });
  } catch (error) {
    console.error(
      `[nitrado] File download request failed: ${error.message}`
    );

    throw error;
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');

    throw new Error(
      `Nitrado file download failed for ${remotePath}: ` +
      `HTTP ${response.status}` +
      (detail ? ` — ${detail.slice(0, 500)}` : '')
    );
  }

  const content = await response.text();

  console.log(
    `[nitrado] Remote file downloaded: ` +
    `${Buffer.byteLength(content, 'utf8')} bytes.`
  );

  return content;
}

// --------------------------------------------------
// Upload validation
// --------------------------------------------------

function validateUploadContent(remotePath, content) {
  const filename = remotePath.split('/').pop().toLowerCase();

  let parsed;

  try {
    parsed = JSON.parse(String(content));
  } catch (error) {
    throw new Error(
      `Refusing to upload invalid JSON to ${remotePath}: ${error.message}`
    );
  }

  if (filename === 'cfggameplay.json') {
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      !parsed.WorldsData ||
      !Array.isArray(
        parsed.WorldsData.playerRestrictedAreaFiles
      )
    ) {
      throw new Error(
        `Refusing to upload non-gameplay JSON to ${remotePath}. ` +
        'Expected WorldsData.playerRestrictedAreaFiles.'
      );
    }

    if (
      parsed.areaName ||
      parsed.PRABoxes ||
      parsed.safePositions3D
    ) {
      throw new Error(
        `Refusing to upload a teleport-area document to ${remotePath}.`
      );
    }
  }

  if (/^teleport_.*\.json$/i.test(filename)) {
    if (
      !parsed ||
      typeof parsed.areaName !== 'string' ||
      !Array.isArray(parsed.PRABoxes) ||
      !Array.isArray(parsed.safePositions3D)
    ) {
      throw new Error(
        `Refusing to upload non-teleport JSON to ${remotePath}.`
      );
    }
  }
}

// --------------------------------------------------
// Upload files
// --------------------------------------------------

async function uploadRemoteFile(serviceId, remotePath, content) {
  serviceId = requireServiceId(serviceId);
  remotePath = normalizeRemotePath(remotePath);

  if (!remotePath.startsWith('/games/')) {
    throw new Error(
      'Remote upload path must be an absolute Nitrado path ' +
      'beginning with /games/.'
    );
  }

  const slash = remotePath.lastIndexOf('/');

  if (slash < 0 || slash === remotePath.length - 1) {
    throw new Error(
      'Remote upload path must include a directory and filename.'
    );
  }

  validateUploadContent(remotePath, content);

  const directory = remotePath.slice(0, slash) || '/';
  const filename = remotePath.slice(slash + 1);

  console.log(
    `[nitrado] Upload target: ${remotePath} ` +
    `(${Buffer.byteLength(String(content), 'utf8')} bytes)`
  );

  const tokenResponse = await apiRequest(
    `${API_BASE}/services/${serviceId}/gameservers/file_server/upload`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        path: directory,
        file: filename
      })
    }
  );

  const upload = tokenResponse.token ?? tokenResponse;

  if (!upload.url || !upload.token) {
    throw new Error(
      `Nitrado did not return an upload token for ${remotePath}.`
    );
  }

  const response = await fetch(upload.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/binary',
      token: upload.token
    },
    body: content,
    signal: AbortSignal.timeout(30000)
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');

    throw new Error(
      `Nitrado file upload failed for ${remotePath}: ` +
      `HTTP ${response.status}` +
      (detail ? ` — ${detail.slice(0, 500)}` : '')
    );
  }

  console.log(`[nitrado] Upload completed: ${remotePath}`);

  return true;
}

async function writeRemoteFile(serviceId, remotePath, content) {
  return uploadRemoteFile(serviceId, remotePath, content);
}

async function writeTeleportAreaFile(
  serviceId,
  remotePath,
  content
) {
  const normalized = normalizeRemotePath(remotePath);

  if (
    !/^\/games\/.+\/Custom\/TELEPORT_[^/]+\.json$/i.test(normalized)
  ) {
    throw new Error(
      'Teleport JSON must be saved as its own file inside Custom. ' +
      `Path: ${remotePath}`
    );
  }

  let parsed;

  try {
    parsed = JSON.parse(String(content));
  } catch (error) {
    throw new Error(`Invalid teleport JSON: ${error.message}`);
  }

  if (
    !parsed ||
    typeof parsed.areaName !== 'string' ||
    !Array.isArray(parsed.PRABoxes) ||
    !Array.isArray(parsed.safePositions3D)
  ) {
    throw new Error(
      'Teleport JSON must contain areaName, PRABoxes, ' +
      'and safePositions3D.'
    );
  }

  return uploadRemoteFile(serviceId, normalized, content);
}

async function writeGameplayConfigFile(
  serviceId,
  remotePath,
  content
) {
  const normalized = normalizeRemotePath(remotePath);

  if (!normalized.toLowerCase().endsWith('/cfggameplay.json')) {
    throw new Error(
      'Gameplay config writer only accepts cfggameplay.json paths. ' +
      `Got: ${remotePath}`
    );
  }

  return uploadRemoteFile(serviceId, normalized, content);
}

// --------------------------------------------------
// Update effect-area configuration
// --------------------------------------------------

function requireRemoteFilePath(
  remotePath,
  serverName = 'selected server'
) {
  const normalized = normalizeRemotePath(remotePath);

  if (!normalized.toLowerCase().endsWith('.json')) {
    throw new Error(
      `effectAreaPath for ${serverName} must point to a .json file.`
    );
  }

  return normalized;
}

async function updateEffectAreaFile(
  serviceId,
  remotePathSetting,
  additions,
  serverName
) {
  const remotePath = requireRemoteFilePath(
    remotePathSetting,
    serverName
  );

  console.log(`[delivery] Reading Nitrado config: ${remotePath}`);

  const raw = await readRemoteFile(serviceId, remotePath);

  let config;

  try {
    config = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `The remote CfgEffectArea file is not valid JSON: ${error.message}`
    );
  }

  if (!config || !Array.isArray(config.Areas)) {
    throw new Error(
      'Remote CfgEffectArea JSON must contain an "Areas" array. ' +
      'No changes were uploaded.'
    );
  }

  if (!Array.isArray(additions)) {
    throw new Error('Effect-area additions must be an array.');
  }

  let added = 0;

  for (const entry of additions) {
    if (!entry || typeof entry.AreaName !== 'string') {
      console.warn(
        '[delivery] Skipping an effect-area entry with no valid AreaName.'
      );
      continue;
    }

    const alreadyThere = config.Areas.some(
      area => area?.AreaName === entry.AreaName
    );

    if (!alreadyThere) {
      config.Areas.push(entry);
      added++;
    }
  }

  if (added > 0) {
    const output = `${JSON.stringify(config, null, 4)}\n`;

    console.log(
      `[delivery] Uploading ${added} DPP_SHOP area ` +
      `entr${added === 1 ? 'y' : 'ies'} to Nitrado...`
    );

    await writeRemoteFile(serviceId, remotePath, output);
  } else {
    console.log(
      '[delivery] All entries already exist; no duplicate entries added.'
    );
  }

  return { remotePath, added };
}

// --------------------------------------------------
// Delete a remote file
// --------------------------------------------------

async function deleteRemoteFile(serviceId, remotePath) {
  serviceId = requireServiceId(serviceId);
  remotePath = normalizeRemotePath(remotePath);

  if (!remotePath.startsWith('/games/')) {
    throw new Error(
      'Refusing to delete an invalid remote path. ' +
      'Expected a path beginning with /games/.'
    );
  }

  const url =
    `${API_BASE}/services/${serviceId}/gameservers/file_server/delete`;

  const response = await fetch(url, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${requireToken()}`,
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      path: remotePath
    }).toString(),
    signal: AbortSignal.timeout(20000)
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Nitrado file delete HTTP ${response.status}: ` +
      `${text || response.statusText}`
    );
  }

  return true;
}

// --------------------------------------------------
// Normalize Nitrado directory-listing responses
// --------------------------------------------------

function normalizeDirectoryEntries(value, directory, out = []) {
  if (Array.isArray(value)) {
    for (const item of value) {
      normalizeDirectoryEntries(item, directory, out);
    }

    return out;
  }

  if (!value || typeof value !== 'object') {
    return out;
  }

  const name =
    typeof value.name === 'string'
      ? value.name.trim()
      : '';

  const originalPath =
    typeof value.path === 'string'
      ? value.path.trim().replace(/\\/g, '/')
      : '';

  const type = String(
    value.type || value.entry_type || value.kind || ''
  ).toLowerCase();

  const isDirectory =
    type.includes('dir') ||
    type === 'folder' ||
    type === 'directory';

  let normalizedEntry = { ...value };

  if (name && !isDirectory) {
    const hasFullAdmPath = /\.ADM$/i.test(originalPath);

    if (hasFullAdmPath) {
      normalizedEntry.path = originalPath.startsWith('/')
        ? originalPath
        : `/${originalPath}`;
    } else if (/\.ADM$/i.test(name)) {
      // Nitrado may return only the filename. Supply its directory
      // so the ADM watcher receives a complete remote path.
      const base = originalPath
        ? originalPath.replace(/\/$/, '')
        : directory.replace(/\/$/, '');

      const fullPath = originalPath && originalPath.endsWith(name)
        ? originalPath
        : `${base}/${name}`;

      normalizedEntry.path = fullPath.startsWith('/')
        ? fullPath
        : `/${fullPath}`;
    }
  }

  out.push(normalizedEntry);

  // Also inspect nested arrays/objects in case the API response
  // contains a wrapped entries structure.
  for (const [key, child] of Object.entries(value)) {
    if (
      child &&
      typeof child === 'object' &&
      key !== 'parent' &&
      key !== 'directory'
    ) {
      normalizeDirectoryEntries(child, directory, out);
    }
  }

  return out;
}

// --------------------------------------------------
// List files in a remote directory
// --------------------------------------------------

async function listRemoteDirectory(serviceId, directory, search) {
  serviceId = requireServiceId(serviceId);
  directory = normalizeRemotePath(directory);

  const url = new URL(
    `${API_BASE}/services/${serviceId}/gameservers/file_server/list`
  );

  url.searchParams.set('dir', directory);

  if (search) {
    url.searchParams.set('search', String(search));
  }

  console.log(
    `[nitrado] Listing directory: ${directory}` +
    (search ? ` (search=${search})` : '')
  );

  const result = await apiRequest(url.toString());

  console.log(
    '[nitrado][DEBUG] response keys:',
    Object.keys(result || {})
  );

  // Nitrado responses may wrap the file list in "entries".
  const entries = result.entries ?? result.files ?? result;

  const normalized = normalizeDirectoryEntries(
    entries,
    directory
  );

  // Keep the response shape useful for the ADM watcher, while
  // ensuring each ADM filename has a full path where possible.
  console.log(
    '[nitrado][DEBUG] normalized directory entries:',
    JSON.stringify(normalized, null, 2).slice(0, 12000)
  );

  return normalized;
}

// --------------------------------------------------
// Restart the server
// --------------------------------------------------

async function restartServer(serviceId) {
  serviceId = requireServiceId(serviceId);

  return apiRequest(
    `${API_BASE}/services/${serviceId}/gameservers/restart`,
    { method: 'POST' }
  );
}

// --------------------------------------------------
// Public functions used by the rest of the bot
// --------------------------------------------------

module.exports = {
  getServerStatus,
  readRemoteFile,
  writeRemoteFile,
  writeTeleportAreaFile,
  writeGameplayConfigFile,
  updateEffectAreaFile,
  listRemoteDirectory,
  deleteRemoteFile,
  restartServer
};