import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { Chess, fileOf, rankOf, other } from './chess.js';
import { pieceGeometry, boardGeometry, VOXEL } from './voxels.js';
import { Sound } from './sound.js';

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
scene.fog = new THREE.Fog('#1b1d26', 18, 40);

const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 0, 0);
controls.enableDamping = true;
controls.minDistance = 6;
controls.maxDistance = 32;
controls.maxPolarAngle = Math.PI * 0.47;
controls.enablePan = false;

scene.add(new THREE.HemisphereLight('#fff3e0', '#2a2440', 0.9));
const sun = new THREE.DirectionalLight('#fff1d6', 2.4);
sun.position.set(5, 11, 6);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -7, right: 7, top: 7, bottom: -7, near: 1, far: 30 });
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.02;
scene.add(sun);
const rim = new THREE.DirectionalLight('#8fb4ff', 0.6);
rim.position.set(-6, 5, -8);
scene.add(rim);

const voxelMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0.05 });

const board = new THREE.Mesh(boardGeometry(), voxelMaterial);
board.receiveShadow = true;
board.castShadow = true;
scene.add(board);

const table = new THREE.Mesh(
  new THREE.PlaneGeometry(80, 80),
  new THREE.MeshStandardMaterial({ color: '#23252f', roughness: 1 }),
);
table.rotation.x = -Math.PI / 2;
table.position.y = TABLE_Y;
table.receiveShadow = true;
scene.add(table);

addCoordinates();

const sqPos = (sq) => new THREE.Vector3(fileOf(sq) - 3.5, 0, 3.5 - rankOf(sq));

// ---------- highlights ----------
const markers = new THREE.Group();
scene.add(markers);
const tileGeo = new THREE.BoxGeometry(0.96, 0.02, 0.96);
const dotGeo = new THREE.BoxGeometry(0.2, 0.2, 0.2);
const ringGeo = ringGeometry();
const mat = (color, opacity) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
const M = {
  last: mat('#f5d76e', 0.28), select: mat('#7fd6ff', 0.45), move: mat('#7fd6ff', 0.85),
  capture: mat('#ff6b5a', 0.9), check: mat('#ff3b30', 0.55), hover: mat('#ffffff', 0.12),
};

