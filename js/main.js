import * as THREE from 'three';
import { Chess, fileOf, rankOf, other, toUci } from './chess.js';
import { pieceGeometry, boardGeometry, setPieceArt, VOXEL } from './voxels.js';
import { loadPieceArt, PIECE_SETS } from './art.js';
import { Sound } from './sound.js';
import { Fire } from './fire.js';
import { burnLevels } from './burn.js';
import { Lichess } from './lichess.js';
import { Idle } from './idle.js';

function readPref(k) { try { return localStorage.getItem(k); } catch { return null; } }
function writePref(k, v) { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } }

let pieceSet = PIECE_SETS[readPref('pieces')] ? readPref('pieces') : 'cburnett';
let fireOn = readPref('fire') !== 'off';
const idle = new Idle();
idle.enabled = readPref('idle') !== 'off';
setPieceArt(await loadPieceArt(pieceSet));

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
scene.background = new THREE.Color('#1e1f22');

// Fixed camera looking straight down; a narrow field of view keeps the board almost flat
// while still showing a hint of the pieces' relief.
const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 200);

scene.add(new THREE.HemisphereLight('#ffffff', '#3a3f4a', 1.0));
const sun = new THREE.DirectionalLight('#ffffff', 2.2);
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
  new THREE.MeshStandardMaterial({ color: '#1e1f22', roughness: 1 }),
);
table.rotation.x = -Math.PI / 2;
table.position.y = TABLE_Y;
table.receiveShadow = true;
scene.add(table);

let labels = [];
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
  premove: mat('#8b6fd6', 0.5), premoveDot: mat('#8b6fd6', 0.85),
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
let startFen; // position the current game started from
let viewPly = null; // null: live position; a number: browsing history at that many plies
let historyGame = null; // the position being browsed
let premove = null; // { from, to }: one queued move for when it becomes our turn

