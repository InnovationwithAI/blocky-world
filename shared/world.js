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

  function hash(x, z) {
    let n = Math.sin(x * 127.1 + z * 311.7 + SEED * 0.017) * 43758.5453123;
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

  // Multi-octave height in blocks (integer), plus whether a tree grows there.
  function heightAt(x, z) {
    let h = 0;
    h += valueNoise(x * 0.04, z * 0.04) * 10;
    h += valueNoise(x * 0.09, z * 0.09) * 4;
    h += valueNoise(x * 0.2, z * 0.2) * 1.5;
    return Math.max(1, Math.round(h * 0.6) + 3);
  }

  function treeAt(x, z) {
    // Deterministic sparse tree placement independent of height noise.
    const v = hash(x * 0.31 + 91.7, z * 0.31 - 44.3);
    return v > 0.99;
  }

  // Returns column definitions for one chunk: { "lx,lz": { height, tree } }
  function generateChunkColumns(cx, cz) {
    const columns = {};
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        const wx = cx * CHUNK_SIZE + lx;
        const wz = cz * CHUNK_SIZE + lz;
        columns[lx + ',' + lz] = {
          height: heightAt(wx, wz),
          tree: treeAt(wx, wz) && heightAt(wx, wz) > 0
        };
      }
    }
    return columns;
  }

  function worldToChunk(wx, wz) {
    return [Math.floor(wx / CHUNK_SIZE), Math.floor(wz / CHUNK_SIZE)];
  }

  return { CHUNK_SIZE, heightAt, treeAt, generateChunkColumns, worldToChunk, hash };
});
