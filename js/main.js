import * as THREE from 'three';
import { Chess, fileOf, rankOf, other, toUci } from './chess.js';
import { pieceGeometry, boardGeometry, VOXEL } from './voxels.js';
import { Sound } from './sound.js';
import { Fire } from './fire.js';
import { burnLevels } from './burn.js';
import { Lichess } from './lichess.js';

// ---------- scene ----------
const TABLE_Y = -0.35;
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
scene.background = new THREE.Color('#1b1d26');

// Fixed camera looking straight down; a narrow field of view keeps the board almost flat
// while still showing a hint of the pieces' relief.
const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 200);

scene.add(new THREE.HemisphereLight('#fff3e0', '#2a2440', 1.0));
const sun = new THREE.DirectionalLight('#fff1d6', 2.2);
sun.position.set(-3, 12, -4);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -7, right: 7, top: 7, bottom: -7, near: 1, far: 30 });
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.02;
scene.add(sun);

const voxelMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0.05 });

const board = new THREE.Mesh(boardGeometry(), voxelMaterial);
board.receiveShadow = true;
board.castShadow = true;
scene.add(board);

const table = new THREE.Mesh(
  new THREE.PlaneGeometry(200, 200),
  new THREE.MeshStandardMaterial({ color: '#23252f', roughness: 1 }),
);
table.rotation.x = -Math.PI / 2;
table.position.y = TABLE_Y;
table.receiveShadow = true;
scene.add(table);

const labels = addCoordinates();
const fire = new Fire(scene);

const sqPos = (sq) => new THREE.Vector3(fileOf(sq) - 3.5, 0, 3.5 - rankOf(sq));

// ---------- highlights ----------
const markers = new THREE.Group();
scene.add(markers);
const tileGeo = new THREE.BoxGeometry(0.96, 0.02, 0.96);
const dotGeo = new THREE.BoxGeometry(0.2, 0.2, 0.2);
const ringGeo = ringGeometry();
const mat = (color, opacity) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
const M = {
  last: mat('#f5d76e', 0.32), select: mat('#7fd6ff', 0.5), move: mat('#7fd6ff', 0.85),
  capture: mat('#ff6b5a', 0.9), check: mat('#ff3b30', 0.95), hover: mat('#ffffff', 0.3),
};

function ringGeometry() {
  // Square ring of voxels around a square, visible around the token standing on it.
  const g = [];
  for (let i = 0; i < 8; i++) {
    for (const [x, z] of [[i, 0], [i, 7], [0, i], [7, i]]) {
      const b = new THREE.BoxGeometry(0.1, 0.06, 0.1);
      b.translate(-0.42 + x * 0.12, 0.03, -0.42 + z * 0.12);
      g.push(b);
    }
  }
  return mergeGeometries(g);
}

