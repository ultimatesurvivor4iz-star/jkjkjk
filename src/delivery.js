const { db } = require("./db");
const { updateEffectAreaFile } = require("./nitrado");

const getJob = db.prepare(`SELECT * FROM delivery_jobs WHERE purchase_id = ?`);
const updateCoordinates = db.prepare(`
  UPDATE delivery_jobs
  SET x = ?, y = ?, z = ?, error = NULL, updated_at = CURRENT_TIMESTAMP
  WHERE purchase_id = ?
`);
const recordError = db.prepare(`
  UPDATE delivery_jobs
  SET attempts = attempts + 1, error = ?, updated_at = CURRENT_TIMESTAMP
  WHERE purchase_id = ?
`);
const clearError = db.prepare(`
  UPDATE delivery_jobs
  SET error = NULL, updated_at = CURRENT_TIMESTAMP
  WHERE purchase_id = ?
`);

// Serialize read-modify-write operations so simultaneous orders cannot overwrite each other.
let fileUpdateQueue = Promise.resolve();
async function updateEffectAreaFileSerially(serviceId, remotePath, additions, serverName) {
  let release;
  const previous = fileUpdateQueue;
  fileUpdateQueue = new Promise(resolve => { release = resolve; });
  await previous;
  try {
    return await updateEffectAreaFile(serviceId, remotePath, additions, serverName);
  } finally {
    release();
  }
}

function validateCoordinates(coordinates) {
  if (!Array.isArray(coordinates) || coordinates.length !== 3 ||
      !coordinates.every(value => typeof value === "number" && Number.isFinite(value))) {
    throw new Error("Coordinates must be three finite numbers (X, Y, Z).");
  }
  if (coordinates.some(value => Math.abs(value) > 100000)) {
    throw new Error("One or more coordinates are outside the accepted range.");
  }
}

async function queueDelivery(order, server, item, quantity, coordinates) {
  if (!order || !Number.isSafeInteger(order.id) || order.id < 1) {
    throw new Error("Invalid purchase ID.");
  }
  if (!server || !/^\d+$/.test(String(server.serviceId || ""))) {
    throw new Error("This server has no valid Nitrado service ID.");
  }
  if (server.itemDeliveryEnabled !== true) {
    throw new Error(`Item delivery is disabled for ${server.name}. Enable itemDeliveryEnabled only after its Nitrado path is configured and tested.`);
  }
  if (!item || typeof item.itemType !== "string" || !/^[A-Za-z0-9_]+$/.test(item.itemType)) {
    throw new Error("Invalid DayZ item class (itemType).");
  }
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 10) {
    throw new Error("Quantity must be between 1 and 10.");
  }
  validateCoordinates(coordinates);

  updateCoordinates.run(coordinates[0], coordinates[1], coordinates[2], order.id);
  console.log(`[delivery] Order #${order.id}: ${item.itemType} x${quantity} for ${server.name}`);
  console.log(`[delivery] Requested position: X=${coordinates[0]}, Y=${coordinates[1]}, Z=${coordinates[2]}`);

  try {
    const additions = Array.from({ length: quantity }, (_, index) => ({
      AreaName: `DPP_SHOP_${require("node:crypto").createHash("sha256")
        .update(`usbotq-order-${order.id}-${index + 1}`)
        .digest("hex").slice(0, 32)}`,
      Type: item.itemType,
      Data: {
        Pos: [coordinates[0], coordinates[1], coordinates[2]],
        Radius: 1
      }
    }));

    const result = await updateEffectAreaFileSerially(server.serviceId, server.effectAreaPath, additions, server.name);
    clearError.run(order.id);
    console.log(`[delivery] Order #${order.id}: Nitrado configuration updated (${result.added} new entry/entries).`);
    console.log("[delivery] The server must load this config at startup. This bot does not restart the server automatically.");
    return { ...result, coordinates };
  } catch (error) {
    recordError.run(String(error.message || error).slice(0, 1000), order.id);
    console.error(`[delivery] Order #${order.id} failed: ${error.message || error}`);
    throw error;
  }
}

module.exports = { queueDelivery, getJob };
