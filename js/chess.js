// Chess rules engine. Squares are 0..63, index = rank * 8 + file, rank 0 is White's back rank.
// A piece is a two-letter string: color ('w' | 'b') + type ('P','N','B','R','Q','K').

export const FILES = 'abcdefgh';
export const sqName = (sq) => FILES[sq & 7] + ((sq >> 3) + 1);
export const fileOf = (sq) => sq & 7;
export const rankOf = (sq) => sq >> 3;
export const other = (c) => (c === 'w' ? 'b' : 'w');

const KNIGHT_D = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const KING_D = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const ROOK_D = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const BISHOP_D = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const BACK_RANK = ['R', 'N', 'B', 'Q', 'K', 'B', 'N', 'R'];

export const parseSq = (s) => FILES.indexOf(s[0]) + (Number(s[1]) - 1) * 8;
export const toUci = (m) => sqName(m.from) + sqName(m.to) + (m.promo ? m.promo.toLowerCase() : '');
export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const at = (f, r) => (f >= 0 && f < 8 && r >= 0 && r < 8 ? r * 8 + f : -1);

export class Chess {
  constructor(state) {
    if (state) this.load(state);
    else this.reset();
  }

  reset(fen) {
    if (fen && fen !== 'startpos' && fen !== START_FEN) {
      this.loadFen(fen);
      return;
    }
    this.board = new Array(64).fill(null);
    for (let f = 0; f < 8; f++) {
      this.board[f] = 'w' + BACK_RANK[f];
      this.board[8 + f] = 'wP';
      this.board[48 + f] = 'bP';
      this.board[56 + f] = 'b' + BACK_RANK[f];
    }
    this.turn = 'w';
    this.castling = { wK: true, wQ: true, bK: true, bQ: true };
    this.ep = -1;
    this.halfmove = 0;
    this.fullmove = 1;
    this.stack = [];
    this.keys = [this.key()];
  }

  // Plain serializable snapshot (used to hand a position to the AI worker).
  state() {
    return {
      board: this.board.slice(), turn: this.turn, castling: { ...this.castling },
      ep: this.ep, halfmove: this.halfmove, fullmove: this.fullmove,
    };
  }

  load(s) {
    this.board = s.board.slice();
    this.turn = s.turn;
    this.castling = { ...s.castling };
    this.ep = s.ep;
    this.halfmove = s.halfmove;
    this.fullmove = s.fullmove;
    this.stack = [];
    this.keys = [this.key()];
  }

  loadFen(fen) {
    const [placement, turn, cast = '-', ep = '-', half = '0', full = '1'] = fen.trim().split(/\s+/);
    const board = new Array(64).fill(null);
    placement.split('/').forEach((row, i) => {
      let f = 0;
      for (const ch of row) {
        if (/\d/.test(ch)) f += +ch;
        else board[(7 - i) * 8 + f++] = (ch === ch.toUpperCase() ? 'w' : 'b') + ch.toUpperCase();
      }
    });
    this.load({
      board, turn, ep: ep === '-' ? -1 : parseSq(ep), halfmove: +half, fullmove: +full,
      castling: { wK: cast.includes('K'), wQ: cast.includes('Q'), bK: cast.includes('k'), bQ: cast.includes('q') },
    });
  }

  // Legal move for a UCI string; also accepts king-takes-rook castling notation.
  moveFromUci(uci) {
    const from = parseSq(uci.slice(0, 2)), to = parseSq(uci.slice(2, 4));
    const promo = uci[4] ? uci[4].toUpperCase() : undefined;
    const legal = this.legalMoves();
    return legal.find((m) => m.from === from && m.to === to && m.promo === promo) ||
      legal.find((m) => m.castle && m.from === from && m.castle.from === to) || null;
  }

  key() {
    const c = this.castling;
    return this.board.map((p) => p || '-').join('') + this.turn +
      (c.wK ? 'K' : '') + (c.wQ ? 'Q' : '') + (c.bK ? 'k' : '') + (c.bQ ? 'q' : '') + this.ep;
  }

