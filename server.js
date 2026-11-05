
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  transports: ["websocket", "polling"]
});

const PORT = process.env.PORT || 3000;
const rooms = new Map();
const ADMIN_OWNER_NAME = "kale";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const crypto = require("crypto");
const DEFAULT_MAX_PLAYERS = 4;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false }
    })
  : null;
if (!supabase) console.warn("Supabase is not configured. Player progression saving is disabled until SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set.");

const XP_PER_LEVEL = 500;
function profileNameKey(value) {
  return cleanName(value).normalize("NFKC").toLocaleLowerCase("en-US");
}
function profileView(row, fallbackName = "Player") {
  const totalXp = Math.max(0, Number(row?.total_xp) || 0);
  return {
    name: row?.display_name || fallbackName,
    totalXp,
    level: Math.floor(totalXp / XP_PER_LEVEL) + 1,
    xp: totalXp % XP_PER_LEVEL,
    xpToNext: XP_PER_LEVEL,
    kills: Number(row?.total_kills) || 0,
    wins: Number(row?.total_wins) || 0,
    matches: Number(row?.matches_played) || 0
  };
}

async function loadPlayerProfile(name) {
  if (!supabase) throw new Error("Supabase is not configured on the Render server yet.");
  const displayName = cleanName(name);
  const { data, error } = await supabase
    .from("player_profiles")
    .select("display_name,total_xp,total_kills,total_wins,matches_played")
    .eq("name_key", profileNameKey(displayName))
    .maybeSingle();
  if (error) throw error;
  return { found: !!data, profile: profileView(data, displayName) };
}

async function awardMatchProgress(room) {
  if (!supabase || !room || room.mode === "ffa" || room.progressAwarded) return;
  room.progressAwarded = true;
  await Promise.all([...room.players.values()].map(async player => {
    const won = room.mode === "1v1"
      ? room.outcome?.winner === "player" && room.outcome.winnerId === player.id
      : room.outcome?.winner === "squad";
    const earnedXp = Math.max(0, Number(player.matchXp) || 0) + 100 + (won ? 500 : 0);
    try {
      const { data, error } = await supabase.rpc("award_player_progress", {
        p_name_key: profileNameKey(player.name),
        p_display_name: cleanName(player.name),
        p_xp: earnedXp,
        p_kills: Math.max(0, Number(player.matchKills) || 0),
        p_wins: won ? 1 : 0,
        p_matches: 1
      });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      io.to(player.id).emit("profileUpdated", {
        ...profileView(row, player.name), earnedXp, won
      });
    } catch (error) {
      console.error("Could not save progression for", player.name, error.message);
      io.to(player.id).emit("gameNotice", { message: "Progress could not be saved. Check the server's Supabase settings." });
    }
  }));
}