const $ = (id) => document.getElementById(id);
const ui = {
  status: $('status'), moves: $('moves'), mode: $('mode'), level: $('level'),
  promo: $('promo'), banner: $('banner'), bannerText: $('banner-text'),
  pieces: $('pieces'), fire: $('fire'), idle: $('idle'), clock: $('clock'),
  barTop: $('bar-top'), barBottom: $('bar-bottom'),
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

// A piece is a group (positioned on the board, turned to face the viewer) holding its voxel body.
function makePieceMesh(p) {
  const body = new THREE.Mesh(pieceGeometry(p[1], p[0]).geometry, voxelMaterial);
  body.castShadow = true;
  body.receiveShadow = true;
  const obj = new THREE.Group();
  obj.add(body);
  obj.userData.body = body;
  obj.userData.piece = p;
  obj.userData.burn = 0;
  obj.rotation.y = viewFrom === 'w' ? 0 : Math.PI; // pieces stay upright for the viewer
  return obj;
}

function disposePiece(obj) {
  const m = obj.userData.body.material;
  if (m !== voxelMaterial) m.dispose();
}

function setBurn(obj, level) {
  obj.userData.burn = level;
  const body = obj.userData.body;
  if (level > 0 && body.material === voxelMaterial) {
    body.material = body.material.clone();
    body.material.emissive = new THREE.Color('#ff5a14');
  }
}

// Rebuild the piece meshes for a position: the live game, or a browsed one from history.
function syncPieces(pos = game) {
  for (const m of pieces.values()) {
    scene.remove(m);
    disposePiece(m);
  }
  pieces.clear();
  const burns = burnLevels(pos.stack.map((u) => u.m));
  pos.board.forEach((p, sq) => {
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
  const pos = historyGame || game;
  const top = pos.stack[pos.stack.length - 1];
  const last = historyGame ? top && top.m : lastMove;
  if (last) {
    addMarker(tileGeo, M.last, last.from);
    addMarker(tileGeo, M.last, last.to);
  }
  if (pos.inCheck()) addMarker(ringGeo, M.check, pos.kingSquare(pos.turn), 0.0);
  if (premove && !historyGame) {
    addMarker(tileGeo, M.premove, premove.from, 0.015);
    addMarker(tileGeo, M.premove, premove.to, 0.015);
  }
  if (selected >= 0) {
    addMarker(tileGeo, M.select, selected, 0.014);
    const seen = new Set();
    for (const m of legalForSelected) {
      if (seen.has(m.to)) continue;
      seen.add(m.to);
      if (m.premove) addMarker(dotGeo, M.premoveDot, m.to, 0.12).userData.bob = true;
      else if (m.captured) addMarker(ringGeo, M.capture, m.to, 0.0);
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
    if (premove) s += ' · премув';
    ui.status.textContent = s;
    ui.banner.hidden = true;
    ui.bannerText.textContent = '';
  }
  if (viewPly !== null) ui.status.textContent = `Просмотр: ход ${viewPly} из ${sanList.length}`;
  renderMoveList();
  renderOnline();
}

function renderMoveList() {
  const current = viewPly === null ? sanList.length : viewPly;
  ui.moves.innerHTML = '';
  for (let i = 0; i < sanList.length; i += 2) {
    const li = document.createElement('li');
    for (const k of [i, i + 1]) {
      const span = document.createElement('span');
      if (k < sanList.length) {
        span.textContent = sanList[k];
        span.dataset.ply = k + 1;
        span.classList.toggle('cur', k + 1 === current);
      }
      li.appendChild(span);
    }
    ui.moves.appendChild(li);
  }
  const cur = ui.moves.querySelector('.cur');
  if (viewPly === null || !cur) ui.moves.scrollTop = ui.moves.scrollHeight;
  else cur.scrollIntoView({ block: 'nearest' });
}

// ---------- moves ----------
// dragged: the piece was already carried to the target square by the player.
async function playMove(m, { dragged = false } = {}) {
  const gen = generation;
  if (viewPly !== null) exitHistory();
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
  if (!isOnline()) clockMoved(m.piece[0]);
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
    disposePiece(mesh);
    const q = makePieceMesh(game.board[m.to]);
    q.position.copy(sqPos(m.to));
    q.userData.sq = m.to;
    setBurn(q, mesh.userData.burn);
    scene.add(q);
    pieces.set(m.to, q);
    burst(sqPos(m.to), m.piece[0]);
    sound.promote();
  }

  if (!isOnline() && !gameOver) {
    const st = game.status();
    if (st.over) endGame(st);
  }
  if (game.inCheck() && !gameOver) sound.check();
  refreshMarkers();
  updateStatus();
  busy = false;
  maybeAI();
  tryPremove();
}

function endGame(st) {
  gameOver = st;
  premove = null;
  clockStop();
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
  disposePiece(victim);
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
        const onBoard = Math.abs(p.pos.x) < 4 && Math.abs(p.pos.z) < 4;
        const floor = (onBoard ? 0 : TABLE_Y) + VOXEL / 2;
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

// Premoves: while the opponent is to move, one move can be queued, as on lichess.
function canPremove() {
  const h = humanColor();
  if (h === null || gameOver || pendingPromotion || game.turn === h) return false;
  return !isOnline() || (!!online.gameId && !online.finished);
}
const inputMode = () => (canInteract() ? 'move' : canPremove() ? 'premove' : null);
const ownColor = (mode) => (mode === 'move' ? game.turn : humanColor());

// Squares a piece could reach on the next turn whatever the opponent does: sliders ignore
// blockers, pawns may always try to capture diagonally, the king may try to castle.
function premoveDests(sq) {
  const p = game.board[sq];
  if (!p) return [];
  const c = p[0], f = fileOf(sq), r = rankOf(sq), out = [];
  const add = (df, dr) => {
    const nf = f + df, nr = r + dr;
    if (nf >= 0 && nf < 8 && nr >= 0 && nr < 8) out.push({ from: sq, to: nr * 8 + nf, premove: true });
  };
  const ray = (df, dr) => { for (let k = 1; k < 8; k++) add(df * k, dr * k); };
  const t = p[1];
  if (t === 'P') {
    const dir = c === 'w' ? 1 : -1;
    add(0, dir);
    if (r === (c === 'w' ? 1 : 6)) add(0, 2 * dir);
    add(-1, dir);
    add(1, dir);
  } else if (t === 'N') {
    for (const [df, dr] of [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]]) add(df, dr);
  } else if (t === 'K') {
    for (let df = -1; df <= 1; df++) for (let dr = -1; dr <= 1; dr++) if (df || dr) add(df, dr);
    if (sq === (c === 'w' ? 4 : 60)) { add(2, 0); add(-2, 0); }
  } else {
    if (t !== 'B') for (const [df, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) ray(df, dr);
    if (t !== 'R') for (const [df, dr] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) ray(df, dr);
  }
  return out.filter((m) => !(game.board[m.to] && game.board[m.to][0] === c && game.board[m.to][1] !== 'R'));
}

function setPremove(from, to) {
  premove = { from, to };
  selectSquare(-1);
  sound.select();
  refreshMarkers();
  updateStatus();
}

function cancelPremove() {
  if (!premove) return;
  premove = null;
  refreshMarkers();
  updateStatus();
}

// Play the queued premove as soon as it is our turn, if it is legal now (promotes to a queen).
function tryPremove() {
  if (!premove || !canInteract()) return;
  const pm = premove;
  premove = null;
  const cands = game.legalMoves().filter((m) => m.from === pm.from && (m.to === pm.to || (m.castle && m.castle.from === pm.to)));
  const m = cands.find((x) => x.promo === 'Q') || cands[0];
  if (m) humanMove(m);
  else {
    refreshMarkers();
    updateStatus();
  }
}

// Try to act on a click or drop from square `from` to `to`; returns true if it did something.
function moveOrPremove(from, to, opts) {
  const mode = inputMode();
  if (mode === 'move') {
    const moves = game.legalMoves().filter((m) => m.from === from && m.to === to);
    if (!moves.length) return false;
    if (moves.length > 1) askPromotion(moves, opts);
    else humanMove(moves[0], opts);
    return true;
  }
  if (mode === 'premove' && premoveDests(from).some((m) => m.to === to)) {
    setPremove(from, to);
    return true;
  }
  return false;
}

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

function selectSquare(sq, mode = 'move') {
  selected = sq;
  if (sq < 0) legalForSelected = [];
  else if (mode === 'premove') legalForSelected = premoveDests(sq);
  else legalForSelected = game.legalMoves().filter((m) => m.from === sq);
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
    if (viewPly !== null) return;
    const p = game.board[press.sq];
    const mode = inputMode();
    if (!mode || !p || p[0] !== ownColor(mode) || !pieces.get(press.sq)) return;
    if (mode === 'premove') cancelPremove();
    drag = { sq: press.sq, mesh: pieces.get(press.sq) };
    selectSquare(press.sq, mode);
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
    const isMove = inputMode() === 'move';
    // A real move keeps the piece where it was dropped; a premove sends it home until it is played.
    const acted = target >= 0 && pieces.get(d.sq) === d.mesh && moveOrPremove(d.sq, target, isMove ? { dragged: true } : undefined);
    if (acted && isMove) return;
    // Not a legal drop (or a premove): fly back home.
    const home = sqPos(d.sq);
    const from = d.mesh.position.clone();
    d.mesh.scale.setScalar(1);
    tween(0.18, (t) => d.mesh.position.lerpVectors(from, home, t));
    refreshMarkers();
    return;
  }
  if (!cancelled) onSquare(start.sq);
}
canvas.addEventListener('pointerup', (e) => endPress(e, false));
canvas.addEventListener('pointercancel', (e) => endPress(e, true));

function onSquare(sq) {
  if (viewPly !== null) {
    exitHistory();
    return;
  }
  const mode = inputMode();
  if (sq < 0 || !mode) return;
  if (selected >= 0 && selected !== sq && moveOrPremove(selected, sq)) return;
  if (mode === 'premove') cancelPremove();
  const p = game.board[sq];
  if (p && p[0] === ownColor(mode) && sq !== selected) {
    selectSquare(sq, mode);
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
  startFen = fen;
  viewPly = null;
  historyGame = null;
  premove = null;
  clockReset();
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
  if (viewPly !== null) exitHistory();
  aiRequest++;
  generation++;
  busy = false;
  premove = null;
  const h = humanColor();
  let n = 0;
  // Step back to the human's turn (in AI mode the AI's reply is undone too).
  do {
    if (!game.undo()) break;
    sanList.pop();
    clockUndo();
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
  placeCoordinates(color);
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
  const bars = barsVisible ? 2 * (BAR_H + BAR_GAP) : 0;
  const aw = W - left - pad * 2, ah = H - top - pad * 2 - bars;
  const SIZE = 8.2; // the board itself plus a thin margin
  const wpp = Math.max(SIZE / aw, SIZE / ah); // world units per pixel at board level
  const dist = (H * wpp) / 2 / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const cx = left + pad + aw / 2 - W / 2, cy = top + pad + bars / 2 + ah / 2 - H / 2;
  const s = viewFrom === 'w' ? 1 : -1;
  // Screen right is +x and screen down is +z when White is at the bottom.
  camera.position.set(-cx * wpp * s, dist, -cy * wpp * s);
  camera.up.set(0, 0, -s);
  camera.lookAt(camera.position.x, 0, camera.position.z);
  camera.updateMatrixWorld();
  placeBars();
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
  Object.assign(online, { gameId: id, color, finished: false, players: null, clock: null, initialMs: 0, moves: 0, lastState: null, message: '', drawOffered: false });
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
    online.initialMs = msg.clock ? msg.clock.initial : Math.max(msg.state.wtime || 0, msg.state.btime || 0);
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
    endGame({ over: true, reason: st.status, winner });
    sound.check();
    hideToast();
  }
  updateStatus();
  tryPremove();
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

// ---------- coordinates inside the squares ----------
// Rank numbers in the top-right corner of the viewer's right-hand file, file letters in the
// bottom-left corner of the viewer's bottom rank; blue on light squares, pale on dark ones.
const labelGeo = new THREE.PlaneGeometry(0.2, 0.2);
const labelTextures = new Map();
function labelTexture(text, onLight) {
  const k = text + onLight;
  if (!labelTextures.has(k)) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const x = c.getContext('2d');
    x.fillStyle = onLight ? '#4f6f9f' : '#e4e9f0';
    x.font = 'bold 50px system-ui, sans-serif';
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillText(text, 32, 36);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    labelTextures.set(k, tex);
  }
  return labelTextures.get(k);
}

function placeCoordinates(view) {
  for (const l of labels) {
    scene.remove(l);
    l.material.dispose();
  }
  labels = [];
  const s = view === 'w' ? 1 : -1; // screen right is +x*s, screen up is -z*s
  const add = (text, sq, dx, dz) => {
    const light = ((sq & 7) + (sq >> 3)) & 1;
    const m = new THREE.Mesh(labelGeo, new THREE.MeshBasicMaterial({
      map: labelTexture(text, light), transparent: true, depthWrite: false,
    }));
    m.rotation.x = -Math.PI / 2;
    m.rotation.z = view === 'w' ? 0 : Math.PI;
    m.position.copy(sqPos(sq)).add(new THREE.Vector3(dx * s, 0.012, dz * s));
    scene.add(m);
    labels.push(m);
  };
  for (let i = 0; i < 8; i++) {
    add(String(i + 1), i * 8 + (view === 'w' ? 7 : 0), 0.37, -0.37);
    add('abcdefgh'[i], (view === 'w' ? 0 : 56) + i, -0.37, 0.37);
  }
}

// ---------- clocks ----------
// Local games can be played with a clock; online games use the lichess clock. Either way the
// remaining time is shown as bars above and below the board.
const CLOCK_OPTIONS = ['none', '1+0', '3+2', '5+3', '10+0', '15+10'];
const BAR_H = 18, BAR_GAP = 6;
const clk = { on: false, initial: 0, inc: 0, w: 0, b: 0, running: null, since: 0, history: [] };
let barsVisible = false;

function clockReset() {
  const v = ui.clock.value;
  clk.on = !isOnline() && v !== 'none';
  const [min, inc] = clk.on ? v.split('+').map(Number) : [0, 0];
  Object.assign(clk, { initial: min * 60000, inc: inc * 1000, w: min * 60000, b: min * 60000, running: null, history: [] });
}

const localClock = (c) => clk[c] - (clk.running === c ? performance.now() - clk.since : 0);

// Called just before `color` makes a move. Clocks start once both sides have moved, like on lichess.
function clockMoved(color) {
  if (!clk.on) return;
  clk.history.push({ w: clk.w, b: clk.b });
  if (clk.running === color) clk[color] = localClock(color) + clk.inc;
  clk.running = game.stack.length >= 1 ? other(color) : null;
  clk.since = performance.now();
}

function clockUndo() {
  if (!clk.on) return;
  const h = clk.history.pop();
  if (h) Object.assign(clk, h);
  clk.running = game.stack.length >= 2 ? game.turn : null;
  clk.since = performance.now();
}

function clockStop() {
  if (clk.running) clk[clk.running] = Math.max(0, localClock(clk.running));
  clk.running = null;
}

function checkFlag() {
  if (!clk.on || !clk.running || gameOver || localClock(clk.running) > 0) return;
  const loser = clk.running;
  aiRequest++;
  busy = false;
  // Lose on time, unless the opponent has nothing left to mate with.
  const rest = game.board.filter((p) => p && p[0] !== loser && p[1] !== 'K');
  const canMate = rest.some((p) => p[1] !== 'N' && p[1] !== 'B') || rest.length > 1;
  endGame({ over: true, reason: 'outoftime', winner: canMate ? other(loser) : null });
  sound.check();
  refreshMarkers();
  updateStatus();
}

function clockInfo(color) {
  if (isOnline()) {
    if (!online.gameId || !online.clock) return null;
    return { ms: clockOf(color), initial: online.initialMs || 1, running: !online.finished && online.moves >= 2 && game.turn === color };
  }
  if (!clk.on) return null;
  return { ms: localClock(color), initial: clk.initial || 1, running: clk.running === color };
}

function renderBars() {
  const visible = !!clockInfo('w');
  if (visible !== barsVisible) {
    barsVisible = visible;
    ui.barTop.hidden = ui.barBottom.hidden = !visible;
    placeCamera();
  }
  if (!visible) return;
  for (const [el, color] of [[ui.barTop, other(viewFrom)], [ui.barBottom, viewFrom]]) {
    const { ms, initial, running } = clockInfo(color);
    const frac = Math.max(0, Math.min(1, ms / initial));
    el.querySelector('.fill').style.width = `${(frac * 100).toFixed(2)}%`;
    el.querySelector('.time').textContent = `${color === 'w' ? '○' : '●'} ${fmtClock(ms)}`;
    el.classList.toggle('running', running);
    el.classList.toggle('low', ms < Math.min(20000, initial * 0.1));
  }
}

// Bars hug the board's top and bottom edges on screen.
function placeBars() {
  const a = new THREE.Vector3(-4, 0, -4).project(camera), b = new THREE.Vector3(4, 0, 4).project(camera);
  const W = window.innerWidth, H = window.innerHeight;
  const xs = [a.x, b.x].map((x) => (x + 1) / 2 * W), ys = [a.y, b.y].map((y) => (1 - y) / 2 * H);
  const left = Math.min(...xs), width = Math.abs(xs[1] - xs[0]);
  const top = Math.min(...ys), bottom = Math.max(...ys);
  Object.assign(ui.barTop.style, { left: `${left}px`, width: `${width}px`, top: `${top - BAR_GAP - BAR_H}px`, height: `${BAR_H}px` });
  Object.assign(ui.barBottom.style, { left: `${left}px`, width: `${width}px`, top: `${bottom + BAR_GAP}px`, height: `${BAR_H}px` });
}

// ---------- move history ----------
// Browse earlier positions without touching the game; any move or board click returns to it.
function showPly(k) {
  const n = game.stack.length;
  k = Math.max(0, Math.min(n, k));
  if (k === n) {
    if (viewPly !== null) exitHistory();
    return;
  }
  selectSquare(-1);
  const g = new Chess();
  g.reset(startFen);
  for (let i = 0; i < k; i++) g.make(game.stack[i].m, true);
  viewPly = k;
  historyGame = g;
  syncPieces(g);
  refreshMarkers();
  updateStatus();
  sound.tap();
}

function exitHistory() {
  viewPly = null;
  historyGame = null;
  syncPieces();
  refreshMarkers();
  updateStatus();
}

const currentPly = () => (viewPly === null ? game.stack.length : viewPly);
$('hist-first').addEventListener('click', () => showPly(0));
$('hist-prev').addEventListener('click', () => showPly(currentPly() - 1));
$('hist-next').addEventListener('click', () => showPly(currentPly() + 1));
$('hist-last').addEventListener('click', () => showPly(game.stack.length));
ui.moves.addEventListener('click', (e) => {
  const ply = e.target.dataset && e.target.dataset.ply;
  if (ply) showPly(Number(ply));
});
window.addEventListener('keydown', (e) => {
  if (e.target.closest && e.target.closest('input, select, textarea')) return;
  const keys = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -Infinity, ArrowDown: Infinity, Home: -Infinity, End: Infinity };
  if (!(e.key in keys)) return;
  e.preventDefault();
  const d = keys[e.key];
  showPly(Number.isFinite(d) ? currentPly() + d : d < 0 ? 0 : game.stack.length);
});

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
      const glow = (0.6 + Math.min(burn, 6) * 0.1) * (0.8 + Math.sin(t * 13 + sq) * 0.2);
      mesh.userData.body.material.emissiveIntensity = fireOn ? glow * 0.06 : 0;
      if (fireOn) sources.push({ key: mesh.uuid, pos: mesh.position, level: burn });
    }
  }
  // Hold new idle moves while a move is animating or a piece is in hand.
  idle.step(t, pieces, { calm: busy || !!drag, skip: drag && drag.mesh });
  fire.update(dt, t, sources);
  if ((clockTick += dt) > 0.1) {
    clockTick = 0;
    checkFlag();
    renderBars();
    if (isOnline() && online.gameId) renderOnline();
  }
  renderer.render(scene, camera);
});

ui.pieces.value = pieceSet;
ui.pieces.addEventListener('change', async () => {
  pieceSet = ui.pieces.value;
  writePref('pieces', pieceSet);
  setPieceArt(await loadPieceArt(pieceSet));
  syncPieces(historyGame || game);
});
ui.fire.checked = fireOn;
ui.idle.checked = idle.enabled;
ui.idle.addEventListener('change', () => {
  idle.enabled = ui.idle.checked;
  writePref('idle', idle.enabled ? 'on' : 'off');
});
ui.fire.addEventListener('change', () => {
  fireOn = ui.fire.checked;
  writePref('fire', fireOn ? 'on' : 'off');
});
ui.clock.value = CLOCK_OPTIONS.includes(readPref('clock')) ? readPref('clock') : 'none';
ui.clock.addEventListener('change', () => {
  writePref('clock', ui.clock.value);
  newGame();
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

window.__chess = { game, playMove, pieces, debris, camera, online, onLichessEvent, setView, clk, fire, showPly, idle }; // for debugging from the console
