// Shared deterministic world generation - runs identically on server (Node) and client (browser).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.World = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {

  const CHUNK_SIZE = 16;
  const SEED = 1337;
  const BEDROCK_Y = -24;
  const DIRT_DEPTH = 3;
  const WATER_LEVEL = 5;

  function hash(x, z) {
    let n = Math.sin(x * 127.1 + z * 311.7 + SEED * 0.017) * 43758.5453123;
    return n - Math.floor(n);
  }
  function hash3(x, y, z) {
    let n = Math.sin(x * 127.1 + y * 269.5 + z * 419.2 + SEED * 0.013) * 43758.5453123;
    return n - Math.floor(n);
  }

  function lerp(a, b, t) { return a + (b - a) * t; }
  function smooth(t) { return t * t * (3 - 2 * t); }

  function valueNoise(x, z) {
    const x0 = Math.floor(x), z0 = Math.floor(z);
    const sx = smooth(x - x0), sz = smooth(z - z0);
    const n00 = hash(x0, z0), n10 = hash(x0 + 1, z0);
    const n01 = hash(x0, z0 + 1), n11 = hash(x0 + 1, z0 + 1);
    const ix0 = lerp(n00, n10, sx);
    const ix1 = lerp(n01, n11, sx);
    return lerp(ix0, ix1, sz);
  }

  function valueNoise3(x, y, z) {
    const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
    const sx = smooth(x - x0), sy = smooth(y - y0), sz = smooth(z - z0);
    const c000 = hash3(x0, y0, z0), c100 = hash3(x0 + 1, y0, z0);
    const c010 = hash3(x0, y0 + 1, z0), c110 = hash3(x0 + 1, y0 + 1, z0);
    const c001 = hash3(x0, y0, z0 + 1), c101 = hash3(x0 + 1, y0, z0 + 1);
    const c011 = hash3(x0, y0 + 1, z0 + 1), c111 = hash3(x0 + 1, y0 + 1, z0 + 1);
    const x00 = lerp(c000, c100, sx), x10 = lerp(c010, c110, sx);
    const x01 = lerp(c001, c101, sx), x11 = lerp(c011, c111, sx);
    const y0i = lerp(x00, x10, sy), y1i = lerp(x01, x11, sy);
    return lerp(y0i, y1i, sz);
  }

  // Large, slow-varying noise picks one of a few biomes per region.
  function biomeAt(x, z) {
    const v = valueNoise(x * 0.01, z * 0.01);
    if (v < 0.35) return 'desert';
    if (v > 0.68) return 'snow';
    return 'forest';
  }

  // Multi-octave height in blocks (integer), plus whether a tree grows there.
  function heightAt(x, z) {
    let h = 0;
    h += valueNoise(x * 0.04, z * 0.04) * 10;
    h += valueNoise(x * 0.09, z * 0.09) * 4;
    h += valueNoise(x * 0.2, z * 0.2) * 1.5;
    const biome = biomeAt(x, z);
    const flatten = biome === 'desert' ? 0.7 : 1;
    return Math.max(1, Math.round(h * 0.6 * flatten) + 3);
  }

  function treeAt(x, z) {
    const biome = biomeAt(x, z);
    if (biome === 'desert') return false;
    const v = hash(x * 0.31 + 91.7, z * 0.31 - 44.3);
    const threshold = biome === 'snow' ? 0.995 : 0.99;
    return v > threshold;
  }

  // Returns column definitions for one chunk: { "lx,lz": { height, tree, biome } }
  function generateChunkColumns(cx, cz) {
    const columns = {};
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        const wx = cx * CHUNK_SIZE + lx;
        const wz = cz * CHUNK_SIZE + lz;
        const h = heightAt(wx, wz);
        columns[lx + ',' + lz] = { height: h, tree: treeAt(wx, wz) && h > WATER_LEVEL, biome: biomeAt(wx, wz) };
      }
    }
    return columns;
  }

  function worldToChunk(wx, wz) {
    return [Math.floor(wx / CHUNK_SIZE), Math.floor(wz / CHUNK_SIZE)];
  }

  // Ore veins get rarer (and more valuable) the deeper you go.
  function oreAt(x, y, z) {
    const r = hash3(x * 12.9, y * 7.7, z * 12.9);
    if (y <= BEDROCK_Y + 3) {
      if (r > 0.985) return 'diamond_ore';
      if (r > 0.94) return 'gold_ore';
      if (r > 0.85) return 'iron_ore';
      if (r > 0.78) return 'coal_ore';
    } else if (y <= 2) {
      if (r > 0.95) return 'iron_ore';
      if (r > 0.85) return 'coal_ore';
    } else if (r > 0.93) {
      return 'coal_ore';
    }
    return null;
  }

  // Material for a given y within a column whose surface is at `height`.
  function materialAt(x, y, z, height, biome) {
    if (y === BEDROCK_Y) return 'bedrock';
    if (y === height - 1) {
      if (height <= WATER_LEVEL || biome === 'desert') return 'sand';
      if (biome === 'snow') return 'snow';
      return 'grass';
    }
    if (y >= height - 1 - DIRT_DEPTH) return biome === 'desert' ? 'sand' : 'dirt';
    const ore = oreAt(x, y, z);
    return ore || 'stone';
  }

  // Carve underground tunnels/pockets with 3D noise. Kept away from bedrock so
  // it doesn't turn every hill into swiss cheese. Most tunnels stay sealed at
  // least 3 blocks below the surface, but where the same noise field is
  // already carving strongly, let a rarer, higher threshold reach all the way
  // up - that's what gives a handful of tunnels a visible open-air mouth
  // instead of every cave being a fully enclosed pocket.
  function isCave(x, y, z, height) {
    if (y <= BEDROCK_Y + 1) return false;
    const n = valueNoise3(x * 0.11, y * 0.16, z * 0.11);
    if (y >= height - 3) return n > 0.86;
    return n > 0.74;
  }

  // ---------- Structures ----------
  // Deterministic, like everything else here: given a chunk coordinate, both
  // client and server independently compute the same answer with no need to
  // transfer structure geometry over the network - a dungeon is just another
  // thing chunk generation carves in, the same way caves and ore veins are.
  const DUNGEON_W = 7, DUNGEON_H = 4, DUNGEON_D = 7;

  // Rare: one roll per chunk, ~1.5% chance. Origin is kept well inside the
  // chunk (never touching the edge) so a dungeon never has to span two
  // chunks, which would need cross-chunk bookkeeping neither side has today.
  function dungeonAt(cx, cz) {
    const roll = hash(cx * 91.7 + 13.1, cz * 91.7 - 27.3);
    if (roll <= 0.985) return null;
    const spanX = CHUNK_SIZE - DUNGEON_W - 4;
    const spanZ = CHUNK_SIZE - DUNGEON_D - 4;
    const localX = 2 + Math.floor(hash(cx * 5.1, cz * 5.1) * spanX);
    const localZ = 2 + Math.floor(hash(cx * 7.7, cz * 7.7) * spanZ);
    const originX = cx * CHUNK_SIZE + localX;
    const originZ = cz * CHUNK_SIZE + localZ;
    const surfaceH = heightAt(originX, originZ);
    const depthBelowSurface = 6 + Math.floor(hash(cx * 11.3, cz * 11.3) * 10);
    const originY = Math.max(BEDROCK_Y + 3, surfaceH - depthBelowSurface);
    return { originX, originY, originZ };
  }

  // Returns the material that belongs at (x,y,z) for the dungeon rooted at
  // (originX, originY, originZ), or undefined if that position falls outside
  // the dungeon entirely (caller should fall through to normal terrain).
  // 'air' means "carve this empty" - distinct from undefined ("not ours").
  function dungeonBlockAt(originX, originY, originZ, x, y, z) {
    const dx = x - originX, dy = y - originY, dz = z - originZ;
    if (dx < 0 || dx >= DUNGEON_W || dy < 0 || dy >= DUNGEON_H || dz < 0 || dz >= DUNGEON_D) return undefined;
    const isDoorway = dz === 0 && dx === Math.floor(DUNGEON_W / 2) && (dy === 1 || dy === 2);
    if (isDoorway) return 'air';
    if (dx === 1 && dz === 1 && dy === 1) return 'chest';
    if (dx === Math.floor(DUNGEON_W / 2) && dz === Math.floor(DUNGEON_D / 2) && dy === 1) return 'spawner';
    const isWall = dx === 0 || dx === DUNGEON_W - 1 || dz === 0 || dz === DUNGEON_D - 1;
    const isFloorCeil = dy === 0 || dy === DUNGEON_H - 1;
    if (isWall || isFloorCeil) {
      return hash3(dx * 3.3, dy * 3.3, dz * 3.3) > 0.5 ? 'mossy_cobblestone' : 'cobblestone';
    }
    return 'air';
  }

  function dungeonSpawnerPos(dungeon) {
    return {
      x: dungeon.originX + Math.floor(DUNGEON_W / 2),
      y: dungeon.originY + 1,
      z: dungeon.originZ + Math.floor(DUNGEON_D / 2)
    };
  }

  // ---------- Mineshaft: a short supported tunnel with a rail line and a
  // loot chest at the far end. No explicit walls - it carves through
  // whatever stone is there and lets the surrounding terrain be the walls,
  // same as a real mineshaft cutting through rock rather than a built room.
  const MINESHAFT_LEN = 10, MINESHAFT_W = 3, MINESHAFT_H = 3;

  function mineshaftAt(cx, cz) {
    const roll = hash(cx * 63.1 + 29.3, cz * 63.1 - 41.7);
    if (roll <= 0.98) return null;
    const spanX = CHUNK_SIZE - MINESHAFT_LEN - 4;
    const spanZ = CHUNK_SIZE - MINESHAFT_W - 4;
    const localX = 2 + Math.floor(hash(cx * 4.3, cz * 4.3) * spanX);
    const localZ = 2 + Math.floor(hash(cx * 9.9, cz * 9.9) * spanZ);
    const originX = cx * CHUNK_SIZE + localX;
    const originZ = cz * CHUNK_SIZE + localZ;
    const surfaceH = heightAt(originX, originZ);
    const depthBelowSurface = 6 + Math.floor(hash(cx * 15.7, cz * 15.7) * 12);
    const originY = Math.max(BEDROCK_Y + 3, surfaceH - depthBelowSurface);
    return { originX, originY, originZ };
  }

  function mineshaftBlockAt(originX, originY, originZ, x, y, z) {
    const dx = x - originX, dy = y - originY, dz = z - originZ;
    if (dx < 0 || dx >= MINESHAFT_LEN || dy < 0 || dy >= MINESHAFT_H || dz < 0 || dz >= MINESHAFT_W) return undefined;
    const isSupportPost = (dx % 4 === 0) && dy <= 1 && (dz === 0 || dz === MINESHAFT_W - 1);
    const isSupportBeam = (dx % 4 === 0) && dy === MINESHAFT_H - 1;
    if (isSupportPost || isSupportBeam) return 'wood';
    if (dy === 0) return dz === 1 ? 'rail' : 'planks';
    if (dx === MINESHAFT_LEN - 2 && dz === 1 && dy === 1) return 'chest';
    return 'air';
  }

  // ---------- Village: a small cluster of huts, each with a door and a
  // crafting table, close enough together to read as a settlement.
  const HOUSE_SIZE = 4;
  const VILLAGE_HOUSE_OFFSETS = [{ dx: 0, dz: 0 }, { dx: 6, dz: 1 }, { dx: 2, dz: 7 }];
  const VILLAGE_FOOTPRINT_X = 10, VILLAGE_FOOTPRINT_Z = 11;

  function houseBlockAt(dx, dy, dz) {
    if (dx < 0 || dx >= HOUSE_SIZE || dy < 0 || dy >= HOUSE_SIZE || dz < 0 || dz >= HOUSE_SIZE) return undefined;
    if (dz === 0 && dx === 1 && (dy === 1 || dy === 2)) return 'air'; // doorway
    if (dy === HOUSE_SIZE - 1) return 'stairs'; // flat roof
    if (dy === 0) return 'planks'; // floor
    if (dx === 0 || dx === HOUSE_SIZE - 1 || dz === 0 || dz === HOUSE_SIZE - 1) return 'planks'; // walls
    if (dx === 2 && dz === 2 && dy === 1) return 'crafting_table';
    return 'air';
  }

  function villageAt(cx, cz) {
    const roll = hash(cx * 53.3 - 7.7, cz * 53.3 + 19.1);
    if (roll <= 0.992) return null; // rarer than dungeons/mineshafts - feels special
    const spanX = CHUNK_SIZE - VILLAGE_FOOTPRINT_X - 4;
    const spanZ = CHUNK_SIZE - VILLAGE_FOOTPRINT_Z - 4;
    const localX = 2 + Math.floor(hash(cx * 6.1, cz * 6.1) * spanX);
    const localZ = 2 + Math.floor(hash(cx * 8.9, cz * 8.9) * spanZ);
    return { originX: cx * CHUNK_SIZE + localX, originZ: cz * CHUNK_SIZE + localZ };
  }

  // Each house sits on its own local ground height (not the village
  // anchor's), so a house on a slope still sits flush with the terrain
  // right under it instead of floating or sinking.
  function villageBlockAt(village, x, y, z) {
    for (const off of VILLAGE_HOUSE_OFFSETS) {
      const hx = village.originX + off.dx, hz = village.originZ + off.dz;
      const hy = heightAt(hx, hz);
      const b = houseBlockAt(x - hx, y - hy, z - hz);
      if (b !== undefined) return b;
    }
    return undefined;
  }

  return {
    CHUNK_SIZE, BEDROCK_Y, DIRT_DEPTH, WATER_LEVEL, DUNGEON_W, DUNGEON_H, DUNGEON_D,
    heightAt, treeAt, biomeAt, materialAt, isCave, oreAt,
    generateChunkColumns, worldToChunk, hash,
    dungeonAt, dungeonBlockAt, dungeonSpawnerPos,
    mineshaftAt, mineshaftBlockAt,
    villageAt, villageBlockAt
  };
});
