// ---------- Procedural audio (no external sound files) ----------
let audioCtx = null;
function ensureAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
}

function playTone({ freq = 440, duration = 0.12, type = 'sine', volume = 0.15, slideTo = null }) {
  if (!audioCtx) return;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
  if (slideTo !== null) osc.frequency.linearRampToValueAtTime(slideTo, audioCtx.currentTime + duration);
  gain.gain.setValueAtTime(volume, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start();
  osc.stop(audioCtx.currentTime + duration);
}

function playNoise({ duration = 0.1, volume = 0.15, filterFreq = 1200 }) {
  if (!audioCtx) return;
  const bufferSize = Math.floor(audioCtx.sampleRate * duration);
  const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
  const src = audioCtx.createBufferSource();
  src.buffer = buffer;
  const filter = audioCtx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = filterFreq;
  const gain = audioCtx.createGain();
  gain.gain.setValueAtTime(volume, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
  src.connect(filter);
  filter.connect(gain);
  gain.connect(audioCtx.destination);
  src.start();
}

const sfx = {
  footstep: () => playNoise({ duration: 0.08, volume: 0.06, filterFreq: 800 }),
  breakBlock: () => playNoise({ duration: 0.15, volume: 0.18, filterFreq: 1500 }),
  placeBlock: () => playNoise({ duration: 0.1, volume: 0.14, filterFreq: 600 }),
  jump: () => playTone({ freq: 300, slideTo: 420, duration: 0.15, type: 'sine', volume: 0.12 }),
  land: () => playNoise({ duration: 0.12, volume: 0.2, filterFreq: 400 }),
  hurt: () => playTone({ freq: 180, slideTo: 90, duration: 0.25, type: 'sawtooth', volume: 0.18 }),
  attack: () => playTone({ freq: 500, slideTo: 250, duration: 0.1, type: 'triangle', volume: 0.14 }),
  splash: () => playNoise({ duration: 0.2, volume: 0.15, filterFreq: 2000 }),
  nightfall: () => playTone({ freq: 220, slideTo: 110, duration: 1.2, type: 'sine', volume: 0.08 }),
  daybreak: () => playTone({ freq: 330, slideTo: 440, duration: 1.2, type: 'sine', volume: 0.08 })
};

// ---------- Scene setup ----------
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputEncoding = THREE.sRGBEncoding;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const hemiLight = new THREE.HemisphereLight(0xbfe3ff, 0x3a2f28, 1.0);
scene.add(hemiLight);
const sunLight = new THREE.DirectionalLight(0xfff1d6, 1.0);
sunLight.castShadow = true;
sunLight.shadow.mapSize.set(1536, 1536);
sunLight.shadow.camera.near = 1;
sunLight.shadow.camera.far = 150;
sunLight.shadow.camera.left = -40;
sunLight.shadow.camera.right = 40;
sunLight.shadow.camera.top = 40;
sunLight.shadow.camera.bottom = -40;
sunLight.shadow.bias = -0.0015;
scene.add(sunLight);
scene.add(sunLight.target);

// ---------- Sun & moon sprites ----------
function makeGlowTexture(rgb) {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, `rgba(${rgb},1)`);
  grad.addColorStop(0.4, `rgba(${rgb},0.9)`);
  grad.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}
const sunSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: makeGlowTexture('255,244,214'), transparent: true, depthWrite: false, fog: false }));
sunSprite.scale.set(16, 16, 1);
scene.add(sunSprite);
const moonSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: makeGlowTexture('222,228,245'), transparent: true, depthWrite: false, fog: false }));
moonSprite.scale.set(11, 11, 1);
scene.add(moonSprite);

const DAY_SKY = new THREE.Color(0x7ec0ee);
const NIGHT_SKY = new THREE.Color(0x0a0e2a);
const UNDERWATER_TINT = new THREE.Color(0x1a4a7a);

// ---------- Block-break particles ----------
const particleGeo = new THREE.BoxGeometry(0.15, 0.15, 0.15);
const particleMaterials = {};
const activeParticles = [];
function spawnBreakParticles(x, y, z, material) {
  if (!particleMaterials[material]) {
    particleMaterials[material] = new THREE.MeshLambertMaterial({ color: MATERIAL_COLORS[material] || 0x888888 });
  }
  const mat = particleMaterials[material];
  for (let i = 0; i < 6; i++) {
    const mesh = new THREE.Mesh(particleGeo, mat);
    mesh.position.set(x + (Math.random() - 0.5) * 0.7, y + (Math.random() - 0.5) * 0.7, z + (Math.random() - 0.5) * 0.7);
    scene.add(mesh);
    activeParticles.push({
      mesh,
      velocity: new THREE.Vector3((Math.random() - 0.5) * 2.5, Math.random() * 2.5 + 1, (Math.random() - 0.5) * 2.5),
      life: 0.6
    });
  }
}
function updateParticles(dt) {
  for (let i = activeParticles.length - 1; i >= 0; i--) {
    const p = activeParticles[i];
    p.life -= dt;
    if (p.life <= 0) { scene.remove(p.mesh); activeParticles.splice(i, 1); continue; }
    p.velocity.y -= 9 * dt;
    p.mesh.position.addScaledVector(p.velocity, dt);
    p.mesh.scale.setScalar(Math.max(0, p.life / 0.6));
  }
}
scene.fog = new THREE.Fog(0x7ec0ee, 50, 110);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------- Weather particles (rain/snow) ----------
const WEATHER_COUNT = 300;
const WEATHER_RADIUS = 18;
const weatherGeo = new THREE.BufferGeometry();
const weatherPositions = new Float32Array(WEATHER_COUNT * 3);
for (let i = 0; i < WEATHER_COUNT; i++) {
  weatherPositions[i * 3] = (Math.random() - 0.5) * WEATHER_RADIUS * 2;
  weatherPositions[i * 3 + 1] = Math.random() * 20;
  weatherPositions[i * 3 + 2] = (Math.random() - 0.5) * WEATHER_RADIUS * 2;
}
weatherGeo.setAttribute('position', new THREE.BufferAttribute(weatherPositions, 3));
const weatherMat = new THREE.PointsMaterial({ color: 0xaaccff, size: 0.15, transparent: true, opacity: 0.7 });
const weatherPoints = new THREE.Points(weatherGeo, weatherMat);
weatherPoints.visible = false;
scene.add(weatherPoints);

function updateWeather(dt) {
  const biome = World.biomeAt(Math.round(camera.position.x), Math.round(camera.position.z));
  const active = isRaining && biome !== 'desert';
  weatherPoints.visible = active;
  // keep the particle cloud centered on the player horizontally; only local Y cycles
  weatherPoints.position.x = camera.position.x;
  weatherPoints.position.z = camera.position.z;
  if (!active) return;
  const snowing = biome === 'snow';
  weatherMat.color.set(snowing ? 0xffffff : 0xaaccff);
  weatherMat.size = snowing ? 0.12 : 0.15;
  const fallSpeed = (snowing ? 3 : 14) * dt;
  const pos = weatherGeo.attributes.position.array;
  for (let i = 0; i < WEATHER_COUNT; i++) {
    pos[i * 3 + 1] -= fallSpeed;
    if (pos[i * 3 + 1] < -2) {
      pos[i * 3] = (Math.random() - 0.5) * WEATHER_RADIUS * 2;
      pos[i * 3 + 1] = 20;
      pos[i * 3 + 2] = (Math.random() - 0.5) * WEATHER_RADIUS * 2;
    }
  }
  weatherGeo.attributes.position.needsUpdate = true;
}

// ---------- Block materials & global instanced meshes ----------
const CHUNK_SIZE = World.CHUNK_SIZE;
const MATERIAL_COLORS = {
  grass: 0x4caf50, dirt: 0x8b5a2b, stone: 0x888888,
  wood: 0x5c3d1e, leaves: 0x2e6b2e, planks: 0xd2b48c, bedrock: 0x2b2b2e,
  sand: 0xdbc76e, snow: 0xf2f6f8,
  bed: 0xc23b3b,
  wheat_young: 0x9acd32, wheat_ripe: 0xe8c547,
  lever: 0x6b6b6b, plate: 0x7a7a5a, door: 0x8a5a3a,
  rail: 0x9a9a9a, portal: 0x8e2de2, netherrack: 0x6b2020, lava: 0xff4500, water: 0x3a6fd8,
  furnace: 0x555050, glass: 0xcfe8e8, wool: 0xf0ede4, stairs: 0xc9a876, slab: 0xdcc199,
  enchant_table: 0x2d6b5e, brewing_stand: 0x6b4a8a, piston: 0x7a8a5a, hopper: 0x4a4a4a,
  nether_brick: 0x3a1414
};
const UNBREAKABLE = new Set(['bedrock', 'lava', 'water']);
const boxGeo = new THREE.BoxGeometry(1, 1, 1);
const meshes = {};       // material -> InstancedMesh
const meshUserData = {}; // material -> { count, capacity, positions: [] }

// Small procedural noise texture per material - crisp/pixelated on purpose,
// so blocks read as textured surfaces instead of flat plastic color.
function makeBlockTexture(hexColor, variance, grain) {
  const size = 16;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const base = new THREE.Color(hexColor);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
      n = n - Math.floor(n);
      if (grain === 'vertical') n = (n + (x % 3) * 0.15) % 1;
      const shade = 1 + (n - 0.5) * variance;
      const r = Math.min(255, Math.max(0, Math.round(base.r * 255 * shade)));
      const g = Math.min(255, Math.max(0, Math.round(base.g * 255 * shade)));
      const b = Math.min(255, Math.max(0, Math.round(base.b * 255 * shade)));
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}
const MATERIAL_VARIANCE = {
  grass: 0.35, dirt: 0.4, stone: 0.3, wood: 0.5, leaves: 0.4, planks: 0.3, bedrock: 0.5,
  sand: 0.25, snow: 0.15, bed: 0.3, wheat_young: 0.3, wheat_ripe: 0.3,
  lever: 0.3, plate: 0.3, door: 0.35, rail: 0.3, portal: 0.5, netherrack: 0.4, lava: 0.3, water: 0.2,
  furnace: 0.35, glass: 0.15, wool: 0.2, stairs: 0.3, slab: 0.3,
  enchant_table: 0.4, brewing_stand: 0.4, piston: 0.35, hopper: 0.3, nether_brick: 0.35
};
const MATERIAL_GRAIN = { wood: 'vertical', planks: 'vertical', door: 'vertical' };
const blockTextures = {};
Object.keys(MATERIAL_COLORS).forEach((m) => {
  blockTextures[m] = makeBlockTexture(MATERIAL_COLORS[m], MATERIAL_VARIANCE[m] || 0.3, MATERIAL_GRAIN[m]);
});

