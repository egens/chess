// Voxel models for the pieces and a face-culling mesher that turns them into BufferGeometry.
import * as THREE from 'three';

export const VOXEL = 0.08; // edge length of one piece voxel in world units (a board square is 1)

// Radius per layer, bottom to top. A voxel (x, z) with x, z in -4..4 is filled if x² + z² <= r².
const PROFILES = {
  P: [4.3, 3.8, 3.2, 2.3, 1.6, 1.6, 1.6, 2.6, 1.5, 2.3, 2.6, 2.6, 2.3, 1.5],
  R: [4.3, 3.8, 3.2, 2.6, 2.6, 2.3, 2.3, 2.3, 2.3, 2.3, 2.6, 3.2, 3.6, 3.6, 3.6, 3.6],
  B: [4.3, 3.8, 3.2, 2.3, 1.6, 1.6, 1.6, 1.6, 2.6, 1.5, 2.3, 2.6, 2.6, 2.6, 2.3, 2.3, 1.5, 1.1, 0.5, 1.1, 0.5],
  Q: [4.3, 3.8, 3.2, 2.6, 2.3, 1.6, 1.6, 1.6, 1.6, 1.6, 2.3, 3.2, 1.6, 2.3, 2.6, 3.2, 3.6, 3.6, 3.6, 1.6, 1.1, 1.5, 1.1],
  K: [4.3, 3.8, 3.2, 2.6, 2.3, 1.6, 1.6, 1.6, 1.6, 1.6, 2.3, 3.2, 1.6, 2.3, 2.6, 3.2, 3.2, 2.3, 1.1, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
  N: [4.3, 3.8, 3.2, 2.6],
};

// Knight head side profile, bottom to top, columns are z = -4..4 (front = +z).
const KNIGHT_SIDE = [
  '..#####..',
  '..####...',
  '..####...',
  '..#####..',
  '.######..',
  '.#######.',
  '.########',
  '.########',
  '..#######',
  '..######.',
  '..#####..',
  '..####...',
  '..#..#...',
];

function hash(x, y, z) {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

// Returns a list of voxels { x, y, z, accent } for a piece type in its local grid.
export function pieceVoxels(type) {
  const out = [];
  const prof = PROFILES[type];
  const top = prof.length - 1;
  prof.forEach((r, y) => {
    for (let x = -4; x <= 4; x++) {
      for (let z = -4; z <= 4; z++) {
        const d2 = x * x + z * z;
        if (d2 > r * r) continue;
        let accent = false;
        if (type === 'R' && y >= top - 1) {
          // Crenellated, hollow top.
          if (d2 < 5) continue;
          if (y === top && (x === 0 || z === 0 || Math.abs(x) === Math.abs(z))) continue;
        }
        if (type === 'B' && y >= 10 && y <= 15 && x === y - 12 && z >= 0) continue; // mitre slit
        if (type === 'Q' && y >= 16 && y <= 18) {
          if (d2 < 7) continue; // hollow crown
          if (y > 16 && !((x + z + 8) % 2 === 0 && d2 >= 9)) continue; // spikes
        }
        if (type === 'Q' && y >= 19) accent = true;
        if ((type === 'Q' || type === 'K') && y === 11) accent = true; // collar band
        out.push({ x, y, z, accent });
      }
    }
  });
  if (type === 'K') {
    const y0 = prof.length;
    for (let i = 0; i < 5; i++) out.push({ x: 0, y: y0 + i, z: 0, accent: true });
    for (const x of [-2, -1, 1, 2]) out.push({ x, y: y0 + 3, z: 0, accent: true });
  }
  if (type === 'N') {
    KNIGHT_SIDE.forEach((row, i) => {
      const y = prof.length + i;
      for (let c = 0; c < 9; c++) {
        if (row[c] !== '#') continue;
        const z = c - 4;
        const w = i < 4 ? 2 : 1;
        for (let x = -w; x <= w; x++) {
          const eye = i === 9 && z === 2 && Math.abs(x) === 1;
          const mane = z <= -2 && x === 0 && i >= 4;
          out.push({ x, y, z, accent: eye || mane });
        }
      }
      if (i >= 4 && i <= 11) out.push({ x: 0, y, z: -4 + (row.indexOf('#') - 1), accent: true }); // mane ridge
    });
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
  w: { base: new THREE.Color('#e4d7b6'), accent: new THREE.Color('#c9a227') },
  b: { base: new THREE.Color('#4a4558'), accent: new THREE.Color('#b8322a') },
};

// Local voxel centers + colors for a piece. Used both for the solid mesh and for the shatter debris.
export function pieceData(type, color) {
  const pal = PALETTE[color];
  return pieceVoxels(type).map((v) => {
    const c = (v.accent ? pal.accent : pal.base).clone();
    c.multiplyScalar(0.9 + hash(v.x, v.y, v.z) * 0.18);
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
