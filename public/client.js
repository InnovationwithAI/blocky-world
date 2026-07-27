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

const DAY_SKY = new THREE.Color(0x7ec0ee);
const NIGHT_SKY = new THREE.Color(0x0a0e2a);
scene.fog = new THREE.Fog(0x7ec0ee, 50, 110);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------- Block materials & global instanced meshes ----------
const CHUNK_SIZE = World.CHUNK_SIZE;
const MATERIAL_COLORS = {
  grass: 0x4caf50, dirt: 0x8b5a2b, stone: 0x888888,
  wood: 0x5c3d1e, leaves: 0x2e6b2e, planks: 0xd2b48c, bedrock: 0x2b2b2e
};
const UNBREAKABLE = new Set(['bedrock']);
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
const MATERIAL_VARIANCE = { grass: 0.35, dirt: 0.4, stone: 0.3, wood: 0.5, leaves: 0.4, planks: 0.3, bedrock: 0.5 };
const MATERIAL_GRAIN = { wood: 'vertical', planks: 'vertical' };
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
  return entry.material;
}

// Highest block at-or-below (current feet height + step-up allowance).
// Ignores floating blocks (e.g. a tree canopy's leaves) that sit far above
// the player - otherwise walking under/near a tree "ground-snaps" onto it.
function groundHeightBelow(x, z, feetY) {
  const set = columnBlocks.get(ckey(Math.round(x), Math.round(z)));
  if (!set || set.size === 0) return -Infinity;
  const maxY = feetY + 1.1;
  let best = -Infinity;
  for (const y of set) {
    if (y <= maxY && y > best) best = y;
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
    const { height, tree } = columns[localKey];
    for (let y = World.BEDROCK_Y; y < height; y++) {
      addBlockInstance(wx, y, wz, World.materialAt(y, height), chunkKey);
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

function unloadChunk(cx, cz) {
  const chunkKey = cx + ',' + cz;
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
const remoteMobs = new Map();    // id -> { mesh, target }
let dayClock = 0;
let myHealth = 20, myHunger = 20;

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

function makeMobMesh() {
  const group = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.2, 0.5), new THREE.MeshLambertMaterial({ color: 0x2f5c2f }));
  body.position.y = 0.6;
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), new THREE.MeshLambertMaterial({ color: 0x3a703a }));
  head.position.y = 1.45;
  group.add(body, head);
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
const remoteMobsByGroup = new WeakSet();
function addRemoteMob(id, m) {
  const mesh = makeMobMesh();
  mesh.position.set(m.x, m.y, m.z);
  mesh.userData.mobId = id;
  remoteMobsByGroup.add(mesh);
  remoteMobs.set(id, { mesh, target: { x: m.x, y: m.y, z: m.z } });
}
function removeRemoteMob(id) {
  const rm = remoteMobs.get(id);
  if (rm) scene.remove(rm.mesh);
  remoteMobs.delete(id);
}

const playersOnlineEl = document.getElementById('players-online');

socket.on('init', (data) => {
  selfId = data.selfId;
  dayLength = data.dayLength;
  const spawn = data.players[selfId];
  if (spawn) camera.position.set(spawn.x, spawn.y, spawn.z);
  for (const [id, p] of Object.entries(data.players)) if (id !== selfId) addRemotePlayer(id, p);
  for (const [id, m] of Object.entries(data.mobs)) addRemoteMob(id, m);
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
  const [cx, cz] = World.worldToChunk(x, z);
  const chunkKey = cx + ',' + cz;
  if (!loadedChunks.has(chunkKey)) return;
  if (action === 'remove') removeBlockInstance(x, y, z);
  else addBlockInstance(x, y, z, material, chunkKey);
});
socket.on('respawn', ({ x, y, z }) => {
  camera.position.set(x, y, z);
  velocityY = 0;
});
socket.on('tick', (data) => {
  for (const [id, p] of Object.entries(data.players)) {
    if (id === selfId) { myHealth = p.health; myHunger = p.hunger; continue; }
    let rp = remotePlayers.get(id);
    if (!rp) { addRemotePlayer(id, p); rp = remotePlayers.get(id); }
    rp.target = { x: p.x, y: p.y, z: p.z, ry: p.ry };
  }
  const activeMobIds = new Set(Object.keys(data.mobs));
  for (const [id, m] of Object.entries(data.mobs)) {
    let rm = remoteMobs.get(id);
    if (!rm) { addRemoteMob(id, m); rm = remoteMobs.get(id); }
    rm.target = { x: m.x, y: m.y, z: m.z };
  }
  for (const id of Array.from(remoteMobs.keys())) if (!activeMobIds.has(id)) removeRemoteMob(id);
  dayClock = data.dayClock;
});

// ---------- Player controls ----------
// Mouse-look (via Pointer Lock) is optional - arrow keys always work as a
// keyboard-only alternative, since not every player has a mouse.
camera.rotation.order = 'YXZ';
const controls = new THREE.PointerLockControls(camera, document.body);
const instructions = document.getElementById('instructions');
let gameStarted = false;
function startGame() {
  if (gameStarted) return;
  gameStarted = true;
  instructions.style.display = 'none';
  try { controls.lock(); } catch (e) { /* no mouse available - keyboard controls still work */ }
}
instructions.addEventListener('click', startGame);
controls.addEventListener('unlock', () => { instructions.style.display = 'flex'; gameStarted = false; });

const move = { forward: false, back: false, left: false, right: false };
const look = { left: false, right: false, up: false, down: false };
let velocityY = 0;
let onGround = false;
const GRAVITY = -20;
const JUMP_SPEED = 8;
const MOVE_SPEED = 6;
const TURN_SPEED = 2.4; // radians/sec for keyboard look

// ---------- Collision (AABB player vs voxel grid) ----------
const EYE_HEIGHT = 1.3;   // eye above feet
const PLAYER_HEIGHT = 1.7; // total body height
const PLAYER_RADIUS = 0.3;
const STEP_HEIGHT = 1.05;  // auto-climb ledges up to one block tall while grounded

function isSolidBlock(x, y, z) {
  return blockAt.has(bkey(Math.round(x), Math.round(y), Math.round(z)));
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
const inventory = { grass: 0, dirt: 10, stone: 5, wood: 0, leaves: 0, planks: 0, apple: 2 };
let selectedMaterial = 'dirt';
const hotbarEl = document.getElementById('hotbar');

function renderHotbar() {
  hotbarEl.innerHTML = '';
  HOTBAR_ORDER.forEach((material, i) => {
    const slot = document.createElement('div');
    slot.className = 'slot' + (material === selectedMaterial ? ' active' : '');
    slot.innerHTML = `<span class="key">${i + 1}</span><span class="count">${inventory[material]}</span>
      <span class="swatch" style="background:#${MATERIAL_COLORS[material].toString(16).padStart(6, '0')}"></span>`;
    hotbarEl.appendChild(slot);
  });
}
renderHotbar();

const STARTER_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'Enter',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

document.addEventListener('keydown', (e) => {
  if (!gameStarted && STARTER_KEYS.has(e.code)) startGame();
  switch (e.code) {
    case 'KeyW': move.forward = true; break;
    case 'KeyS': move.back = true; break;
    case 'KeyA': move.left = true; break;
    case 'KeyD': move.right = true; break;
    case 'ArrowLeft': look.left = true; break;
    case 'ArrowRight': look.right = true; break;
    case 'ArrowUp': look.up = true; break;
    case 'ArrowDown': look.down = true; break;
    case 'Space': if (onGround) { velocityY = JUMP_SPEED; onGround = false; } break;
    case 'Digit1': case 'Digit2': case 'Digit3': case 'Digit4': case 'Digit5': case 'Digit6': {
      const idx = Number(e.code.slice(5)) - 1;
      if (HOTBAR_ORDER[idx]) { selectedMaterial = HOTBAR_ORDER[idx]; renderHotbar(); }
      break;
    }
    case 'KeyC':
      if (inventory.wood >= 1) {
        inventory.wood -= 1;
        inventory.planks += 4;
        renderHotbar();
      }
      break;
    case 'KeyF':
      if (inventory.apple >= 1) {
        inventory.apple -= 1;
        socket.emit('eat');
        document.getElementById('apple-count').textContent = 'Apples: ' + inventory.apple + ' (press F to eat)';
      }
      break;
    case 'KeyJ': if (gameStarted) breakOrAttack(); break;
    case 'KeyK': if (gameStarted) placeBlock(); break;
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
  }
});

// ---------- Breaking / placing / attacking ----------
const raycaster = new THREE.Raycaster();
raycaster.far = 8;
const centerVec = new THREE.Vector2(0, 0);
document.addEventListener('contextmenu', (e) => e.preventDefault());

function breakOrAttack() {
  raycaster.setFromCamera(centerVec, camera);

  const mobMeshes = Array.from(remoteMobsAll()).map((m) => m.mesh);
  const mobHits = raycaster.intersectObjects(mobMeshes, true);
  if (mobHits.length > 0) {
    const hitGroup = findMobGroup(mobHits[0].object);
    const mobId = hitGroup && hitGroup.userData.mobId;
    if (mobId) { socket.emit('attackMob', { mobId }); return; }
  }

  const hits = raycaster.intersectObjects(Object.values(meshes));
  if (hits.length === 0) return;
  const hit = hits[0];
  const material = meshOwner(hit.object);
  const pos = meshUserData[material].positions[hit.instanceId];
  if (!pos || UNBREAKABLE.has(material)) return;

  removeBlockInstance(pos.x, pos.y, pos.z);
  inventory[material] = (inventory[material] || 0) + 1;
  if (material === 'leaves' && Math.random() < 0.25) {
    inventory.apple = (inventory.apple || 0) + 1;
    document.getElementById('apple-count').textContent = 'Apples: ' + inventory.apple + ' (press F to eat)';
  }
  renderHotbar();
  socket.emit('blockEdit', { x: pos.x, y: pos.y, z: pos.z, action: 'remove' });
}

function placeBlock() {
  raycaster.setFromCamera(centerVec, camera);
  const hits = raycaster.intersectObjects(Object.values(meshes));
  if (hits.length === 0) return;
  const hit = hits[0];
  const material = meshOwner(hit.object);
  const pos = meshUserData[material].positions[hit.instanceId];
  if (!pos) return;
  if (inventory[selectedMaterial] <= 0) return;
  const n = hit.face.normal;
  const nx = Math.round(pos.x + n.x), ny = Math.round(pos.y + n.y), nz = Math.round(pos.z + n.z);
  if (blockAt.has(bkey(nx, ny, nz))) return;
  if (blockOverlapsPlayer(nx, ny, nz)) return;
  const [cx, cz] = World.worldToChunk(nx, nz);
  inventory[selectedMaterial] -= 1;
  renderHotbar();
  addBlockInstance(nx, ny, nz, selectedMaterial, cx + ',' + cz);
  socket.emit('blockEdit', { x: nx, y: ny, z: nz, action: 'add', material: selectedMaterial });
}

document.addEventListener('mousedown', (e) => {
  if (!gameStarted) return;
  if (e.button === 0) breakOrAttack();
  else if (e.button === 2) placeBlock();
});

function meshOwner(object) {
  for (const material in meshes) if (meshes[material] === object) return material;
  return null;
}
function remoteMobsAll() { return remoteMobs.values(); }
function findMobGroup(object) {
  let o = object;
  while (o) { if (remoteMobsByGroup.has(o)) return o; o = o.parent; }
  return null;
}

// ---------- Animation loop ----------
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.1);

  if (look.left) camera.rotation.y += TURN_SPEED * dt;
  if (look.right) camera.rotation.y -= TURN_SPEED * dt;
  if (look.up) camera.rotation.x = Math.min(Math.PI / 2 - 0.05, camera.rotation.x + TURN_SPEED * 0.8 * dt);
  if (look.down) camera.rotation.x = Math.max(-(Math.PI / 2 - 0.05), camera.rotation.x - TURN_SPEED * 0.8 * dt);

  if (gameStarted) {
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    dir.y = 0; dir.normalize();
    const right = new THREE.Vector3().crossVectors(dir, camera.up).normalize();

    const step = new THREE.Vector3();
    if (move.forward) step.add(dir);
    if (move.back) step.sub(dir);
    if (move.right) step.add(right);
    if (move.left) step.sub(right);
    if (step.lengthSq() > 0) step.normalize().multiplyScalar(MOVE_SPEED * dt);

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

    velocityY += GRAVITY * dt;
    const tryY = camera.position.y + velocityY * dt;
    const feetY = camera.position.y - EYE_HEIGHT;

    if (velocityY <= 0) {
      const ground = groundHeightBelow(camera.position.x, camera.position.z, feetY);
      const feetLevel = (ground === -Infinity ? World.BEDROCK_Y - 1 : ground) + 0.5 + EYE_HEIGHT;
      if (tryY <= feetLevel) {
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
  updateChunks();

  for (const [, rp] of remotePlayers) {
    rp.mesh.position.lerp(new THREE.Vector3(rp.target.x, rp.target.y - 0.9, rp.target.z), 0.25);
    rp.mesh.rotation.y = rp.target.ry;
  }
  for (const [, rm] of remoteMobs) {
    rm.mesh.position.lerp(new THREE.Vector3(rm.target.x, rm.target.y - 0.9, rm.target.z), 0.25);
  }

  // day/night visuals
  const fade = 0.05;
  let brightness;
  if (dayClock < 0.5 - fade) brightness = 1;
  else if (dayClock < 0.5 + fade) brightness = 1 - (dayClock - (0.5 - fade)) / (2 * fade);
  else if (dayClock < 0.95 - fade) brightness = 0;
  else if (dayClock < 0.95 + fade) brightness = (dayClock - (0.95 - fade)) / (2 * fade);
  else brightness = 1;

  const sky = DAY_SKY.clone().lerp(NIGHT_SKY, 1 - brightness);
  scene.background = sky;
  scene.fog.color = sky;
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