function createMeshFor(material, capacity) {
  const mat = new THREE.MeshLambertMaterial({ map: blockTextures[material] });
  const mesh = new THREE.InstancedMesh(boxGeo, mat, capacity);
  mesh.count = 0;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  scene.add(mesh);
  meshes[material] = mesh;
  meshUserData[material] = { count: 0, capacity, positions: new Array(capacity) };
  return mesh;
}
Object.keys(MATERIAL_COLORS).forEach((m) => createMeshFor(m, 2048));

function growCapacity(material) {
  const old = meshes[material];
  const oldUd = meshUserData[material];
  const newCap = oldUd.capacity * 2;
  const mat = old.material;
  const mesh = new THREE.InstancedMesh(boxGeo, mat, newCap);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const m4 = new THREE.Matrix4();
  for (let i = 0; i < oldUd.count; i++) {
    old.getMatrixAt(i, m4);
    mesh.setMatrixAt(i, m4);
  }
  mesh.count = oldUd.count;
  scene.remove(old);
  scene.add(mesh);
  meshes[material] = mesh;
  const newUd = { count: oldUd.count, capacity: newCap, positions: oldUd.positions.concat(new Array(newCap - oldUd.capacity)) };
  meshUserData[material] = newUd;
}

const blockAt = new Map();       // "x,y,z" -> { material, index, chunkKey }
const chunkBlockKeys = new Map(); // "cx,cz" -> Set of "x,y,z"
const columnBlocks = new Map();   // "x,z" -> Set of y
const portalBlocks = new Set();   // "x,y,z" keys of placed portal blocks
const plateBlocks = new Set();    // "x,y,z" keys of placed pressure plates
const doorPositions = new Set();  // "x,y,z" keys of doors ever placed (open or closed)
const pistonPositions = new Set(); // "x,y,z" keys of placed pistons
const hopperPositions = new Set(); // "x,y,z" keys of placed hoppers
const fallingBlocks = new Set();  // "x,y,z" keys of sand blocks that may need to fall

function bkey(x, y, z) { return x + ',' + y + ',' + z; }
function ckey(x, z) { return x + ',' + z; }

function addBlockInstance(x, y, z, material, chunkKey) {
  const k = bkey(x, y, z);
  if (blockAt.has(k)) return;
  const ud = meshUserData[material];
  if (ud.count >= ud.capacity) growCapacity(material);
  const mesh = meshes[material];
  const udNow = meshUserData[material];
  const idx = udNow.count;
  const m4 = new THREE.Matrix4().makeTranslation(x, y, z);
  mesh.setMatrixAt(idx, m4);
  udNow.positions[idx] = { x, y, z };
  udNow.count++;
  mesh.count = udNow.count;
  mesh.instanceMatrix.needsUpdate = true;
  blockAt.set(k, { material, index: idx, chunkKey });

  if (chunkKey) {
    if (!chunkBlockKeys.has(chunkKey)) chunkBlockKeys.set(chunkKey, new Set());
    chunkBlockKeys.get(chunkKey).add(k);
  }
  const ck = ckey(x, z);
  if (!columnBlocks.has(ck)) columnBlocks.set(ck, new Set());
  columnBlocks.get(ck).add(y);
  if (material === 'portal') portalBlocks.add(k);
  if (material === 'plate') plateBlocks.add(k);
  if (material === 'door') doorPositions.add(k);
  if (material === 'piston') pistonPositions.add(k);
  if (material === 'hopper') hopperPositions.add(k);
}

function removeBlockInstance(x, y, z) {
  const k = bkey(x, y, z);
  const entry = blockAt.get(k);
  if (!entry) return null;
  const mesh = meshes[entry.material];
  const ud = meshUserData[entry.material];
  const last = ud.count - 1;
  if (entry.index !== last) {
    const m4 = new THREE.Matrix4();
    mesh.getMatrixAt(last, m4);
    mesh.setMatrixAt(entry.index, m4);
    const lastPos = ud.positions[last];
    ud.positions[entry.index] = lastPos;
    const lastKey = bkey(lastPos.x, lastPos.y, lastPos.z);
    const lastEntry = blockAt.get(lastKey);
    if (lastEntry) { lastEntry.index = entry.index; blockAt.set(lastKey, lastEntry); }
  }
  ud.count--;
  mesh.count = ud.count;
  mesh.instanceMatrix.needsUpdate = true;
  blockAt.delete(k);
  if (entry.chunkKey && chunkBlockKeys.has(entry.chunkKey)) chunkBlockKeys.get(entry.chunkKey).delete(k);
  const ck = ckey(x, z);
  const colSet = columnBlocks.get(ck);
  if (colSet) { colSet.delete(y); if (colSet.size === 0) columnBlocks.delete(ck); }
  portalBlocks.delete(k);
  plateBlocks.delete(k);
  const aboveEntry = blockAt.get(bkey(x, y + 1, z));
  if (aboveEntry && aboveEntry.material === 'sand') fallingBlocks.add(bkey(x, y + 1, z));
  return entry.material;
}

// Highest block at-or-below (current feet height + step-up allowance).
// Ignores floating blocks (e.g. a tree canopy's leaves) that sit far above
// the player - otherwise walking under/near a tree "ground-snaps" onto it.
function groundHeightBelow(x, z, feetY) {
  const rx = Math.round(x), rz = Math.round(z);
  const set = columnBlocks.get(ckey(rx, rz));
  if (!set || set.size === 0) return -Infinity;
  const maxY = feetY + 1.1;
  let best = -Infinity;
  for (const y of set) {
    if (y <= maxY && y > best) {
      const entry = blockAt.get(bkey(rx, y, rz));
      if (entry && entry.material === 'water') continue; // water has no standing surface
      best = y;
    }
  }
  return best;
}

// ---------- Chunk streaming ----------
const RENDER_DIST = 2;
const loadedChunks = new Set();
const requestedChunks = new Set();
const pendingEdits = new Map(); // chunkKey -> edits (received before we asked, safety)

// Tapered, rounded canopy (wide base -> mid layer -> small cap) instead of a
// solid cube blob, plus a deterministic trunk-height variation per tree.
function buildTree(wx, wz, groundHeight, chunkKey) {
  const v = World.hash(wx * 7.7 + 3.1, wz * 7.7 - 5.2);
  const trunkH = 4 + (v > 0.5 ? 1 : 0);
  const topY = groundHeight + trunkH - 1;

  for (let ty = groundHeight; ty < groundHeight + trunkH; ty++) {
    addBlockInstance(wx, ty, wz, 'wood', chunkKey);
  }

  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      if (Math.abs(dx) === 2 && Math.abs(dz) === 2) continue; // round off far corners
      if (dx === 0 && dz === 0) continue; // trunk already occupies this cell
      addBlockInstance(wx + dx, topY, wz + dz, 'leaves', chunkKey);
    }
  }
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      addBlockInstance(wx + dx, topY + 1, wz + dz, 'leaves', chunkKey);
    }
  }
  addBlockInstance(wx, topY + 2, wz, 'leaves', chunkKey);
  addBlockInstance(wx + 1, topY + 2, wz, 'leaves', chunkKey);
  addBlockInstance(wx - 1, topY + 2, wz, 'leaves', chunkKey);
  addBlockInstance(wx, topY + 2, wz + 1, 'leaves', chunkKey);
  addBlockInstance(wx, topY + 2, wz - 1, 'leaves', chunkKey);
}

function loadChunk(cx, cz, columns, edits) {
  const chunkKey = cx + ',' + cz;
  if (loadedChunks.has(chunkKey)) return;
  loadedChunks.add(chunkKey);
  requestedChunks.delete(chunkKey);

  for (const localKey in columns) {
    const [lx, lz] = localKey.split(',').map(Number);
    const wx = cx * CHUNK_SIZE + lx;
    const wz = cz * CHUNK_SIZE + lz;
    const { height, tree, biome } = columns[localKey];
    for (let y = World.BEDROCK_Y; y < height; y++) {
      if (World.isCave(wx, y, wz, height)) continue;
      addBlockInstance(wx, y, wz, World.materialAt(y, height, biome), chunkKey);
    }
    if (tree) buildTree(wx, wz, height, chunkKey);
  }

  // apply persisted edits on top of procedural base
  for (const localKey in edits) {
    const [lx, y, lz] = localKey.split(',').map(Number);
    const wx = cx * CHUNK_SIZE + lx;
    const wz = cz * CHUNK_SIZE + lz;
    const edit = edits[localKey];
    if (edit.action === 'remove') removeBlockInstance(wx, y, wz);
    else addBlockInstance(wx, y, wz, edit.material, chunkKey);
  }
}

function unloadChunkByKey(chunkKey) {
  const keys = chunkBlockKeys.get(chunkKey);
  if (keys) {
    for (const k of Array.from(keys)) {
      const [x, y, z] = k.split(',').map(Number);
      removeBlockInstance(x, y, z);
    }
  }
  chunkBlockKeys.delete(chunkKey);
  loadedChunks.delete(chunkKey);
}
function unloadChunk(cx, cz) { unloadChunkByKey(cx + ',' + cz); }
function unloadAllOverworldChunks() {
  for (const key of Array.from(loadedChunks)) unloadChunkByKey(key);
}

function updateChunks() {
  const [pcx, pcz] = World.worldToChunk(camera.position.x, camera.position.z);
  const wanted = new Set();
  for (let dx = -RENDER_DIST; dx <= RENDER_DIST; dx++) {
    for (let dz = -RENDER_DIST; dz <= RENDER_DIST; dz++) {
      const cx = pcx + dx, cz = pcz + dz;
      const key = cx + ',' + cz;
      wanted.add(key);
      if (!loadedChunks.has(key) && !requestedChunks.has(key)) {
        requestedChunks.add(key);
        socket.emit('requestChunk', { cx, cz });
      }
    }
  }
  for (const key of Array.from(loadedChunks)) {
    if (!wanted.has(key)) {
      const [cx, cz] = key.split(',').map(Number);
      unloadChunk(cx, cz);
    }
  }
}

