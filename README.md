# Battle Royale FPS — multiplayer server

These are the starter GitHub files for the Render **Web Service**.

## Files
- `server.js` — Node.js + Socket.IO server. Creates 5-character rooms, allows up to 2 players, and relays player positions.
- `package.json` — installs the server dependencies and provides the `npm start` command.

## Render settings
- Service type: **Web Service**
- Runtime/language: **Node**
- Build command: `npm install`
- Start command: `npm start`
- Instance plan: **Free** (for testing)

Render supplies the port automatically through `process.env.PORT`.

## Important current-stage limitations
This is the server foundation, not the finished multiplayer game. The existing HTML game has not yet been connected to it. The server currently supports room creation/joining, player position updates, player health/shield status, and shared bot positions. Your game HTML still needs a client-side Socket.IO connection and changes to display the other player and use the shared bot state. Until that client integration is done, the current game will still run as its original single-player game.

The server's bot movement is a basic shared placeholder; it does not yet synchronize bot shooting, damage, loot, chests, vehicles, building, storm damage, or match victory. Those systems need to be integrated and tested before the game is truly multiplayer.

## Socket events
Client -> server:
- `createRoom` with `{ name }`
- `joinRoom` with `{ roomCode, name }`
- `playerUpdate` with `{ x, y, z, yaw, pitch }`
- `playerVitals` with `{ health, shield, alive }`
- `leaveRoom`

Server -> client:
- `roomState` with `{ roomCode, players, bots }`
- `playerMoved` with the other player's updated position

Room creation/join callbacks return `{ ok, roomCode, playerId }` or `{ ok: false, error }`.