function mergeGeometries(list) {
  const pos = [], nor = [], idx = [];
  for (const g of list) {
    const off = pos.length / 3;
    pos.push(...g.attributes.position.array);
    nor.push(...g.attributes.normal.array);
    for (const i of g.index.array) idx.push(i + off);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setIndex(idx);
  return out;
}

function addMarker(geo, material, sq, y = 0.012) {
  const m = new THREE.Mesh(geo, material);
  m.position.copy(sqPos(sq)).setY(y);
  m.userData.sq = sq;
  markers.add(m);
  return m;
}

// ---------- game state ----------
const game = new Chess();
const pieces = new Map(); // square -> mesh
const sanList = [];
let selected = -1;
let legalForSelected = [];
let busy = false; // a move is being animated or the AI is thinking
let gameOver = null;
let lastMove = null;
let pendingPromotion = null;
let aiRequest = 0;
let generation = 0; // bumped whenever the position is rebuilt, so stale animations stop early
let viewFrom = 'w';
let hoverSq = -1;

const $ = (id) => document.getElementById(id);
const ui = {
  status: $('status'), moves: $('moves'), mode: $('mode'), level: $('level'),
  promo: $('promo'), banner: $('banner'), bannerText: $('banner-text'),
};

const LEVELS = { 1: [1, 300], 2: [2, 600], 3: [3, 1200], 4: [5, 2500] };
const sound = new Sound();

// Moves are applied one at a time, in order (human input, AI replies and lichess updates).
let chain = Promise.resolve();
const serial = (fn) => {
  const p = chain.then(fn);
  chain = p.catch((e) => console.error(e));
  return p;
};

const isOnline = () => ui.mode.value === 'lichess';
function humanColor() {
  if (isOnline()) return online.color;
  const mode = ui.mode.value;
  if (mode === 'pvp') return null; // both sides
  return mode === 'white' ? 'w' : 'b';
}
function isHumanTurn() {
  if (isOnline()) return !!online.gameId && !online.finished && game.turn === online.color;
  const h = humanColor();
  return h === null || h === game.turn;
}

function makePieceMesh(p) {
  const { geometry } = pieceGeometry(p[1], p[0]);
  const mesh = new THREE.Mesh(geometry, voxelMaterial);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.piece = p;
  mesh.userData.burn = 0;
  mesh.rotation.y = viewFrom === 'w' ? 0 : Math.PI; // glyphs stay upright for the viewer
  return mesh;
}

function setBurn(mesh, level) {
  mesh.userData.burn = level;
  if (level > 0 && mesh.material === voxelMaterial) {
    mesh.material = voxelMaterial.clone();
    mesh.material.emissive = new THREE.Color('#ff5a14');
  }
}

function syncPieces() {
  for (const m of pieces.values()) {
    scene.remove(m);
    if (m.material !== voxelMaterial) m.material.dispose();
  }
  pieces.clear();
  const burns = burnLevels(game.stack.map((u) => u.m));
  game.board.forEach((p, sq) => {
    if (!p) return;
    const mesh = makePieceMesh(p);
    mesh.position.copy(sqPos(sq));
    mesh.userData.sq = sq;
    setBurn(mesh, burns.get(sq) || 0);
    scene.add(mesh);
    pieces.set(sq, mesh);
  });
}

function refreshMarkers() {
  markers.clear();
  if (lastMove) {
    addMarker(tileGeo, M.last, lastMove.from);
    addMarker(tileGeo, M.last, lastMove.to);
  }
  if (game.inCheck()) addMarker(ringGeo, M.check, game.kingSquare(game.turn), 0.0);
  if (selected >= 0) {
    addMarker(tileGeo, M.select, selected, 0.014);
    const seen = new Set();
    for (const m of legalForSelected) {
      if (seen.has(m.to)) continue;
      seen.add(m.to);
      if (m.captured) addMarker(ringGeo, M.capture, m.to, 0.0);
      else addMarker(dotGeo, M.move, m.to, 0.12).userData.bob = true;
    }
  }
  if (hoverSq >= 0 && hoverSq !== selected) addMarker(tileGeo, M.hover, hoverSq, 0.016);
}

const NAMES = { w: 'Белые', b: 'Чёрные' };
function gameOverText(st) {
  const win = st.winner ? `${NAMES[st.winner]} победили` : 'ничья';
  const texts = {
    checkmate: `Мат! ${NAMES[st.winner]} победили`,
    mate: `Мат! ${NAMES[st.winner]} победили`,
    stalemate: 'Пат — ничья',
    fifty: 'Правило 50 ходов — ничья',
    material: 'Недостаточно материала — ничья',
    repetition: 'Троекратное повторение — ничья',
    resign: `${st.winner ? NAMES[other(st.winner)] : 'Соперник'} сдались — ${win}`,
    outoftime: `Время вышло — ${win}`,
    timeout: `Соперник покинул партию — ${win}`,
    draw: 'Ничья по соглашению',
    aborted: 'Партия отменена',
    noStart: 'Партия не началась',
  };
  return texts[st.reason] || `Партия окончена — ${win}`;
}

function updateStatus() {
  if (gameOver) {
    const text = gameOverText(gameOver);
    ui.status.textContent = text;
    if (ui.bannerText.textContent !== text) {
      ui.bannerText.textContent = text;
      ui.banner.hidden = false;
    }
  } else {
    let s;
    if (isOnline() && !online.gameId) s = online.message || 'Онлайн-режим: найдите соперника';
    else if (isOnline()) s = game.turn === online.color ? 'Ваш ход' : 'Ход соперника';
    else s = `Ход: ${NAMES[game.turn]}`;
    if (game.inCheck() && (!isOnline() || online.gameId)) s += ' — шах!';
    if (!isOnline() && !isHumanTurn()) s += ' (думает…)';
    ui.status.textContent = s;
    ui.banner.hidden = true;
    ui.bannerText.textContent = '';
  }
  ui.moves.innerHTML = '';
  for (let i = 0; i < sanList.length; i += 2) {
    const li = document.createElement('li');
    li.innerHTML = `<span>${sanList[i]}</span><span>${sanList[i + 1] || ''}</span>`;
    ui.moves.appendChild(li);
  }
  ui.moves.scrollTop = ui.moves.scrollHeight;
  renderOnline();
}

// ---------- moves ----------
// dragged: the piece was already carried to the target square by the player.
async function playMove(m, { dragged = false } = {}) {
  const gen = generation;
  busy = true;
  selected = -1;
  legalForSelected = [];
  hoverSq = -1;
  sanList.push(game.san(m));
  const mesh = pieces.get(m.from);
  const capSq = m.epCapture !== undefined ? m.epCapture : m.captured ? m.to : -1;
  const victim = capSq >= 0 ? pieces.get(capSq) : null;
  pieces.delete(m.from);
  if (victim) pieces.delete(capSq);
  pieces.set(m.to, mesh);
  mesh.userData.sq = m.to;
  game.make(m);
  lastMove = m;
  refreshMarkers();

  const impact = victim ? () => {
    shatter(victim, sqPos(m.to).sub(sqPos(m.from)).normalize(), m.piece[1]);
    sound.crash();
    setBurn(mesh, mesh.userData.burn + 1);
    sound.ignite();
  } : null;
  const anims = [dragged ? dropMove(mesh, m.to, impact) : animateMove(mesh, m.from, m.to, m.piece[1] === 'N', impact)];
  if (m.castle) {
    const rook = pieces.get(m.castle.from);
    pieces.delete(m.castle.from);
    pieces.set(m.castle.to, rook);
    rook.userData.sq = m.castle.to;
    anims.push(animateMove(rook, m.castle.from, m.castle.to, true));
  }
  await Promise.all(anims);
  if (gen !== generation) return;
  if (!victim) sound.tap();

  if (m.promo) {
    scene.remove(mesh);
    const q = makePieceMesh(game.board[m.to]);
    q.position.copy(sqPos(m.to));
    q.userData.sq = m.to;
    setBurn(q, mesh.userData.burn);
    scene.add(q);
    pieces.set(m.to, q);
    burst(sqPos(m.to), m.piece[0]);
    sound.promote();
  }

  if (!isOnline()) {
    const st = game.status();
    gameOver = st.over ? st : null;
  }
  if (game.inCheck() && !gameOver) sound.check();
  refreshMarkers();
  updateStatus();
  busy = false;
  maybeAI();
}

function animateMove(mesh, from, to, jump, onImpact) {
  const a = sqPos(from), b = sqPos(to);
  const dist = a.distanceTo(b);
  const dur = 0.25 + Math.min(dist, 5) * 0.07;
  const height = jump ? 0.9 : 0.2 + dist * 0.05;
  return tween(dur, (t) => {
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    mesh.position.lerpVectors(a, b, e);
    mesh.position.y = Math.sin(Math.PI * e) * height;
    if (onImpact && t >= 0.8) { onImpact(); onImpact = null; }
  }).then(() => {
    if (onImpact) onImpact();
    mesh.position.copy(b);
    return squash(mesh);
  });
}

function dropMove(mesh, to, onImpact) {
  const a = mesh.position.clone(), b = sqPos(to);
  mesh.scale.set(1, 1, 1);
  return tween(0.14, (t) => {
    mesh.position.lerpVectors(a, b, t * t);
  }).then(() => {
    if (onImpact) onImpact();
    mesh.position.copy(b);
    return squash(mesh);
  });
}

const squash = (mesh) => tween(0.18, (t) => {
  const s = 1 - Math.sin(Math.PI * t) * 0.25;
  mesh.scale.set(1 / Math.sqrt(s), s, 1 / Math.sqrt(s));
}).then(() => mesh.scale.set(1, 1, 1));

// ---------- tweens ----------
const tweens = new Set();
function tween(duration, fn) {
  return new Promise((resolve) => tweens.add({ t: 0, duration, fn, resolve }));
}
function stepTweens(dt) {
  for (const tw of tweens) {
    tw.t = Math.min(1, tw.t + dt / tw.duration);
    tw.fn(tw.t);
    if (tw.t >= 1) { tweens.delete(tw); tw.resolve(); }
  }
}

// ---------- debris ----------
const debris = [];
const boxGeo = new THREE.BoxGeometry(VOXEL * 0.97, VOXEL * 0.97, VOXEL * 0.97);
const debrisMaterial = new THREE.MeshStandardMaterial({ roughness: 0.75, metalness: 0.05 });
const tmpM = new THREE.Matrix4(), tmpQ = new THREE.Quaternion(), tmpE = new THREE.Euler(), tmpS = new THREE.Vector3();

function shatter(victim, dir, attackerType) {
  scene.remove(victim);
  if (victim.material !== voxelMaterial) victim.material.dispose();
  const p = victim.userData.piece;
  const { voxels } = pieceGeometry(p[1], p[0]);
  const inst = new THREE.InstancedMesh(boxGeo, debrisMaterial, voxels.length);
  inst.castShadow = true;
  inst.receiveShadow = true;
  const force = { P: 1.6, N: 2.2, B: 2.2, R: 2.6, Q: 3, K: 3.2 }[attackerType] || 3;
  const parts = voxels.map((v, i) => {
    const local = new THREE.Vector3(v.x, v.y, v.z).applyEuler(victim.rotation);
    const pos = local.clone().add(victim.position);
    const out = new THREE.Vector3(local.x, 0, local.z);
    // Seen from above, anything flying high looks huge, so keep the blast low and compact.
    const vel = out.multiplyScalar(1.5 + Math.random() * 2)
      .add(dir.clone().multiplyScalar(force * (0.2 + Math.random() * 0.4)))
      .add(new THREE.Vector3((Math.random() - 0.5) * 0.6, 1 + Math.random() * 1.5 + v.y * 2, (Math.random() - 0.5) * 0.6));
    inst.setColorAt(i, v.color);
    return {
      pos, vel,
      rot: new THREE.Euler(),
      spin: new THREE.Vector3((Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20),
      rest: false,
    };
  });
  inst.instanceColor.needsUpdate = true;
  scene.add(inst);
  debris.push({ inst, parts, age: 0 });
}

function burst(center, color) {
  // A short fountain of gold voxels when a pawn promotes.
  const n = 60;
  const inst = new THREE.InstancedMesh(boxGeo, debrisMaterial, n);
  const c = new THREE.Color(color === 'w' ? '#ffd54a' : '#ff5a4a');
  const parts = [];
  for (let i = 0; i < n; i++) {
    inst.setColorAt(i, c.clone().multiplyScalar(0.8 + Math.random() * 0.4));
    const a = Math.random() * Math.PI * 2, s = 1 + Math.random() * 2;
    parts.push({
      pos: center.clone().setY(0.2),
      vel: new THREE.Vector3(Math.cos(a) * s, 4 + Math.random() * 3, Math.sin(a) * s),
      rot: new THREE.Euler(), spin: new THREE.Vector3(8, 6, 4), rest: false,
    });
  }
  inst.instanceColor.needsUpdate = true;
  scene.add(inst);
  debris.push({ inst, parts, age: 1.2 });
}

const LIFE = 4.5, FADE = 1.2;
function stepDebris(dt) {
  for (let k = debris.length - 1; k >= 0; k--) {
    const d = debris[k];
    d.age += dt;
    const scale = d.age < LIFE - FADE ? 1 : Math.max(0, (LIFE - d.age) / FADE);
    d.parts.forEach((p, i) => {
      if (!p.rest) {
        p.vel.y -= 14 * dt;
        p.pos.addScaledVector(p.vel, dt);
        p.rot.x += p.spin.x * dt; p.rot.y += p.spin.y * dt; p.rot.z += p.spin.z * dt;
        const onBoard = Math.abs(p.pos.x) < 4.75 && Math.abs(p.pos.z) < 4.75;
        const floor = (onBoard ? (Math.abs(p.pos.x) < 4 && Math.abs(p.pos.z) < 4 ? 0 : 0.06) : TABLE_Y) + VOXEL / 2;
        if (p.pos.y < floor && (onBoard ? p.pos.y > floor - 0.3 : true)) {
          p.pos.y = floor;
          if (Math.abs(p.vel.y) < 0.8) {
            p.vel.y = 0;
            p.vel.x *= 0.82; p.vel.z *= 0.82;
            p.spin.multiplyScalar(0.6);
            // Settle flat once it has (almost) stopped.
            if (p.vel.lengthSq() < 0.01) {
              p.rest = true;
              p.rot.set(0, p.rot.y, 0);
            }
          } else {
            p.vel.y *= -0.35;
            p.vel.x *= 0.7; p.vel.z *= 0.7;
            p.spin.multiplyScalar(0.7);
          }
        }
      }
      tmpE.copy(p.rot);
      tmpQ.setFromEuler(tmpE);
      tmpS.setScalar(scale);
      tmpM.compose(p.pos, tmpQ, tmpS);
      d.inst.setMatrixAt(i, tmpM);
    });
    d.inst.instanceMatrix.needsUpdate = true;
    if (d.age >= LIFE) {
      scene.remove(d.inst);
      d.inst.dispose();
      debris.splice(k, 1);
    }
  }
}

// ---------- AI ----------
const worker = new Worker(new URL('./ai.js', import.meta.url), { type: 'module' });
worker.onmessage = (e) => {
  const { id, move } = e.data;
  if (id !== aiRequest || !move) return;
  const m = game.legalMoves().find((x) => x.from === move.from && x.to === move.to && x.promo === move.promo);
  if (m) serial(() => playMove(m));
  else busy = false;
};

function maybeAI() {
  if (isOnline() || gameOver || isHumanTurn()) return;
  busy = true;
  updateStatus();
  const [maxDepth, timeMs] = LEVELS[ui.level.value];
  const id = ++aiRequest;
  // Small pause so the previous move's debris has a moment to fly before the reply.
  setTimeout(() => {
    if (id !== aiRequest) return;
    worker.postMessage({ id, state: game.state(), maxDepth, timeMs });
  }, 450);
}

// A move made by the person at this screen (click, drag or promotion choice).
function humanMove(m, opts) {
  if (isOnline()) sendOnlineMove(m);
  return serial(() => playMove(m, opts));
}

// ---------- input: click-click and drag-and-drop ----------
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const boardPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const DRAG_Y = 0.45;
const dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -DRAG_Y);
let press = null; // { x, y, sq, id }
let drag = null; // { sq, mesh }

const canInteract = () => !busy && !gameOver && !pendingPromotion && isHumanTurn();

function setRay(e) {
  const r = canvas.getBoundingClientRect();
  pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
}

function groundSquare(e) {
  setRay(e);
  const p = new THREE.Vector3();
  if (!raycaster.ray.intersectPlane(boardPlane, p)) return -1;
  const f = Math.floor(p.x + 4), rk = Math.floor(4 - p.z);
  return f >= 0 && f < 8 && rk >= 0 && rk < 8 ? rk * 8 + f : -1;
}

function selectSquare(sq) {
  selected = sq;
  legalForSelected = sq >= 0 ? game.legalMoves().filter((m) => m.from === sq) : [];
}

canvas.addEventListener('pointerdown', (e) => {
  sound.unlock();
  if (press) return;
  press = { x: e.clientX, y: e.clientY, sq: groundSquare(e), id: e.pointerId };
  canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener('pointermove', (e) => {
  if (!press || e.pointerId !== press.id) return;
  if (!drag) {
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < 6) return;
    const p = game.board[press.sq];
    if (!canInteract() || !p || p[0] !== game.turn) return;
    drag = { sq: press.sq, mesh: pieces.get(press.sq) };
    selectSquare(press.sq);
    sound.select();
  }
  setRay(e);
  const at = new THREE.Vector3();
  if (raycaster.ray.intersectPlane(dragPlane, at)) {
    drag.mesh.position.set(at.x, DRAG_Y, at.z);
    drag.mesh.scale.setScalar(1.12);
  }
  const sq = groundSquare(e);
  if (sq !== hoverSq) {
    hoverSq = sq;
    refreshMarkers();
  }
});

function endPress(e, cancelled) {
  if (!press || e.pointerId !== press.id) return;
  const start = press;
  press = null;
  if (drag) {
    const d = drag;
    drag = null;
    hoverSq = -1;
    const target = cancelled ? -1 : groundSquare(e);
    const moves = legalForSelected.filter((m) => m.to === target);
    if (moves.length && canInteract()) {
      if (moves.length > 1) askPromotion(moves, { dragged: true });
      else humanMove(moves[0], { dragged: true });
    } else {
      // Not a legal drop: fly back home and keep it selected.
      const home = sqPos(d.sq);
      const from = d.mesh.position.clone();
      d.mesh.scale.setScalar(1);
      tween(0.18, (t) => d.mesh.position.lerpVectors(from, home, t));
      refreshMarkers();
    }
    return;
  }
  if (!cancelled) onSquare(start.sq);
}
canvas.addEventListener('pointerup', (e) => endPress(e, false));
canvas.addEventListener('pointercancel', (e) => endPress(e, true));

function onSquare(sq) {
  if (sq < 0 || !canInteract()) return;
  const p = game.board[sq];
  const targets = legalForSelected.filter((m) => m.to === sq);
  if (targets.length) {
    if (targets.length > 1) askPromotion(targets);
    else humanMove(targets[0]);
    return;
  }
  if (p && p[0] === game.turn && sq !== selected) {
    selectSquare(sq);
    sound.select();
  } else {
    selectSquare(-1);
  }
  refreshMarkers();
}

function askPromotion(moves, opts) {
  pendingPromotion = { moves, opts };
  ui.promo.hidden = false;
  ui.promo.dataset.color = game.turn;
}
ui.promo.addEventListener('click', (e) => {
  const t = e.target.closest('button')?.dataset.piece;
  if (!t || !pendingPromotion) return;
  const { moves, opts } = pendingPromotion;
  pendingPromotion = null;
  ui.promo.hidden = true;
  humanMove(moves.find((x) => x.promo === t), opts);
});

// ---------- local game controls ----------
function resetBoard(fen) {
  aiRequest++;
  generation++;
  game.reset(fen);
  sanList.length = 0;
  selectSquare(-1);
  gameOver = null;
  lastMove = null;
  busy = false;
  pendingPromotion = null;
  ui.promo.hidden = true;
  syncPieces();
  refreshMarkers();
}

function newGame() {
  if (isOnline()) return;
  resetBoard();
  setView(humanColor() || 'w');
  updateStatus();
  maybeAI();
}

function undo() {
  if (pendingPromotion || isOnline()) return;
  aiRequest++;
  generation++;
  busy = false;
  const h = humanColor();
  let n = 0;
  // Step back to the human's turn (in AI mode the AI's reply is undone too).
  do {
    if (!game.undo()) break;
    sanList.pop();
    n++;
  } while (h !== null && game.turn !== h && game.stack.length);
  if (!n) return;
  const top = game.stack[game.stack.length - 1];
  lastMove = top ? top.m : null;
  gameOver = null;
  selectSquare(-1);
  syncPieces();
  refreshMarkers();
  updateStatus();
  maybeAI();
}

// ---------- camera ----------
function setView(color) {
  viewFrom = color;
  for (const mesh of pieces.values()) mesh.rotation.y = color === 'w' ? 0 : Math.PI;
  for (const l of labels) l.rotation.z = color === 'w' ? 0 : Math.PI;
  fire.wind.set(0, 0, color === 'w' ? -0.18 : 0.18); // flames lean towards the top of the screen
  placeCamera();
}

// Fit the board (with its frame) into the part of the screen the panel does not cover.
function placeCamera() {
  const W = window.innerWidth, H = window.innerHeight;
  const panel = document.getElementById('panel').getBoundingClientRect();
  let left = 0, top = 0;
  if (W >= 900) left = panel.right;
  else if (W < H) top = panel.bottom;
  const pad = 12;
  const aw = W - left - pad * 2, ah = H - top - pad * 2;
  const SIZE = 9.6;
  const wpp = Math.max(SIZE / aw, SIZE / ah); // world units per pixel at board level
  const dist = (H * wpp) / 2 / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const cx = left + pad + aw / 2 - W / 2, cy = top + pad + ah / 2 - H / 2;
  const s = viewFrom === 'w' ? 1 : -1;
  // Screen right is +x and screen down is +z when White is at the bottom.
  camera.position.set(-cx * wpp * s, dist, -cy * wpp * s);
  camera.up.set(0, 0, -s);
  camera.lookAt(camera.position.x, 0, camera.position.z);
}

$('new').addEventListener('click', newGame);
$('undo').addEventListener('click', undo);
$('flip').addEventListener('click', () => setView(other(viewFrom)));
$('banner-new').addEventListener('click', () => {
  if (isOnline()) leaveOnlineGame();
  else newGame();
});
$('banner-close').addEventListener('click', () => { ui.banner.hidden = true; });
$('sound').addEventListener('click', (e) => {
  sound.enabled = !sound.enabled;
  e.currentTarget.textContent = sound.enabled ? '🔊' : '🔈';
});
$('panel-toggle').addEventListener('click', () => {
  document.body.classList.toggle('collapsed');
  placeCamera();
});

let previousMode = ui.mode.value;
ui.mode.addEventListener('change', () => {
  if (previousMode === 'lichess' && online.gameId && !online.finished) {
    ui.mode.value = 'lichess';
    online.message = 'Сначала завершите онлайн-партию';
    updateStatus();
    return;
  }
  previousMode = ui.mode.value;
  document.body.classList.toggle('online', isOnline());
  if (isOnline()) {
    resetBoard();
    setView('w');
    startOnline();
    updateStatus();
  } else {
    stopOnline();
    newGame();
  }
});

// ---------- lichess ----------
const lichess = new Lichess();
const online = {
  color: null, gameId: null, finished: false, players: null, clock: null, moves: 0,
  stopEvents: null, stopGame: null, cancelSeek: null, outgoing: null, incoming: null,
  message: '', lastState: null, initialFen: 'startpos', drawOffered: false,
};
const ol = {
  section: $('online'), login: $('ol-login'), lobby: $('ol-lobby'), game: $('ol-game'), me: $('ol-me'),
  tc: $('ol-tc'), rated: $('ol-rated'), seek: $('ol-seek'), user: $('ol-user'), msg: $('ol-msg'),
  top: $('ol-top'), bottom: $('ol-bottom'), resign: $('ol-resign'), draw: $('ol-draw'), leave: $('ol-leave'),
  toast: $('toast'), toastText: $('toast-text'), toastYes: $('toast-yes'), toastNo: $('toast-no'),
};

function olMessage(text) {
  online.message = text;
  updateStatus();
}

async function startOnline() {
  if (!lichess.loggedIn) { renderOnline(); return; }
  try {
    if (!lichess.me) await lichess.account();
  } catch (e) {
    olMessage(`Lichess: ${e.message}`);
    return;
  }
  if (!online.stopEvents) {
    online.stopEvents = lichess.streamEvents(onLichessEvent, (s, e) => {
      if (s === 'reconnecting') olMessage('Связь с Lichess потеряна, переподключаюсь…');
      if (s === 'open' && online.message.startsWith('Связь')) olMessage('');
      if (s === 'closed' && e) olMessage(`Lichess: ${e.message}`);
    });
  }
  renderOnline();
}

function stopOnline() {
  online.stopEvents?.();
  online.stopEvents = null;
  online.cancelSeek?.();
  online.cancelSeek = null;
  online.stopGame?.();
  online.stopGame = null;
  online.gameId = null;
  online.color = null;
  hideToast();
}

function onLichessEvent(ev) {
  const me = lichess.me && lichess.me.id;
  if (ev.type === 'gameStart') {
    const g = ev.game;
    if (online.gameId && !online.finished && online.gameId !== (g.gameId || g.id)) return;
    if (g.compat && g.compat.board === false) {
      olMessage('Эта партия не поддерживается Board API (слишком быстрый контроль)');
      return;
    }
    online.cancelSeek?.();
    online.cancelSeek = null;
    online.outgoing = null;
    hideToast();
    joinGame(g.gameId || g.id, g.color === 'white' ? 'w' : 'b');
  } else if (ev.type === 'gameFinish') {
    // The game stream delivers the final state; nothing else to do here.
  } else if (ev.type === 'challenge') {
    const c = ev.challenge;
    if (c.challenger && c.challenger.id === me) {
      online.outgoing = c;
      olMessage(`Вызов отправлен ${c.destUser ? c.destUser.name : ''}, ждём ответа…`);
    } else if (!online.gameId || online.finished) {
      online.incoming = c;
      const tc = c.timeControl && c.timeControl.type === 'clock' ? ` (${c.timeControl.show})` : '';
      showToast(`${c.challenger.name}${c.challenger.rating ? ` (${c.challenger.rating})` : ''} вызывает вас${tc}${c.rated ? ', рейтинговая' : ''}`,
        () => lichess.acceptChallenge(c.id).catch((e) => olMessage(`Не удалось принять: ${e.message}`)),
        () => lichess.declineChallenge(c.id).catch(() => {}));
    }
  } else if (ev.type === 'challengeCanceled' || ev.type === 'challengeDeclined') {
    const c = ev.challenge;
    if (online.incoming && online.incoming.id === c.id) { online.incoming = null; hideToast(); }
    if (online.outgoing && online.outgoing.id === c.id) {
      online.outgoing = null;
      olMessage(ev.type === 'challengeDeclined' ? 'Вызов отклонён' : 'Вызов отменён');
    }
  }
}

function joinGame(id, color) {
  if (online.gameId === id && !online.finished) return;
  online.stopGame?.();
  Object.assign(online, { gameId: id, color, finished: false, players: null, clock: null, moves: 0, lastState: null, message: '', drawOffered: false });
  ui.mode.value = 'lichess';
  resetBoard();
  setView(color);
  updateStatus();
  online.stopGame = lichess.streamGame(id, (msg) => onGameMessage(id, msg), (s, e) => {
    if (s === 'closed' && e) olMessage(`Партия недоступна: ${e.message}`);
  });
}

function leaveOnlineGame() {
  online.stopGame?.();
  online.stopGame = null;
  online.gameId = null;
  online.color = null;
  resetBoard();
  setView('w');
  updateStatus();
}

function onGameMessage(id, msg) {
  if (id !== online.gameId) return;
  if (msg.type === 'gameFull') {
    online.players = { w: msg.white, b: msg.black };
    online.initialFen = msg.initialFen || 'startpos';
    onGameState(msg.state);
  } else if (msg.type === 'gameState') {
    onGameState(msg);
  } else if (msg.type === 'opponentGone') {
    olMessage(msg.gone ? 'Соперник отключился' : '');
  }
}

function onGameState(st) {
  online.lastState = st;
  online.clock = { w: st.wtime, b: st.btime, at: performance.now() };
  const opp = other(online.color);
  online.drawOffered = !!st[opp === 'w' ? 'wdraw' : 'bdraw'];
  if (online.drawOffered && !online.finished) {
    showToast('Соперник предлагает ничью', () => lichess.draw(online.gameId, true).catch(() => {}),
      () => lichess.draw(online.gameId, false).catch(() => {}));
  }
  serial(() => syncWithServer(st));
}

// Bring the local board in line with the server's move list: animate a single new move,
// otherwise rebuild the position without animation.
async function syncWithServer(st) {
  if (online.lastState !== st && online.lastState.moves !== st.moves) return; // a newer state is queued
  const moves = st.moves ? st.moves.split(' ') : [];
  online.moves = moves.length;
  const local = game.stack.map((u) => toUci(u.m));
  const prefix = local.every((u, i) => u === moves[i]);
  if (prefix && moves.length === local.length + 1) {
    const m = game.moveFromUci(moves[moves.length - 1]);
    if (m) await playMove(m);
  } else if (!prefix || moves.length !== local.length) {
    resetBoard(online.initialFen);
    for (const u of moves) {
      const m = game.moveFromUci(u);
      if (!m) break;
      sanList.push(game.san(m));
      game.make(m);
      lastMove = m;
    }
    syncPieces();
    refreshMarkers();
  }
  if (st.status !== 'started' && st.status !== 'created') {
    online.finished = true;
    online.stopGame?.();
    online.stopGame = null;
    const winner = st.winner ? st.winner[0] : null;
    gameOver = { over: true, reason: st.status, winner };
    sound.check();
    hideToast();
  }
  updateStatus();
}

function sendOnlineMove(m) {
  const id = online.gameId;
  lichess.move(id, toUci(m)).catch((e) => {
    olMessage(`Ход не принят: ${e.message}`);
    // Roll back to what the server last told us.
    if (online.lastState && id === online.gameId) {
      const st = online.lastState;
      serial(async () => {
        resetBoard(online.initialFen);
        await syncWithServer(st);
      });
    }
  });
}

function timeControl() {
  const [time, increment] = ol.tc.value.split('+').map(Number);
  return { time, increment, rated: ol.rated.checked };
}

$('ol-signin').addEventListener('click', () => lichess.login().catch((e) => olMessage(`Ошибка входа: ${e.message}`)));
$('ol-logout').addEventListener('click', async () => {
  stopOnline();
  await lichess.logout();
  renderOnline();
});
ol.seek.addEventListener('click', () => {
  if (online.cancelSeek) {
    online.cancelSeek();
    online.cancelSeek = null;
    olMessage('Поиск отменён');
    return;
  }
  olMessage('Ищем соперника…');
  online.cancelSeek = lichess.seek(timeControl(), (err) => {
    online.cancelSeek = null;
    if (err) olMessage(`Поиск не удался: ${err.message}`);
    else renderOnline();
  });
  renderOnline();
});
$('ol-challenge').addEventListener('click', async () => {
  const name = ol.user.value.trim();
  if (!name) return;
  try {
    online.outgoing = await lichess.challenge(name, timeControl());
    olMessage(`Вызов отправлен ${name}, ждём ответа…`);
  } catch (e) {
    olMessage(`Не удалось вызвать ${name}: ${e.message}`);
  }
});
ol.resign.addEventListener('click', () => {
  if (!online.gameId || online.finished) return;
  const act = online.moves < 2 ? lichess.abort(online.gameId) : lichess.resign(online.gameId);
  act.catch((e) => olMessage(e.message));
});
ol.draw.addEventListener('click', () => {
  if (!online.gameId || online.finished) return;
  lichess.draw(online.gameId, true).then(() => olMessage('Ничья предложена'), (e) => olMessage(e.message));
});
ol.leave.addEventListener('click', leaveOnlineGame);

let toastHandlers = null;
function showToast(text, yes, no) {
  ol.toastText.textContent = text;
  toastHandlers = { yes, no };
  ol.toast.hidden = false;
}
function hideToast() {
  ol.toast.hidden = true;
  toastHandlers = null;
}
ol.toastYes.addEventListener('click', () => { toastHandlers?.yes(); hideToast(); });
ol.toastNo.addEventListener('click', () => { toastHandlers?.no(); hideToast(); });

const fmtClock = (ms) => {
  if (ms == null) return '';
  ms = Math.max(0, ms);
  const s = Math.floor(ms / 1000);
  const t = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  return s < 10 ? `${t}.${Math.floor((ms % 1000) / 100)}` : t;
};

function clockOf(color) {
  const c = online.clock;
  if (!c) return null;
  let ms = c[color];
  // Clocks start once both sides have moved.
  if (!online.finished && online.moves >= 2 && game.turn === color) ms -= performance.now() - c.at;
  return ms;
}

function playerLine(el, color) {
  const p = online.players && online.players[color];
  const name = p ? (p.name || p.id || (p.aiLevel ? `Stockfish ${p.aiLevel}` : '?')) : '…';
  el.querySelector('.name').textContent = `${color === 'w' ? '○' : '●'} ${name}${p && p.rating ? ` (${p.rating})` : ''}`;
  el.querySelector('.clock').textContent = fmtClock(clockOf(color));
  el.classList.toggle('active', !online.finished && game.turn === color);
}

function renderOnline() {
  if (!isOnline()) return;
  const inGame = !!online.gameId;
  ol.login.hidden = lichess.loggedIn;
  ol.lobby.hidden = !lichess.loggedIn || inGame;
  ol.game.hidden = !inGame;
  if (lichess.me) ol.me.textContent = `Вы: ${lichess.me.username}`;
  ol.seek.textContent = online.cancelSeek ? 'Отменить поиск' : 'Найти соперника';
  ol.msg.textContent = online.message;
  if (inGame) {
    playerLine(ol.top, other(online.color));
    playerLine(ol.bottom, online.color);
    ol.resign.textContent = online.moves < 2 ? 'Отменить партию' : 'Сдаться';
    ol.resign.hidden = ol.draw.hidden = online.finished;
    ol.leave.hidden = !online.finished;
  }
}

// ---------- coordinates on the frame ----------
function addCoordinates() {
  const list = [];
  const make = (text) => {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const x = c.getContext('2d');
    x.fillStyle = '#e9d8b0';
    x.font = 'bold 44px monospace';
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillText(text, 32, 34);
    const tex = new THREE.CanvasTexture(c);
    tex.magFilter = THREE.NearestFilter;
    tex.colorSpace = THREE.SRGBColorSpace;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.34),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
    m.rotation.x = -Math.PI / 2;
    scene.add(m);
    list.push(m);
    return m;
  };
  for (let i = 0; i < 8; i++) {
    for (const z of [4.37, -4.37]) make('abcdefgh'[i]).position.set(i - 3.5, 0.09, z);
    for (const x of [-4.37, 4.37]) make(String(i + 1)).position.set(x, 0.09, 3.5 - i);
  }
  return list;
}

// ---------- loop ----------
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  placeCamera();
}
window.addEventListener('resize', resize);
if (window.innerWidth < 640) document.body.classList.add('collapsed');
resize();