// ---------- Networking ----------
const socket = io();
let selfId = null;
let dayLength = 240000;
const remotePlayers = new Map(); // id -> { mesh, target }
const remoteEntities = new Map(); // id -> { mesh, target, kind }
let dayClock = 0;
let lastDayClock = 0;
let isRaining = false;
let myHealth = 20, myHunger = 20;
let currentDim = 'overworld';
let overworldReturnPos = null;
let portalCooldownUntil = 0;

const SKIN_TONE = 0xe0ac69;
function makePlayerMesh(color) {
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshLambertMaterial({ color });
  const skinMat = new THREE.MeshLambertMaterial({ color: SKIN_TONE });

  const head = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.45, 0.45), skinMat);
  head.position.y = 1.475;

  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.65, 0.3), bodyMat);
  torso.position.y = 0.925;

  const legGeo = new THREE.BoxGeometry(0.22, 0.65, 0.25);
  const legL = new THREE.Mesh(legGeo, bodyMat);
  legL.position.set(-0.13, 0.325, 0);
  const legR = new THREE.Mesh(legGeo, bodyMat);
  legR.position.set(0.13, 0.325, 0);

  const armGeo = new THREE.BoxGeometry(0.2, 0.65, 0.2);
  const armL = new THREE.Mesh(armGeo, skinMat);
  armL.position.set(-0.35, 0.925, 0);
  const armR = new THREE.Mesh(armGeo, skinMat);
  armR.position.set(0.35, 0.925, 0);

  [head, torso, legL, legR, armL, armR].forEach((m) => { m.castShadow = true; group.add(m); });
  scene.add(group);
  return group;
}

const ENTITY_LOOKS = {
  zombie: { body: 0x2f5c2f, head: 0x3a703a, scale: 1 },
  skeleton: { body: 0xd8d8c8, head: 0xe8e8d8, scale: 1 },
  boss: { body: 0x3a0d0d, head: 0x5c1414, scale: 1.9 },
  cow: { body: 0x5a3d2b, head: 0xffffff, scale: 1.1 },
  pig: { body: 0xe8a0a8, head: 0xf0b8c0, scale: 0.9 },
  spider: { body: 0x1a1414, head: 0x2a1e1e, scale: 0.85 },
  enderman: { body: 0x111111, head: 0x8e2de2, scale: 1.6 },
  villager: { body: 0x8a6a4a, head: 0xd9b98a, scale: 1.05 }
};
function makeEntityMesh(kind) {
  const look = ENTITY_LOOKS[kind] || ENTITY_LOOKS.zombie;
  const group = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.2, 0.5), new THREE.MeshLambertMaterial({ color: look.body }));
  body.position.y = 0.6;
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), new THREE.MeshLambertMaterial({ color: look.head }));
  head.position.y = 1.45;
  body.castShadow = head.castShadow = true;
  group.add(body, head);
  group.scale.setScalar(look.scale);
  scene.add(group);
  return group;
}

function addRemotePlayer(id, p) {
  const mesh = makePlayerMesh(p.color);
  mesh.position.set(p.x, p.y, p.z);
  remotePlayers.set(id, { mesh, target: { x: p.x, y: p.y, z: p.z, ry: p.ry || 0 } });
}
function removeRemotePlayer(id) {
  const rp = remotePlayers.get(id);
  if (rp) scene.remove(rp.mesh);
  remotePlayers.delete(id);
}
const remoteEntitiesByGroup = new WeakSet();
function addRemoteEntity(id, e) {
  const mesh = makeEntityMesh(e.kind);
  mesh.position.set(e.x, e.y, e.z);
  mesh.userData.entityId = id;
  mesh.userData.kind = e.kind;
  remoteEntitiesByGroup.add(mesh);
  remoteEntities.set(id, { mesh, target: { x: e.x, y: e.y, z: e.z }, kind: e.kind });
}
function removeRemoteEntity(id) {
  const re = remoteEntities.get(id);
  if (re) scene.remove(re.mesh);
  remoteEntities.delete(id);
}

const playersOnlineEl = document.getElementById('players-online');
const toastContainer = document.getElementById('toast-container');
const unlockedAchievements = new Set();
function unlockAchievement(id, text) {
  if (unlockedAchievements.has(id)) return;
  unlockedAchievements.add(id);
  showToast('Achievement unlocked: ' + text);
}
function showToast(text) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  toastContainer.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 350); }, 2200);
}

socket.on('init', (data) => {
  selfId = data.selfId;
  dayLength = data.dayLength;
  const spawn = data.players[selfId];
  if (spawn) camera.position.set(spawn.x, spawn.y, spawn.z);
  for (const [id, p] of Object.entries(data.players)) if (id !== selfId) addRemotePlayer(id, p);
  for (const [id, e] of Object.entries(data.entities)) addRemoteEntity(id, e);
  playersOnlineEl.textContent = 'Players online: ' + (Object.keys(data.players).length);
});
socket.on('playerJoined', (p) => {
  if (p.id !== selfId) addRemotePlayer(p.id, p);
  playersOnlineEl.textContent = 'Players online: ' + (remotePlayers.size + 1);
});
socket.on('playerLeft', ({ id }) => {
  removeRemotePlayer(id);
  playersOnlineEl.textContent = 'Players online: ' + (remotePlayers.size + 1);
});
socket.on('chunkData', ({ cx, cz, columns, edits }) => loadChunk(cx, cz, columns, edits));
socket.on('blockEdit', ({ x, y, z, action, material }) => {
  const chunkKey = currentDim === 'nether' ? 'nether,nether' : (() => {
    const [cx, cz] = World.worldToChunk(x, z);
    return cx + ',' + cz;
  })();
  if (currentDim === 'overworld' && !loadedChunks.has(chunkKey)) return;
  if (action === 'remove') {
    removeBlockInstance(x, y, z);
  } else {
    if (blockAt.has(bkey(x, y, z))) removeBlockInstance(x, y, z); // replace in place (e.g. crop growth)
    addBlockInstance(x, y, z, material, chunkKey);
  }
});
socket.on('respawn', ({ x, y, z, fromNether }) => {
  if (fromNether || currentDim === 'nether') {
    unloadChunkByKey('nether,nether');
    currentDim = 'overworld';
    showToast('Died in the Nether - back in the Overworld');
  }
  camera.position.set(x, y, z);
  velocityY = 0;
});
socket.on('gameOver', () => {
  gameOver = true;
  document.getElementById('gameover-banner').style.display = 'flex';
  try { controls.unlock(); } catch (e) { /* no-op if not locked */ }
});
socket.on('netherArena', ({ edits, spawn }) => {
  unloadAllOverworldChunks();
  for (const key in edits) {
    const [x, y, z] = key.split(',').map(Number);
    if (edits[key].action === 'add') addBlockInstance(x, y, z, edits[key].material, 'nether,nether');
  }
  currentDim = 'nether';
  camera.position.set(spawn.x, spawn.y, spawn.z);
  velocityY = 0;
  portalCooldownUntil = performance.now() + 2000;
  showToast('Entered the Nether!');
  unlockAchievement('nether_entered', 'Into the Fire');
});
socket.on('overworldReturn', ({ x, y, z }) => {
  unloadChunkByKey('nether,nether');
  currentDim = 'overworld';
  camera.position.set(x, y, z);
  velocityY = 0;
  portalCooldownUntil = performance.now() + 2000;
  showToast('Back in the Overworld');
});
socket.on('lootDrop', ({ kind }) => {
  if (kind === 'cow' || kind === 'pig') {
    inventory.meat = (inventory.meat || 0) + 2;
    renderHotbar();
    showToast('+2 meat');
  }
});
socket.on('tick', (data) => {
  for (const [id, p] of Object.entries(data.players)) {
    if (id === selfId) {
      if (p.health < myHealth - 0.5) sfx.hurt();
      myHealth = p.health; myHunger = p.hunger; continue;
    }
    let rp = remotePlayers.get(id);
    if (!rp) { addRemotePlayer(id, p); rp = remotePlayers.get(id); }
    rp.target = { x: p.x, y: p.y, z: p.z, ry: p.ry };
  }
  const activeIds = new Set(Object.keys(data.entities));
  for (const [id, e] of Object.entries(data.entities)) {
    let re = remoteEntities.get(id);
    if (!re) { addRemoteEntity(id, e); re = remoteEntities.get(id); }
    re.target = { x: e.x, y: e.y, z: e.z };
  }
  for (const id of Array.from(remoteEntities.keys())) if (!activeIds.has(id)) removeRemoteEntity(id);
  dayClock = data.dayClock;
  isRaining = !!data.isRaining;
});

// ---------- Player controls ----------
// Mouse-look (via Pointer Lock) is optional - arrow keys always work as a
// keyboard-only alternative, since not every player has a mouse.
camera.rotation.order = 'YXZ';
const controls = new THREE.PointerLockControls(camera, document.body);
const instructions = document.getElementById('instructions');
let gameStarted = false;
function startGame() {
  // Releasing the mouse (ESC, alt-tab, losing pointer lock) should not
  // "un-start" the game or freeze keyboard play - only the very first call
  // flips gameStarted; every call still tries to (re)acquire the mouse.
  if (!gameStarted) {
    gameStarted = true;
    ensureAudio();
  }
  instructions.style.display = 'none';
  try { controls.lock(); } catch (e) { /* no mouse available - keyboard controls still work */ }
}
instructions.addEventListener('click', startGame);
controls.addEventListener('unlock', () => { instructions.style.display = 'flex'; });

const move = { forward: false, back: false, left: false, right: false, up: false, down: false };
const look = { left: false, right: false, up: false, down: false };
let velocityY = 0;
let onGround = false;
let fallPeakY = null;
let footstepTimer = 0;
let inWater = false;
const GRAVITY = -20;
const JUMP_SPEED = 8;
const MOVE_SPEED = 6;
const FLY_SPEED = 8;
const TURN_SPEED = 2.4; // radians/sec for keyboard look

// ---------- Collision (AABB player vs voxel grid) ----------
const EYE_HEIGHT = 1.3;   // eye above feet
const PLAYER_HEIGHT = 1.7; // total body height
const PLAYER_RADIUS = 0.3;
const STEP_HEIGHT = 1.05;  // auto-climb ledges up to one block tall while grounded

