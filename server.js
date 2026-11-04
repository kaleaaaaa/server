
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  transports: ["websocket", "polling"]
});

const PORT = process.env.PORT || 3000;
const rooms = new Map();
const MAX_PLAYERS = 4;

app.get("/", (_req, res) =>
  res.type("text").send("Battle Royale multiplayer server is online.")
);

app.get("/health", (_req, res) =>
  res.json({ ok: true, rooms: rooms.size })
);

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

function cleanName(v) {
  return String(v || "Player").trim().slice(0, 16) || "Player";
}

function number(v, fallback = 0, min = -260, max = 260) {
  const n = Number(v);
  return Number.isFinite(n)
    ? Math.max(min, Math.min(max, n))
    : fallback;
}

function makeBots() {
  return Array.from({ length: 10 }, (_, i) => ({
    id: `bot-${i + 1}`,
    x: Math.random() * 200 - 100,
    z: Math.random() * 200 - 100,
    health: 100,
    shield: 25,
    alive: true,
    fire: 1 + Math.random() * 2
  }));
}

function makeRoom(code) {
  return {
    code,
    players: new Map(),
    hostId: null,
    phase: "lobby",
    bots: makeBots(),
    botProjectiles: [],
    chests: [],
    worldReady: false,
    structures: [],
    stormRadius: 230,
    stormTime: 0,
    lastTick: Date.now(),
    createdAt: Date.now()
  };
}

function stateOf(room) {
  return {
    roomCode: room.code,
    hostId: room.hostId,
    phase: room.phase,
    maxPlayers: MAX_PLAYERS,
    players: [...room.players.values()].map(p => ({
      id: p.id,
      name: p.name,
      x: p.x,
      y: p.y,
      z: p.z,
      yaw: p.yaw,
      pitch: p.pitch,
      health: p.health,
      shield: p.shield,
      alive: p.alive,
      medkits: p.medkits,
      potions: p.potions,
      kills: p.kills,
      materials: p.materials
    })),
    bots: room.bots.map(b => ({ ...b })),
    chests: room.chests.map(c => ({ ...c })),
    structures: room.structures.map(s => ({ ...s })),
    stormRadius: room.stormRadius,
    stormTime: room.stormTime
  };
}

function emitState(room) {
  io.to(room.code).emit("roomState", stateOf(room));
}

function getRoom(socket) {
  return socket.data.roomCode
    ? rooms.get(socket.data.roomCode)
    : null;
}

function leaveRoom(socket) {
  const code = socket.data.roomCode;
  if (!code) return;

  const room = rooms.get(code);
  socket.leave(code);
  delete socket.data.roomCode;

  if (!room) return;

  room.players.delete(socket.id);

  if (!room.players.size) {
    rooms.delete(code);
  } else {
    if (room.hostId === socket.id) {
      room.hostId = room.players.keys().next().value;
      if (room.phase === "countdown") room.phase = "lobby";
    }
    emitState(room);
  }
}

function applyDamage(player, amount) {
  if (!player || !player.alive) return;

  let remaining = Math.max(0, amount);
  const absorbed = Math.min(player.shield, remaining);

  player.shield -= absorbed;
  remaining -= absorbed;
  player.health = Math.max(0, player.health - remaining);

  if (player.health <= 0) {
    player.alive = false;
  }
}

