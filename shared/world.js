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
        columns[lx + ',' + lz] = { height: h, tree: treeAt(wx, wz) && h > 0, biome: biomeAt(wx, wz) };
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
      if (biome === 'desert') return 'sand';
      if (biome === 'snow') return 'snow';
      return 'grass';
    }
    if (y >= height - 1 - DIRT_DEPTH) return biome === 'desert' ? 'sand' : 'dirt';
    const ore = oreAt(x, y, z);
    return ore || 'stone';
  }

  // Carve underground tunnels/pockets with 3D noise. Kept away from bedrock
  // and the near-surface layer so it doesn't turn every hill into swiss cheese.
  function isCave(x, y, z, height) {
    if (y <= BEDROCK_Y + 1) return false;
    if (y >= height - 3) return false;
    const n = valueNoise3(x * 0.11, y * 0.16, z * 0.11);
    return n > 0.74;
  }

  return {
    CHUNK_SIZE, BEDROCK_Y, DIRT_DEPTH,
    heightAt, treeAt, biomeAt, materialAt, isCave, oreAt,
    generateChunkColumns, worldToChunk, hash
  };
});