const clock = new THREE.Clock();
let clockTick = 0;
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;
  stepTweens(dt);
  stepDebris(dt);
  for (const m of markers.children) {
    if (m.userData.bob) {
      m.position.y = 0.14 + Math.sin(t * 3 + m.userData.sq) * 0.04;
      m.rotation.y = t * 1.5;
    }
  }
  const sources = [];
  for (const [sq, mesh] of pieces) {
    // Lift the selected piece a little (unless it is being carried or animated).
    if (!busy && (!drag || drag.mesh !== mesh)) {
      const target = sq === selected ? 0.18 + Math.sin(t * 4) * 0.03 : 0;
      mesh.position.y += (target - mesh.position.y) * Math.min(1, dt * 12);
    }
    const burn = mesh.userData.burn;
    if (burn > 0 && mesh.parent) {
      sources.push({ key: mesh.uuid, pos: mesh.position, level: burn });
      mesh.material.emissiveIntensity = (0.05 + Math.min(burn, 6) * 0.03) * (0.8 + Math.sin(t * 13 + sq) * 0.2);
    }
  }
  fire.update(dt, t, sources);
  if (isOnline() && online.gameId && (clockTick += dt) > 0.1) {
    clockTick = 0;
    renderOnline();
  }
  renderer.render(scene, camera);
});

resetBoard();
setView('w');
updateStatus();

// Coming back from the lichess login page.
lichess.handleRedirect().then((done) => {
  if (!done) return;
  ui.mode.value = 'lichess';
  ui.mode.dispatchEvent(new Event('change'));
}, (e) => {
  ui.mode.value = 'lichess';
  ui.mode.dispatchEvent(new Event('change'));
  olMessage(`Вход не удался: ${e.message}`);
});

window.__chess = { game, playMove, pieces, debris, camera, online, onLichessEvent, setView }; // for debugging from the console
