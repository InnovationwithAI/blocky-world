const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
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
const lootedChests = new Set(); // "x,y,z" of dungeon chests already opened

// ---------- World persistence ----------
// Players/entities are session state (no login system, socket ids change
// every reconnect) so only the world itself - what has been built/planted -
// is worth saving. This protects against the free-tier idle spin-down/wake
// cycle; it does NOT survive an actual redeploy, since Render's free web
// service disk is rebuilt fresh on every deploy regardless of what is
// written here. Surviving deploys too would need a persistent disk or an
// external database on the Render account - a billing decision, not
// something to wire up unasked.
const SAVE_FILE = path.join(__dirname, 'world-save.json');
const SAVE_INTERVAL_MS = 30 * 1000;

function loadWorld() {
  try {
    if (!fs.existsSync(SAVE_FILE)) return;
    const data = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8'));
    if (data.chunkEdits) Object.assign(chunkEdits, data.chunkEdits);
    if (data.crops) Object.assign(crops, data.crops);
    if (Array.isArray(data.lootedChests)) for (const k of data.lootedChests) lootedChests.add(k);
    // netherBuilt is deliberately not restored - entities (including the
    // boss) are session state and are not saved, so leaving this false lets
    // buildNetherArena() do its normal deterministic rebuild, including a
    // fresh boss, the first time anyone re-enters after a restart.
    console.log('Loaded saved world from', SAVE_FILE);
  } catch (e) {
    console.error('Failed to load saved world, starting fresh:', e.message);
  }
}

function saveWorld() {
  try {
    const data = JSON.stringify({ chunkEdits, crops, lootedChests: Array.from(lootedChests) });
    fs.writeFileSync(SAVE_FILE, data);
  } catch (e) {
    console.error('Failed to save world:', e.message);
  }
}

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

const HOSTILE_KINDS = new Set(['zombie', 'skeleton', 'boss', 'spider', 'enderman', 'creeper']);
const PASSIVE_KINDS = new Set(['cow', 'pig', 'sheep', 'chicken']);
const LOOT_KINDS = new Set(['cow', 'pig', 'skeleton', 'spider', 'enderman', 'chicken']);
const CREEPER_FUSE_MS = 1200;
const CREEPER_FUSE_RANGE_SQ = 9; // 3 blocks, true 3D distance
const MELEE_RANGE_SQ = 9; // 3 blocks, true 3D distance
const EXPLOSION_RADIUS = 2;
const TNT_FUSE_MS = 2500;
const TNT_RADIUS = 3;
const ARMOR_REDUCTION = { wool: 0.1, gold: 0.2, iron: 0.35, diamond: 0.5 };

const DUNGEON_LOOT_POOL = [
  { key: 'iron_ingot', amount: () => 1 + Math.floor(Math.random() * 3) },
  { key: 'gold_ingot', amount: () => 1 + Math.floor(Math.random() * 2) },
  { key: 'diamond', amount: () => 1 },
  { key: 'coal', amount: () => 2 + Math.floor(Math.random() * 3) },
  { key: 'torch', amount: () => 2 + Math.floor(Math.random() * 4) },
  { key: 'cooked_meat', amount: () => 1 + Math.floor(Math.random() * 3) },
  { key: 'bone', amount: () => 1 + Math.floor(Math.random() * 3) },
  { key: 'string', amount: () => 1 + Math.floor(Math.random() * 3) },
  { key: 'wheat', amount: () => 1 + Math.floor(Math.random() * 3) }
];
function rollDungeonLoot() {
  const count = 2 + Math.floor(Math.random() * 3);
  const items = [];
  for (let i = 0; i < count; i++) {
    const pick = DUNGEON_LOOT_POOL[Math.floor(Math.random() * DUNGEON_LOOT_POOL.length)];
    items.push({ key: pick.key, amount: pick.amount() });
  }
  return items;
}