function isSolidBlock(x, y, z) {
  const entry = blockAt.get(bkey(Math.round(x), Math.round(y), Math.round(z)));
  return !!entry && entry.material !== 'water'; // water is passable/swimmable, not solid
}

// Can the player's body occupy this eye position without overlapping a solid block?
function canStandAt(ex, ey, ez) {
  const feetY = ey - EYE_HEIGHT;
  const sampleYs = [feetY + 0.15, feetY + PLAYER_HEIGHT - 0.15];
  const offsets = [-PLAYER_RADIUS, PLAYER_RADIUS];
  for (const sy of sampleYs) {
    for (const ox of offsets) {
      for (const oz of offsets) {
        if (isSolidBlock(ex + ox, sy, ez + oz)) return false;
      }
    }
  }
  return true;
}

function blockOverlapsPlayer(bx, by, bz) {
  const feetY = camera.position.y - EYE_HEIGHT;
  const headY = feetY + PLAYER_HEIGHT;
  const withinY = (by + 0.5) > feetY && (by - 0.5) < headY;
  const withinXZ = Math.abs(bx - camera.position.x) < (PLAYER_RADIUS + 0.5) &&
                    Math.abs(bz - camera.position.z) < (PLAYER_RADIUS + 0.5);
  return withinY && withinXZ;
}

// ---------- Inventory & hotbar ----------
const HOTBAR_ORDER = ['dirt', 'stone', 'grass', 'wood', 'leaves', 'planks'];
const inventory = {
  grass: 0, dirt: 10, stone: 5, wood: 0, leaves: 0, planks: 0, apple: 2, meat: 0,
  bed: 0, bow: 0, rail: 0, lever: 0, plate: 0, door: 0, portal: 1,
  wheat_seeds: 0, wheat: 0, water: 1, lava: 1,
  sand: 0, furnace: 0, glass: 0, wool: 0, stairs: 0, slab: 0, cooked_meat: 0,
  enchant_table: 0, brewing_stand: 0, piston: 0, hopper: 0,
  potion_speed: 0, potion_strength: 0, fish: 0, carrot: 0, potato: 0, carrot_seeds: 0, potato_seeds: 0,
  tools: { pickaxe: null, axe: null, sword: null }
};
let selectedMaterial = 'dirt';
let heldSpecial = null; // 'bed' | 'lever' | 'plate' | 'door' | 'rail' | 'portal' | 'bow' | 'wheat_seeds' | null
const hotbarEl = document.getElementById('hotbar');
const TOOL_TIER_RANK = { wood: 1, stone: 2 };

function renderHotbar() {
  hotbarEl.innerHTML = '';
  HOTBAR_ORDER.forEach((material, i) => {
    const slot = document.createElement('div');
    slot.className = 'slot' + (!heldSpecial && material === selectedMaterial ? ' active' : '');
    slot.innerHTML = `<span class="key">${i + 1}</span><span class="count">${inventory[material]}</span>
      <span class="swatch" style="background:#${MATERIAL_COLORS[material].toString(16).padStart(6, '0')}"></span>`;
    hotbarEl.appendChild(slot);
  });
  if (heldSpecial) {
    const slot = document.createElement('div');
    slot.className = 'slot active';
    const color = heldSpecial === 'bow' ? 0xd2a679 : (MATERIAL_COLORS[heldSpecial] || 0xffffff);
    slot.innerHTML = `<span class="key">held</span><span class="count">${inventory[heldSpecial]}</span>
      <span class="swatch" style="background:#${color.toString(16).padStart(6, '0')}"></span>`;
    hotbarEl.appendChild(slot);
  }
}
renderHotbar();

// ---------- Crafting menu ----------
const RECIPES = [
  { id: 'planks', name: 'Planks (1 wood -> 4 planks)', cost: { wood: 1 }, give: { planks: 4 } },
  { id: 'bed', name: 'Bed (3 planks)', cost: { planks: 3 }, give: { bed: 1 } },
  { id: 'pickaxe_wood', name: 'Wood Pickaxe (3 planks)', cost: { planks: 3 }, tool: { pickaxe: 'wood' } },
  { id: 'axe_wood', name: 'Wood Axe (3 planks)', cost: { planks: 3 }, tool: { axe: 'wood' } },
  { id: 'sword_wood', name: 'Wood Sword (2 planks)', cost: { planks: 2 }, tool: { sword: 'wood' } },
  { id: 'pickaxe_stone', name: 'Stone Pickaxe (3 stone)', cost: { stone: 3 }, tool: { pickaxe: 'stone' }, requireTool: { pickaxe: 'wood' } },
  { id: 'axe_stone', name: 'Stone Axe (3 stone)', cost: { stone: 3 }, tool: { axe: 'stone' }, requireTool: { axe: 'wood' } },
  { id: 'sword_stone', name: 'Stone Sword (2 stone)', cost: { stone: 2 }, tool: { sword: 'stone' }, requireTool: { sword: 'wood' } },
  { id: 'bow', name: 'Bow (3 wood)', cost: { wood: 3 }, give: { bow: 1 } },
  { id: 'rail', name: 'Rail x4 (2 stone)', cost: { stone: 2 }, give: { rail: 4 } },
  { id: 'lever', name: 'Lever (1 stone)', cost: { stone: 1 }, give: { lever: 1 } },
  { id: 'plate', name: 'Pressure Plate (2 planks)', cost: { planks: 2 }, give: { plate: 1 } },
  { id: 'door', name: 'Door (4 planks)', cost: { planks: 4 }, give: { door: 1 } },
  { id: 'portal', name: 'Portal Block (6 stone)', cost: { stone: 6 }, give: { portal: 1 } },
  { id: 'furnace', name: 'Furnace (5 stone)', cost: { stone: 5 }, give: { furnace: 1 } },
  { id: 'wool', name: 'Wool (2 leaves)', cost: { leaves: 2 }, give: { wool: 1 } },
  { id: 'stairs', name: 'Stairs x4 (4 planks)', cost: { planks: 4 }, give: { stairs: 4 } },
  { id: 'slab', name: 'Slabs x4 (2 planks)', cost: { planks: 2 }, give: { slab: 4 } },
  { id: 'enchant_table', name: 'Enchant Table (4 stone + 2 wood)', cost: { stone: 4, wood: 2 }, give: { enchant_table: 1 } },
  { id: 'brewing_stand', name: 'Brewing Stand (2 stone + 1 wood)', cost: { stone: 2, wood: 1 }, give: { brewing_stand: 1 } },
  { id: 'piston', name: 'Piston (3 stone + 2 wood)', cost: { stone: 3, wood: 2 }, give: { piston: 1 } },
  { id: 'hopper', name: 'Hopper (5 stone)', cost: { stone: 5 }, give: { hopper: 1 } }
];
let craftMenuOpen = false;
let craftSelectedIndex = 0;
const craftMenuEl = document.getElementById('craft-menu');
const recipeListEl = document.getElementById('recipe-list');

function canAfford(recipe) {
  for (const mat in recipe.cost) if ((inventory[mat] || 0) < recipe.cost[mat]) return false;
  if (recipe.requireTool) {
    for (const t in recipe.requireTool) {
      const have = inventory.tools[t];
      if (!have || TOOL_TIER_RANK[have] < TOOL_TIER_RANK[recipe.requireTool[t]]) return false;
    }
  }
  if (recipe.tool) {
    for (const t in recipe.tool) {
      const have = inventory.tools[t];
      if (have && TOOL_TIER_RANK[have] >= TOOL_TIER_RANK[recipe.tool[t]]) return false; // already have this tier or better
    }
  }
  return true;
}

const HELD_SPECIAL_ITEMS = new Set(['bed', 'lever', 'plate', 'door', 'rail', 'portal', 'bow',
  'furnace', 'glass', 'wool', 'stairs', 'slab', 'enchant_table', 'brewing_stand', 'piston', 'hopper']);
function craftRecipe(recipe) {
  if (!canAfford(recipe)) { showToast("Can't craft that yet"); return; }
  for (const mat in recipe.cost) inventory[mat] -= recipe.cost[mat];
  if (recipe.give) {
    for (const item in recipe.give) {
      inventory[item] = (inventory[item] || 0) + recipe.give[item];
      if (HELD_SPECIAL_ITEMS.has(item)) heldSpecial = item;
    }
  }
  if (recipe.tool) for (const t in recipe.tool) inventory.tools[t] = recipe.tool[t];
  renderHotbar();
  renderCraftMenu();
  showToast('Crafted ' + recipe.name.split(' (')[0]);
  unlockAchievement('first_craft', 'Crafter');
}

function renderCraftMenu() {
  recipeListEl.innerHTML = '';
  RECIPES.forEach((r, i) => {
    const row = document.createElement('div');
    row.className = 'recipe' + (i === craftSelectedIndex ? ' selected' : '');
    row.style.opacity = canAfford(r) ? '1' : '0.4';
    row.innerHTML = `<span class="name">${r.name}</span>`;
    row.addEventListener('click', () => craftRecipe(r));
    recipeListEl.appendChild(row);
  });
}

function toggleCraftMenu() {
  craftMenuOpen = !craftMenuOpen;
  craftMenuEl.style.display = craftMenuOpen ? 'flex' : 'none';
  if (craftMenuOpen) renderCraftMenu();
}