async function awardFFAPlayerKill(player) {
  if (!supabase || !player) return;
  const earnedXp = 100;
  try {
    const { data, error } = await supabase.rpc("award_player_progress", {
      p_name_key: profileNameKey(player.name),
      p_display_name: cleanName(player.name),
      p_xp: earnedXp,
      p_kills: 1,
      p_wins: 0,
      p_matches: 0
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    io.to(player.id).emit("profileUpdated", {
      ...profileView(row, player.name), earnedXp, won: false
    });
  } catch (error) {
    console.error("Could not save Free For All kill for", player.name, error.message);
    io.to(player.id).emit("gameNotice", { message: "Your Free For All kill could not be saved to progression." });
  }
}

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

function makeBots(mode = "squad") {
  if (mode === "1v1" || mode === "ffa") return [];
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

function makeRoom(code, payload = {}) {
  const mode = payload.mode === "1v1" ? "1v1" : payload.mode === "ffa" ? "ffa" : "squad";
  return {
    code,
    serverName: String(payload.serverName || "New Server").trim().slice(0, 28) || "New Server",
    mode,
    maxPlayers: mode === "1v1" ? 2 : mode === "ffa" ? 10 : DEFAULT_MAX_PLAYERS,
    outcome: null,
    progressAwarded: false,
    players: new Map(),
    hostId: null,
    phase: "lobby",
    bots: makeBots(mode),
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
    serverName: room.serverName,
    mode: room.mode,
    maxPlayers: room.maxPlayers,
    outcome: room.outcome,
    hostId: room.hostId,
    phase: room.phase,
    maxPlayers: room.maxPlayers,
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
      score: p.score || 0,
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
  broadcastServerList();
}
function publicServerList() {
  return [...rooms.values()].map(room => ({
    id: room.code, name: room.serverName, mode: room.mode,
    players: room.players.size, maxPlayers: room.maxPlayers, phase: room.phase
  }));
}
function broadcastServerList() { io.emit("serverList", publicServerList()); }

function shotBlockedByBuild(room, ox, oy, oz, tx, ty, tz) {
  const segmentHitsBox = (a, b, half) => {
    const d = { x:b.x-a.x, y:b.y-a.y, z:b.z-a.z };
    let lo = 0, hi = 1;
    for (const [o,v,h] of [[a.x,d.x,half.x],[a.y,d.y,half.y],[a.z,d.z,half.z]]) {
      if (Math.abs(v) < 1e-8) { if (o < -h || o > h) return false; }
      else {
        let t1=(-h-o)/v, t2=(h-o)/v;
        if (t1>t2) [t1,t2]=[t2,t1];
        lo=Math.max(lo,t1); hi=Math.min(hi,t2);
        if (lo>hi) return false;
      }
    }
    return lo >= 0 && lo <= 1 && hi >= lo;
  };
  for (const structure of room.structures) {
    const yaw = Number(structure.yaw) || 0;
    const c=Math.cos(yaw), s=Math.sin(yaw);
    const wallLocal = (p) => {
      const dx=p.x-structure.x, dz=p.z-structure.z;
      return { x:dx*c-dz*s, y:p.y-1.8, z:dx*s+dz*c };
    };
    const rampLocal = (p) => {
      const dx=p.x-structure.x, dz=p.z-structure.z;
      const x=dx*c-dz*s, worldZ=dx*s+dz*c;
      const y=p.y-1.4, z=worldZ+3.25;
      const slope=Math.atan2(2.8,6.5);
      return { x, y:y*Math.cos(slope)+z*Math.sin(slope), z:-y*Math.sin(slope)+z*Math.cos(slope) };
    };
    const a={x:ox,y:oy,z:oz}, b={x:tx,y:ty,z:tz};
    if (structure.type === "ramp") {
      if (segmentHitsBox(rampLocal(a),rampLocal(b),{x:2.5,y:0.16,z:Math.hypot(6.5,2.8)/2})) return true;
    } else {
      if (segmentHitsBox(wallLocal(a),wallLocal(b),{x:3,y:1.8,z:0.2})) return true;
    }
  }
  return false;
}

function checkOutcome(room) {
  if (!room || room.mode === "ffa" || room.outcome || room.phase !== "playing") return;
  const living = [...room.players.values()].filter(p => p.alive);
  if (room.mode === "1v1") {
    const winner = [...room.players.values()].find(p => (p.score || 0) >= 10);
    if (winner) room.outcome = { winner: "player", winnerId: winner.id, score: winner.score, targetScore: 10 };
  } else {
    if (living.length === 0) room.outcome = { winner: "bots" };
    else if (room.bots.every(b => !b.alive)) room.outcome = { winner: "squad" };
  }
  if (room.outcome) {
    io.to(room.code).emit("matchEnded", room.outcome);
    emitState(room);
    void awardMatchProgress(room);
  }
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
  if (room.hostId === socket.id) room.hostId = room.players.keys().next().value || null;
  if (!room.players.size) { rooms.delete(code); broadcastServerList(); }
  else { checkOutcome(room); emitState(room); }
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

function playerById(room, id) {
  return room.players.get(id);
}

function isAdmin(socket) {
  return socket.data.adminAuthenticated === true &&
    String(socket.data.playerName || "").toLowerCase() === ADMIN_OWNER_NAME;
}

function safePasswordMatch(candidate) {
  if (!ADMIN_PASSWORD || typeof candidate !== "string") return false;
  const expected = Buffer.from(ADMIN_PASSWORD, "utf8");
  const supplied = Buffer.from(candidate, "utf8");
  return expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
}

function adminSnapshot() {
  return {
    rooms: [...rooms.values()].map(room => ({
      code: room.code,
      name: room.serverName,
      mode: room.mode,
      phase: room.phase,
      players: [...room.players.values()].map(p => ({
        id: p.id, name: p.name, kills: p.kills || 0,
        score: p.score || 0, health: p.health, shield: p.shield,
        alive: p.alive
      })),
      maxPlayers: room.maxPlayers,
      createdAt: room.createdAt
    }))
  };
}

io.on("connection", socket => {

  socket.on("getProfile", async (payload = {}, cb = () => {}) => {
    const name = cleanName(payload.name);
    socket.data.playerName = name;
    if (!supabase) return cb({ ok: false, error: "Profile database is not connected yet. Finish the Supabase setup first." });
    try {
      const result = await loadPlayerProfile(name);
      cb({ ok: true, ...result });
    } catch (error) {
      console.error("Profile lookup failed:", error.message);
      cb({ ok: false, error: "Could not load this profile. Check the Supabase table setup." });
    }
  });

  socket.on("adminLogin", (payload = {}, cb = () => {}) => {
    const submittedName = cleanName(payload.name);
    const identityName = socket.data.playerName || submittedName;
    const now = Date.now();
    const attempts = socket.data.adminLoginAttempts || { count: 0, since: now };
    if (now - attempts.since > 10 * 60 * 1000) {
      attempts.count = 0;
      attempts.since = now;
    }
    if (attempts.count >= 5) {
      socket.data.adminLoginAttempts = attempts;
      return cb({ ok: false, error: "Too many attempts. Wait 10 minutes and try again." });
    }
    if (identityName.toLowerCase() !== ADMIN_OWNER_NAME ||
        submittedName.toLowerCase() !== ADMIN_OWNER_NAME ||
        !safePasswordMatch(payload.password)) {
      attempts.count++;
      socket.data.adminLoginAttempts = attempts;
      socket.data.adminAuthenticated = false;
      return cb({ ok: false, error: "Admin access denied." });
    }
    socket.data.playerName = ADMIN_OWNER_NAME;
    socket.data.adminAuthenticated = true;
    socket.data.adminLoginAttempts = { count: 0, since: now };
    cb({ ok: true, snapshot: adminSnapshot() });
  });

  socket.on("adminGetSnapshot", (_payload = {}, cb = () => {}) => {
    if (!isAdmin(socket)) return cb({ ok: false, error: "Admin authentication required." });
    cb({ ok: true, snapshot: adminSnapshot() });
  });

  socket.on("adminKickPlayer", (payload = {}, cb = () => {}) => {
    if (!isAdmin(socket)) return cb({ ok: false, error: "Admin authentication required." });
    const targetId = String(payload.playerId || "");
    let targetSocket = null;
    for (const room of rooms.values()) {
      if (room.players.has(targetId)) {
        targetSocket = io.sockets.sockets.get(targetId);
        break;
      }
    }
    if (!targetSocket) return cb({ ok: false, error: "That player is no longer online." });
    targetSocket.emit("adminKicked", { message: "You were removed from the server by an administrator." });
    leaveRoom(targetSocket);
    cb({ ok: true });
    io.emit("adminSnapshotChanged");
  });

  socket.on("adminEndMatch", (payload = {}, cb = () => {}) => {
    if (!isAdmin(socket)) return cb({ ok: false, error: "Admin authentication required." });
    const room = rooms.get(String(payload.roomCode || "").toUpperCase());
    if (!room) return cb({ ok: false, error: "Server not found." });
    if (room.phase !== "playing" && room.phase !== "countdown") {
      return cb({ ok: false, error: "That server does not have an active match." });
    }
    room.phase = "lobby";
    room.outcome = null;
    room.startAt = null;
    for (const player of room.players.values()) {
      player.alive = true;
      player.health = 100;
      player.shield = 100;
      io.to(player.id).emit("adminMatchEnded", { message: "The match was ended by an administrator." });
    }
    emitState(room);
    cb({ ok: true });
    io.emit("adminSnapshotChanged");
  });

  socket.on("adminCloseServer", (payload = {}, cb = () => {}) => {
    if (!isAdmin(socket)) return cb({ ok: false, error: "Admin authentication required." });
    const room = rooms.get(String(payload.roomCode || "").toUpperCase());
    if (!room) return cb({ ok: false, error: "Server not found." });
    for (const player of [...room.players.values()]) {
      const targetSocket = io.sockets.sockets.get(player.id);
      if (targetSocket) {
        targetSocket.emit("adminRoomClosed", { message: "This server was closed by an administrator." });
        leaveRoom(targetSocket);
      }
    }
    rooms.delete(room.code);
    broadcastServerList();
    cb({ ok: true });
    io.emit("adminSnapshotChanged");
  });

  socket.on("adminBroadcast", (payload = {}, cb = () => {}) => {
    if (!isAdmin(socket)) return cb({ ok: false, error: "Admin authentication required." });
    const message = String(payload.message || "").trim().slice(0, 180);
    if (!message) return cb({ ok: false, error: "Enter an announcement first." });
    io.emit("adminAnnouncement", { message, from: ADMIN_OWNER_NAME });
    cb({ ok: true });
  });

  socket.on("adminGrantXp", async (payload = {}, cb = () => {}) => {
    if (!isAdmin(socket)) return cb({ ok: false, error: "Admin authentication required." });
    if (!supabase) return cb({ ok: false, error: "Supabase is not configured on the server." });
    const name = cleanName(payload.name);
    const xp = Math.floor(Number(payload.xp));
    if (!name || !Number.isFinite(xp) || xp < 1 || xp > 10000) {
      return cb({ ok: false, error: "Enter a player name and an XP amount from 1 to 10,000." });
    }
    try {
      const { data, error } = await supabase.rpc("award_player_progress", {
        p_name_key: profileNameKey(name),
        p_display_name: cleanName(name),
        p_xp: xp,
        p_kills: 0,
        p_wins: 0,
        p_matches: 0
      });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      const profile = profileView(row, name);
      for (const room of rooms.values()) {
        for (const player of room.players.values()) {
          if (profileNameKey(player.name) === profileNameKey(name)) {
            io.to(player.id).emit("profileUpdated", { ...profile, earnedXp: xp, won: false });
          }
        }
      }
      cb({ ok: true, profile });
    } catch (error) {
      console.error("Admin XP grant failed:", error.message);
      cb({ ok: false, error: "Could not update that player's XP profile." });
    }
  });

  socket.on("createRoom", (payload = {}, cb = () => {}) => {
    leaveRoom(socket);
    socket.data.playerName = cleanName(payload.name);

    const code = makeRoomCode();
    const room = makeRoom(code, payload);

    room.hostId = socket.id;
     room.players.set(socket.id, {
      id: socket.id,
      name: cleanName(payload.name),
      x: 0,
      y: 0,
      z: 0,
      yaw: 0,
      pitch: 0,
      health: 100,
      shield: 100,
      alive: true,
      medkits: 0,
      potions: 0,
      kills: 0,
      matchKills: 0,
      matchXp: 0,
      score: 0,
      materials: room.mode === "ffa" ? 999 : 100,
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
      isHost: true,
      serverName: room.serverName,
      mode: room.mode
    });

    emitState(room);
  });

  socket.on("joinRoom", (payload = {}, cb = () => {}) => {
    leaveRoom(socket);
    socket.data.playerName = cleanName(payload.name);

    const code = String(payload.serverId || payload.roomCode || "")
      .trim()
      .toUpperCase();

    const room = rooms.get(code);

    if (!room) {
      return cb({
        ok: false,
        error: "That room code was not found."
      });
    }

    if (room.phase !== "lobby") {
      return cb({ ok: false, error: "That match has already started." });
    }

    if (room.players.size >= room.maxPlayers) {
      return cb({
        ok: false,
        error: "That server is full."
      });
    }

    const spawnPoints = [
      { x: -8, z: 0 }, { x: 8, z: 0 }, { x: 0, z: -8 }, { x: 0, z: 8 },
      { x: -12, z: -12 }, { x: 12, z: -12 }, { x: -12, z: 12 }, { x: 12, z: 12 },
      { x: -18, z: 0 }, { x: 18, z: 0 }
    ];
    const spawn = spawnPoints[room.players.size] || { x: 0, z: 0 };
    room.players.set(socket.id, {
      id: socket.id,
      name: cleanName(payload.name),
      x: spawn.x,
      y: 0,
      z: spawn.z,
      yaw: 0,
      pitch: 0,
      health: 100,
      shield: 100,
      alive: true,
      medkits: 0,
      potions: 0,
      kills: 0,
      matchKills: 0,
      matchXp: 0,
      score: 0,
      materials: room.mode === "ffa" ? 999 : 100,
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
      isHost: socket.id === room.hostId,
      serverName: room.serverName,
      mode: room.mode
    });

    emitState(room);
  });

  socket.on("startMatch", (_data = {}, cb = () => {}) => {
    const room = getRoom(socket);
    if (!room) return cb({ ok: false, error: "Join a room first." });
    if (socket.id !== room.hostId) {
      return cb({ ok: false, error: "Only the squad host can start the match." });
    }
    if (room.phase !== "lobby") {
      return cb({ ok: false, error: "The match is already starting." });
    }

    if (room.mode === "1v1" && room.players.size !== 2) return cb({ ok: false, error: "A 1v1 match needs two players." });
    room.phase = "countdown";
    room.outcome = null;
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
      current.progressAwarded = false;
      for (const player of current.players.values()) {
        player.matchXp = 0;
        player.matchKills = 0;
      }
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
      x: p.x,
      y: p.y,
      z: p.z,
      yaw: p.yaw,
      pitch: p.pitch,
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

    // Send the visible projectile to the other players in this room.
    // Damage remains handled by the existing authoritative server hit check below.
    socket.to(room.code).emit("playerProjectile", {
      shooterId: shooter.id,
      shooterName: shooter.name,
      origin: { x: ox, y: oy, z: oz },
      direction: { x: dx, y: dy, z: dz },
      speed: 85
    });

    for (const target of room.players.values()) {
      if (room.mode !== "1v1" && room.mode !== "ffa") break;
      if (target.id === shooter.id || !target.alive) continue;

      const tx = target.x;
      const ty = target.y + 1.2;
      const tz = target.z;

      const vx = tx - ox;
      const vy = ty - oy;
      const vz = tz - oz;

      const along = vx * dx + vy * dy + vz * dz;

      if (along < 0 || along > 90) continue;

      const dist = Math.hypot(
        vx - dx * along,
        vy - dy * along,
        vz - dz * along
      );

      if (dist < 1.25) {
        // A built wall/ramp between the muzzle and target absorbs the shot.
        if (shotBlockedByBuild(room, ox, oy, oz, tx, ty, tz)) break;
        applyDamage(target, 25);

        if (!target.alive) {
          shooter.kills++;
          shooter.matchKills = (shooter.matchKills || 0) + 1;
          shooter.matchXp = (shooter.matchXp || 0) + 100;
          if (room.mode === "1v1" || room.mode === "ffa") shooter.score = (shooter.score || 0) + 1;
          if (room.mode === "ffa") void awardFFAPlayerKill(shooter);
        }

        checkOutcome(room);
        emitState(room);

        if ((room.mode === "1v1" || room.mode === "ffa") && !room.outcome && !target.alive) {
          const targetId = target.id;
          const targetIndex = [...room.players.keys()].indexOf(targetId);
          const ffaSpawns = [
            { x: 0, z: 0 }, { x: -8, z: 0 }, { x: 8, z: 0 }, { x: 0, z: -8 }, { x: 0, z: 8 },
            { x: -12, z: -12 }, { x: 12, z: -12 }, { x: -12, z: 12 }, { x: 12, z: 12 }, { x: 18, z: 0 }
          ];
          const spawn = room.mode === "ffa" ? (ffaSpawns[Math.max(0,targetIndex)] || {x:0,z:0}) : (targetId === room.hostId ? { x: 0, z: 0 } : { x: 8, z: 0 });
          setTimeout(() => {
            const current = rooms.get(room.code);
            const respawning = current?.players.get(targetId);
            if (!current || current.outcome || current.phase !== "playing" || !respawning) return;
            respawning.health = 100;
            respawning.shield = 100;
            respawning.alive = true;
            respawning.x = spawn.x;
            respawning.y = 0;
            respawning.z = spawn.z;
            respawning.yaw = targetId === current.hostId ? 0 : Math.PI;
            io.to(targetId).emit("playerRespawned", { id: targetId, x: spawn.x, z: spawn.z });
            emitState(current);
          }, 1400);
        }
        break;
      }
    }
  });

  socket.on("damageBot", data => {
    const room = getRoom(socket);
    const p = room?.players.get(socket.id);

    if (!room || !p || !p.alive) return;

    const bot = room.bots.find(
      b => b.id === String(data.id)
    );

    if (!bot || !bot.alive) return;

    const amount = number(data.amount, 25, 0, 50);
    const absorbed = Math.min(bot.shield, amount);

    bot.shield -= absorbed;
    bot.health = Math.max(
      0,
      bot.health - (amount - absorbed)
    );

    if (bot.health <= 0) {
      bot.alive = false;
      p.kills++;
      p.matchKills = (p.matchKills || 0) + 1;
      p.matchXp = (p.matchXp || 0) + 25;
    }

    checkOutcome(room);
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

    if (
      !chest ||
      chest.opened ||
      Math.hypot(p.x - chest.x, p.z - chest.z) > 5
    ) return;

    chest.opened = true;
    chest.loot = Math.random() < 0.5
      ? "medkit"
      : "potion";

    if (chest.loot === "medkit") {
      p.medkits++;
    } else {
      p.potions++;
    }

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
    } else if (
      data.type === "potion" &&
      p.potions > 0 &&
      p.shield < 100
    ) {
      p.potions--;
      p.shield = Math.min(100, p.shield + 40);
    }

    emitState(room);
  });

  socket.on("buildStructure", data => {
    const room = getRoom(socket);
    const p = room?.players.get(socket.id);

    if (!room || !p || !p.alive || p.materials < 10) return;

    const type = data.type === "ramp"
      ? "ramp"
      : "wall";

    const structure = {
      id: `${socket.id}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      owner: socket.id,
      type,
      x: number(data.x, p.x),
      z: number(data.z, p.z),
      yaw: number(data.yaw, p.yaw, -1000, 1000)
    };

    p.materials = Math.max(0, p.materials - 10);
    room.structures.push(structure);

    if (room.structures.length > 100) {
      room.structures.shift();
    }

    emitState(room);
  });

  socket.on("vehicleUpdate", data => {
    const room = getRoom(socket);
    const p = room?.players.get(socket.id);

    if (!room || !p || !p.alive) return;

    const type = String(data.type || "").slice(0, 16);

    if (!["truck", "sedan", "sports", "suv"].includes(type)) {
      return;
    }

    room.vehicles ||= {};

    room.vehicles[type] = {
      type,
      x: number(data.x, p.x),
      z: number(data.z, p.z),
      yaw: number(data.yaw, p.yaw, -1000, 1000),
      driver: socket.id
    };

    io.to(room.code).emit(
      "vehicleMoved",
      room.vehicles[type]
    );
  });

  socket.on("playerVitals", data => {
    const room = getRoom(socket);
    const p = room?.players.get(socket.id);

    if (!room || !p) return;

    p.health = number(data.health, p.health, 0, 100);
    p.shield = number(data.shield, p.shield, 0, 100);
    p.alive = data.alive !== false && p.health > 0;

    checkOutcome(room);
    emitState(room);
  });

  socket.on("requestServerList", () => socket.emit("serverList", publicServerList()));

  socket.on("leaveRoom", () => leaveRoom(socket));
  socket.on("disconnect", () => {
    socket.data.adminAuthenticated = false;
    leaveRoom(socket);
  });
});

// Shared bot movement, attacks, and storm simulation.
setInterval(() => {
  const now = Date.now();

  for (const room of rooms.values()) {
    const dt = Math.min(
      0.2,
      (now - room.lastTick) / 1000
    );

    room.lastTick = now;

    const living = [...room.players.values()]
      .filter(p => p.alive);

    if (!living.length) continue;
    if (room.mode === "ffa") {
      emitState(room);
      continue;
    }

    room.stormTime += dt;

    if (room.stormTime > 15) {
      room.stormRadius = Math.max(
        25,
        room.stormRadius - dt * 0.8
      );
    }

    for (const bot of room.bots) {
      if (room.mode === "1v1" || !bot.alive) continue;

      let target = null;
      let best = Infinity;

      for (const p of living) {
        const d = Math.hypot(
          p.x - bot.x,
          p.z - bot.z
        );

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

      if (best < 65 && bot.fire <= 0) {
        const ox = bot.x, oy = 1.5, oz = bot.z;
        const tx = target.x, ty = target.y + 1.2, tz = target.z;
        const len = Math.hypot(tx-ox, ty-oy, tz-oz) || 1;
        const direction = { x:(tx-ox)/len, y:(ty-oy)/len, z:(tz-oz)/len };
        room.botProjectiles.push({ x:ox, y:oy, z:oz, vx:direction.x*42, vy:direction.y*42, vz:direction.z*42, life:3, targetId:target.id });
        io.to(room.code).emit("botProjectile", { origin:{x:ox,y:oy,z:oz}, direction, speed:42 });
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

    for (let i = room.botProjectiles.length - 1; i >= 0; i--) {
      const b = room.botProjectiles[i];
      const old = { x:b.x, y:b.y, z:b.z };
      b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt; b.life -= dt;
      if (shotBlockedByBuild(room, old.x, old.y, old.z, b.x, b.y, b.z)) {
        b.life = 0;
      }
      const target = room.players.get(b.targetId);
      if (b.life > 0 && target && target.alive) {
        const dx=target.x-b.x, dy=(target.y+1.2)-b.y, dz=target.z-b.z;
        if (Math.hypot(dx,dy,dz) < 1.25) { applyDamage(target,10); b.life=0; }
      }
      if (b.life <= 0) room.botProjectiles.splice(i,1);
    }

    for (const p of room.players.values()) {
      if (
        p.alive &&
        Math.hypot(p.x, p.z) > room.stormRadius
      ) {
        p._stormDamage = (p._stormDamage || 0) + dt;

        if (p._stormDamage >= 2) {
          applyDamage(p, 5);
          p._stormDamage = 0;
        }
      } else {
        p._stormDamage = 0;
      }
    }

    checkOutcome(room);
    emitState(room);
  }
}, 100);

const server = httpServer.listen(PORT, () =>
  console.log(
    `Battle Royale multiplayer server listening on port ${PORT}`
  )
);

process.on("SIGTERM", () =>
  server.close(() => process.exit(0))
);
