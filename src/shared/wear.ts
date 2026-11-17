/**
 * Physical wear, applied to the real pixels on every hand-off (take or gift opened).
 * It compounds: each owner's damage sits on top of everyone else's.
 * Modelled on a cardboard piece: the print fades and yellows, rubs off at the edges to show the board,
 * picks up grime, scuffs, stains and creases. Only the outermost pixels of the original outline can
 * fray or chip away, so a piece gets ragged but never dissolves.
 * Always run wear BEFORE embedding the payload.
 */

/** Bare cardboard, where the print has rubbed off. */
const BOARD = [228, 218, 198];
const GRIME_DEPTH = 10;
/** How far from the original outline pixels can fray or chip away entirely. */
const FRAY_DEPTH = 2;
const CHIP_DEPTH = 5;

/**
 * How much wear one event adds.
 * - handling: hand-offs (1 per take or gift opened). Rubs edges, adds grime, scuffs, creases and chips.
 *   Ten of them make a well-worn piece.
 * - days: time spent out of the puzzle, applied when the piece comes back or gets wrapped.
 *   Fades and yellows the print, and now and then adds a stain or a peel.
 */
export interface Wear {
  handling: number;
  days: number;
}

/** Per hand-off. */
const HANDLING = {
  fade: 0.05,
  /** The surface print rubs thin: contrast and saturation drain away. */
  rub: 0.05,
  grime: 0.1,
  whiten: [0, 0.3, 0.2, 0.12, 0.06, 0.03],
  fray: [0, 0.07, 0.025],
  scuffs: 3,
  creases: 0.3,
  chips: 0.6,
  peels: 0.15,
};

/** Per day out of the puzzle. */
const AGE = {
  /** The print is half-faded after this many days out. */
  fadeHalfLife: 365,
  stains: 0.5 / 365,
  peels: 0.3 / 365,
};

type Rand = () => number;

const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

/** Stochastic rounding so tiny per-take changes still accumulate over many owners. */
const round = (v: number, rand: Rand) => clamp(Math.floor(v + rand()));

/** 4-neighbour distance (in px, capped) from each pixel inside the mask to the nearest pixel outside it. */
function insideDistance(mask: Uint8Array, w: number, h: number, cap: number): Uint8Array {
  const dist = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let head = 0, tail = 0;
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] === 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!inside(x, y)) continue;
      if (!inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1)) {
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
      if (!inside(nx, ny)) continue;
      const q = ny * w + nx;
      if (dist[q] === 0) {
        dist[q] = d + 1;
        queue[tail++] = q;
      }
    }
  }
  // Anything deeper than the cap is simply "far from the edge".
  for (let p = 0; p < w * h; p++) if (mask[p] && !dist[p]) dist[p] = cap + 1;
  return dist;
}

/** Blend a pixel toward a colour. */
function toward(rgba: Uint8Array, i: number, c: readonly number[], t: number) {
  for (let k = 0; k < 3; k++) rgba[i + k] = clamp(Math.round(rgba[i + k] + (c[k] - rgba[i + k]) * t));
}

function shade(rgba: Uint8Array, i: number, delta: number) {
  rgba[i] = clamp(rgba[i] + delta);
  rgba[i + 1] = clamp(rgba[i + 1] + delta);
  rgba[i + 2] = clamp(rgba[i + 2] + delta);
}

/**
 * @param mask the piece's original outline (1 = inside), same size as the image. Wear never reaches outside it,
 *             and only its outer FRAY_DEPTH / CHIP_DEPTH pixels can lose opacity.
 */