  isAttacked(sq, by) {
    const f = fileOf(sq), r = rankOf(sq), b = this.board;
    const pr = by === 'w' ? r - 1 : r + 1;
    for (const df of [-1, 1]) {
      const s = at(f + df, pr);
      if (s >= 0 && b[s] === by + 'P') return true;
    }
    for (const [df, dr] of KNIGHT_D) {
      const s = at(f + df, r + dr);
      if (s >= 0 && b[s] === by + 'N') return true;
    }
    for (const [df, dr] of KING_D) {
      const s = at(f + df, r + dr);
      if (s >= 0 && b[s] === by + 'K') return true;
    }
    for (const [dirs, a, q] of [[ROOK_D, by + 'R', by + 'Q'], [BISHOP_D, by + 'B', by + 'Q']]) {
      for (const [df, dr] of dirs) {
        let cf = f + df, cr = r + dr, s;
        while ((s = at(cf, cr)) >= 0) {
          const p = b[s];
          if (p) {
            if (p === a || p === q) return true;
            break;
          }
          cf += df; cr += dr;
        }
      }
    }
    return false;
  }

  kingSquare(c) {
    return this.board.indexOf(c + 'K');
  }

  inCheck(c = this.turn) {
    return this.isAttacked(this.kingSquare(c), other(c));
  }

  pseudoMoves(capturesOnly = false) {
    const moves = [], b = this.board, c = this.turn, o = other(c);
    const add = (from, to, extra) => {
      const m = { from, to, piece: b[from], captured: b[to] || null, ...extra };
      if (m.piece[1] === 'P' && (rankOf(to) === 7 || rankOf(to) === 0)) {
        for (const pr of ['Q', 'R', 'B', 'N']) moves.push({ ...m, promo: pr });
      } else moves.push(m);
    };
    for (let sq = 0; sq < 64; sq++) {
      const p = b[sq];
      if (!p || p[0] !== c) continue;
      const f = fileOf(sq), r = rankOf(sq), t = p[1];
      if (t === 'P') {
        const dir = c === 'w' ? 1 : -1, start = c === 'w' ? 1 : 6;
        const one = at(f, r + dir);
        if (!capturesOnly && one >= 0 && !b[one]) {
          add(sq, one);
          const two = at(f, r + 2 * dir);
          if (r === start && !b[two]) add(sq, two, { double: true });
        } else if (capturesOnly && one >= 0 && !b[one] && (rankOf(one) === 0 || rankOf(one) === 7)) {
          add(sq, one);
        }
        for (const df of [-1, 1]) {
          const s = at(f + df, r + dir);
          if (s < 0) continue;
          if (b[s] && b[s][0] === o) add(sq, s);
          else if (s === this.ep) add(sq, s, { epCapture: s - 8 * dir, captured: o + 'P' });
        }
      } else if (t === 'N' || t === 'K') {
        for (const [df, dr] of t === 'N' ? KNIGHT_D : KING_D) {
          const s = at(f + df, r + dr);
          if (s < 0 || (b[s] && b[s][0] === c)) continue;
          if (capturesOnly && !b[s]) continue;
          add(sq, s);
        }
        if (t === 'K' && !capturesOnly) this.castleMoves(sq, moves);
      } else {
        const dirs = t === 'R' ? ROOK_D : t === 'B' ? BISHOP_D : KING_D;
        for (const [df, dr] of dirs) {
          let cf = f + df, cr = r + dr, s;
          while ((s = at(cf, cr)) >= 0) {
            if (b[s]) {
              if (b[s][0] === o) add(sq, s);
              break;
            }
            if (!capturesOnly) add(sq, s);
            cf += df; cr += dr;
          }
        }
      }
    }
    return moves;
  }

  castleMoves(kSq, moves) {
    const c = this.turn, o = other(c), b = this.board, home = c === 'w' ? 4 : 60;
    if (kSq !== home || this.isAttacked(home, o)) return;
    if (this.castling[c + 'K'] && !b[home + 1] && !b[home + 2] && b[home + 3] === c + 'R' &&
        !this.isAttacked(home + 1, o) && !this.isAttacked(home + 2, o)) {
      moves.push({ from: home, to: home + 2, piece: c + 'K', captured: null, castle: { from: home + 3, to: home + 1 } });
    }
    if (this.castling[c + 'Q'] && !b[home - 1] && !b[home - 2] && !b[home - 3] && b[home - 4] === c + 'R' &&
        !this.isAttacked(home - 1, o) && !this.isAttacked(home - 2, o)) {
      moves.push({ from: home, to: home - 2, piece: c + 'K', captured: null, castle: { from: home - 4, to: home - 1 } });
    }
  }

  legalMoves(capturesOnly = false) {
    const c = this.turn, out = [];
    for (const m of this.pseudoMoves(capturesOnly)) {
      this.make(m, true);
      if (!this.isAttacked(this.kingSquare(c), other(c))) out.push(m);
      this.undo(true);
    }
    return out;
  }

