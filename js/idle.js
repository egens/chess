// Small idle animations so the board does not look frozen. Every piece breathes very slightly,
// and every few seconds one random piece does a short move in character. Only the piece's body
// (the child mesh) is touched, so moving, dragging and the selection lift are unaffected.

const ease = (k) => k * k * (3 - 2 * k);
const bump = (k) => Math.sin(Math.PI * k); // 0 -> 1 -> 0

// Each returns offsets for progress k in [0, 1]: y (lift), ry (turn), sy / sxz (scale).
const MOVES = {
  // Pawn: a little hop with a squash on landing.
  P: { dur: 0.6, f: (k) => ({ y: bump(Math.min(1, k / 0.75)) * 0.1, sy: k > 0.75 ? 1 - bump((k - 0.75) / 0.25) * 0.12 : 1 }) },
  // Knight: tosses its head, a quick turn one way and back.
  N: { dur: 0.9, f: (k) => ({ ry: Math.sin(k * Math.PI * 2) * 0.22 * (1 - k), y: bump(k) * 0.03 }) },
  // Bishop: a slow pirouette.
  B: { dur: 1.4, f: (k) => ({ ry: ease(k) * Math.PI * 2 }) },
  // Rook: two heavy stomps.
  R: { dur: 0.7, f: (k) => { const s = bump((k * 2) % 1) * 0.1; return { sy: 1 - s, sxz: 1 + s * 0.5 }; } },
  // Queen: a proud swell.
  Q: { dur: 0.9, f: (k) => { const s = bump(k) * 0.07; return { sy: 1 + s, sxz: 1 + s }; } },
  // King: looks left, then right.
  K: { dur: 1.8, f: (k) => ({ ry: Math.sin(k * Math.PI * 2) * 0.18 }) },
};

export class Idle {
  constructor() {
    this.enabled = true;
    this.next = 2;
  }

  // pieces: Map(square -> group with userData.body / userData.piece); skip: a group to leave alone.
  step(t, pieces, { calm = false, skip = null } = {}) {
    if (this.enabled && !calm && t >= this.next && pieces.size) {
      const list = [...pieces.values()].filter((o) => o !== skip && !o.userData.idle);
      const o = list[Math.floor(Math.random() * list.length)];
      if (o) o.userData.idle = { start: t, move: MOVES[o.userData.piece[1]] };
      this.next = t + 1 + Math.random() * 2;
    }
    for (const o of pieces.values()) {
      const body = o.userData.body;
      if (!o.userData.phase) o.userData.phase = Math.random() * Math.PI * 2;
      let y = 0, ry = 0, sy = 1, sxz = 1;
      if (this.enabled) {
        sy = 1 + Math.sin(t * 1.7 + o.userData.phase) * 0.012; // breathing
        const a = o.userData.idle;
        if (a) {
          const k = (t - a.start) / a.move.dur;
          if (k >= 1) o.userData.idle = null;
          else {
            const r = a.move.f(k);
            y = r.y || 0;
            ry = r.ry || 0;
            sy *= r.sy || 1;
            sxz = r.sxz || 1;
          }
        }
      } else o.userData.idle = null;
      body.position.y = y;
      body.rotation.y = ry;
      body.scale.set(sxz, sy, sxz);
    }
  }
}
