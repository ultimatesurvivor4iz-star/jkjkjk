# USautobot delivery patch (types.xml excluded)

This patch updates the bot to write order entries into the existing custom `Areas` array in the configured CfgEffectArea JSON file on Nitrado. It preserves all other JSON data, including existing contaminated areas and `SafePositions`.

## Included changes

- `src/index.js`: fixes slash-option ordering; reads X/Y/Z; logs orders; calls delivery after purchase; reports Nitrado upload errors to Discord.
- `src/db.js`: safely adds nullable X/Y/Z columns to existing `delivery_jobs` tables without deleting existing records.
- `src/delivery.js`: writes one `DPP_SHOP_<32 hex chars>` entry per quantity, with the requested item class and coordinates; serializes writes to avoid concurrent lost updates.
- `src/nitrado.js`: adds Nitrado file download/upload-token helpers and safely updates the configured remote JSON file.
- `src/config/servers.json`: stores an independent `effectAreaPath` for each of the five Nitrado services; delivery remains enabled only for `+99LOOT` until the other servers are configured and tested.
- `.env.example`: documents the additional required remote file path setting.

## Before running

1. Back up the existing project and the remote CfgEffectArea file.
2. Copy the included files into the same relative locations in your project, overwriting those files only.
3. In `src/config/servers.json`, fill in each server's `effectAreaPath` with that specific server's exact full remote path to its existing CfgEffectArea JSON file, as shown in that server's Nitrado file browser. Paths can differ by map or mission folder. Do not copy a guessed path. Keep your real `NITRADO_TOKEN` private.
4. Make sure `NITRADO_TOKEN` is a Nitrado API token with permission to read and write the service's files.
5. Stop the bot and start it from the project root with `npm start` (or from `src` with `node index.js`).
6. Place one low-risk test order with known coordinates and quantity 1. Confirm PowerShell says it read and uploaded the file, then re-open the file in Nitrado and verify a new `DPP_SHOP_...` entry appears at the expected position.
7. Restart the game server manually when safe. This patch deliberately does not restart the server automatically for each purchase.

## Important limitations

- This implements the file-update path matching the custom entry structure supplied by you. It cannot independently prove that your server's custom DPP_SHOP mechanism will process every vanilla item class; verify with one test item.
- Each quantity creates a separate entry at the same coordinates. For quantity greater than 1, consider a small position offset if the items overlap.
- Existing orders that were created before this patch do not have saved coordinates. Place a new test order after installing it.
- If the Nitrado upload fails after purchase creation, the purchase remains recorded and charged, with an error in the delivery job and console. Check the error before retrying to avoid confusion.
- No `.env`, database, `types.xml`, or credentials are included in this patch.
