# Teleport shop and restart scheduler

## Included

- `/buy item` keeps the existing item delivery workflow.
- `/buy teleport` creates a unique `Custom/TELEPORT_....json` restricted-area file and registers it in `WorldsData.playerRestrictedAreaFiles` in `cfggameplay.json`.
- Fixed PRA box size `[2, 1.5, 2]` and rotation `[90, 0, 0]`.
- End coordinates are written to `safePositions3D`; start coordinates are written to `PRABoxes`.
- Purchases are persisted in SQLite. A pending teleport activates after the next bot-managed restart; its timer then runs for `resets * 2 hours - 30 minutes`.
- Expired config references and files are removed before a managed restart. Because DayZ loads these settings at startup, a live server can keep an already-loaded area until it restarts.
- Restart control is OFF by default. Set `restartManagementEnabled: true` for `dayz-5` in `src/config/servers.json` AND `NITRADO_MANAGED_RESTARTS=true` only after disabling Nitrado's existing scheduled restarts. The scheduler targets even-hour UTC times.

## Before enabling

1. Back up the server's existing `cfggameplay.json`.
2. Verify that `/games/ni8985720_4/ftproot/dayzps_missions/dayzOffline.chernarusplus/cfggameplay.json` is the correct path for this server.
3. Verify the `Custom` directory exists in the mission folder.
4. Test the Nitrado file-delete and restart permissions with a non-production/test server if possible.
5. Keep `restartManagementEnabled: false` and `NITRADO_MANAGED_RESTARTS=false` until you have manually disabled Nitrado's scheduled restarts; then enable both. Running both schedules can cause duplicate restarts.
6. Use `npm start`. This project registers commands when the bot logs in.

## Operational note

The code intentionally preserves the existing economy behavior where insufficient-balance rejection is disabled for testing. The restart scheduler only manages `dayz-5` and is disabled unless explicitly enabled in `.env`.
