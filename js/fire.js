// Voxel fire for pieces that have captured. One instanced mesh holds every flame particle;
// each burning piece also gets a flickering glow on the board under it.
import * as THREE from 'three';

const MAX = 4000;
// Colours are additive, so they are kept dim: the flames should flicker, not blind.
const STOPS = [
  [0, new THREE.Color(0.6, 0.5, 0.25)],
  [0.25, new THREE.Color(0.6, 0.28, 0.05)],
  [0.6, new THREE.Color(0.45, 0.08, 0.02)],
  [1, new THREE.Color(0.05, 0.01, 0)],
];

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,170,60,1)');
  g.addColorStop(0.4, 'rgba(255,90,20,0.45)');
  g.addColorStop(1, 'rgba(255,40,0,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

export class Fire {
  constructor(scene) {
    this.scene = scene;
    this.mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
      MAX,
    );
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.setColorAt(0, new THREE.Color());
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    scene.add(this.mesh);
    this.parts = [];
    this.spawnAcc = new Map();
    this.glows = new Map();
    this.glowGeo = new THREE.PlaneGeometry(1, 1);
    this.glowTex = glowTexture();
    this.wind = new THREE.Vector3(0, 0, -0.18);
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._s = new THREE.Vector3();
    this._c = new THREE.Color();
  }

  // sources: [{ key, pos: Vector3, level }]
  update(dt, t, sources) {
    const live = new Set();
    for (const s of sources) {
      live.add(s.key);
      const level = Math.min(s.level, 6);
      const rate = 22 + level * 14;
      let acc = (this.spawnAcc.get(s.key) || 0) + rate * dt;
      while (acc >= 1 && this.parts.length < MAX) {
        acc -= 1;
        // Flames lick up from the token's rim so the piece's symbol stays readable from above.
        const a = Math.random() * Math.PI * 2, r = 0.36 + Math.random() * 0.08;
        const out = 0.12 + Math.random() * 0.15 + level * 0.04;
        this.parts.push({
          pos: new THREE.Vector3(s.pos.x + Math.cos(a) * r, s.pos.y + 0.12 + Math.random() * 0.1, s.pos.z + Math.sin(a) * r),
          vel: new THREE.Vector3(Math.cos(a) * out, 0.4 + Math.random() * 0.5 + level * 0.08, Math.sin(a) * out),
          age: 0,
          life: 0.4 + Math.random() * 0.4 + level * 0.04,
          size: 0.05 + Math.random() * 0.035 + level * 0.009,
          rot: Math.random() * Math.PI,
          seed: Math.random() * 10,
        });
      }
      this.spawnAcc.set(s.key, acc);

      let glow = this.glows.get(s.key);
      if (!glow) {
        glow = new THREE.Mesh(this.glowGeo, new THREE.MeshBasicMaterial({
          map: this.glowTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
        }));
        glow.rotation.x = -Math.PI / 2;
        this.scene.add(glow);
        this.glows.set(s.key, glow);
      }
      const flick = 0.85 + Math.sin(t * 17 + s.pos.x * 3) * 0.08 + Math.sin(t * 29 + s.pos.z) * 0.07;
      glow.position.set(s.pos.x, 0.02, s.pos.z);
      glow.scale.setScalar((1.2 + level * 0.12) * flick);
      glow.material.opacity = Math.min(0.6, 0.2 + level * 0.05) * flick;
    }
    for (const [key, glow] of this.glows) {
      if (live.has(key)) continue;
      this.scene.remove(glow);
      glow.material.dispose();
      this.glows.delete(key);
      this.spawnAcc.delete(key);
    }

    let n = 0;
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i];
      p.age += dt;
      if (p.age >= p.life) {
        this.parts[i] = this.parts[this.parts.length - 1];
        this.parts.pop();
        continue;
      }
      const k = p.age / p.life;
      p.vel.x += Math.sin(t * 9 + p.seed) * 0.6 * dt;
      p.vel.z += Math.cos(t * 7 + p.seed) * 0.6 * dt;
      p.pos.addScaledVector(p.vel, dt).addScaledVector(this.wind, dt);
      p.rot += dt * 3;
      this.colorAt(k, this._c);
      this.mesh.setColorAt(n, this._c);
      this._q.setFromEuler(this._e.set(p.rot, p.rot * 0.7, 0));
      this._s.setScalar(p.size * (1.1 - k * 0.8));
      this._m.compose(p.pos, this._q, this._s);
      this.mesh.setMatrixAt(n, this._m);
      n++;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  colorAt(k, out) {
    for (let i = 1; i < STOPS.length; i++) {
      if (k <= STOPS[i][0]) {
        const [k0, c0] = STOPS[i - 1], [k1, c1] = STOPS[i];
        return out.copy(c0).lerp(c1, (k - k0) / (k1 - k0));
      }
    }
    return out.copy(STOPS[STOPS.length - 1][1]);
  }
}