function ringGeometry() {
  // Square ring of voxels around a capturable square.
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
let busy = false; // animation or AI in progress
let gameOver = null;
let lastMove = null;
let pendingPromotion = null;
let aiRequest = 0;
let generation = 0; // bumped by new game / undo so stale move animations stop early

const ui = {
  status: document.getElementById('status'),
  moves: document.getElementById('moves'),
  mode: document.getElementById('mode'),
  level: document.getElementById('level'),
  promo: document.getElementById('promo'),
  banner: document.getElementById('banner'),
  bannerText: document.getElementById('banner-text'),
};

const LEVELS = { 1: [1, 300], 2: [2, 600], 3: [3, 1200], 4: [5, 2500] };
const sound = new Sound();

function humanColor() {
  const mode = ui.mode.value;
  if (mode === 'pvp') return null; // both
  return mode === 'white' ? 'w' : 'b';
}
const isHumanTurn = () => {
  const h = humanColor();
  return h === null || h === game.turn;
};

function makePieceMesh(p) {
  const { geometry } = pieceGeometry(p[1], p[0]);
  const mesh = new THREE.Mesh(geometry, voxelMaterial);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.piece = p;
  if (p[1] === 'N') mesh.rotation.y = p[0] === 'w' ? Math.PI : 0;
  return mesh;
}

function syncPieces() {
  for (const m of pieces.values()) scene.remove(m);
  pieces.clear();
  game.board.forEach((p, sq) => {
    if (!p) return;
    const mesh = makePieceMesh(p);
    mesh.position.copy(sqPos(sq));
    mesh.userData.sq = sq;
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
  if (game.inCheck()) addMarker(tileGeo, M.check, game.kingSquare(game.turn), 0.015);
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
}

function updateStatus() {
  const names = { w: 'Белые', b: 'Чёрные' };
  if (gameOver) {
    const reasons = {
      checkmate: `Мат! ${names[gameOver.winner]} победили`,
      stalemate: 'Пат — ничья',
      fifty: 'Правило 50 ходов — ничья',
      material: 'Недостаточно материала — ничья',
      repetition: 'Троекратное повторение — ничья',
    };
    ui.status.textContent = reasons[gameOver.reason];
    ui.bannerText.textContent = reasons[gameOver.reason];
    ui.banner.hidden = false;
  } else {
    let s = `Ход: ${names[game.turn]}`;
    if (game.inCheck()) s += ' — шах!';
    if (!isHumanTurn()) s += ' (думает…)';
    ui.status.textContent = s;
    ui.banner.hidden = true;
  }
  ui.moves.innerHTML = '';
  for (let i = 0; i < sanList.length; i += 2) {
    const li = document.createElement('li');
    li.innerHTML = `<span>${sanList[i]}</span><span>${sanList[i + 1] || ''}</span>`;
    ui.moves.appendChild(li);
  }
  ui.moves.scrollTop = ui.moves.scrollHeight;
}

// ---------- moves ----------
async function playMove(m) {
  const gen = generation;
  busy = true;
  selected = -1;
  legalForSelected = [];
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

  const anims = [animateMove(mesh, m.from, m.to, m.piece[1] === 'N', victim ? () => {
    shatter(victim, sqPos(m.to).sub(sqPos(m.from)).normalize(), m.piece[1]);
    sound.crash();
  } : null)];
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
    scene.add(q);
    pieces.set(m.to, q);
    burst(sqPos(m.to), m.piece[0]);
    sound.promote();
  }

  const st = game.status();
  gameOver = st.over ? st : null;
  if (st.check && !st.over) sound.check();
  refreshMarkers();
  updateStatus();
  busy = false;
  maybeAI();
}

function animateMove(mesh, from, to, jump, onImpact) {
  const a = sqPos(from), b = sqPos(to);
  const dist = a.distanceTo(b);
  const dur = 0.25 + Math.min(dist, 5) * 0.07;
  const height = jump ? 0.9 : 0.15 + dist * 0.05;
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

const squash = (mesh) => tween(0.18, (t) => {
  const s = 1 - Math.sin(Math.PI * t) * 0.12;
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
    const r = Math.random();
    const vel = out.multiplyScalar(2.5 + r * 3)
      .add(dir.clone().multiplyScalar(force * (0.3 + Math.random() * 0.6)))
      .add(new THREE.Vector3((Math.random() - 0.5), 1 + Math.random() * 2 + v.y * 1.5, (Math.random() - 0.5)));
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
  if (m) playMove(m);
  else busy = false;
};

function maybeAI() {
  if (gameOver || isHumanTurn()) return;
  busy = true;
  updateStatus();
  const [maxDepth, timeMs] = LEVELS[ui.level.value];
  const id = ++aiRequest;
  const started = performance.now();
  // Small pause so the previous move's debris has a moment to fly before the reply.
  setTimeout(() => {
    if (id !== aiRequest) return;
    worker.postMessage({ id, state: game.state(), maxDepth, timeMs });
  }, Math.max(0, 450 - (performance.now() - started)));
}

// ---------- input ----------
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const boardPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
let downAt = null;

canvas.addEventListener('pointerdown', (e) => {
  sound.unlock();
  downAt = { x: e.clientX, y: e.clientY };
});
canvas.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 6) return;
  downAt = null;
  onPick(pick(e));
});

// Returns both the piece under the cursor and the board square under it: a tall piece in front
// can cover the square the player actually aimed at.
function pick(e) {
  const r = canvas.getBoundingClientRect();
  pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObjects([...pieces.values()], false)[0];
  const p = new THREE.Vector3();
  let ground = -1;
  if (raycaster.ray.intersectPlane(boardPlane, p)) {
    const f = Math.floor(p.x + 4), rk = Math.floor(4 - p.z);
    if (f >= 0 && f < 8 && rk >= 0 && rk < 8) ground = rk * 8 + f;
  }
  return { piece: hit ? hit.object.userData.sq : -1, ground };
}

function onPick({ piece, ground }) {
  const isTarget = (sq) => legalForSelected.some((m) => m.to === sq);
  const isOwn = (sq) => sq >= 0 && game.board[sq] && game.board[sq][0] === game.turn;
  let sq;
  if (isTarget(piece)) sq = piece;
  else if (isTarget(ground)) sq = ground;
  else if (isOwn(piece)) sq = piece;
  else sq = ground >= 0 ? ground : piece;
  onSquare(sq);
}

function onSquare(sq) {
  if (busy || gameOver || pendingPromotion || !isHumanTurn()) return;
  const p = game.board[sq];
  const targets = legalForSelected.filter((m) => m.to === sq);
  if (targets.length) {
    if (targets.length > 1) askPromotion(targets);
    else playMove(targets[0]);
    return;
  }
  if (p && p[0] === game.turn && sq !== selected) {
    selected = sq;
    legalForSelected = game.legalMoves().filter((m) => m.from === sq);
    sound.select();
  } else {
    selected = -1;
    legalForSelected = [];
  }
  refreshMarkers();
}

function askPromotion(moves) {
  pendingPromotion = moves;
  ui.promo.hidden = false;
  ui.promo.dataset.color = game.turn;
}
ui.promo.addEventListener('click', (e) => {
  const t = e.target.closest('button')?.dataset.piece;
  if (!t || !pendingPromotion) return;
  const m = pendingPromotion.find((x) => x.promo === t);
  pendingPromotion = null;
  ui.promo.hidden = true;
  playMove(m);
});

// ---------- controls ----------
function newGame() {
  aiRequest++;
  generation++;
  game.reset();
  sanList.length = 0;
  selected = -1;
  legalForSelected = [];
  gameOver = null;
  lastMove = null;
  busy = false;
  pendingPromotion = null;
  ui.promo.hidden = true;
  syncPieces();
  refreshMarkers();
  resetCamera();
  updateStatus();
  maybeAI();
}

function undo() {
  if (pendingPromotion) return;
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
  selected = -1;
  legalForSelected = [];
  syncPieces();
  refreshMarkers();
  updateStatus();
  maybeAI();
}

let viewFrom = 'w';
function resetCamera() {
  const h = humanColor();
  viewFrom = h || 'w';
  placeCamera();
}
function placeCamera() {
  const z = viewFrom === 'w' ? 1 : -1;
  // On narrow screens look more from above and back off until the board's width fits.
  const portrait = camera.aspect < 1;
  const polar = portrait ? 0.5 : 0.69;
  const fitWidth = 5.2 / (Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect);
  const dist = Math.max(12.9, fitWidth);
  camera.position.set(0, Math.cos(polar) * dist, Math.sin(polar) * dist * z);
  controls.target.set(0, 0, portrait ? -0.6 * z : 0);
  controls.update();
}

document.getElementById('new').addEventListener('click', newGame);
document.getElementById('undo').addEventListener('click', undo);
document.getElementById('flip').addEventListener('click', () => {
  viewFrom = other(viewFrom);
  placeCamera();
});
document.getElementById('banner-new').addEventListener('click', newGame);
document.getElementById('sound').addEventListener('click', (e) => {
  sound.enabled = !sound.enabled;
  e.currentTarget.textContent = sound.enabled ? '🔊' : '🔈';
});
ui.mode.addEventListener('change', newGame);
document.getElementById('panel-toggle').addEventListener('click', () => {
  document.body.classList.toggle('collapsed');
});

// ---------- coordinates on the frame ----------
function addCoordinates() {
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
    return m;
  };
  for (let i = 0; i < 8; i++) {
    for (const [z, flip] of [[4.37, false], [-4.37, true]]) {
      const m = make('abcdefgh'[i]);
      m.position.set(i - 3.5, 0.09, z);
      if (flip) m.rotation.z = Math.PI;
      scene.add(m);
    }
    for (const [x, flip] of [[-4.37, false], [4.37, true]]) {
      const m = make(String(i + 1));
      m.position.set(x, 0.09, 3.5 - i);
      if (flip) m.rotation.z = Math.PI;
      scene.add(m);
    }
  }
}

// ---------- loop ----------
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  // Pull back on narrow (portrait) screens so the whole board fits.
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', () => { resize(); placeCamera(); });
resize();
if (window.innerWidth < 640) document.body.classList.add('collapsed');

const clock = new THREE.Clock();
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
  // Lift the selected piece a little.
  for (const [sq, mesh] of pieces) {
    if (busy) break;
    const target = sq === selected ? 0.18 + Math.sin(t * 4) * 0.03 : 0;
    mesh.position.y += (target - mesh.position.y) * Math.min(1, dt * 12);
  }
  controls.update();
  renderer.render(scene, camera);
});

newGame();
window.__chess = { game, playMove, pieces, debris, camera, controls }; // handy for debugging from the console
