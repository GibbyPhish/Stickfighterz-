# Stickdown Draft Fix

This build fixes the draft crash/lock caused when CPU slots are mixed with human slots.

## Render
Use this directory as the Render Root Directory if this folder is inside the repository:

`stickdown_online_mobile/stickdown_online`

Build command:
`npm install`

Start command:
`npm start`

## Draft behavior
- Only connected human clients participate in the unique-build snake draft.
- At most four humans get unique builds because there are four unique builds.
- CPU slots never block the human draft.
- If a client disconnects during its turn, the server safely skips the turn.
- After unique human picks are complete, every remaining fighter gets a balanced duplicate build.
- Invalid or out-of-turn draft requests return a visible error instead of crashing the server.
