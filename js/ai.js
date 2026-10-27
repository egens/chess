// Alpha-beta search with iterative deepening, quiescence and piece-square tables.
// Runs inside a Web Worker: receives { state, maxDepth, timeMs }, replies with { from, to, promo }.
import { Chess } from './chess.js';

const VALUE = { P: 100, N: 320, B: 330, R: 500, Q: 900, K: 0 };

// Tables from White's point of view, a8 first (row 0 = rank 8).
const PST = {
  P: [0, 0, 0, 0, 0, 0, 0, 0, 50, 50, 50, 50, 50, 50, 50, 50, 10, 10, 20, 30, 30, 20, 10, 10, 5, 5, 10, 25, 25, 10, 5, 5,
    0, 0, 0, 20, 20, 0, 0, 0, 5, -5, -10, 0, 0, -10, -5, 5, 5, 10, 10, -20, -20, 10, 10, 5, 0, 0, 0, 0, 0, 0, 0, 0],
  N: [-50, -40, -30, -30, -30, -30, -40, -50, -40, -20, 0, 0, 0, 0, -20, -40, -30, 0, 10, 15, 15, 10, 0, -30, -30, 5, 15, 20, 20, 15, 5, -30,
    -30, 0, 15, 20, 20, 15, 0, -30, -30, 5, 10, 15, 15, 10, 5, -30, -40, -20, 0, 5, 5, 0, -20, -40, -50, -40, -30, -30, -30, -30, -40, -50],
  B: [-20, -10, -10, -10, -10, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 10, 10, 5, 0, -10, -10, 5, 5, 10, 10, 5, 5, -10,
    -10, 0, 10, 10, 10, 10, 0, -10, -10, 10, 10, 10, 10, 10, 10, -10, -10, 5, 0, 0, 0, 0, 5, -10, -20, -10, -10, -10, -10, -10, -10, -20],
  R: [0, 0, 0, 0, 0, 0, 0, 0, 5, 10, 10, 10, 10, 10, 10, 5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, 0, 0, 0, 5, 5, 0, 0, 0],
  Q: [-20, -10, -10, -5, -5, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 5, 5, 5, 0, -10, -5, 0, 5, 5, 5, 5, 0, -5,
    0, 0, 5, 5, 5, 5, 0, -5, -10, 5, 5, 5, 5, 5, 0, -10, -10, 0, 5, 0, 0, 0, 0, -10, -20, -10, -10, -5, -5, -10, -10, -20],
  K: [-30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30,
    -20, -30, -30, -40, -40, -30, -30, -20, -10, -20, -20, -20, -20, -20, -20, -10, 20, 20, 0, 0, 0, 0, 20, 20, 20, 30, 10, 0, 0, 10, 30, 20],
  KE: [-50, -40, -30, -20, -20, -30, -40, -50, -30, -20, -10, 0, 0, -10, -20, -30, -30, -10, 20, 30, 30, 20, -10, -30, -30, -10, 30, 40, 40, 30, -10, -30,
    -30, -10, 30, 40, 40, 30, -10, -30, -30, -10, 20, 30, 30, 20, -10, -30, -30, -30, 0, 0, 0, 0, -30, -30, -50, -30, -30, -30, -30, -30, -30, -50],
};

function evaluate(g) {
  let score = 0, queens = 0, minors = 0;
  for (const p of g.board) {
    if (!p) continue;
    if (p[1] === 'Q') queens++;
    if (p[1] === 'N' || p[1] === 'B' || p[1] === 'R') minors++;
  }
  const endgame = queens === 0 || (queens <= 2 && minors <= 2);
  for (let sq = 0; sq < 64; sq++) {
    const p = g.board[sq];
    if (!p) continue;
    const t = p[1];
    // Index into the a8-first table: white mirrors ranks, black uses as-is.
    const idx = p[0] === 'w' ? (7 - (sq >> 3)) * 8 + (sq & 7) : sq;
    const v = VALUE[t] + PST[t === 'K' && endgame ? 'KE' : t][idx];
    score += p[0] === 'w' ? v : -v;
  }
  return g.turn === 'w' ? score : -score;
}

const MATE = 100000;

function order(moves, best) {
  const key = (m) => {
    if (best && m.from === best.from && m.to === best.to && m.promo === best.promo) return 1e6;
    let s = 0;
    if (m.captured) s += 10 * VALUE[m.captured[1]] - VALUE[m.piece[1]] + 1000;
    if (m.promo) s += VALUE[m.promo];
    return s;
  };
  return moves.sort((a, b) => key(b) - key(a));
}

class Search {
  constructor(g, deadline) {
    this.g = g;
    this.deadline = deadline;
    this.nodes = 0;
    this.aborted = false;
  }

  timeUp() {
    if ((++this.nodes & 1023) === 0 && performance.now() > this.deadline) this.aborted = true;
    return this.aborted;
  }

  quiesce(alpha, beta, depth = 0) {
    if (this.timeUp()) return 0;
    const stand = evaluate(this.g);
    if (stand >= beta) return beta;
    if (stand > alpha) alpha = stand;
    if (depth > 6) return alpha;
    for (const m of order(this.g.legalMoves(true))) {
      this.g.make(m, true);
      const s = -this.quiesce(-beta, -alpha, depth + 1);
      this.g.undo(true);
      if (this.aborted) return 0;
      if (s >= beta) return beta;
      if (s > alpha) alpha = s;
    }
    return alpha;
  }

  negamax(depth, alpha, beta, ply) {
    if (this.timeUp()) return 0;
    const moves = this.g.legalMoves();
    if (moves.length === 0) return this.g.inCheck() ? -MATE + ply : 0;
    if (this.g.halfmove >= 100) return 0;
    if (depth === 0) return this.quiesce(alpha, beta);
    for (const m of order(moves)) {
      this.g.make(m, true);
      const s = -this.negamax(depth - 1, -beta, -alpha, ply + 1);
      this.g.undo(true);
      if (this.aborted) return 0;
      if (s >= beta) return beta;
      if (s > alpha) alpha = s;
    }
    return alpha;
  }

  root(depth, prevBest) {
    let best = null, alpha = -Infinity;
    // Shuffle before the (stable) sort so equally good moves vary from game to game.
    const moves = order(this.g.legalMoves().sort(() => Math.random() - 0.5), prevBest);
    for (const m of moves) {
      this.g.make(m, true);
      const s = -this.negamax(depth - 1, -Infinity, -alpha, 1);
      this.g.undo(true);
      if (this.aborted) break;
      if (s > alpha) { alpha = s; best = m; }
    }
    return best;
  }
}

export function think(state, maxDepth, timeMs) {
  const g = new Chess(state);
  const search = new Search(g, performance.now() + timeMs);
  let best = null;
  for (let d = 1; d <= maxDepth; d++) {
    const m = search.root(d, best);
    if (search.aborted) break;
    if (m) best = m;
  }
  if (!best) best = g.legalMoves()[0];
  return best ? { from: best.from, to: best.to, promo: best.promo } : null;
}

if (typeof self !== 'undefined' && typeof window === 'undefined') {
  self.onmessage = (e) => {
    const { state, maxDepth, timeMs, id } = e.data;
    self.postMessage({ id, move: think(state, maxDepth, timeMs) });
  };
}
