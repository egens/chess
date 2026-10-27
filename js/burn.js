// How many captures each piece still on the board has made, by replaying the move list.
// Returns Map(square -> count); the fire on a piece grows with its count.
export function burnLevels(moves) {
  const lv = new Map();
  for (const m of moves) {
    const n = (lv.get(m.from) || 0) + (m.captured ? 1 : 0);
    lv.delete(m.from);
    lv.delete(m.to);
    if (m.epCapture !== undefined) lv.delete(m.epCapture);
    if (n) lv.set(m.to, n);
    if (m.castle) {
      const r = lv.get(m.castle.from);
      lv.delete(m.castle.from);
      if (r) lv.set(m.castle.to, r);
    }
  }
  return lv;
}