// ---------- Inventory screen ----------
const ITEM_DISPLAY = {
  dirt: { name: 'Dirt' }, stone: { name: 'Stone' }, grass: { name: 'Grass' },
  wood: { name: 'Wood' }, leaves: { name: 'Leaves' }, planks: { name: 'Planks' },
  apple: { name: 'Apple', color: 0xd94f4f }, meat: { name: 'Raw Meat', color: 0xaa5544 },
  bed: { name: 'Bed' }, bow: { name: 'Bow', color: 0xd2a679 }, rail: { name: 'Rail' },
  lever: { name: 'Lever' }, plate: { name: 'Pressure Plate' }, door: { name: 'Door' },
  portal: { name: 'Portal' }, wheat_seeds: { name: 'Seeds', color: 0xc7d84a }, wheat: { name: 'Wheat' },
  water: { name: 'Water Bucket' }, lava: { name: 'Lava Bucket' },
  sand: { name: 'Sand' }, furnace: { name: 'Furnace' }, glass: { name: 'Glass' }, wool: { name: 'Wool' },
  stairs: { name: 'Stairs' }, slab: { name: 'Slab' }, cooked_meat: { name: 'Cooked Meat', color: 0x8a5a3a },
  enchant_table: { name: 'Enchant Table' }, brewing_stand: { name: 'Brewing Stand' },
  piston: { name: 'Piston' }, hopper: { name: 'Hopper' },
  potion_speed: { name: 'Speed Potion', color: 0x4ad0e0 }, potion_strength: { name: 'Strength Potion', color: 0xc03030 },
  fish: { name: 'Fish', color: 0x8fb3c9 }, carrot: { name: 'Carrot', color: 0xe08a2b }, potato: { name: 'Potato', color: 0xc9a86a }
};
let invScreenOpen = false;
const invScreenEl = document.getElementById('inv-screen');
const invGridEl = document.getElementById('inv-grid');
const invToolsEl = document.getElementById('inv-tools');

function renderInventoryScreen() {
  invGridEl.innerHTML = '';
  for (const key in ITEM_DISPLAY) {
    const info = ITEM_DISPLAY[key];
    const color = info.color != null ? info.color : (MATERIAL_COLORS[key] != null ? MATERIAL_COLORS[key] : 0x999999);
    const count = inventory[key] || 0;
    const cell = document.createElement('div');
    cell.className = 'inv-cell';
    cell.style.opacity = count > 0 ? '1' : '0.35';
    cell.innerHTML = `<span class="inv-count">${count}</span>
      <span class="swatch" style="background:#${color.toString(16).padStart(6, '0')}"></span>
      <span class="inv-name">${info.name}</span>`;
    invGridEl.appendChild(cell);
  }
  const t = inventory.tools;
  invToolsEl.innerHTML = `<span>Pickaxe: ${t.pickaxe || 'none'}</span><span>Axe: ${t.axe || 'none'}</span><span>Sword: ${t.sword || 'none'}</span>`;
}

function toggleInventoryScreen() {
  invScreenOpen = !invScreenOpen;
  invScreenEl.style.display = invScreenOpen ? 'flex' : 'none';
  if (invScreenOpen) renderInventoryScreen();
}

const STARTER_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'Enter',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

function eatFood() {
  if (inventory.cooked_meat >= 1) { inventory.cooked_meat -= 1; socket.emit('eat', { amount: 14 }); showToast('Ate cooked meat'); }
  else if (inventory.fish >= 1) { inventory.fish -= 1; socket.emit('eat', { amount: 8 }); showToast('Ate fish'); }
  else if (inventory.meat >= 1) { inventory.meat -= 1; socket.emit('eat', { amount: 10 }); showToast('Ate raw meat'); }
  else if (inventory.carrot >= 1) { inventory.carrot -= 1; socket.emit('eat', { amount: 5 }); showToast('Ate carrot'); }
  else if (inventory.potato >= 1) { inventory.potato -= 1; socket.emit('eat', { amount: 5 }); showToast('Ate potato'); }
  else if (inventory.apple >= 1) { inventory.apple -= 1; socket.emit('eat', { amount: 6 }); showToast('Ate apple'); }
  else { showToast('No food to eat'); return; }
  renderHotbar();
  document.getElementById('apple-count').textContent =
    `Apples: ${inventory.apple} | Meat: ${inventory.meat} (F to eat)`;
}

document.addEventListener('keydown', (e) => {
  if (!gameStarted && STARTER_KEYS.has(e.code)) startGame();

  if (craftMenuOpen) {
    if (e.code === 'ArrowUp') { craftSelectedIndex = (craftSelectedIndex - 1 + RECIPES.length) % RECIPES.length; renderCraftMenu(); }
    else if (e.code === 'ArrowDown') { craftSelectedIndex = (craftSelectedIndex + 1) % RECIPES.length; renderCraftMenu(); }
    else if (e.code === 'Enter') { craftRecipe(RECIPES[craftSelectedIndex]); }
    else if (e.code === 'KeyE' || e.code === 'Escape') { toggleCraftMenu(); }
    return;
  }
  if (invScreenOpen) {
    if (e.code === 'KeyX' || e.code === 'Escape') toggleInventoryScreen();
    return;
  }

  switch (e.code) {
    case 'KeyW': move.forward = true; break;
    case 'KeyS': move.back = true; break;
    case 'KeyA': move.left = true; break;
    case 'KeyD': move.right = true; break;
    case 'ArrowLeft': look.left = true; break;
    case 'ArrowRight': look.right = true; break;
    case 'ArrowUp': look.up = true; break;
    case 'ArrowDown': look.down = true; break;
    case 'Space':
      if (creativeMode || spectatorMode) move.up = true;
      else if (inWater) move.up = true;
      else if (onGround) { velocityY = JUMP_SPEED; onGround = false; sfx.jump(); }
      break;
    case 'ShiftLeft': move.down = true; break;
    case 'Digit1': case 'Digit2': case 'Digit3': case 'Digit4': case 'Digit5': case 'Digit6': {
      const idx = Number(e.code.slice(5)) - 1;
      if (HOTBAR_ORDER[idx]) { selectedMaterial = HOTBAR_ORDER[idx]; heldSpecial = null; renderHotbar(); }
      break;
    }
    case 'Digit7':
      if (inventory.wheat_seeds > 0) { heldSpecial = 'wheat_seeds'; renderHotbar(); showToast('Holding wheat seeds'); }
      break;
    case 'Digit8':
      if (inventory.water > 0) { heldSpecial = 'water'; renderHotbar(); showToast('Holding water bucket'); }
      break;
    case 'Digit9':
      if (inventory.lava > 0) { heldSpecial = 'lava'; renderHotbar(); showToast('Holding lava bucket'); }
      break;
    case 'KeyE': toggleCraftMenu(); break;
    case 'KeyX': toggleInventoryScreen(); break;
    case 'KeyF': eatFood(); break;
    case 'KeyB': breedNearby(); break;
    case 'KeyN': sleepInBed(); break;
    case 'KeyG': toggleCreative(); break;
    case 'KeyP': toggleHardcore(); break;
    case 'KeyO': toggleSpectator(); break;
    case 'KeyR': toggleRide(); break;
    case 'KeyC': useNearbyBlock(); break;
    case 'KeyV': drinkPotion(); break;
    case 'KeyT': tradeWithVillager(); break;
    case 'KeyH': goFishing(); break;
    case 'KeyJ': if (gameStarted && !spectatorMode && !gameOver) breakOrAttack(); break;
    case 'KeyK': if (gameStarted && !spectatorMode && !gameOver) placeBlock(); break;
  }
});
document.addEventListener('keyup', (e) => {
  switch (e.code) {
    case 'KeyW': move.forward = false; break;
    case 'KeyS': move.back = false; break;
    case 'KeyA': move.left = false; break;
    case 'KeyD': move.right = false; break;
    case 'ArrowLeft': look.left = false; break;
    case 'ArrowRight': look.right = false; break;
    case 'ArrowUp': look.up = false; break;
    case 'ArrowDown': look.down = false; break;
    case 'Space': move.up = false; break;
    case 'ShiftLeft': move.down = false; break;
  }
});

// ---------- Breaking / placing / attacking ----------
const raycaster = new THREE.Raycaster();
raycaster.far = 8;
const centerVec = new THREE.Vector2(0, 0);
document.addEventListener('contextmenu', (e) => e.preventDefault());

const SWORD_DAMAGE = { none: 3, wood: 6, stone: 10 };

function breakOrAttack() {
  raycaster.setFromCamera(centerVec, camera);

  const entityMeshes = Array.from(remoteEntities.values()).map((m) => m.mesh);
  const entityHits = raycaster.intersectObjects(entityMeshes, true);
  if (entityHits.length > 0) {
    const hitGroup = findEntityGroup(entityHits[0].object);
    const entityId = hitGroup && hitGroup.userData.entityId;
    if (entityId) {
      let dmg = SWORD_DAMAGE[inventory.tools.sword || 'none'];
      if (inventory.tools.swordEnchanted) dmg += TOOL_ENCHANT_BONUS.sword;
      if (performance.now() < strengthBuffUntil) dmg += 3;
      socket.emit('attackEntity', { entityId, damage: dmg });
      sfx.attack();
      unlockAchievement('first_attack', 'Fighter');
      return;
    }
  }

  const hits = raycaster.intersectObjects(Object.values(meshes));
  if (hits.length === 0) return;
  const hit = hits[0];
  const material = meshOwner(hit.object);
  const pos = meshUserData[material].positions[hit.instanceId];
  if (!pos || UNBREAKABLE.has(material)) return;

  if (material === 'lever' || material === 'plate') { activateNearestMechanism(pos); return; }
  if (material === 'stone' && !inventory.tools.pickaxe) { showToast('Need a pickaxe to mine stone'); return; }

  removeBlockInstance(pos.x, pos.y, pos.z);
  if (material === 'wheat_ripe') {
    inventory.wheat = (inventory.wheat || 0) + 1;
    inventory.wheat_seeds = (inventory.wheat_seeds || 0) + 1;
  } else if (material === 'wheat_young') {
    inventory.wheat_seeds = (inventory.wheat_seeds || 0) + 1;
  } else if (material === 'wood') {
    inventory.wood = (inventory.wood || 0) + (inventory.tools.axe ? 3 : 1);
  } else {
    inventory[material] = (inventory[material] || 0) + 1;
  }
  if (material === 'leaves' && Math.random() < 0.25) inventory.apple = (inventory.apple || 0) + 1;
  if (material === 'grass') {
    const roll = Math.random();
    if (roll < 0.3) inventory.wheat_seeds = (inventory.wheat_seeds || 0) + 1;
    else if (roll < 0.38) { inventory.carrot = (inventory.carrot || 0) + 1; unlockAchievement('first_carrot', 'Root Vegetables'); }
    else if (roll < 0.46) { inventory.potato = (inventory.potato || 0) + 1; unlockAchievement('first_carrot', 'Root Vegetables'); }
  }
  renderHotbar();
  document.getElementById('apple-count').textContent = `Apples: ${inventory.apple} | Meat: ${inventory.meat} (F to eat)`;
  socket.emit('blockEdit', { x: pos.x, y: pos.y, z: pos.z, action: 'remove' });
  sfx.breakBlock();
  spawnBreakParticles(pos.x, pos.y, pos.z, material);
  unlockAchievement('first_break', 'Block Breaker');
}

