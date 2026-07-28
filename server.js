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
const players = {};    // socketId -> {x,y,z,ry,color,health,hunger,dim,bedSpawn}
const entities = {};   // id -> {kind,x,y,z,health,dim,lastHit,baby}
const chunkEdits = {}; // "cx,cz" -> { "lx,y,lz": {action,material} } (nether arena stored under key 'nether,nether')
const crops = {};      // "x,y,z" -> plantedAt ms (overworld only)

const DAY_LENGTH = 3 * 60 * 1000; // 3 minute full day/night cycle
const startTime = Date.now();
let sleepOffsetMs = 0;
function getDayClock() { return (((Date.now() - startTime + sleepOffsetMs) % DAY_LENGTH) + DAY_LENGTH) % DAY_LENGTH / DAY_LENGTH; }
function isNight() { const t = getDayClock(); return t > 0.5 && t < 0.95; }

let isRaining = false;
setInterval(() => { isRaining = Math.random() < 0.35; }, 90 * 1000);

const COLORS = [0xff5555, 0x5588ff, 0xffaa00, 0x55ff88, 0xcc55ff, 0x55ffff];
let colorIdx = 0;
let entityIdCounter = 1;

const HOSTILE_KINDS = new Set(['zombie', 'skeleton', 'boss', 'spider', 'enderman']);
const CROP_GROWTH_MS = 45 * 1000;

function randomSpawn() {
  let x, z;
  do {
    x = Math.round((Math.random() - 0.5) * 20);
    z = Math.round((Math.random() - 0.5) * 20);
  } while (World.treeAt(x, z));
  const h = World.heightAt(x, z);
  return { x: x + 0.5, y: h + 2, z: z + 0.5 };
}

function respawnPoint(p) {
  if (p.bedSpawn) return { x: p.bedSpawn.x, y: p.bedSpawn.y, z: p.bedSpawn.z };
  return randomSpawn();
}

// ---------- Nether arena (fixed-size, not chunk-streamed) ----------
const NETHER_HALF = 16;
const NETHER_KEY = 'nether,nether';
let netherBuilt = false;
function buildNetherArena() {
  if (netherBuilt) return;
  netherBuilt = true;
  chunkEdits[NETHER_KEY] = {};
  const put = (x, y, z, material) => { chunkEdits[NETHER_KEY][x + ',' + y + ',' + z] = { action: 'add', material }; };
  for (let x = -NETHER_HALF; x <= NETHER_HALF; x++) {
    for (let z = -NETHER_HALF; z <= NETHER_HALF; z++) {
      const edge = Math.abs(x) === NETHER_HALF || Math.abs(z) === NETHER_HALF;
      put(x, 0, z, edge ? 'bedrock' : 'netherrack');
      put(x, 8, z, 'bedrock'); // ceiling (well above player reach)
      if (edge) { for (let wy = 1; wy <= 7; wy++) put(x, wy, z, 'bedrock'); }
      else if (World.hash(x * 3.1, z * 3.1) > 0.9) put(x, 1, z, 'lava');
    }
  }
  put(-6, 1, 0, 'portal'); // return portal to overworld

  // small fortress structure around the boss, built from nether brick
  const fx = 4, fz = 4, fSize = 4;
  for (let x = fx - fSize; x <= fx + fSize; x++) {
    for (let z = fz - fSize; z <= fz + fSize; z++) {
      const onEdge = Math.abs(x - fx) === fSize || Math.abs(z - fz) === fSize;
      if (onEdge) {
        put(x, 1, z, 'nether_brick');
        put(x, 2, z, 'nether_brick');
        put(x, 3, z, 'nether_brick');
      }
    }
  }
  // gaps for an entrance
  delete chunkEdits[NETHER_KEY][(fx - fSize) + ',1,' + fz];
  delete chunkEdits[NETHER_KEY][(fx - fSize) + ',2,' + fz];

  entities['boss1'] = { kind: 'boss', x: fx, y: 1.5, z: fz, health: 60, dim: 'nether' };
}

