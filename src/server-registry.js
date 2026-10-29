
const fs = require("node:fs");
const path = require("node:path");

const CONFIG_PATH = path.join(
  __dirname,
  "config",
  "servers.json"
);

function loadServers() {
  const raw = fs.readFileSync(CONFIG_PATH, "utf8");
  const config = JSON.parse(raw);

  if (!config || !Array.isArray(config.servers)) {
    throw new Error("config/servers.json must contain a servers array.");
  }

  const ids = new Set();
  const serviceIds = new Set();

  for (const server of config.servers) {
    if (!server || typeof server.id !== "string" ||
        !/^[a-z0-9-]+$/.test(server.id)) {
      throw new Error("Each server needs a valid unique id.");
    }

    if (ids.has(server.id)) {
      throw new Error(`Duplicate server id: ${server.id}`);
    }
    ids.add(server.id);

    if (typeof server.name !== "string" || !server.name.trim()) {
      throw new Error(`Server ${server.id} needs a name.`);
    }

    if (typeof server.enabled !== "boolean" ||
        typeof server.itemDeliveryEnabled !== "boolean") {
      throw new Error(`Server ${server.id} has invalid feature flags.`);
    }

    // Empty IDs are allowed during initial setup.
    if (server.serviceId !== "" &&
        !/^\d+$/.test(String(server.serviceId))) {
      throw new Error(`Server ${server.id} has an invalid serviceId.`);
    }

    if (server.serviceId !== "") {
      const serviceId = String(server.serviceId);
      if (serviceIds.has(serviceId)) {
        throw new Error(`Nitrado service ${serviceId} is assigned twice.`);
      }
      serviceIds.add(serviceId);
    }
  }

  return config.servers;
}

function listServers({ includeDisabled = false } = {}) {
  return loadServers()
    .filter(server => includeDisabled || server.enabled)
    .map(({ id, name, serviceId, enabled, itemDeliveryEnabled, admFilePath, admDirectory }) => ({
      id, name, serviceId: String(serviceId || ""), configured: serviceId !== "", enabled, itemDeliveryEnabled,
      admFilePath: admFilePath || "", admDirectory: admDirectory || ""
    }));
}

function getServer(serverId) {
  const server = loadServers().find(item => item.id === serverId);

  if (!server || !server.enabled) {
    throw new Error("Server not found or disabled.");
  }

  if (!server.serviceId) {
    throw new Error(`Nitrado service ID is not configured for ${server.id}.`);
  }

  return { ...server, serviceId: String(server.serviceId) };
}

module.exports = { listServers, getServer };