function placeBlock() {
  if (heldSpecial === 'bow') { shootBow(); return; }

  raycaster.setFromCamera(centerVec, camera);
  const hits = raycaster.intersectObjects(Object.values(meshes));
  if (hits.length === 0) return;
  const hit = hits[0];
  const material = meshOwner(hit.object);
  const pos = meshUserData[material].positions[hit.instanceId];
  if (!pos) return;

  const placeMaterial = heldSpecial === 'wheat_seeds' ? 'wheat_young' : (heldSpecial || selectedMaterial);
  const invKey = heldSpecial || selectedMaterial;
  if (!creativeMode && (inventory[invKey] || 0) <= 0) return;

  const n = hit.face.normal;
  const nx = Math.round(pos.x + n.x), ny = Math.round(pos.y + n.y), nz = Math.round(pos.z + n.z);
  if (blockAt.has(bkey(nx, ny, nz))) return;
  if (blockOverlapsPlayer(nx, ny, nz)) return;
  const chunkKey = currentDim === 'nether' ? 'nether,nether' : (() => {
    const [cx, cz] = World.worldToChunk(nx, nz);
    return cx + ',' + cz;
  })();
  if (!creativeMode) inventory[invKey] -= 1;
  renderHotbar();
  addBlockInstance(nx, ny, nz, placeMaterial, chunkKey);
  socket.emit('blockEdit', { x: nx, y: ny, z: nz, action: 'add', material: placeMaterial });
  sfx.placeBlock();
  if (placeMaterial === 'sand') fallingBlocks.add(bkey(nx, ny, nz));

  if (placeMaterial === 'portal') portalCooldownUntil = Math.max(portalCooldownUntil, performance.now());
  if (placeMaterial === 'wheat_young') unlockAchievement('first_plant', 'Farmer');
  if (placeMaterial === 'water' || placeMaterial === 'lava') {
    spreadFluid(nx, ny, nz, placeMaterial);
    unlockAchievement('first_fluid', 'Plumber');
  }
  unlockAchievement('first_place', 'Builder');
}

// Simple one-shot flood-fill spread (not a continuous simulation) - falls
// first, then spreads sideways up to a material-specific distance.
function spreadFluid(sx, sy, sz, material) {
  const maxDist = material === 'lava' ? 3 : 6;
  const maxPlaced = 40;
  const visited = new Set([bkey(sx, sy, sz)]);
  const queue = [{ x: sx, y: sy, z: sz, dist: 0 }];
  let placed = 0;
  while (queue.length && placed < maxPlaced) {
    const cur = queue.shift();
    const downKey = bkey(cur.x, cur.y - 1, cur.z);
    if (!blockAt.has(downKey) && !visited.has(downKey)) {
      visited.add(downKey);
      placeFluidCell(cur.x, cur.y - 1, cur.z, material);
      placed++;
      queue.push({ x: cur.x, y: cur.y - 1, z: cur.z, dist: 0 });
      continue;
    }
    if (cur.dist >= maxDist) continue;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cur.x + dx, nz = cur.z + dz;
      const k = bkey(nx, cur.y, nz);
      if (!blockAt.has(k) && !visited.has(k)) {
        visited.add(k);
        placeFluidCell(nx, cur.y, nz, material);
        placed++;
        queue.push({ x: nx, y: cur.y, z: nz, dist: cur.dist + 1 });
      }
    }
  }
}
function placeFluidCell(x, y, z, material) {
  const chunkKey = currentDim === 'nether' ? 'nether,nether' : (() => {
    const [cx, cz] = World.worldToChunk(x, z);
    return cx + ',' + cz;
  })();
  addBlockInstance(x, y, z, material, chunkKey);
  socket.emit('blockEdit', { x, y, z, action: 'add', material });
}

document.addEventListener('mousedown', (e) => {
  if (!gameStarted || craftMenuOpen || invScreenOpen || spectatorMode || gameOver) return;
  if (e.button === 0) breakOrAttack();
  else if (e.button === 2) placeBlock();
});

// ---------- Extra interactions: bed/sleep, breeding, creative, minecart, bow ----------
function findNearbyBlockOfType(material, radius, originX, originY, originZ) {
  const cx = Math.round(originX != null ? originX : camera.position.x);
  const cy = Math.round((originY != null ? originY : camera.position.y - EYE_HEIGHT));
  const cz = Math.round(originZ != null ? originZ : camera.position.z);
  let best = null, bestDist = Infinity;
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dz = -radius; dz <= radius; dz++) {
        const entry = blockAt.get(bkey(cx + dx, cy + dy, cz + dz));
        if (entry && entry.material === material) {
          const d = dx * dx + dy * dy + dz * dz;
          if (d < bestDist) { bestDist = d; best = { x: cx + dx, y: cy + dy, z: cz + dz }; }
        }
      }
    }
  }
  return best;
}

function findNearestDoorPosition(originX, originY, originZ, radius) {
  let best = null, bestDist = Infinity;
  for (const key of doorPositions) {
    const [dx, dy, dz] = key.split(',').map(Number);
    const d = (dx - originX) ** 2 + (dy - originY) ** 2 + (dz - originZ) ** 2;
    if (d < bestDist && d <= radius * radius) { bestDist = d; best = { x: dx, y: dy, z: dz }; }
  }
  return best;
}

function findNearestPositionIn(set, originX, originY, originZ, radius) {
  let best = null, bestDist = Infinity;
  for (const key of set) {
    const [dx, dy, dz] = key.split(',').map(Number);
    const d = (dx - originX) ** 2 + (dy - originY) ** 2 + (dz - originZ) ** 2;
    if (d < bestDist && d <= radius * radius) { bestDist = d; best = { x: dx, y: dy, z: dz }; }
  }
  return best;
}

function toggleNearestDoor(fromPos) {
  const door = findNearestDoorPosition(fromPos.x, fromPos.y, fromPos.z, 3);
  if (!door) { showToast('No door nearby'); return; }
  if (blockAt.has(bkey(door.x, door.y, door.z))) {
    removeBlockInstance(door.x, door.y, door.z);
    socket.emit('blockEdit', { x: door.x, y: door.y, z: door.z, action: 'remove' });
    showToast('Door opened');
  } else {
    const chunkKey = currentDim === 'nether' ? 'nether,nether' : (() => {
      const [cx, cz] = World.worldToChunk(door.x, door.z);
      return cx + ',' + cz;
    })();
    addBlockInstance(door.x, door.y, door.z, 'door', chunkKey);
    socket.emit('blockEdit', { x: door.x, y: door.y, z: door.z, action: 'add', material: 'door' });
    showToast('Door closed');
  }
}

function activatePiston(pistonPos) {
  const fromKey = bkey(pistonPos.x + 1, pistonPos.y, pistonPos.z);
  const toKey = bkey(pistonPos.x + 2, pistonPos.y, pistonPos.z);
  const entry = blockAt.get(fromKey);
  if (!entry || UNBREAKABLE.has(entry.material)) { showToast('Nothing to push'); return; }
  if (blockAt.has(toKey)) { showToast('Piston is blocked'); return; }
  const material = entry.material;
  removeBlockInstance(pistonPos.x + 1, pistonPos.y, pistonPos.z);
  socket.emit('blockEdit', { x: pistonPos.x + 1, y: pistonPos.y, z: pistonPos.z, action: 'remove' });
  const chunkKey = currentDim === 'nether' ? 'nether,nether' : (() => {
    const [cx, cz] = World.worldToChunk(pistonPos.x + 2, pistonPos.z);
    return cx + ',' + cz;
  })();
  addBlockInstance(pistonPos.x + 2, pistonPos.y, pistonPos.z, material, chunkKey);
  socket.emit('blockEdit', { x: pistonPos.x + 2, y: pistonPos.y, z: pistonPos.z, action: 'add', material });
  showToast('Piston pushed a block (pushes toward +X)');
  unlockAchievement('first_piston', 'Redstone Engineer');
}

function activateNearestMechanism(fromPos) {
  const door = findNearestDoorPosition(fromPos.x, fromPos.y, fromPos.z, 3);
  const piston = findNearestPositionIn(pistonPositions, fromPos.x, fromPos.y, fromPos.z, 3);
  if (door && piston) {
    const dd = (door.x - fromPos.x) ** 2 + (door.y - fromPos.y) ** 2 + (door.z - fromPos.z) ** 2;
    const pd = (piston.x - fromPos.x) ** 2 + (piston.y - fromPos.y) ** 2 + (piston.z - fromPos.z) ** 2;
    if (dd <= pd) toggleNearestDoor(fromPos); else activatePiston(piston);
  } else if (door) {
    toggleNearestDoor(fromPos);
  } else if (piston) {
    activatePiston(piston);
  } else {
    showToast('No door or piston nearby');
  }
}

function sleepInBed() {
  const bed = findNearbyBlockOfType('bed', 4);
  if (!bed) { showToast('No bed nearby'); return; }
  socket.emit('setBedSpawn', bed);
  socket.emit('sleep');
  showToast('Zzz... spawn set to bed');
}

const TOOL_ENCHANT_BONUS = { sword: 3 };
function useNearbyBlock() {
  if (findNearbyBlockOfType('furnace', 3)) { smeltAtFurnace(); return; }
  if (findNearbyBlockOfType('enchant_table', 3)) { enchantTool(); return; }
  if (findNearbyBlockOfType('brewing_stand', 3)) { brewPotion(); return; }
  showToast('No furnace, enchant table, or brewing stand nearby');
}

function smeltAtFurnace() {
  if (inventory.sand > 0) {
    inventory.sand -= 1;
    inventory.glass = (inventory.glass || 0) + 1;
    showToast('Smelted sand into glass');
  } else if (inventory.meat > 0) {
    inventory.meat -= 1;
    inventory.cooked_meat = (inventory.cooked_meat || 0) + 1;
    showToast('Cooked meat');
  } else {
    showToast('Nothing to smelt (need sand or raw meat)');
    return;
  }
  renderHotbar();
  unlockAchievement('first_smelt', 'Smelter');
}

