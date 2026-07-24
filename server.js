const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const World = require('./shared/world.js');

const app = express();
app.use(express.static(__dirname + '/public'));
app.use('/shared', express.static(__dirname + '/shared'));

const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 8123;

// ---------- Authoritative game state ----------
const players = {};   // socketId -> {x,y,z,ry,color,health,hunger}
const mobs = {};      // mobId -> {x,y,z,health,lastHit}
const chunkEdits = {}; // "cx,cz" -> { "lx,y,lz": {action,material} }

const DAY_LENGTH = 3 * 60 * 1000; // 3 minute full day/night cycle
const startTime = Date.now();
function getDayClock() { return ((Date.now() - startTime) % DAY_LENGTH) / DAY_LENGTH; }
function isNight() { const t = getDayClock(); return t > 0.5 && t < 0.95; }

const COLORS = [0xff5555, 0x5588ff, 0xffaa00, 0x55ff88, 0xcc55ff, 0x55ffff];
let colorIdx = 0;
let mobIdCounter = 1;

function randomSpawn() {
  let x, z;
  do {
    x = Math.round((Math.random() - 0.5) * 20);
    z = Math.round((Math.random() - 0.5) * 20);
  } while (World.treeAt(x, z));
  const h = World.heightAt(x, z);
  return { x: x + 0.5, y: h + 2, z: z + 0.5 };
}

io.on('connection', (socket) => {
  const spawn = randomSpawn();
  players[socket.id] = {
    x: spawn.x, y: spawn.y, z: spawn.z, ry: 0,
    color: COLORS[colorIdx++ % COLORS.length],
    health: 20, hunger: 20
  };

  socket.emit('init', {
    selfId: socket.id,
    players,
    mobs,
    dayLength: DAY_LENGTH,
    startTime
  });
  socket.broadcast.emit('playerJoined', { id: socket.id, ...players[socket.id] });

  socket.on('move', (data) => {
    const p = players[socket.id];
    if (!p) return;
    p.x = data.x; p.y = data.y; p.z = data.z; p.ry = data.ry;
  });

  socket.on('requestChunk', ({ cx, cz }) => {
    const columns = World.generateChunkColumns(cx, cz);
    const key = cx + ',' + cz;
    socket.emit('chunkData', { cx, cz, columns, edits: chunkEdits[key] || {} });
  });

  socket.on('blockEdit', ({ x, y, z, action, material }) => {
    const [cx, cz] = World.worldToChunk(x, z);
    const key = cx + ',' + cz;
    if (!chunkEdits[key]) chunkEdits[key] = {};
    const lx = x - cx * World.CHUNK_SIZE;
    const lz = z - cz * World.CHUNK_SIZE;
    const ek = lx + ',' + y + ',' + lz;
    chunkEdits[key][ek] = action === 'remove' ? { action: 'remove' } : { action: 'add', material };
    socket.broadcast.emit('blockEdit', { x, y, z, action, material });
  });

  socket.on('attackMob', ({ mobId }) => {
    const mob = mobs[mobId];
    if (!mob) return;
    mob.health -= 5;
    if (mob.health <= 0) delete mobs[mobId];
  });

  socket.on('eat', () => {
    const p = players[socket.id];
    if (!p) return;
    p.hunger = Math.min(20, p.hunger + 6);
  });

  socket.on('disconnect', () => {
    delete players[socket.id];
    io.emit('playerLeft', { id: socket.id });
  });
});

// ---------- Server tick: mob AI, spawning, hunger/health ----------
const TICK_MS = 150;
setInterval(() => {
  const night = isNight();
  const playerList = Object.entries(players);

  if (night && playerList.length > 0 && Object.keys(mobs).length < playerList.length * 4 && Math.random() < 0.3) {
    const [, target] = playerList[Math.floor(Math.random() * playerList.length)];
    const angle = Math.random() * Math.PI * 2;
    const dist = 10 + Math.random() * 6;
    const mx = target.x + Math.cos(angle) * dist;
    const mz = target.z + Math.sin(angle) * dist;
    const h = World.heightAt(Math.round(mx), Math.round(mz));
    mobs['m' + (mobIdCounter++)] = { x: mx, y: h + 1.5, z: mz, health: 20 };
  }
  if (!night) {
    for (const id in mobs) delete mobs[id];
  }

  for (const id in mobs) {
    const mob = mobs[id];
    let nearest = null, nd = Infinity;
    for (const [, p] of playerList) {
      const d = (p.x - mob.x) ** 2 + (p.z - mob.z) ** 2;
      if (d < nd) { nd = d; nearest = p; }
    }
    if (nearest) {
      const dx = nearest.x - mob.x, dz = nearest.z - mob.z;
      const len = Math.hypot(dx, dz) || 1;
      const speed = 1.2 * (TICK_MS / 1000);
      mob.x += (dx / len) * speed;
      mob.z += (dz / len) * speed;
      mob.y = World.heightAt(Math.round(mob.x), Math.round(mob.z)) + 1.5;
      if (nd < 2.25 && (!mob.lastHit || Date.now() - mob.lastHit > 1800)) {
        nearest.health = Math.max(0, nearest.health - 1);
        mob.lastHit = Date.now();
      }
    }
  }

  for (const [id, p] of playerList) {
    p.hunger = Math.max(0, p.hunger - 0.015);
    if (p.hunger <= 0) p.health = Math.max(0, p.health - 0.015);
    if (p.health <= 0) {
      const spawn = randomSpawn();
      p.x = spawn.x; p.y = spawn.y; p.z = spawn.z;
      p.health = 20; p.hunger = 20;
      io.to(id).emit('respawn', { x: p.x, y: p.y, z: p.z });
    }
  }

  io.emit('tick', { players, mobs, dayClock: getDayClock() });
}, TICK_MS);

server.listen(PORT, () => console.log('Server running on http://localhost:' + PORT));