io.on('connection', (socket) => {
  const spawn = randomSpawn();
  players[socket.id] = {
    x: spawn.x, y: spawn.y, z: spawn.z, ry: 0,
    color: COLORS[colorIdx++ % COLORS.length],
    health: 20, hunger: 20, dim: 'overworld', bedSpawn: null
  };

  socket.emit('init', {
    selfId: socket.id,
    players,
    entities,
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

  socket.on('enterNether', () => {
    const p = players[socket.id];
    if (!p) return;
    buildNetherArena();
    p.dim = 'nether';
    p.x = 0.5; p.y = 2.5; p.z = 0.5;
    socket.emit('netherArena', { edits: chunkEdits[NETHER_KEY], spawn: { x: p.x, y: p.y, z: p.z } });
  });

  socket.on('enterOverworld', ({ x, y, z }) => {
    const p = players[socket.id];
    if (!p) return;
    p.dim = 'overworld';
    p.x = x; p.y = y; p.z = z;
    socket.emit('overworldReturn', { x, y, z });
  });

  socket.on('blockEdit', ({ x, y, z, action, material, dim }) => {
    const p = players[socket.id];
    const playerDim = (p && p.dim) || 'overworld';
    const key = playerDim === 'nether' ? NETHER_KEY : (() => {
      const [cx, cz] = World.worldToChunk(x, z);
      return cx + ',' + cz;
    })();
    if (!chunkEdits[key]) chunkEdits[key] = {};
    let ek;
    if (playerDim === 'nether') {
      ek = x + ',' + y + ',' + z;
    } else {
      const [cx, cz] = World.worldToChunk(x, z);
      ek = (x - cx * World.CHUNK_SIZE) + ',' + y + ',' + (z - cz * World.CHUNK_SIZE);
    }
    chunkEdits[key][ek] = action === 'remove' ? { action: 'remove' } : { action: 'add', material };
    const cropKey = x + ',' + y + ',' + z;
    if (action === 'remove') delete crops[cropKey];
    if (action === 'add' && material === 'wheat_young') crops[cropKey] = Date.now();

    for (const [id, sock] of io.sockets.sockets) {
      if (id === socket.id) continue;
      const other = players[id];
      if (other && other.dim === playerDim) sock.emit('blockEdit', { x, y, z, action, material });
    }
  });

  socket.on('attackEntity', ({ entityId, damage }) => {
    const ent = entities[entityId];
    if (!ent) return;
    ent.health -= (damage || 5);
    if (ent.health <= 0) {
      if (!HOSTILE_KINDS.has(ent.kind) && ent.kind !== 'boss') {
        io.to(socket.id).emit('lootDrop', { kind: ent.kind });
      }
      delete entities[entityId];
      if (ent.kind === 'boss') {
        setTimeout(buildNetherArena, 100); // simple respawn-arena refresh incl. new boss
        netherBuilt = false;
      }
    }
  });

  socket.on('breedEntities', ({ entityId }) => {
    const parent = entities[entityId];
    if (!parent) return;
    const id = 'e' + (entityIdCounter++);
    entities[id] = { kind: parent.kind, x: parent.x + 0.5, y: parent.y, z: parent.z + 0.5, health: 10, dim: parent.dim, baby: true };
  });

  socket.on('setBedSpawn', ({ x, y, z }) => {
    const p = players[socket.id];
    if (!p) return;
    p.bedSpawn = { x, y, z };
  });

  socket.on('sleep', () => {
    // simplification: any one player sleeping skips the shared night for everyone
    if (isNight()) {
      const target = 0.03; // just after dawn
      sleepOffsetMs -= (getDayClock() - target) * DAY_LENGTH;
    }
  });

  socket.on('eat', ({ amount }) => {
    const p = players[socket.id];
    if (!p) return;
    p.hunger = Math.min(20, p.hunger + (amount || 6));
  });

  socket.on('takeDamage', ({ amount }) => {
    const p = players[socket.id];
    if (!p) return;
    p.health = Math.max(0, p.health - (amount || 1));
  });

  socket.on('setHardcore', ({ hardcore }) => {
    const p = players[socket.id];
    if (!p) return;
    p.hardcore = !!hardcore;
  });

  socket.on('disconnect', () => {
    delete players[socket.id];
    io.emit('playerLeft', { id: socket.id });
  });
});

// ---------- Server tick: entity AI, spawning, hunger/health, crops ----------
const TICK_MS = 150;
setInterval(() => {
  const night = isNight();
  const playerList = Object.entries(players);
  const overworldPlayers = playerList.filter(([, p]) => p.dim === 'overworld');
  const netherPlayers = playerList.filter(([, p]) => p.dim === 'nether');

  // hostile mob spawn/despawn (overworld only, night only)
  const hostileCount = Object.values(entities).filter((e) => e.dim === 'overworld' && HOSTILE_KINDS.has(e.kind)).length;
  if (night && overworldPlayers.length > 0 && hostileCount < overworldPlayers.length * 4 && Math.random() < 0.3) {
    const [, target] = overworldPlayers[Math.floor(Math.random() * overworldPlayers.length)];
    const angle = Math.random() * Math.PI * 2;
    const dist = 10 + Math.random() * 6;
    const mx = target.x + Math.cos(angle) * dist;
    const mz = target.z + Math.sin(angle) * dist;
    const h = World.heightAt(Math.round(mx), Math.round(mz));
    const roll = Math.random();
    const kind = roll < 0.4 ? 'zombie' : roll < 0.7 ? 'skeleton' : roll < 0.9 ? 'spider' : 'enderman';
    entities['e' + (entityIdCounter++)] = { kind, x: mx, y: h + 1.5, z: mz, health: kind === 'spider' ? 12 : 20, dim: 'overworld' };
  }
  if (!night) {
    for (const id in entities) if (entities[id].dim === 'overworld' && HOSTILE_KINDS.has(entities[id].kind)) delete entities[id];
  }

  // passive animal spawn (overworld, daytime, light cap)
  const animalCount = Object.values(entities).filter((e) => e.dim === 'overworld' && (e.kind === 'cow' || e.kind === 'pig')).length;
  if (!night && overworldPlayers.length > 0 && animalCount < overworldPlayers.length * 3 && Math.random() < 0.08) {
    const [, target] = overworldPlayers[Math.floor(Math.random() * overworldPlayers.length)];
    const angle = Math.random() * Math.PI * 2;
    const dist = 8 + Math.random() * 10;
    const mx = target.x + Math.cos(angle) * dist;
    const mz = target.z + Math.sin(angle) * dist;
    const h = World.heightAt(Math.round(mx), Math.round(mz));
    const kind = Math.random() < 0.5 ? 'cow' : 'pig';
    entities['e' + (entityIdCounter++)] = { kind, x: mx, y: h + 1.5, z: mz, health: 10, dim: 'overworld', wanderT: 0 };
  }

  // villager spawn (overworld, rare, small cap)
  const villagerCount = Object.values(entities).filter((e) => e.kind === 'villager').length;
  if (overworldPlayers.length > 0 && villagerCount < overworldPlayers.length * 2 && Math.random() < 0.015) {
    const [, target] = overworldPlayers[Math.floor(Math.random() * overworldPlayers.length)];
    const angle = Math.random() * Math.PI * 2;
    const dist = 8 + Math.random() * 10;
    const mx = target.x + Math.cos(angle) * dist;
    const mz = target.z + Math.sin(angle) * dist;
    const h = World.heightAt(Math.round(mx), Math.round(mz));
    entities['e' + (entityIdCounter++)] = { kind: 'villager', x: mx, y: h + 1.5, z: mz, health: 30, dim: 'overworld' };
  }

  // entity AI
  for (const id in entities) {
    const ent = entities[id];
    const pool = ent.dim === 'nether' ? netherPlayers : overworldPlayers;
    if (HOSTILE_KINDS.has(ent.kind)) {
      let nearest = null, nd = Infinity;
      for (const [, p] of pool) {
        const d = (p.x - ent.x) ** 2 + (p.z - ent.z) ** 2;
        if (d < nd) { nd = d; nearest = p; }
      }
      if (nearest) {
        if (ent.kind === 'enderman') {
          ent.teleportT = (ent.teleportT || 0) - TICK_MS;
          if (ent.teleportT <= 0) {
            ent.teleportT = 3000 + Math.random() * 2000;
            const angle = Math.random() * Math.PI * 2;
            const dist = 2 + Math.random() * 3;
            ent.x = nearest.x + Math.cos(angle) * dist;
            ent.z = nearest.z + Math.sin(angle) * dist;
            if (ent.dim === 'overworld') ent.y = World.heightAt(Math.round(ent.x), Math.round(ent.z)) + 1.5;
          }
        } else {
          const dx = nearest.x - ent.x, dz = nearest.z - ent.z;
          const len = Math.hypot(dx, dz) || 1;
          const isRanged = ent.kind === 'skeleton';
          const keepDistance = isRanged ? 6 : 0;
          const speed = (ent.kind === 'boss' ? 1.6 : ent.kind === 'spider' ? 1.8 : 1.2) * (TICK_MS / 1000);
          if (len > keepDistance + 1) {
            ent.x += (dx / len) * speed;
            ent.z += (dz / len) * speed;
          }
          if (ent.dim === 'overworld') ent.y = World.heightAt(Math.round(ent.x), Math.round(ent.z)) + 1.5;
        }
        const dx2 = nearest.x - ent.x, dz2 = nearest.z - ent.z;
        const nd2 = dx2 * dx2 + dz2 * dz2;
        const dmg = ent.kind === 'boss' ? 4 : 1;
        const range = ent.kind === 'skeleton' ? 49 : 2.25;
        const cooldown = ent.kind === 'skeleton' ? 2200 : 1800;
        if (nd2 < range && (!ent.lastHit || Date.now() - ent.lastHit > cooldown)) {
          nearest.health = Math.max(0, nearest.health - dmg);
          ent.lastHit = Date.now();
        }
      }
    } else if (ent.kind === 'cow' || ent.kind === 'pig') {
      ent.wanderT = (ent.wanderT || 0) - TICK_MS;
      if (ent.wanderT <= 0) {
        ent.wanderAngle = Math.random() * Math.PI * 2;
        ent.wanderT = 2000 + Math.random() * 3000;
      }
      const speed = 0.4 * (TICK_MS / 1000);
      ent.x += Math.cos(ent.wanderAngle || 0) * speed;
      ent.z += Math.sin(ent.wanderAngle || 0) * speed;
      ent.y = World.heightAt(Math.round(ent.x), Math.round(ent.z)) + 1.5;
    }
  }

  // crop growth
  for (const key in crops) {
    if (Date.now() - crops[key] > CROP_GROWTH_MS) {
      const [x, y, z] = key.split(',').map(Number);
      const editKey = chunkEditKeyFor(x, z);
      const [ecx, ecz] = World.worldToChunk(x, z);
      const lx = x - ecx * World.CHUNK_SIZE, lz = z - ecz * World.CHUNK_SIZE;
      if (!chunkEdits[editKey]) chunkEdits[editKey] = {};
      chunkEdits[editKey][lx + ',' + y + ',' + lz] = { action: 'add', material: 'wheat_ripe' };
      delete crops[key];
      io.emit('blockEdit', { x, y, z, action: 'add', material: 'wheat_ripe' });
    }
  }

  // hunger/health
  for (const [id, p] of playerList) {
    p.hunger = Math.max(0, p.hunger - 0.015);
    if (p.hunger <= 0) p.health = Math.max(0, p.health - 0.015);

    // Check death BEFORE regen - otherwise hunger-driven regen can nudge a
    // player who just hit exactly 0 (from a fall/lava/combat hit) back above
    // zero on the very next tick, silently undoing what should have been lethal.
    if (p.health <= 0 && !p.gameOver) {
      if (p.hardcore) {
        p.gameOver = true;
        io.to(id).emit('gameOver');
        continue;
      }
      const wasNether = p.dim === 'nether';
      p.dim = 'overworld'; // dying anywhere sends you back to the overworld to respawn
      const spawn = respawnPoint(p);
      p.x = spawn.x; p.y = spawn.y; p.z = spawn.z;
      p.health = 20; p.hunger = 20;
      io.to(id).emit('respawn', { x: p.x, y: p.y, z: p.z, fromNether: wasNether });
      continue;
    }

    if (p.hunger > 14 && p.health < 20) p.health = Math.min(20, p.health + 0.02);
  }

  for (const [id, p] of playerList) {
    const visibleEntities = {};
    for (const eid in entities) if (entities[eid].dim === p.dim) visibleEntities[eid] = entities[eid];
    const visiblePlayers = {};
    for (const [pid, pp] of playerList) if (pp.dim === p.dim) visiblePlayers[pid] = pp;
    io.to(id).emit('tick', { players: visiblePlayers, entities: visibleEntities, dayClock: getDayClock(), isRaining });
  }
}, TICK_MS);

function chunkEditKeyFor(x, z) {
  const [cx, cz] = World.worldToChunk(x, z);
  return cx + ',' + cz;
}

server.listen(PORT, () => console.log('Server running on http://localhost:' + PORT));
