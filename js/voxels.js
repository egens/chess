// Voxel models for the pieces and a face-culling mesher that turns them into BufferGeometry.
import * as THREE from 'three';

import { artGrid } from './art.js';

const GRID = 26; // figurine resolution: GRID x GRID voxels per square
export const VOXEL = 0.9 / GRID; // edge length of one piece voxel in world units (a board square is 1)

let pieceArt = null;

function hash(x, y, z) {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

export function setPieceArt(art) { pieceArt = art; }

// Voxel figurine built from the classic 2D piece art: the silhouette is extruded and domed,
// so it reads like the drawing from above and has real relief for light and shadow.
// Returns [{ x, y, z, color }] in the local grid (x, z centered on the square, y up).
export function pieceVoxels(type, color) {
  const grid = artGrid(pieceArt.get(color + type), GRID);
  const filled = (r, c) => r >= 0 && r < GRID && c >= 0 && c < GRID && grid[r][c];
  // Distance from the silhouette edge (in cells), used to dome the figurine.
  const dist = grid.map((line) => line.map(() => Infinity));
  const queue = [];
  for (let r = 0; r < GRID; r++) {
    for (let c = 0; c < GRID; c++) {
      if (!filled(r, c)) continue;
      if (!filled(r - 1, c) || !filled(r + 1, c) || !filled(r, c - 1) || !filled(r, c + 1)) {
        dist[r][c] = 0;
        queue.push([r, c]);
      }
    }
  }
  for (let i = 0; i < queue.length; i++) {
    const [r, c] = queue[i];
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nr = r + dr, nc = c + dc;
      if (filled(nr, nc) && dist[nr][nc] > dist[r][c] + 1) {
        dist[nr][nc] = dist[r][c] + 1;
        queue.push([nr, nc]);
      }
    }
  }
  const out = [];
  const half = (GRID - 1) / 2;
  for (let r = 0; r < GRID; r++) {
    for (let c = 0; c < GRID; c++) {
      const cell = grid[r][c];
      if (!cell) continue;
      // Outline cells sit one step lower than the body next to them, so the drawing's lines read as grooves.
      const h = 2 + Math.min(dist[r][c], 4) - (cell.dark && dist[r][c] > 0 ? 1 : 0);
      for (let y = 0; y < h; y++) out.push({ x: c - half, y, z: r - half, color: cell });
    }
  }
  return out;
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

// Local voxel centers + colors for a piece. Used both for the solid mesh and for the shatter debris.
export function pieceData(type, color) {
  return pieceVoxels(type, color).map((v) => {
    const c = new THREE.Color(v.color.r, v.color.g, v.color.b);
    c.convertSRGBToLinear();
    c.multiplyScalar(0.94 + hash(v.x * 2, v.y, v.z * 2) * 0.1);
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
  if (!cache.has(k)) {
    const voxels = pieceData(type, color);
    cache.set(k, { geometry: meshBoxes(voxels), voxels });
  }
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