  // fast=true skips repetition bookkeeping (used during search).
  make(m, fast = false) {
    const b = this.board, c = this.turn;
    this.stack.push({ m, castling: { ...this.castling }, ep: this.ep, halfmove: this.halfmove, fullmove: this.fullmove });
    b[m.to] = m.promo ? c + m.promo : m.piece;
    b[m.from] = null;
    if (m.epCapture !== undefined) b[m.epCapture] = null;
    if (m.castle) {
      b[m.castle.to] = b[m.castle.from];
      b[m.castle.from] = null;
    }
    this.ep = m.double ? (m.from + m.to) >> 1 : -1;
    if (m.piece[1] === 'K') this.castling[c + 'K'] = this.castling[c + 'Q'] = false;
    for (const s of [m.from, m.to]) {
      if (s === 0) this.castling.wQ = false;
      if (s === 7) this.castling.wK = false;
      if (s === 56) this.castling.bQ = false;
      if (s === 63) this.castling.bK = false;
    }
    this.halfmove = m.piece[1] === 'P' || m.captured ? 0 : this.halfmove + 1;
    if (c === 'b') this.fullmove++;
    this.turn = other(c);
    if (!fast) this.keys.push(this.key());
  }

  undo(fast = false) {
    const u = this.stack.pop();
    if (!u) return null;
    const { m } = u, b = this.board;
    this.turn = m.piece[0];
    b[m.from] = m.piece;
    b[m.to] = m.epCapture !== undefined ? null : m.captured;
    if (m.epCapture !== undefined) b[m.epCapture] = m.captured;
    if (m.castle) {
      b[m.castle.from] = b[m.castle.to];
      b[m.castle.to] = null;
    }
    this.castling = u.castling;
    this.ep = u.ep;
    this.halfmove = u.halfmove;
    this.fullmove = u.fullmove;
    if (!fast) this.keys.pop();
    return m;
  }

  insufficientMaterial() {
    const rest = this.board.filter((p) => p && p[1] !== 'K');
    if (rest.length === 0) return true;
    if (rest.length === 1 && (rest[0][1] === 'N' || rest[0][1] === 'B')) return true;
    if (rest.every((p) => p[1] === 'B')) {
      const colors = new Set();
      this.board.forEach((p, sq) => { if (p && p[1] === 'B') colors.add((fileOf(sq) + rankOf(sq)) & 1); });
      return colors.size === 1;
    }
    return false;
  }

  // { over, reason, winner } — winner is 'w' | 'b' | null.
  status() {
    const moves = this.legalMoves();
    if (moves.length === 0) {
      return this.inCheck()
        ? { over: true, reason: 'checkmate', winner: other(this.turn) }
        : { over: true, reason: 'stalemate', winner: null };
    }
    if (this.halfmove >= 100) return { over: true, reason: 'fifty', winner: null };
    if (this.insufficientMaterial()) return { over: true, reason: 'material', winner: null };
    const k = this.keys[this.keys.length - 1];
    if (this.keys.filter((x) => x === k).length >= 3) return { over: true, reason: 'repetition', winner: null };
    return { over: false, check: this.inCheck(), winner: null };
  }

  // Standard algebraic notation; call before making the move.
  san(m) {
    let s;
    if (m.castle) s = fileOf(m.to) === 6 ? 'O-O' : 'O-O-O';
    else {
      const t = m.piece[1];
      const cap = !!m.captured;
      if (t === 'P') {
        s = (cap ? FILES[fileOf(m.from)] + 'x' : '') + sqName(m.to) + (m.promo ? '=' + m.promo : '');
      } else {
        const rivals = this.legalMoves().filter((o) => o.to === m.to && o.piece === m.piece && o.from !== m.from);
        let dis = '';
        if (rivals.length) {
          const sameFile = rivals.some((o) => fileOf(o.from) === fileOf(m.from));
          const sameRank = rivals.some((o) => rankOf(o.from) === rankOf(m.from));
          if (!sameFile) dis = FILES[fileOf(m.from)];
          else if (!sameRank) dis = String(rankOf(m.from) + 1);
          else dis = sqName(m.from);
        }
        s = t + dis + (cap ? 'x' : '') + sqName(m.to);
      }
    }
    this.make(m, true);
    const n = this.legalMoves().length;
    if (this.inCheck()) s += n === 0 ? '#' : '+';
    this.undo(true);
    return s;
  }
}
