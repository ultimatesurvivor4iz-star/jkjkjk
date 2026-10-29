
const fs = require("node:fs");
const path = require("node:path");

const xmlPath = path.join(__dirname, "..", "types.xml");
const pricesPath = path.join(__dirname, "..", "prices.txt");
const outputPath = path.join(__dirname, "..", "src", "shop.json");

const DEFAULT_PRICE = 100;

if (!fs.existsSync(xmlPath)) {
  console.error("Cannot find types.xml in your bot folder.");
  process.exit(1);
}

if (!fs.existsSync(pricesPath)) {
  console.error("Cannot find prices.txt in your bot folder.");
  process.exit(1);
}

const xml = fs.readFileSync(xmlPath, "utf8");
const pricesText = fs.readFileSync(pricesPath, "utf8");

// Load category prices from prices.txt.
// Format: category=price
const categoryPrices = new Map();

for (const line of pricesText.split(/\r?\n/)) {
  const trimmed = line.trim();

  if (!trimmed || trimmed.startsWith("#")) continue;

  const separator = trimmed.indexOf("=");
  if (separator === -1) continue;

  const category = trimmed.slice(0, separator).trim().toLowerCase();
  const priceText = trimmed.slice(separator + 1).trim();
  const price = Number(priceText);

  if (
    category &&
    priceText !== "" &&
    Number.isFinite(price) &&
    price >= 0
  ) {
    categoryPrices.set(category, price);
  }
}

// Read item definitions from DayZ types.xml.
const items = [];
const seen = new Set();

for (const match of xml.matchAll(
  /<type\b([^>]*)>([\s\S]*?)<\/type>/gi
)) {
  const attributes = match[1];
  const body = match[2];

  const nameMatch = attributes.match(
    /\bname\s*=\s*["']([^"']+)["']/i
  );

  if (!nameMatch) continue;

  const className = nameMatch[1].trim();

  if (!/^[A-Za-z0-9_]+$/.test(className)) continue;

  // Ignore map/building objects and static objects.
  if (/^(Land_|StaticObj_)/i.test(className)) continue;

  if (seen.has(className)) continue;

  // Skip types explicitly marked as non-spawnable.
  const nominal = body.match(
    /<nominal>\s*(-?\d+)\s*<\/nominal>/i
  );

  const lifetime = body.match(
    /<lifetime>\s*(-?\d+)\s*<\/lifetime>/i
  );

  if (nominal && Number(nominal[1]) <= 0) continue;
  if (lifetime && Number(lifetime[1]) <= 0) continue;

  // Read the item's category from XML.
  const categoryMatch = body.match(
    /<category\b[^>]*\bname\s*=\s*["']([^"']+)["'][^>]*\/?>/i
  );

  const category = categoryMatch
    ? categoryMatch[1].trim().toLowerCase()
    : "";

  // Use the category price, or the default if not configured.
  const price = categoryPrices.has(category)
    ? categoryPrices.get(category)
    : DEFAULT_PRICE;

  seen.add(className);

  items.push({
  id: className.toLowerCase(),
  name: className,
  price,
  category,
  itemType: className,
  deliveryMode: "manual"
});
}

if (items.length === 0) {
  console.error("No items found. Check your types.xml file.");
  process.exit(1);
}

// Back up the existing catalogue before overwriting it.
if (fs.existsSync(outputPath)) {
  fs.copyFileSync(outputPath, outputPath + ".backup");
  console.log("Previous catalogue backed up.");
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });

fs.writeFileSync(
  outputPath,
  JSON.stringify(items, null, 2) + "\n",
  "utf8"
);

console.log(`Imported ${items.length} items into src/shop.json`);
console.log(`Default price: ${DEFAULT_PRICE} coins`);
console.log("Category prices loaded from prices.txt");
console.log("Excluded prefixes: Land_, StaticObj_");
console.log("Delivery remains manual; no server files were changed.");
