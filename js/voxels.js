// Voxel models for the pieces and a face-culling mesher that turns them into BufferGeometry.
import * as THREE from 'three';

export const VOXEL = 0.065; // edge length of one piece voxel in world units (a board square is 1)

// v2 pieces are made to be read from straight above: a round token with the classic chess
// silhouette standing out in relief. Rows go from the far edge of the token (screen top) down,
// columns left to right, 11x11. 'o' marks an accent voxel (the knight's eye).
const GLYPHS = {
  P: [
    '...........',
    '....###....',
    '...#####...',
    '...#####...',
    '....###....',
    '...#####...',
    '....###....',
    '....###....',
    '...#####...',
    '..#######..',
    '..#######..',
  ],
  R: [
    '...........',
    '.##..#..##.',
    '.#########.',
    '..#######..',
    '...#####...',
    '...#####...',
    '...#####...',
    '...#####...',
    '..#######..',
    '.#########.',
    '.#########.',
  ],
  N: [
    '....#.#....',
    '...#####...',
    '..#######..',
    '.##o######.',
    '.#########.',
    '.###..####.',
    '......####.',
    '.....#####.',
    '....######.',
    '..########.',
    '.#########.',
  ],
  B: [
    '.....#.....',
    '....###....',
    '...###.#...',
    '...##.##...',
    '...#####...',
    '....###....',
    '...#####...',
    '....###....',
    '....###....',
    '..#######..',
    '.#########.',
  ],
  Q: [
    '#....#....#',
    '.#..###..#.',
    '.##.###.##.',
    '.#########.',
    '..#######..',
    '...#####...',
    '....###....',
    '...#####...',
    '....###....',
    '..#######..',
    '.#########.',
  ],
  K: [
    '.....#.....',
    '....###....',
    '.....#.....',
    '..##.#.##..',
    '.#########.',
    '.#########.',
    '..#######..',
    '...#####...',
    '....###....',
    '..#######..',
    '.#########.',
  ],
};

function hash(x, y, z) {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

// Returns a list of voxels { x, y, z, part } in the piece's local grid (x, z in -6..6).
// part: 'disk' | 'rim' | 'outline' | 'fill' | 'accent'.
export function pieceVoxels(type) {
  const out = [];
  for (let x = -6; x <= 6; x++) {
    for (let z = -6; z <= 6; z++) {
      const d2 = x * x + z * z;
      if (d2 <= 6.4 * 6.4) out.push({ x, y: 0, z, part: d2 > 5.4 * 5.4 ? 'rim' : 'disk' });
      if (d2 <= 6 * 6) out.push({ x, y: 1, z, part: d2 > 5 * 5 ? 'rim' : 'disk' });
    }
  }
  const g = GLYPHS[type];
  const filled = (r, c) => r >= 0 && r < 11 && c >= 0 && c < 11 && g[r][c] !== '.';
  for (let r = 0; r < 11; r++) {
    for (let c = 0; c < 11; c++) {
      if (!filled(r, c)) continue;
      const edge = !filled(r - 1, c) || !filled(r + 1, c) || !filled(r, c - 1) || !filled(r, c + 1);
      const x = c - 5, z = r - 5;
      const part = g[r][c] === 'o' ? 'accent' : edge ? 'outline' : 'fill';
      // The outline is two voxels tall, the inside one higher: a raised, pillowy icon.
      const h = edge ? 2 : 3;
      for (let y = 2; y < 2 + h; y++) out.push({ x, y, z, part });
    }
  }
  return dedupe(out);
}

function dedupe(list) {
  const seen = new Map();
  for (const v of list) seen.set(`${v.x},${v.y},${v.z}`, v);
  return [...seen.values()];
}

const FACES = [
  { n: [1, 0, 0], c: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]] },
  { n: [-1, 0, 0], c: [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]] },
  { n: [0, 1, 0], c: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]] },
  { n: [0, -1, 0], c: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
  { n: [0, 0, 1], c: [[1, 0, 1], [1, 1, 1], [0, 1, 1], [0, 0, 1]] },
  { n: [0, 0, -1], c: [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]] },
];