export function applyWear(rgba: Uint8Array, w: number, h: number, wear: Wear, mask: Uint8Array, rand: Rand = Math.random): void {
  const handling = Math.max(0, wear.handling);
  const days = Math.max(0, wear.days);
  if (!handling && !days) return;
  const dist = insideDistance(mask, w, h, 16);
  const visible = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && rgba[(y * w + x) * 4 + 3] > 0;
  /** Expected-value count: e.g. 1.3 → 1 or 2, averaging 1.3. */
  const count = (rate: number) => Math.floor(rate + rand());
  /** Compound a per-unit fraction over n units. */
  const over = (perUnit: number, n: number) => 1 - (1 - perUnit) ** n;

  // The print fades and yellows like an old photo (time, plus a little from handling),
  // and grime builds up where fingers hold the edges.
  const fade = 1 - (1 - over(HANDLING.fade, handling)) * 0.5 ** (days / AGE.fadeHalfLife);
  const grime = over(HANDLING.grime, handling);
  const rub = over(HANDLING.rub, handling);
  for (let p = 0; p < w * h; p++) {
    const i = p * 4;
    if (rgba[i + 3] === 0 || !mask[p]) continue;
    if (rub) {
      const l = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
      const flat = 150 + (l - 150) * 0.55;
      for (let c = 0; c < 3; c++) rgba[i + c] = clamp(Math.round(rgba[i + c] + (flat + (BOARD[c] - 213) * 0.5 - rgba[i + c]) * rub * 0.7));
    }
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    const sepia = [lum * 1.04 + 8, lum * 0.97 + 4, lum * 0.82];
    const d = dist[p];
    const dirt = d < GRIME_DEPTH ? grime * (1 - d / GRIME_DEPTH) : 0;
    const keep = [1 - dirt * 0.8, 1 - dirt, 1 - dirt * 1.4];
    for (let c = 0; c < 3; c++) {
      const v = rgba[i + c];
      rgba[i + c] = round((v + (sepia[c] - v) * fade) * Math.max(0, keep[c]), rand);
    }
  }

  // Edge whitening: the print rubs off the edges first, showing the bare board.
  if (handling) {
    const chance = HANDLING.whiten.map((c) => over(c, handling));
    for (let p = 0; p < w * h; p++) {
      const d = dist[p];
      if (!d || d >= chance.length || rgba[p * 4 + 3] === 0) continue;
      if (rand() < chance[d]) toward(rgba, p * 4, BOARD, 0.5 + rand() * 0.45);
    }
  }

  // Scuffs: short rubbed lines where the print has worn thin.
  for (let n = count(HANDLING.scuffs * handling); n > 0; n--) {
    let x = rand() * w, y = rand() * h;
    const a = rand() * Math.PI * 2, len = 10 + rand() * 35, t0 = 0.25 + rand() * 0.3, thick = rand() < 0.5;
    for (let t = 0; t < len; t++, x += Math.cos(a), y += Math.sin(a)) {
      const px = Math.round(x), py = Math.round(y);
      for (const [ox, oy] of thick ? [[0, 0], [1, 0], [0, 1]] : [[0, 0]]) {
        const qx = px + ox, qy = py + oy;
        if (!visible(qx, qy) || !mask[qy * w + qx]) continue;
        toward(rgba, (qy * w + qx) * 4, BOARD, t0 * (1 - t / len / 2) * (0.7 + rand() * 0.3));
      }
    }
  }

  // Stains: a little spill, sometimes drying into a ring.
  for (let n = count(AGE.stains * days); n > 0; n--) {
    const cx = w * (0.25 + rand() * 0.5), cy = h * (0.25 + rand() * 0.5), rad = 5 + rand() * 11;
    const ring = rand() < 0.5, strength = 0.08 + rand() * 0.1;
    for (let y = Math.floor(cy - rad - 2); y <= cy + rad + 2; y++) {
      for (let x = Math.floor(cx - rad - 2); x <= cx + rad + 2; x++) {
        if (!visible(x, y) || !mask[y * w + x]) continue;
        const r = Math.hypot(x - cx, y - cy) / rad;
        if (r > 1.15) continue;
        const k = ring ? Math.exp(-(((r - 1) / 0.12) ** 2)) + 0.25 * (r < 1 ? 1 : 0) : Math.max(0, 1 - r * r);
        const s = strength * k;
        const i = (y * w + x) * 4;
        rgba[i] = clamp(Math.round(rgba[i] * (1 - s * 0.6)));
        rgba[i + 1] = clamp(Math.round(rgba[i + 1] * (1 - s * 0.85)));
        rgba[i + 2] = clamp(Math.round(rgba[i + 2] * (1 - s * 1.3)));
      }
    }
  }

  // Peels: a tiny patch of print lifts off the surface.
  for (let n = count(HANDLING.peels * handling + AGE.peels * days); n > 0; n--) {
    const cx = w * (0.25 + rand() * 0.5), cy = h * (0.25 + rand() * 0.5), rad = 2 + rand() * 4;
    for (let y = Math.floor(cy - rad - 1); y <= cy + rad + 1; y++) {
      for (let x = Math.floor(cx - rad - 1); x <= cx + rad + 1; x++) {
        if (!visible(x, y) || !mask[y * w + x]) continue;
        const r = Math.hypot(x - cx, y - cy) / rad + (rand() - 0.5) * 0.4;
        if (r < 1) toward(rgba, (y * w + x) * 4, BOARD, 0.85);
      }
    }
  }

  // Creases: a light fold line with a shadow on one side.
  for (let n = count(HANDLING.creases * handling); n > 0; n--) {
    const cx = w * (0.3 + rand() * 0.4), cy = h * (0.3 + rand() * 0.4);
    const a = rand() * Math.PI;
    const nx = -Math.sin(a), ny = Math.cos(a);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (rgba[i + 3] === 0 || !mask[y * w + x]) continue;
        const s = (x - cx) * nx + (y - cy) * ny;
        if (Math.abs(s) < 0.8) toward(rgba, i, BOARD, 0.4 + rand() * 0.25);
        else if (s >= 0.8 && s < 3.5) shade(rgba, i, -18 * (1 - (s - 0.8) / 2.7));
        else if (s <= -0.8 && s > -2) shade(rgba, i, 8);
      }
    }
  }

  // Fraying: the outermost pixels slowly come away, leaving a slightly ragged edge.
  if (handling) {
    const chance = HANDLING.fray.map((c) => over(c, handling));
    for (let p = 0; p < w * h; p++) {
      const d = dist[p];
      if (!d || d > FRAY_DEPTH || rgba[p * 4 + 3] === 0) continue;
      if (rand() < chance[d]) {
        rgba[p * 4 + 3] = rand() < 0.4 ? 0 : 120 + Math.floor(rand() * 120);
        toward(rgba, p * 4, BOARD, 0.6);
      }
    }
  }

  // Chips: a small bite comes out of the edge, with torn board around it.
  const chips = count(HANDLING.chips * handling);
  if (chips) {
    const edge: number[] = [];
    for (let p = 0; p < w * h; p++) if (dist[p] === 1) edge.push(p);
    for (let n = chips; n > 0 && edge.length; n--) {
      const p = edge[Math.floor(rand() * edge.length)];
      const ex = p % w, ey = (p - ex) / w, r = 2 + rand() * 3.5;
      for (let y = Math.floor(ey - r - 2); y <= ey + r + 2; y++) {
        for (let x = Math.floor(ex - r - 2); x <= ex + r + 2; x++) {
          if (x < 0 || y < 0 || x >= w || y >= h || !mask[y * w + x]) continue;
          const q = y * w + x, dd = Math.hypot(x - ex, y - ey);
          if (dd <= r && dist[q] <= CHIP_DEPTH) rgba[q * 4 + 3] = 0;
          else if (dd <= r + 2 && rgba[q * 4 + 3] > 0) toward(rgba, q * 4, BOARD, 0.55);
        }
      }
    }
  }
}
