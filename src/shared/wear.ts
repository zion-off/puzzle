/**
 * Physical wear, applied to the real pixels on every hand-off (take or gift opened).
 * It compounds: each owner's damage sits on top of everyone else's.
 * Always run wear BEFORE embedding the payload.
 */

const PAPER = [236, 224, 198];
const FADE = 0.012;
const GRIME = 0.012;
const GRIME_DEPTH = 7;
const CREASE_AT = new Set([10, 25, 50, 100]);

type Rand = () => number;

const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

/** Stochastic rounding so tiny per-take changes still accumulate over many owners. */
const round = (v: number, rand: Rand) => clamp(Math.floor(v + rand()));

/** 4-neighbour distance (in px, capped) from each opaque pixel to the nearest non-opaque one. */
function edgeDistance(rgba: Uint8Array, w: number, h: number, cap: number): Uint8Array {
  const dist = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let head = 0, tail = 0;
  const opaque = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < w && y < h && rgba[(y * w + x) * 4 + 3] === 255;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!opaque(x, y)) continue;
      if (!opaque(x - 1, y) || !opaque(x + 1, y) || !opaque(x, y - 1) || !opaque(x, y + 1)) {
        dist[y * w + x] = 1;
        queue[tail++] = y * w + x;
      }
    }
  }
  while (head < tail) {
    const p = queue[head++];
    const d = dist[p];
    if (d >= cap) continue;
    const x = p % w, y = (p - x) / w;
    for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
      if (!opaque(nx, ny)) continue;
      const q = ny * w + nx;
      if (dist[q] === 0) {
        dist[q] = d + 1;
        queue[tail++] = q;
      }
    }
  }
  return dist;
}

function shade(rgba: Uint8Array, i: number, delta: number) {
  rgba[i] = clamp(rgba[i] + delta);
  rgba[i + 1] = clamp(rgba[i + 1] + delta);
  rgba[i + 2] = clamp(rgba[i + 2] + delta);
}

export function applyWear(rgba: Uint8Array, w: number, h: number, owners: number, rand: Rand = Math.random): void {
  const dist = edgeDistance(rgba, w, h, GRIME_DEPTH);
  const visible = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && rgba[(y * w + x) * 4 + 3] > 0;

  // Fading toward old paper, and grime where fingers hold the edges.
  for (let p = 0; p < w * h; p++) {
    const i = p * 4;
    if (rgba[i + 3] === 0) continue;
    const d = dist[p] || GRIME_DEPTH;
    const dirt = d < GRIME_DEPTH ? 1 - GRIME * (1 - d / GRIME_DEPTH) : 1;
    for (let c = 0; c < 3; c++) {
      const faded = rgba[i + c] + (PAPER[c] - rgba[i + c]) * FADE;
      rgba[i + c] = round(faded * dirt, rand);
    }
  }

  // Scuffs: short light scratches.
  const scuffs = rand() < 0.45 ? 0 : rand() < 0.7 ? 1 : 2;
  for (let s = 0; s < scuffs; s++) {
    let x = rand() * w, y = rand() * h;
    const a = rand() * Math.PI * 2, len = 6 + rand() * 20, lift = 16 + rand() * 24;
    for (let t = 0; t < len; t++, x += Math.cos(a), y += Math.sin(a)) {
      const px = Math.round(x), py = Math.round(y);
      if (!visible(px, py)) continue;
      shade(rgba, (py * w + px) * 4, lift * (1 - t / len / 2));
    }
  }

  // Creases at milestones: a light fold line with a shadow on one side.
  if (CREASE_AT.has(owners) || (owners > 100 && owners % 100 === 0)) {
    const cx = w * (0.3 + rand() * 0.4), cy = h * (0.3 + rand() * 0.4);
    const a = rand() * Math.PI;
    const nx = -Math.sin(a), ny = Math.cos(a);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (rgba[i + 3] === 0) continue;
        const s = (x - cx) * nx + (y - cy) * ny;
        if (Math.abs(s) < 0.8) shade(rgba, i, 40);
        else if (s >= 0.8 && s < 3) shade(rgba, i, -16 * (1 - (s - 0.8) / 2.2));
        else if (s <= -0.8 && s > -2) shade(rgba, i, 8);
      }
    }
  }

  // Fraying: edge pixels lose opacity (and with it, the ability to hold data).
  const edge: number[] = [];
  for (let p = 0; p < w * h; p++) if (dist[p] === 1) edge.push(p);
  for (const p of edge) {
    if (rand() < 0.035) rgba[p * 4 + 3] = rand() < 0.5 ? 0 : Math.floor(rand() * 200);
  }

  // Chips: once in a while a small bite goes missing.
  if (owners > 3 && edge.length && rand() < 0.04) {
    const p = edge[Math.floor(rand() * edge.length)];
    const ex = p % w, ey = (p - ex) / w, r = 2 + rand() * 3;
    for (let y = Math.floor(ey - r); y <= ey + r; y++) {
      for (let x = Math.floor(ex - r); x <= ex + r; x++) {
        if (x >= 0 && y >= 0 && x < w && y < h && (x - ex) ** 2 + (y - ey) ** 2 <= r * r) {
          rgba[(y * w + x) * 4 + 3] = 0;
        }
      }
    }
  }
}