function enchantTool() {
  if (inventory.tools.sword && !inventory.tools.swordEnchanted && inventory.wheat >= 3) {
    inventory.wheat -= 3;
    inventory.tools.swordEnchanted = true;
    renderHotbar();
    showToast('Sword enchanted! +3 damage');
    unlockAchievement('first_enchant', 'Enchanter');
  } else if (!inventory.tools.sword) {
    showToast('Need a sword to enchant');
  } else if (inventory.tools.swordEnchanted) {
    showToast('Sword is already enchanted');
  } else {
    showToast('Need 3 wheat to pay for enchanting');
  }
}

function brewPotion() {
  if (inventory.apple >= 2) {
    inventory.apple -= 2;
    inventory.potion_speed = (inventory.potion_speed || 0) + 1;
    showToast('Brewed a Speed Potion');
  } else if (inventory.meat >= 2 || inventory.cooked_meat >= 1) {
    if (inventory.cooked_meat >= 1) inventory.cooked_meat -= 1; else inventory.meat -= 2;
    inventory.potion_strength = (inventory.potion_strength || 0) + 1;
    showToast('Brewed a Strength Potion');
  } else {
    showToast('Need 2 apples (speed) or meat (strength) to brew');
    return;
  }
  renderHotbar();
  unlockAchievement('first_brew', 'Brewer');
}

let speedBuffUntil = 0;
let strengthBuffUntil = 0;
function drinkPotion() {
  if (inventory.potion_speed > 0) {
    inventory.potion_speed -= 1;
    speedBuffUntil = performance.now() + 20000;
    showToast('Speed boost! (20s)');
  } else if (inventory.potion_strength > 0) {
    inventory.potion_strength -= 1;
    strengthBuffUntil = performance.now() + 20000;
    showToast('Strength boost! (20s)');
  } else {
    showToast('No potions to drink');
    return;
  }
  renderHotbar();
}

function goFishing() {
  const water = findNearbyBlockOfType('water', 4);
  if (!water) { showToast('No water nearby to fish in'); return; }
  if (Math.random() < 0.5) {
    inventory.fish = (inventory.fish || 0) + 1;
    renderHotbar();
    showToast('Caught a fish!');
    unlockAchievement('first_fish', 'Angler');
  } else {
    showToast('Nothing bit...');
  }
}

function breedNearby() {
  const nearby = Array.from(remoteEntities.values()).filter((re) =>
    (re.kind === 'cow' || re.kind === 'pig') && re.mesh.position.distanceTo(camera.position) < 6
  );
  if (nearby.length < 2) { showToast('Need 2 animals nearby to breed'); return; }
  const kind = nearby[0].kind;
  const pair = nearby.filter((re) => re.kind === kind);
  if (pair.length < 2) { showToast('Need 2 of the same animal'); return; }
  if (inventory.apple < 1 && inventory.meat < 1) { showToast('Need food to breed'); return; }
  if (inventory.apple >= 1) inventory.apple -= 1; else inventory.meat -= 1;
  renderHotbar();
  socket.emit('breedEntities', { entityId: pair[0].mesh.userData.entityId });
  showToast('Bred a baby ' + kind + '!');
  unlockAchievement('first_breed', 'Animal Whisperer');
}

const TRADE_REWARDS = [
  () => ({ item: 'stone', amount: 5 }),
  () => ({ item: 'planks', amount: 4 }),
  () => ({ item: 'apple', amount: 2 }),
  () => ({ item: 'meat', amount: 2 })
];
function tradeWithVillager() {
  const villager = Array.from(remoteEntities.values()).find((re) =>
    re.kind === 'villager' && re.mesh.position.distanceTo(camera.position) < 5
  );
  if (!villager) { showToast('No villager nearby'); return; }
  if ((inventory.wheat || 0) < 5) { showToast('Villager wants 5 wheat to trade'); return; }
  inventory.wheat -= 5;
  const reward = TRADE_REWARDS[Math.floor(Math.random() * TRADE_REWARDS.length)]();
  inventory[reward.item] = (inventory[reward.item] || 0) + reward.amount;
  renderHotbar();
  showToast(`Traded 5 wheat for ${reward.amount} ${reward.item}`);
  unlockAchievement('first_trade', 'Trader');
}

let creativeMode = false;
function toggleCreative() {
  creativeMode = !creativeMode;
  velocityY = 0;
  showToast(creativeMode ? 'Creative mode ON (unlimited blocks + flight)' : 'Creative mode OFF');
}

let hardcoreMode = false;
function toggleHardcore() {
  hardcoreMode = !hardcoreMode;
  socket.emit('setHardcore', { hardcore: hardcoreMode });
  showToast(hardcoreMode ? 'HARDCORE ON - death is permanent!' : 'Hardcore mode off');
}

let spectatorMode = false;
function toggleSpectator() {
  spectatorMode = !spectatorMode;
  velocityY = 0;
  showToast(spectatorMode ? 'Spectator mode ON (fly through blocks, no interaction)' : 'Spectator mode off');
}

let gameOver = false;

let riding = false;
function toggleRide() {
  const feetKey = bkey(Math.round(camera.position.x), Math.round(camera.position.y - EYE_HEIGHT - 0.5), Math.round(camera.position.z));
  const onRail = blockAt.get(feetKey);
  if (!riding && (!onRail || onRail.material !== 'rail')) { showToast('Not standing on a rail'); return; }
  riding = !riding;
  showToast(riding ? 'Riding minecart' : 'Dismounted');
}

function checkPortalProximity() {
  if (!gameStarted || portalCooldownUntil > performance.now() || portalBlocks.size === 0) return;
  for (const key of portalBlocks) {
    const [px, py, pz] = key.split(',').map(Number);
    const dx = px - camera.position.x, dy = py - (camera.position.y - EYE_HEIGHT), dz = pz - camera.position.z;
    if (dx * dx + dy * dy + dz * dz < 0.9) {
      portalCooldownUntil = performance.now() + 3000;
      if (currentDim === 'overworld') {
        overworldReturnPos = { x: camera.position.x, y: camera.position.y, z: camera.position.z };
        socket.emit('enterNether');
      } else {
        socket.emit('enterOverworld', overworldReturnPos || { x: 0.5, y: 10, z: 0.5 });
      }
      return;
    }
  }
}

let plateTriggerCooldownUntil = 0;
function checkPressurePlate() {
  if (!gameStarted || plateBlocks.size === 0 || performance.now() < plateTriggerCooldownUntil) return;
  const feetKey = bkey(Math.round(camera.position.x), Math.round(camera.position.y - EYE_HEIGHT - 0.5), Math.round(camera.position.z));
  if (plateBlocks.has(feetKey)) {
    plateTriggerCooldownUntil = performance.now() + 2500;
    const [px, py, pz] = feetKey.split(',').map(Number);
    activateNearestMechanism({ x: px, y: py, z: pz });
  }
}

let lavaDamageCooldownUntil = 0;
function checkLavaContact() {
  if (!gameStarted || creativeMode || performance.now() < lavaDamageCooldownUntil) return;
  const feetKey = bkey(Math.round(camera.position.x), Math.round(camera.position.y - EYE_HEIGHT), Math.round(camera.position.z));
  const entry = blockAt.get(feetKey);
  if (entry && entry.material === 'lava') {
    lavaDamageCooldownUntil = performance.now() + 1000;
    socket.emit('takeDamage', { amount: 4 });
    showToast('Ouch! Lava!');
  }
}

let fallingBlocksCheckAt = 0;
function processFallingBlocks() {
  if (fallingBlocks.size === 0 || performance.now() < fallingBlocksCheckAt) return;
  fallingBlocksCheckAt = performance.now() + 120;
  for (const key of Array.from(fallingBlocks)) {
    const [x, y, z] = key.split(',').map(Number);
    const entry = blockAt.get(key);
    if (!entry || entry.material !== 'sand') { fallingBlocks.delete(key); continue; }
    if (blockAt.has(bkey(x, y - 1, z))) { fallingBlocks.delete(key); continue; } // supported, done falling
    removeBlockInstance(x, y, z);
    socket.emit('blockEdit', { x, y, z, action: 'remove' });
    const chunkKey = currentDim === 'nether' ? 'nether,nether' : (() => {
      const [cx, cz] = World.worldToChunk(x, z);
      return cx + ',' + cz;
    })();
    addBlockInstance(x, y - 1, z, 'sand', chunkKey);
    socket.emit('blockEdit', { x, y: y - 1, z, action: 'add', material: 'sand' });
    fallingBlocks.delete(key);
    fallingBlocks.add(bkey(x, y - 1, z));
  }
}

let hopperCheckCooldownUntil = 0;
function checkHopperAutoHarvest() {
  if (!gameStarted || hopperPositions.size === 0 || performance.now() < hopperCheckCooldownUntil) return;
  hopperCheckCooldownUntil = performance.now() + 3000;
  for (const key of hopperPositions) {
    const [hx, hy, hz] = key.split(',').map(Number);
    if ((hx - camera.position.x) ** 2 + (hz - camera.position.z) ** 2 > 64) continue; // must be within ~8 blocks
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        for (let dy = -1; dy <= 2; dy++) {
          const entry = blockAt.get(bkey(hx + dx, hy + dy, hz + dz));
          if (entry && entry.material === 'wheat_ripe') {
            removeBlockInstance(hx + dx, hy + dy, hz + dz);
            socket.emit('blockEdit', { x: hx + dx, y: hy + dy, z: hz + dz, action: 'remove' });
            inventory.wheat = (inventory.wheat || 0) + 1;
            inventory.wheat_seeds = (inventory.wheat_seeds || 0) + 1;
            renderHotbar();
            showToast('Hopper collected wheat');
            unlockAchievement('first_hopper', 'Automation');
            return;
          }
        }
      }
    }
  }
}

function shootBow() {
  if (!inventory.bow) { showToast('No bow'); return; }
  raycaster.setFromCamera(centerVec, camera);
  const entityMeshes = Array.from(remoteEntities.values()).map((m) => m.mesh);
  const hits = raycaster.intersectObjects(entityMeshes, true);
  if (hits.length === 0) { showToast('Missed'); return; }
  const hitGroup = findEntityGroup(hits[0].object);
  const entityId = hitGroup && hitGroup.userData.entityId;
  if (entityId) socket.emit('attackEntity', { entityId, damage: 4 });
}

