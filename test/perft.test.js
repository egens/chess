// Move generator check against well-known perft node counts.
import assert from 'node:assert/strict';
import { Chess } from '../js/chess.js';
import { think } from '../js/ai.js';

function fromFen(fen) {
  const [placement, turn, cast, ep] = fen.split(' ');
  const board = new Array(64).fill(null);
  placement.split('/').forEach((row, i) => {
    let f = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) f += +ch;
      else board[(7 - i) * 8 + f++] = (ch === ch.toUpperCase() ? 'w' : 'b') + ch.toUpperCase();
    }
  });
  const epSq = ep === '-' ? -1 : (+ep[1] - 1) * 8 + 'abcdefgh'.indexOf(ep[0]);
  return new Chess({ board, turn, ep: epSq, halfmove: 0, fullmove: 1,
    castling: { wK: cast.includes('K'), wQ: cast.includes('Q'), bK: cast.includes('k'), bQ: cast.includes('q') } });
}

function perft(g, d) {
  if (d === 0) return 1;
  let n = 0;
  for (const m of g.legalMoves()) { g.make(m, true); n += perft(g, d - 1); g.undo(true); }
  return n;
}

const cases = [
  ['rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -', [20, 400, 8902, 197281]],
  ['r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq -', [48, 2039, 97862]],
  ['8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - -', [14, 191, 2812, 43238]],
  ['r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq -', [6, 264, 9467]],
];
for (const [fen, counts] of cases) {
  counts.forEach((c, i) => assert.equal(perft(fromFen(fen), i + 1), c, `${fen} depth ${i + 1}`));
}

// Status detection.
const mate = fromFen('rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq -');
assert.deepEqual(mate.status(), { over: true, reason: 'checkmate', winner: 'b' });
assert.equal(fromFen('7k/5Q2/6K1/8/8/8/8/8 b - -').status().reason, 'stalemate');

// AI finds mate in one: Qxf7#.
const g = fromFen('r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq -');
const best = think(g.state(), 3, 3000);
assert.deepEqual([best.from, best.to], [39, 53]);

// SAN.
const s = new Chess();
assert.equal(s.san(s.legalMoves().find((m) => m.from === 6 && m.to === 21)), 'Nf3');
console.log('all tests passed');