io.on("connection", socket => {

  socket.on("createRoom", (payload = {}, cb = () => {}) => {
    leaveRoom(socket);

    const code = makeRoomCode();
    const room = makeRoom(code);

    room.hostId = socket.id;
    room.players.set(socket.id, {
      id: socket.id,
      name: cleanName(payload.name),
      x: 0, y: 0, z: 0,
      yaw: 0, pitch: 0,
      health: 100, shield: 100,
      alive: true,
      medkits: 0, potions: 0,
      kills: 0, materials: 100,
      lastShot: 0
    });

    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;

    cb({
      ok: true,
      roomCode: code,
      playerId: socket.id,
      spawnX: 0,
      spawnZ: 0,
      isHost: true
    });

    emitState(room);
  });

  socket.on("joinRoom", (payload = {}, cb = () => {}) => {
    leaveRoom(socket);

    const code = String(payload.roomCode || "")
      .trim()
      .toUpperCase();

    const room = rooms.get(code);

    if (!room) {
      return cb({ ok: false, error: "That room code was not found." });
    }

    if (room.phase !== "lobby") {
      return cb({ ok: false, error: "That match has already started." });
    }

    if (room.players.size >= MAX_PLAYERS) {
      return cb({
        ok: false,
        error: "That squad is full (4 players maximum)."
      });
    }

    const spawnPoints = [
      { x: -8, z: 0 },
      { x: 8, z: 0 },
      { x: 0, z: -8 },
      { x: 0, z: 8 }
    ];

    const spawn = spawnPoints[room.players.size] || { x: 0, z: 0 };

    room.players.set(socket.id, {
      id: socket.id,
      name: cleanName(payload.name),
      x: spawn.x, y: 0, z: spawn.z,
      yaw: 0, pitch: 0,
      health: 100, shield: 100,
      alive: true,
      medkits: 0, potions: 0,
      kills: 0, materials: 100,
      lastShot: 0
    });

    socket.join(code);
    socket.data.roomCode = code;

    cb({
      ok: true,
      roomCode: code,
      playerId: socket.id,
      spawnX: spawn.x,
      spawnZ: spawn.z,
      isHost: socket.id === room.hostId
    });

    emitState(room);
  });

  socket.on("startMatch", (_data = {}, cb = () => {}) => {
    const room = getRoom(socket);

    if (!room) return cb({ ok: false, error: "Join a room first." });

    if (socket.id !== room.hostId) {
      return cb({
        ok: false,
        error: "Only the squad host can start the match."
      });
    }

    if (room.phase !== "lobby") {
      return cb({
        ok: false,
        error: "The match is already starting."
      });
    }

    room.phase = "countdown";
    room.startAt = Date.now() + 5000;

    io.to(room.code).emit("matchStarting", {
      startAt: room.startAt,
      players: room.players.size
    });

    emitState(room);
    cb({ ok: true });

    const scheduledStart = room.startAt;

    setTimeout(() => {
      const current = rooms.get(room.code);

      if (!current || current.phase !== "countdown" ||
          current.startAt !== scheduledStart) return;

      current.phase = "playing";

      io.to(current.code).emit("matchStarted", {
        startAt: scheduledStart,
        players: current.players.size
      });

      emitState(current);
    }, 5000);
  });

  socket.on("playerUpdate", data => {
    const room = getRoom(socket);
    const p = room?.players.get(socket.id);

    if (!p || !p.alive) return;

    p.x = number(data.x, p.x);
    p.y = number(data.y, p.y, -20, 100);
    p.z = number(data.z, p.z);
    p.yaw = number(data.yaw, p.yaw, -1000, 1000);
    p.pitch = number(data.pitch, p.pitch, -2, 2);

    socket.to(room.code).emit("playerMoved", {
      id: p.id,
      name: p.name,
      x: p.x, y: p.y, z: p.z,
      yaw: p.yaw, pitch: p.pitch,
      health: p.health,
      shield: p.shield,
      alive: p.alive
    });
  });

  socket.on("shootPlayer", data => {
    const room = getRoom(socket);
    const shooter = room?.players.get(socket.id);

    if (!room || !shooter || !shooter.alive) return;

    const now = Date.now();
    if (now - shooter.lastShot < 85) return;
    shooter.lastShot = now;

    const o = data.origin || {};
    const d = data.direction || {};

    const ox = number(o.x, shooter.x);
    const oy = number(o.y, shooter.y + 1.7, -20, 100);
    const oz = number(o.z, shooter.z);

    let dx = number(d.x, 0, -1, 1);
    let dy = number(d.y, 0, -1, 1);
    let dz = number(d.z, -1, -1, 1);

    const len = Math.hypot(dx, dy, dz) || 1;
    dx /= len;
    dy /= len;
    dz /= len;

    for (const target of room.players.values()) {
      if (target.id === shooter.id || !target.alive) continue;

      const vx = target.x - ox;
      const vy = (target.y + 1.2) - oy;
      const vz = target.z - oz;
      const along = vx * dx + vy * dy + vz * dz;

      if (along < 0 || along > 90) continue;

      const dist = Math.hypot(
        vx - dx * along,
        vy - dy * along,
        vz - dz * along
      );

      if (dist < 1.25) {
        applyDamage(target, 25);
        if (!target.alive) shooter.kills++;
        emitState(room);
        break;
      }
    }
  });

  socket.on("damageBot", data => {
    const room = getRoom(socket);
    const p = room?.players.get(socket.id);

    if (!room || !p || !p.alive) return;

    const bot = room.bots.find(b => b.id === String(data.id));
    if (!bot || !bot.alive) return;

    const amount = number(data.amount, 25, 0, 50);
    const absorbed = Math.min(bot.shield, amount);

    bot.shield -= absorbed;
    bot.health = Math.max(0, bot.health - (amount - absorbed));

    if (bot.health <= 0) {
      bot.alive = false;
      p.kills++;
    }

    emitState(room);
  });

  socket.on("registerWorld", data => {
    const room = getRoom(socket);
    if (!room || room.worldReady) return;

    const positions = Array.isArray(data.chests)
      ? data.chests.slice(0, 100)
      : [];

    room.chests = positions.map((pos, i) => ({
      id: i,
      x: number(pos.x, 0),
      z: number(pos.z, 0),
      opened: false,
      loot: null
    }));

    room.worldReady = true;
    emitState(room);
  });

  socket.on("openChest", data => {
    const room = getRoom(socket);
    const p = room?.players.get(socket.id);

    if (!room || !p || !p.alive) return;

    const chest = room.chests[Number(data.index)];

    if (!chest || chest.opened ||
        Math.hypot(p.x - chest.x, p.z - chest.z) > 5) return;

    chest.opened = true;
    chest.loot = Math.random() < 0.5 ? "medkit" : "potion";

    if (chest.loot === "medkit") p.medkits++;
    else p.potions++;

    emitState(room);

    socket.emit("gameNotice", {
      message: chest.loot === "medkit"
        ? "Found a MEDKIT! Press 4 to use it."
        : "Found a SHIELD POTION! Press 5 to use it."
    });
  });

  socket.on("useItem", data => {
    const room = getRoom(socket);
    const p = room?.players.get(socket.id);

    if (!room || !p || !p.alive) return;

    if (data.type === "medkit" && p.medkits > 0 && p.health < 100) {
      p.medkits--;
      p.health = Math.min(100, p.health + 40);
    } else if (data.type === "potion" && p.potions > 0 && p.shield < 100) {
      p.potions--;
      p.shield = Math.min(100, p.shield + 40);
    }

    emitState(room);
  });

  socket.on("buildStructure", data => {
    const room = getRoom(socket);
    const p = room?.players.get(socket.id);

    if (!room || !p || !p.alive || p.materials < 10) return;

    const type = data.type === "ramp" ? "ramp" : "wall";

    const structure = {
      id: `${socket.id}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      owner: socket.id,
      type,
      x: number(data.x, p.x),
      z: number(data.z, p.z),
      yaw: number(data.yaw, p.yaw, -1000, 1000)
    };

    p.materials -= 10;
    room.structures.push(structure);

    if (room.structures.length > 100) room.structures.shift();

    emitState(room);
  });

  socket.on("vehicleUpdate", data => {
    const room = getRoom(socket);
    const p = room?.players.get(socket.id);

    if (!room || !p || !p.alive) return;

    const type = String(data.type || "").slice(0, 16);
    if (!["truck", "sedan", "sports", "suv"].includes(type)) return;

    room.vehicles ||= {};
    room.vehicles[type] = {
      type,
      x: number(data.x, p.x),
      z: number(data.z, p.z),
      yaw: number(data.yaw, p.yaw, -1000, 1000),
      driver: socket.id
    };

    io.to(room.code).emit("vehicleMoved", room.vehicles[type]);
  });

  socket.on("playerVitals", data => {
    const room = getRoom(socket);
    const p = room?.players.get(socket.id);

    if (!room || !p) return;

    p.health = number(data.health, p.health, 0, 100);
    p.shield = number(data.shield, p.shield, 0, 100);
    p.alive = data.alive !== false && p.health > 0;

    emitState(room);
  });

  socket.on("leaveRoom", () => leaveRoom(socket));
  socket.on("disconnect", () => leaveRoom(socket));
});

// Bot AI and projectile simulation.
setInterval(() => {
  const now = Date.now();

  for (const room of rooms.values()) {
    const dt = Math.min(0.2, (now - room.lastTick) / 1000);
    room.lastTick = now;

    const living = [...room.players.values()].filter(p => p.alive);
    if (!living.length) continue;

    room.stormTime += dt;

    if (room.stormTime > 15) {
      room.stormRadius = Math.max(25, room.stormRadius - dt * 0.8);
    }

    for (const bot of room.bots) {
      if (!bot.alive) continue;

      let target = null;
      let best = Infinity;

      for (const p of living) {
        const d = Math.hypot(p.x - bot.x, p.z - bot.z);
        if (d < best) {
          best = d;
          target = p;
        }
      }

      if (!target) continue;

      if (best > 4) {
        const dx = target.x - bot.x;
        const dz = target.z - bot.z;
        const len = Math.hypot(dx, dz) || 1;
        bot.x += dx / len * 1.6 * dt;
        bot.z += dz / len * 1.6 * dt;
      }

      bot.fire -= dt;

      // Create a projectile instead of damaging the player instantly.
      if (best < 65 && bot.fire <= 0) {
        const origin = { x: bot.x, y: 1.5, z: bot.z };
        const targetPoint = {
          x: target.x,
          y: target.y + 1.1,
          z: target.z
        };

        const dx = targetPoint.x - origin.x;
        const dy = targetPoint.y - origin.y;
        const dz = targetPoint.z - origin.z;
        const length = Math.hypot(dx, dy, dz) || 1;
        const direction = {
          x: dx / length,
          y: dy / length,
          z: dz / length
        };

        room.botProjectiles.push({
          id: `botshot-${Date.now()}-${Math.floor(Math.random() * 1e9)}`,
          x: origin.x,
          y: origin.y,
          z: origin.z,
          vx: direction.x * 42,
          vy: direction.y * 42,
          vz: direction.z * 42,
          targetId: target.id,
          life: 3
        });

        io.to(room.code).emit("botProjectile", {
          origin,
          direction,
          speed: 42
        });

        bot.fire = 1.5 + Math.random() * 1.5;
      }

      if (Math.hypot(bot.x, bot.z) > room.stormRadius) {
        bot.health -= dt * 2;
        if (bot.health <= 0) {
          bot.health = 0;
          bot.alive = false;
        }
      }
    }

    // Move each projectile and damage only when it reaches its target.
    for (let i = room.botProjectiles.length - 1; i >= 0; i--) {
      const shot = room.botProjectiles[i];

      shot.x += shot.vx * dt;
      shot.y += shot.vy * dt;
      shot.z += shot.vz * dt;
      shot.life -= dt;

      const target = room.players.get(shot.targetId);

      if (target && target.alive) {
        const distance = Math.hypot(
          target.x - shot.x,
          (target.y + 1.1) - shot.y,
          target.z - shot.z
        );

        if (distance < 1.15) {
          applyDamage(target, 10);
          room.botProjectiles.splice(i, 1);
          continue;
        }
      }

      if (shot.life <= 0) {
        room.botProjectiles.splice(i, 1);
      }
    }

    for (const p of room.players.values()) {
      if (p.alive && Math.hypot(p.x, p.z) > room.stormRadius) {
        p._stormDamage = (p._stormDamage || 0) + dt;

        if (p._stormDamage >= 2) {
          applyDamage(p, 5);
          p._stormDamage = 0;
        }
      } else {
        p._stormDamage = 0;
      }
    }

    emitState(room);
  }
}, 100);

const server = httpServer.listen(PORT, () =>
  console.log(`Battle Royale multiplayer server listening on port ${PORT}`)
);

process.on("SIGTERM", () =>
  server.close(() => process.exit(0))
);