// Every hit that lands on a player - melee, explosion, fall, lava - routes
// through here so equipped armor reduces it consistently everywhere.
function applyDamage(p, amount) {
  const reduction = ARMOR_REDUCTION[p.armor] || 0;
  p.health = Math.max(0, p.health - amount * (1 - reduction));
}
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
    health: 20, hunger: 20, dim: 'overworld', bedSpawn: null, armor: null
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

  socket.on('blockEdit', ({ x, y, z, action, material, text, dim }) => {
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
    const signText = material === 'sign' && typeof text === 'string' ? text.slice(0, 40) : undefined;
    chunkEdits[key][ek] = action === 'remove' ? { action: 'remove' } : { action: 'add', material, text: signText };
    const cropKey = x + ',' + y + ',' + z;
    if (action === 'remove') delete crops[cropKey];
    if (action === 'add' && material === 'wheat_young') crops[cropKey] = Date.now();
    if (action === 'add' && material === 'tnt') {
      setTimeout(() => triggerExplosion(x, y, z, playerDim, TNT_RADIUS), TNT_FUSE_MS);
    }

    for (const [id, sock] of io.sockets.sockets) {
      if (id === socket.id) continue;
      const other = players[id];
      if (other && other.dim === playerDim) sock.emit('blockEdit', { x, y, z, action, material, text: signText });
    }
  });

  socket.on('attackEntity', ({ entityId, damage }) => {
    const ent = entities[entityId];
    if (!ent) return;
    ent.health -= (damage || 5);
    if (ent.health <= 0) {
      if (LOOT_KINDS.has(ent.kind)) {
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

  socket.on('setArmor', ({ armor }) => {
    const p = players[socket.id];
    if (!p) return;
    p.armor = armor;
  });

  socket.on('chat', ({ text }) => {
    const p = players[socket.id];
    if (!p || typeof text !== 'string') return;
    const trimmed = text.trim().slice(0, 100);
    if (!trimmed) return;
    io.emit('chat', { text: trimmed, color: p.color, id: socket.id });
  });

  // One-time loot per chest, tracked by position so it stays looted for
  // every player (and survives the autosave/reload cycle).
  socket.on('lootChest', ({ x, y, z }) => {
    const key = x + ',' + y + ',' + z;
    if (lootedChests.has(key)) { socket.emit('chestLoot', { empty: true }); return; }
    lootedChests.add(key);
    socket.emit('chestLoot', { items: rollDungeonLoot() });
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
    applyDamage(p, amount || 1);
  });

  socket.on('setHardcore', ({ hardcore }) => {
    const p = players[socket.id];
    if (!p) return;
    p.hardcore = !!hardcore;
  });

  // Personal reset only - a fresh character/spawn for this player. Does not
  // touch the shared world, other players, or anything anyone has built.
  socket.on('startNewGame', () => {
    const p = players[socket.id];
    if (!p) return;
    const wasNether = p.dim === 'nether';
    p.dim = 'overworld';
    p.bedSpawn = null;
    p.hardcore = false;
    p.gameOver = false;
    p.armor = null;
    const spawn = randomSpawn();
    p.x = spawn.x; p.y = spawn.y; p.z = spawn.z;
    p.health = 20; p.hunger = 20;
    io.to(socket.id).emit('respawn', { x: p.x, y: p.y, z: p.z, fromNether: wasNether });
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
    const kind = roll < 0.32 ? 'zombie' : roll < 0.56 ? 'skeleton' : roll < 0.72 ? 'spider' : roll < 0.86 ? 'enderman' : 'creeper';
    const health = kind === 'spider' ? 12 : kind === 'creeper' ? 15 : 20;
    entities['e' + (entityIdCounter++)] = { kind, x: mx, y: h + 1.5, z: mz, health, dim: 'overworld' };
  }
  // dungeon spawners: work regardless of time of day, only trigger near a
  // player, and stop once enough hostiles are already milling around it -
  // checking the 3x3 chunk neighborhood of each player is cheap since
  // dungeonAt is just a couple of hash lookups, no real search involved.
  for (const [, p] of overworldPlayers) {
    const [pcx, pcz] = World.worldToChunk(Math.round(p.x), Math.round(p.z));
    for (let dcx = -1; dcx <= 1; dcx++) {
      for (let dcz = -1; dcz <= 1; dcz++) {
        const dungeon = World.dungeonAt(pcx + dcx, pcz + dcz);
        if (!dungeon) continue;
        const spawner = World.dungeonSpawnerPos(dungeon);
        const dist2 = (p.x - spawner.x) ** 2 + (p.y - spawner.y) ** 2 + (p.z - spawner.z) ** 2;
        if (dist2 > 100) continue;
        const nearbyHostiles = Object.values(entities).filter((e) =>
          e.dim === 'overworld' && HOSTILE_KINDS.has(e.kind) &&
          (e.x - spawner.x) ** 2 + (e.z - spawner.z) ** 2 < 100
        ).length;
        if (nearbyHostiles >= 3 || Math.random() >= 0.04) continue;
        const kind = ['zombie', 'skeleton', 'spider'][Math.floor(Math.random() * 3)];
        entities['e' + (entityIdCounter++)] = {
          kind, x: spawner.x + (Math.random() - 0.5) * 2, y: spawner.y, z: spawner.z + (Math.random() - 0.5) * 2,
          health: kind === 'spider' ? 12 : 20, dim: 'overworld', fromSpawner: true
        };
      }
    }
  }

  // villages get their own villagers, on top of the rare ambient spawn -
  // same 3x3-chunk-neighborhood pattern as dungeon spawners above.
  for (const [, p] of overworldPlayers) {
    const [pcx2, pcz2] = World.worldToChunk(Math.round(p.x), Math.round(p.z));
    for (let dcx = -1; dcx <= 1; dcx++) {
      for (let dcz = -1; dcz <= 1; dcz++) {
        const village = World.villageAt(pcx2 + dcx, pcz2 + dcz);
        if (!village) continue;
        const dist2 = (p.x - village.originX) ** 2 + (p.z - village.originZ) ** 2;
        if (dist2 > 400) continue; // within 20 blocks
        const nearbyVillagers = Object.values(entities).filter((e) =>
          e.kind === 'villager' &&
          (e.x - village.originX) ** 2 + (e.z - village.originZ) ** 2 < 400
        ).length;
        if (nearbyVillagers >= 3 || Math.random() >= 0.03) continue;
        const h = World.heightAt(Math.round(village.originX), Math.round(village.originZ));
        entities['e' + (entityIdCounter++)] = {
          kind: 'villager', x: village.originX + 1.5, y: h + 1.5, z: village.originZ + 1.5,
          health: 30, dim: 'overworld'
        };
      }
    }
  }

  if (!night) {
    // dungeon spawner mobs are exempt - the whole point is they threaten the
    // dungeon regardless of time of day, unlike the ambient night spawns
    for (const id in entities) {
      if (entities[id].dim === 'overworld' && HOSTILE_KINDS.has(entities[id].kind) && !entities[id].fromSpawner) delete entities[id];
    }
  }

  // passive animal spawn (overworld, daytime, light cap)
  const animalCount = Object.values(entities).filter((e) => e.dim === 'overworld' && PASSIVE_KINDS.has(e.kind)).length;
  if (!night && overworldPlayers.length > 0 && animalCount < overworldPlayers.length * 3 && Math.random() < 0.08) {
    const [, target] = overworldPlayers[Math.floor(Math.random() * overworldPlayers.length)];
    const angle = Math.random() * Math.PI * 2;
    const dist = 8 + Math.random() * 10;
    const mx = target.x + Math.cos(angle) * dist;
    const mz = target.z + Math.sin(angle) * dist;
    const h = World.heightAt(Math.round(mx), Math.round(mz));
    const roll = Math.random();
    const kind = roll < 0.28 ? 'cow' : roll < 0.53 ? 'pig' : roll < 0.78 ? 'sheep' : 'chicken';
    const health = kind === 'chicken' ? 6 : 10;
    entities['e' + (entityIdCounter++)] = { kind, x: mx, y: h + 1.5, z: mz, health, dim: 'overworld', wanderT: 0 };
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
          const speed = (ent.kind === 'boss' ? 1.6 : ent.kind === 'spider' ? 1.8 : ent.kind === 'creeper' ? 1.3 : 1.2) * (TICK_MS / 1000);
          if (len > keepDistance + 1) {
            ent.x += (dx / len) * speed;
            ent.z += (dz / len) * speed;
          }
          if (ent.dim === 'overworld') ent.y = World.heightAt(Math.round(ent.x), Math.round(ent.z)) + 1.5;
        }
        // True 3D distance - horizontal-only would let a mob below you in a
        // ravine or above you on a ledge still land hits just for being
        // close on the flat plane, regardless of the actual vertical gap.
        const dx2 = nearest.x - ent.x, dy2 = nearest.y - ent.y, dz2 = nearest.z - ent.z;
        const nd2 = dx2 * dx2 + dy2 * dy2 + dz2 * dz2;
        if (ent.kind === 'creeper') {
          if (nd2 < CREEPER_FUSE_RANGE_SQ) {
            ent.fuseT = (ent.fuseT || 0) + TICK_MS;
            if (ent.fuseT >= CREEPER_FUSE_MS) {
              explodeCreeper(ent);
              delete entities[id];
            }
          } else {
            ent.fuseT = 0;
          }
        } else {
          const dmg = ent.kind === 'boss' ? 4 : 1;
          const range = ent.kind === 'skeleton' ? 49 : MELEE_RANGE_SQ;
          const cooldown = ent.kind === 'skeleton' ? 2200 : 1800;
          if (nd2 < range && (!ent.lastHit || Date.now() - ent.lastHit > cooldown)) {
            applyDamage(nearest, dmg);
            ent.lastHit = Date.now();
          }
        }
      }
    } else if (PASSIVE_KINDS.has(ent.kind)) {
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

// Damages nearby players (falloff with distance) and blows a small crater out
// of the terrain, same as a real chunk edit so it persists and syncs like any
// other block removal. Shared by creeper deaths and detonating TNT.
function triggerExplosion(cx, cy, cz, dim, radius) {
  for (const p of Object.values(players)) {
    if (p.dim !== dim) continue;
    const d = Math.hypot(p.x - cx, p.y - cy, p.z - cz);
    if (d < radius + 1.5) {
      const dmg = Math.round(10 * (1 - d / (radius + 1.5)));
      if (dmg > 0) applyDamage(p, dmg);
    }
  }

  const removed = [];
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dz = -radius; dz <= radius; dz++) {
        if (dx * dx + dy * dy + dz * dz > radius * radius + 1) continue;
        const y = cy + dy;
        if (y <= World.BEDROCK_Y) continue;
        removed.push({ x: cx + dx, y, z: cz + dz });
      }
    }
  }
  for (const { x, y, z } of removed) {
    const key = dim === 'nether' ? NETHER_KEY : chunkEditKeyFor(x, z);
    if (!chunkEdits[key]) chunkEdits[key] = {};
    let ek;
    if (dim === 'nether') {
      ek = x + ',' + y + ',' + z;
    } else {
      const [ecx, ecz] = World.worldToChunk(x, z);
      ek = (x - ecx * World.CHUNK_SIZE) + ',' + y + ',' + (z - ecz * World.CHUNK_SIZE);
    }
    chunkEdits[key][ek] = { action: 'remove' };
  }

  for (const [id, sock] of io.sockets.sockets) {
    const p = players[id];
    if (!p || p.dim !== dim) continue;
    sock.emit('explosion', { x: cx, y: cy, z: cz, radius });
    for (const { x, y, z } of removed) sock.emit('blockEdit', { x, y, z, action: 'remove' });
  }
}

function explodeCreeper(ent) {
  triggerExplosion(Math.round(ent.x), Math.round(ent.y - 1.5), Math.round(ent.z), ent.dim, EXPLOSION_RADIUS);
}

loadWorld();
setInterval(saveWorld, SAVE_INTERVAL_MS);
function shutdownAndSave(signal) {
  console.log(`${signal} received, saving world before exit...`);
  saveWorld();
  process.exit(0);
}
process.on('SIGTERM', () => shutdownAndSave('SIGTERM'));
process.on('SIGINT', () => shutdownAndSave('SIGINT'));

server.listen(PORT, () => console.log('Server running on http://localhost:' + PORT));
