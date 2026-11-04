const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ["websocket", "polling"]
});

const PORT = process.env.PORT || 3000;
const rooms = new Map();

app.get("/", (_req, res) => {
  res.type("text").send("Battle Royale multiplayer server is online.");
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, rooms: rooms.size });
});

function makeRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = Array.from({ length: 5 }, () =>
      alphabet[Math.floor(Math.random() * alphabet.length)]
    ).join("");
  } while (rooms.has(code));
  return code;
}

function makeBots() {
  return Array.from({ length: 10 }, (_, i) => ({
    id: `bot-${i + 1}`,
    x: Math.random() * 180 - 90,
    z: Math.random() * 180 - 90,
    health: 100,
    alive: true
  }));
}

function publicRoomState(room) {
  return {
    roomCode: room.code,
    players: Array.from(room.players.values()).map(player => ({
      id: player.id,
      name: player.name,
      x: player.x,
      y: player.y,
      z: player.z,
      yaw: player.yaw,
      pitch: player.pitch,
      health: player.health,
      shield: player.shield,
      alive: player.alive
    })),
    bots: room.bots.map(bot => ({ ...bot }))
  };
}

function emitRoomState(room) {
  io.to(room.code).emit("roomState", publicRoomState(room));
}

function cleanName(value) {
  const name = String(value || "Player").trim().slice(0, 16);
  return name || "Player";
}

function cleanNumber(value, fallback = 0, min = -260, max = 260) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

io.on("connection", socket => {
  socket.on("createRoom", (payload = {}, callback = () => {}) => {
    // A socket may only belong to one game room at a time.
    leaveCurrentRoom(socket);

    const code = makeRoomCode();
    const room = {
      code,
      players: new Map(),
      bots: makeBots(),
      createdAt: Date.now()
    };

    room.players.set(socket.id, {
      id: socket.id,
      name: cleanName(payload.name),
      x: 0, y: 0, z: 0,
      yaw: 0, pitch: 0,
      health: 100, shield: 100,
      alive: true
    });

    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;

    callback({ ok: true, roomCode: code, playerId: socket.id });
    emitRoomState(room);
  });

  socket.on("joinRoom", (payload = {}, callback = () => {}) => {
    leaveCurrentRoom(socket);

    const code = String(payload.roomCode || "").trim().toUpperCase();
    const room = rooms.get(code);

    if (!room) {
      callback({ ok: false, error: "That room code was not found." });
      return;
    }
    if (room.players.size >= 2) {
      callback({ ok: false, error: "That room is full (2 players maximum)." });
      return;
    }

    room.players.set(socket.id, {
      id: socket.id,
      name: cleanName(payload.name),
      x: 4, y: 0, z: 0,
      yaw: 0, pitch: 0,
      health: 100, shield: 100,
      alive: true
    });

    socket.join(code);
    socket.data.roomCode = code;

    callback({ ok: true, roomCode: code, playerId: socket.id });
    emitRoomState(room);
  });

  socket.on("playerUpdate", (data = {}) => {
    const room = getSocketRoom(socket);
    if (!room) return;

    const player = room.players.get(socket.id);
    if (!player || !player.alive) return;

    player.x = cleanNumber(data.x, player.x);
    player.y = cleanNumber(data.y, player.y, -20, 100);
    player.z = cleanNumber(data.z, player.z);
    player.yaw = cleanNumber(data.yaw, player.yaw, -1000, 1000);
    player.pitch = cleanNumber(data.pitch, player.pitch, -2, 2);

    // Send the updated position to the other player.
    socket.to(room.code).emit("playerMoved", {
      id: player.id,
      name: player.name,
      x: player.x, y: player.y, z: player.z,
      yaw: player.yaw, pitch: player.pitch
    });
  });

  socket.on("playerVitals", (data = {}) => {
    const room = getSocketRoom(socket);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player) return;
    player.health = cleanNumber(data.health, player.health, 0, 100);
    player.shield = cleanNumber(data.shield, player.shield, 0, 100);
    player.alive = data.alive !== false && player.health > 0;
    emitRoomState(room);
  });

  socket.on("leaveRoom", () => leaveCurrentRoom(socket));

  socket.on("disconnect", () => {
    leaveCurrentRoom(socket);
  });
});

function getSocketRoom(socket) {
  const code = socket.data.roomCode;
  return code ? rooms.get(code) : null;
}

function leaveCurrentRoom(socket) {
  const code = socket.data.roomCode;
  if (!code) return;

  const room = rooms.get(code);
  socket.leave(code);
  delete socket.data.roomCode;

  if (!room) return;
  room.players.delete(socket.id);

  if (room.players.size === 0) {
    rooms.delete(code);
  } else {
    emitRoomState(room);
  }
}

// Lightweight bot movement is maintained on the server so both clients
// can receive the same bot positions. Combat/health synchronization is a
// later integration step in the game client.
setInterval(() => {
  for (const room of rooms.values()) {
    const livingPlayers = Array.from(room.players.values()).filter(p => p.alive);
    if (livingPlayers.length === 0) continue;

    for (const bot of room.bots) {
      if (!bot.alive) continue;

      let target = livingPlayers[0];
      let bestDistance = Infinity;
      for (const player of livingPlayers) {
        const d = Math.hypot(player.x - bot.x, player.z - bot.z);
        if (d < bestDistance) {
          bestDistance = d;
          target = player;
        }
      }

      if (bestDistance > 4) {
        const dx = target.x - bot.x;
        const dz = target.z - bot.z;
        const length = Math.hypot(dx, dz) || 1;
        const speed = 1.6;
        bot.x += (dx / length) * speed * 0.1;
        bot.z += (dz / length) * speed * 0.1;
      }
    }

    emitRoomState(room);
  }
}, 100);

const server = httpServer.listen(PORT, () => {
  console.log(`Battle Royale multiplayer server listening on port ${PORT}`);
});

// Render sends SIGTERM when stopping/restarting a service.
process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
