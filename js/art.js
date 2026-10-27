// Classic 2D piece art (cburnett set, see assets/pieces/README.md), rasterized once at startup.
// Used directly by the "classic" theme and as the source shape for the voxel figurines.
const TYPES = ['P', 'N', 'B', 'R', 'Q', 'K'];
const SIZE = 256;

// Black pieces are drawn dark grey with a black outline, like the reference look.
function recolor(svg, color) {
  if (color === 'w') return svg;
  return svg
    .replace('<svg ', '<svg fill="#585858" ')
    .replaceAll('fill="#000"', 'fill="#585858"')
    .replaceAll('#ececec', '#a3a3a3');
}

async function rasterize(svg) {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = c.height = SIZE;
    c.getContext('2d').drawImage(img, 0, 0, SIZE, SIZE);
    return c;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Map 'wK' -> canvas (SIZE x SIZE, transparent background).
export async function loadPieceArt(base = 'assets/pieces/') {
  const art = new Map();
  await Promise.all(['w', 'b'].flatMap((c) => TYPES.map(async (t) => {
    const svg = await (await fetch(`${base}${c}${t}.svg`)).text();
    art.set(c + t, await rasterize(recolor(svg, c)));
  })));
  return art;
}

// Downsample a piece image to an n x n grid of cells: null (empty) or { r, g, b, dark }.
// Each cell takes the colour of its dominant tone, so thin outlines survive as dark cells.
export function artGrid(canvas, n) {
  const px = canvas.getContext('2d').getImageData(0, 0, SIZE, SIZE).data;
  const cell = SIZE / n;
  const grid = [];
  for (let row = 0; row < n; row++) {
    const line = [];
    for (let col = 0; col < n; col++) {
      const tones = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]; // dark, mid, light: count, r, g, b
      let total = 0, opaque = 0;
      for (let y = Math.floor(row * cell); y < Math.floor((row + 1) * cell); y++) {
        for (let x = Math.floor(col * cell); x < Math.floor((col + 1) * cell); x++) {
          const i = (y * SIZE + x) * 4;
          total++;
          if (px[i + 3] < 128) continue;
          opaque++;
          const r = px[i], g = px[i + 1], b = px[i + 2];
          const luma = 0.3 * r + 0.59 * g + 0.11 * b;
          const t = tones[luma < 50 ? 0 : luma < 190 ? 1 : 2];
          t[0]++; t[1] += r; t[2] += g; t[3] += b;
        }
      }
      if (opaque / total < 0.4) { line.push(null); continue; }
      // Favour the outline: a cell that is a third dark reads as outline.
      let k = tones[0][0] > opaque * 0.33 ? 0 : tones[1][0] >= tones[2][0] ? 1 : 2;
      if (tones[k][0] === 0) k = tones.findIndex((t) => t[0] > 0);
      const t = tones[k];
      line.push({ r: t[1] / t[0] / 255, g: t[2] / t[0] / 255, b: t[3] / t[0] / 255, dark: k === 0 });
    }
    grid.push(line);
  }
  return grid;
}