function meshOwner(object) {
  for (const material in meshes) if (meshes[material] === object) return material;
  return null;
}
function findEntityGroup(object) {
  let o = object;
  while (o) { if (remoteEntitiesByGroup.has(o)) return o; o = o.parent; }
  return null;
}

// ---------- Animation loop ----------
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.1);
  const menusOpen = craftMenuOpen || invScreenOpen || gameOver;

  if (!menusOpen) {
    if (look.left) camera.rotation.y += TURN_SPEED * dt;
    if (look.right) camera.rotation.y -= TURN_SPEED * dt;
    if (look.up) camera.rotation.x = Math.min(Math.PI / 2 - 0.05, camera.rotation.x + TURN_SPEED * 0.8 * dt);
    if (look.down) camera.rotation.x = Math.max(-(Math.PI / 2 - 0.05), camera.rotation.x - TURN_SPEED * 0.8 * dt);
  }

  if (gameStarted && !menusOpen && spectatorMode) {
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    dir.y = 0; dir.normalize();
    const right = new THREE.Vector3().crossVectors(dir, camera.up).normalize();
    const step = new THREE.Vector3();
    if (move.forward) step.add(dir);
    if (move.back) step.sub(dir);
    if (move.right) step.add(right);
    if (move.left) step.sub(right);
    if (step.lengthSq() > 0) step.normalize().multiplyScalar(FLY_SPEED * dt);
    camera.position.x += step.x;
    camera.position.z += step.z;
    if (move.up) camera.position.y += FLY_SPEED * dt;
    if (move.down) camera.position.y -= FLY_SPEED * dt;
  } else if (gameStarted && !menusOpen && riding) {
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    dir.y = 0; dir.normalize();
    const speed = 6 * dt;
    const nx = camera.position.x + dir.x * speed, nz = camera.position.z + dir.z * speed;
    const nextRail = blockAt.get(bkey(Math.round(nx), Math.round(camera.position.y - EYE_HEIGHT - 0.5), Math.round(nz)));
    if (nextRail && nextRail.material === 'rail') { camera.position.x = nx; camera.position.z = nz; }
    else { riding = false; showToast('End of track'); }
  } else if (gameStarted && !menusOpen && creativeMode) {
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    dir.y = 0; dir.normalize();
    const right = new THREE.Vector3().crossVectors(dir, camera.up).normalize();
    const step = new THREE.Vector3();
    if (move.forward) step.add(dir);
    if (move.back) step.sub(dir);
    if (move.right) step.add(right);
    if (move.left) step.sub(right);
    const effSpeed = MOVE_SPEED * (performance.now() < speedBuffUntil ? 1.6 : 1);
    if (step.lengthSq() > 0) step.normalize().multiplyScalar(effSpeed * dt);
    camera.position.x += step.x;
    camera.position.z += step.z;
    if (move.up) camera.position.y += FLY_SPEED * dt;
    if (move.down) camera.position.y -= FLY_SPEED * dt;
  } else if (gameStarted && !menusOpen) {
    const wasInWater = inWater;
    const waterCheckEntry = blockAt.get(bkey(Math.round(camera.position.x), Math.round(camera.position.y - EYE_HEIGHT + 0.6), Math.round(camera.position.z)));
    inWater = !!(waterCheckEntry && waterCheckEntry.material === 'water');
    if (inWater !== wasInWater) { sfx.splash(); fallPeakY = null; }

    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    dir.y = 0; dir.normalize();
    const right = new THREE.Vector3().crossVectors(dir, camera.up).normalize();

    const step = new THREE.Vector3();
    if (move.forward) step.add(dir);
    if (move.back) step.sub(dir);
    if (move.right) step.add(right);
    if (move.left) step.sub(right);
    const isMoving = step.lengthSq() > 0;
    const sprinting = onGround && move.down && isMoving && !inWater;
    const speedBuff = performance.now() < speedBuffUntil ? 1.6 : 1;
    const effSpeed = MOVE_SPEED * speedBuff * (sprinting ? 1.4 : 1) * (inWater ? 0.55 : 1);
    if (isMoving) step.normalize().multiplyScalar(effSpeed * dt);

    if (onGround && isMoving && !inWater) {
      footstepTimer -= dt;
      if (footstepTimer <= 0) { sfx.footstep(); footstepTimer = sprinting ? 0.28 : 0.4; }
    }

    const tryX = camera.position.x + step.x;
    if (canStandAt(tryX, camera.position.y, camera.position.z)) {
      camera.position.x = tryX;
    } else if (onGround && canStandAt(tryX, camera.position.y + STEP_HEIGHT, camera.position.z)) {
      camera.position.x = tryX;
      camera.position.y += STEP_HEIGHT;
    }
    const tryZ = camera.position.z + step.z;
    if (canStandAt(camera.position.x, camera.position.y, tryZ)) {
      camera.position.z = tryZ;
    } else if (onGround && canStandAt(camera.position.x, camera.position.y + STEP_HEIGHT, tryZ)) {
      camera.position.z = tryZ;
      camera.position.y += STEP_HEIGHT;
    }

    if (!onGround) fallPeakY = fallPeakY === null ? camera.position.y : Math.max(fallPeakY, camera.position.y);

    velocityY += GRAVITY * (inWater ? 0.25 : 1) * dt;
    if (inWater) {
      if (move.up) velocityY = Math.min(velocityY + 20 * dt, 3);
      velocityY = Math.max(velocityY, -3);
    }
    const tryY = camera.position.y + velocityY * dt;
    const feetY = camera.position.y - EYE_HEIGHT;

    if (velocityY <= 0) {
      const ground = groundHeightBelow(camera.position.x, camera.position.z, feetY);
      const feetLevel = (ground === -Infinity ? World.BEDROCK_Y - 1 : ground) + 0.5 + EYE_HEIGHT;
      if (tryY <= feetLevel) {
        if (!onGround && fallPeakY !== null) {
          const fallDistance = fallPeakY - feetLevel;
          if (fallDistance > 1.5) sfx.land();
          if (fallDistance > 4 && !creativeMode) {
            socket.emit('takeDamage', { amount: Math.round((fallDistance - 4) * 2) });
            showToast('Ouch! That fall hurt');
          }
        }
        fallPeakY = null;
        camera.position.y = feetLevel;
        velocityY = 0;
        onGround = true;
      } else {
        camera.position.y = tryY;
        onGround = false;
      }
    } else {
      if (canStandAt(camera.position.x, tryY, camera.position.z)) {
        camera.position.y = tryY;
      } else {
        velocityY = 0;
      }
      onGround = false;
    }
  }
  if (currentDim === 'overworld') updateChunks();
  checkPortalProximity();
  checkPressurePlate();
  checkLavaContact();
  checkHopperAutoHarvest();
  processFallingBlocks();
  updateParticles(dt);

  for (const [, rp] of remotePlayers) {
    rp.mesh.position.lerp(new THREE.Vector3(rp.target.x, rp.target.y - 0.9, rp.target.z), 0.25);
    rp.mesh.rotation.y = rp.target.ry;
  }
  for (const [, re] of remoteEntities) {
    re.mesh.position.lerp(new THREE.Vector3(re.target.x, re.target.y - 0.9, re.target.z), 0.25);
  }

  if (lastDayClock > 0.9 && dayClock < 0.1 && myHealth > 0) unlockAchievement('survived_night', 'Survived the Night');
  if (lastDayClock < 0.5 && dayClock >= 0.5) sfx.nightfall();
  if (lastDayClock < 0.95 && dayClock >= 0.95) sfx.daybreak();
  lastDayClock = dayClock;

  updateWeather(dt);

  // day/night visuals
  const fade = 0.05;
  let brightness;
  if (dayClock < 0.5 - fade) brightness = 1;
  else if (dayClock < 0.5 + fade) brightness = 1 - (dayClock - (0.5 - fade)) / (2 * fade);
  else if (dayClock < 0.95 - fade) brightness = 0;
  else if (dayClock < 0.95 + fade) brightness = (dayClock - (0.95 - fade)) / (2 * fade);
  else brightness = 1;

  const sky = DAY_SKY.clone().lerp(NIGHT_SKY, 1 - brightness);
  const eyeEntry = blockAt.get(bkey(Math.round(camera.position.x), Math.round(camera.position.y), Math.round(camera.position.z)));
  const eyeInWater = !!(eyeEntry && eyeEntry.material === 'water');
  if (eyeInWater) {
    scene.background = UNDERWATER_TINT;
    scene.fog.color = UNDERWATER_TINT;
    scene.fog.near = 2;
    scene.fog.far = 30;
  } else {
    scene.background = sky;
    scene.fog.color = sky;
    scene.fog.near = 50;
    scene.fog.far = 110;
  }
  sunLight.intensity = 0.25 + 0.95 * brightness;
  hemiLight.intensity = 0.35 + 0.75 * brightness;
  const angle = dayClock * Math.PI * 2;
  sunLight.position.set(
    camera.position.x + Math.cos(angle) * 60,
    Math.sin(angle) * 60 + 30,
    camera.position.z + 30
  );
  sunLight.target.position.copy(camera.position);
  sunLight.target.updateMatrixWorld();

  const skyDist = 200;
  sunSprite.position.set(camera.position.x + Math.cos(angle) * skyDist, Math.sin(angle) * skyDist + 40, camera.position.z + 40);
  moonSprite.position.set(camera.position.x - Math.cos(angle) * skyDist, -Math.sin(angle) * skyDist + 40, camera.position.z + 40);
  sunSprite.material.opacity = Math.max(0, Math.sin(angle)) * 0.5 + brightness * 0.5;
  moonSprite.material.opacity = Math.max(0, -Math.sin(angle)) * (1 - brightness * 0.5);

  document.getElementById('health-fill').style.width = Math.max(0, (myHealth / 20) * 100) + '%';
  document.getElementById('hunger-fill').style.width = Math.max(0, (myHunger / 20) * 100) + '%';
  document.getElementById('dead-banner').style.display = myHealth <= 0 ? 'flex' : 'none';

  renderer.render(scene, camera);
}

// periodic position broadcast
setInterval(() => {
  if (!controls.isLocked) return;
  socket.emit('move', {
    x: camera.position.x, y: camera.position.y, z: camera.position.z, ry: camera.rotation.y
  });
}, 100);

animate();