// Generic mesher: boxes = [{ x, y, z, sx, sy, sz, color: THREE.Color, key }] with integer grid keys for culling.
// Faces shared between two filled cells (same grid) are dropped.
export function meshBoxes(boxes) {
  const filled = new Set(boxes.map((b) => b.key));
  const pos = [], nor = [], col = [], idx = [];
  for (const b of boxes) {
    for (const f of FACES) {
      if (b.grid && filled.has(`${b.grid[0] + f.n[0]},${b.grid[1] + f.n[1]},${b.grid[2] + f.n[2]}`)) continue;
      const base = pos.length / 3;
      // Cheap fake ambient occlusion: darker on the bottom and sides than on top.
      const shade = f.n[1] > 0 ? 1 : f.n[1] < 0 ? 0.6 : 0.85;
      for (const c of f.c) {
        pos.push(b.x + (c[0] - 0.5) * b.sx, b.y + (c[1] - 0.5) * b.sy, b.z + (c[2] - 0.5) * b.sz);
        nor.push(...f.n);
        col.push(b.color.r * shade, b.color.g * shade, b.color.b * shade);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

export const PALETTE = {
  w: { disk: '#d6c7a1', rim: '#6f5a3a', fill: '#fbf6e9', outline: '#2c2219', accent: '#c0392b' },
  b: { disk: '#4a4557', rim: '#15131b', fill: '#2a2732', outline: '#e2c47c', accent: '#e2c47c' },
};
for (const c of Object.values(PALETTE)) for (const k in c) c[k] = new THREE.Color(c[k]);

// Local voxel centers + colors for a piece. Used both for the solid mesh and for the shatter debris.
export function pieceData(type, color) {
  const pal = PALETTE[color];
  return pieceVoxels(type).map((v) => {
    const c = pal[v.part].clone();
    c.multiplyScalar(0.92 + hash(v.x, v.y, v.z) * 0.14);
    return {
      grid: [v.x, v.y, v.z],
      key: `${v.x},${v.y},${v.z}`,
      x: v.x * VOXEL, y: (v.y + 0.5) * VOXEL, z: v.z * VOXEL,
      sx: VOXEL, sy: VOXEL, sz: VOXEL,
      color: c,
    };
  });
}

const cache = new Map();
export function pieceGeometry(type, color) {
  const k = type + color;
  if (!cache.has(k)) cache.set(k, { geometry: meshBoxes(pieceData(type, color)), voxels: pieceData(type, color) });
  return cache.get(k);
}

// Board: every square is a 4x4 patch of slightly uneven voxel tiles, plus a wooden frame.
export function boardGeometry() {
  const boxes = [];
  const light = new THREE.Color('#d8c49a'), dark = new THREE.Color('#6e4b30');
  const frame = new THREE.Color('#3b2618');
  const N = 4, s = 1 / N;
  for (let gx = -3; gx < 8 * N + 3; gx++) {
    for (let gz = -3; gz < 8 * N + 3; gz++) {
      const inside = gx >= 0 && gx < 8 * N && gz >= 0 && gz < 8 * N;
      const h = hash(gx, 7, gz);
      let c, top;
      if (inside) {
        const file = Math.floor(gx / N), rank = Math.floor(gz / N);
        c = ((file + rank) & 1 ? light : dark).clone();
        c.multiplyScalar(0.92 + h * 0.14);
        top = (h - 0.5) * 0.012;
      } else {
        c = frame.clone().multiplyScalar(0.85 + h * 0.3);
        top = 0.06 + (h - 0.5) * 0.02;
      }
      const height = 0.35 + top;
      boxes.push({
        x: -4 + (gx + 0.5) * s, z: 4 - (gz + 0.5) * s, y: top - height / 2,
        sx: s, sy: height, sz: s, color: c, key: `${gx},${gz}`,
      });
    }
  }
  return meshBoxes(boxes);
}
