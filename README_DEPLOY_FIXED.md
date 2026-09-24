# Stickdown Online – fixed deployment build

This build fixes the lobby/draft/map/match lifecycle bugs.

## What was fixed
- Match settings are applied immediately in the host lobby and rejected changes resync from the server.
- A map must be explicitly selected before Start Draft is enabled.
- Draft uses the approved 4 unique builds, with snake order alternating each round.
- Round transitions return to a new attribute draft so builds can change between rounds.
- Match Over has a New Match action that returns everyone to the lobby without destroying the room.
- Shared room URLs auto-join when they contain `?room=CODE`.
- Rooms in Match Over can accept new joiners so the same shared URL remains usable for a rematch.
- Frontend can use same-origin WebSocket hosting or an external server URL via `?server=https%3A%2F%2F...`.
- Mobile/desktop client-side controls remain per-device.

## Render
If this folder is the repository root, leave Render Root Directory blank. Use Build Command `npm install` and Start Command `npm start`.

## Netlify frontend
Deploy `public/` as the static site and run the Node server on Render. Set the server URL in the game's Connection panel. Share URLs will include the server address.


## Draft crash fix
This build fixes the server crash that occurred when a room had CPU slots during the draft. CPU slots never participate in the unique-build snake draft; connected humans get up to four unique picks, then all remaining fighter slots receive duplicate builds automatically.

Render root directory for this repository layout: `stickdown_online_mobile/stickdown_online`. Build: `npm install`. Start: `npm start`.
