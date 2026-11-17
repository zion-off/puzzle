/**
 * Physical wear, applied to the real pixels. It compounds: each owner's damage sits on top of everyone else's.
 *
 * Modelled on a real cardboard jigsaw piece, which is a thin printed paper layer glued onto board:
 * - handling rubs the print off where fingers and neighbouring pieces touch: knob tips and corners first,
 *   showing the white paper underneath. Tips soften, the gloss goes matte in patches, and now and then
 *   the print lifts and peels away near an edge, or the piece gets bent and the print cracks.
 * - time out of the puzzle yellows the print a little and can leave a stain or a peel.
 *
 * Only the outermost pixels at the tips ever lose opacity, so a piece gets soft but never dissolves.
 * Always run wear BEFORE embedding the payload.
 */

/** The white paper under the print. */
const PAPER = [236, 232, 224];

/**
 * How much wear one event adds.
 * - handling: hand-offs (1 per take or gift opened). Ten of them make a well-worn piece.
 * - days: time spent out of the puzzle, applied when the piece comes back or gets wrapped.
 */
export interface Wear {
  handling: number;
  days: number;
}

/** Per hand-off. */
const HANDLING = {
  /** How much print rubs off the edge per hand-off, on flat edges and on tips and corners. */
  rubFlat: 0.12,
  rubTip: 0.55,
  /** How much a tip's outermost pixel thins per hand-off. */
  soften: 0.05,
  scuffs: 1.2,
  peels: 0.45,
  creases: 0.07,
};

/** Per day out of the puzzle. */
const AGE = {
  /** Yellowing creeps toward this much, reaching half of it after `yellowHalfLife` days. */
  yellowMax: 0.35,
  yellowHalfLife: 730,
  stains: 0.5 / 365,
  peels: 0.2 / 365,
};

type Rand = () => number;

const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);


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

/** Smooth value noise in [0, 1], varying over roughly `cell` pixels. */
function noise(w: number, h: number, cell: number, rand: Rand): Float32Array {
  const gw = Math.ceil(w / cell) + 2, gh = Math.ceil(h / cell) + 2;
  const grid = Float32Array.from({ length: gw * gh }, () => rand());
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const gy = y / cell, y0 = Math.floor(gy), ty = smoothstep(0, 1, gy - y0);
    for (let x = 0; x < w; x++) {
      const gx = x / cell, x0 = Math.floor(gx), tx = smoothstep(0, 1, gx - x0);
      const a = grid[y0 * gw + x0], b = grid[y0 * gw + x0 + 1];
      const c = grid[(y0 + 1) * gw + x0], d = grid[(y0 + 1) * gw + x0 + 1];
      out[y * w + x] = (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
    }
  }
  return out;
}

function smoothstep(a: number, b: number, v: number) {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
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

/** Per-pixel paper fibre: fixed for each pixel, so repeated rubbing converges on the same texture. */
function paper(p: number): number[] {
  let x = p ^ 0x9e3779b9;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  x ^= x >>> 16;
  const f = ((x >>> 0) % 13) - 6;
  const g = ((x >>> 8) % 5) - 2;
  return [PAPER[0] + f + g, PAPER[1] + f, PAPER[2] + f - g];
}

/**
 * How much each edge pixel sticks out: 0 on flat or concave edges, up to 1 at knob tips and corners.
 * Measured as the share of a small disc around the pixel that falls outside the piece.
 */
function convexity(mask: Uint8Array, dist: Uint8Array, w: number, h: number, depth: number): Float32Array {
  const out = new Float32Array(w * h);
  const R = 7, disc: [number, number][] = [];
  for (let y = -R; y <= R; y++) for (let x = -R; x <= R; x++) if (x * x + y * y <= R * R) disc.push([x, y]);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (!dist[p] || dist[p] > depth) continue;
      let outside = 0;
      for (const [dx, dy] of disc) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h || !mask[ny * w + nx]) outside++;
      }
      out[p] = smoothstep(0.4, 0.62, outside / disc.length);
    }
  }
  return out;
}

/**
 * @param mask the piece's original outline (1 = inside), same size as the image. Wear never reaches outside it.
 */
export function applyWear(rgba: Uint8Array, w: number, h: number, wear: Wear, mask: Uint8Array, rand: Rand = Math.random): void {
  const handling = Math.max(0, Math.round(wear.handling));
  const days = Math.max(0, wear.days);
  if (!handling && !days) return;
  const dist = insideDistance(mask, w, h, 16);
  const tip = convexity(mask, dist, w, h, 5);
  const on = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] === 1 && rgba[(y * w + x) * 4 + 3] > 0;
  /** Expected-value count: e.g. 1.3 → 1 or 2, averaging 1.3. */
  const count = (rate: number) => Math.floor(rate + rand());

  /** The print lifts and tears away near the edge, showing white paper with a torn rim. */
  const peel = () => {
    let p = -1;
    for (let tries = 0; tries < 400 && p < 0; tries++) {
      const q = Math.floor(rand() * w * h);
      if (dist[q] >= 1 && dist[q] <= 3 && rand() < 0.15 + 0.85 * tip[q]) p = q;
    }
    if (p < 0) return;
    const cx = p % w, cy = (p - cx) / w, R = 3 + rand() * rand() * 12;
    const rough = noise(w, h, 3, rand);
    for (let y = Math.floor(cy - R - 4); y <= cy + R + 4; y++) {
      for (let x = Math.floor(cx - R - 4); x <= cx + R + 4; x++) {
        if (!on(x, y)) continue;
        const q = y * w + x;
        const r = Math.hypot(x - cx, y - cy) / R + (rough[q] - 0.5) * 0.7;
        const i = q * 4;
        if (r < 1) toward(rgba, i, paper(q), 0.92);
        else if (r < 1 + 1.2 / R) toward(rgba, i, PAPER, 0.45);
        else if (r < 1 + 3 / R) shade(rgba, i, -10);
      }
    }
  };

  for (let n = 0; n < handling; n++) {
    // Rubbed edges: print wears off the edge in patches, most at knob tips and corners.
    const patches = noise(w, h, 5, rand);
    for (let p = 0; p < w * h; p++) {
      const d = dist[p];
      if (!d || d > 5 || rgba[p * 4 + 3] === 0) continue;
      const falloff = [0, 1, 0.7, 0.4, 0.2, 0.08][d];
      const amount = (HANDLING.rubFlat + HANDLING.rubTip * tip[p]) * falloff * (0.25 + 0.75 * smoothstep(0.3, 0.75, patches[p]));
      toward(rgba, p * 4, paper(p), amount);
      // Tips soften: the outermost pixels thin out.
      if (d <= 2 && tip[p] > 0.4) {
        const thin = HANDLING.soften * tip[p] * (d === 1 ? 1 : 0.35) * (0.5 + patches[p]);
        rgba[p * 4 + 3] = Math.round(rgba[p * 4 + 3] * (1 - thin));
      }
    }

    // Matte scuffs: soft patches where the gloss and a little ink have rubbed away.
    for (let k = count(HANDLING.scuffs); k > 0; k--) {
      const cx = w * (0.2 + rand() * 0.6), cy = h * (0.2 + rand() * 0.6);
      const a = rand() * Math.PI, rx = 6 + rand() * 14, ry = 2 + rand() * 5, s = 0.1 + rand() * 0.12;
      const ca = Math.cos(a), sa = Math.sin(a);
      for (let y = Math.floor(cy - rx); y <= cy + rx; y++) {
        for (let x = Math.floor(cx - rx); x <= cx + rx; x++) {
          if (!on(x, y)) continue;
          const u = ((x - cx) * ca + (y - cy) * sa) / rx, v = (-(x - cx) * sa + (y - cy) * ca) / ry;
          const e = u * u + v * v;
          if (e < 1) toward(rgba, (y * w + x) * 4, PAPER, s * (1 - e) * (1 - e));
        }
      }
    }

    for (let k = count(HANDLING.peels); k > 0; k--) peel();

    // Creases: the piece got bent and the print cracked along a slightly wandering line.
    for (let k = count(HANDLING.creases); k > 0; k--) {
      let x = w * (0.25 + rand() * 0.5), y = h * (0.25 + rand() * 0.5), a = rand() * Math.PI * 2;
      const len = 30 + rand() * 70, bend = (rand() - 0.5) * 0.02;
      const gaps = noise(w, h, 4, rand);
      for (let t = 0; t < len; t++, x += Math.cos(a), y += Math.sin(a), a += bend) {
        const px = Math.round(x), py = Math.round(y);
        if (!on(px, py)) continue;
        const q = py * w + px, open = smoothstep(0.35, 0.6, gaps[q]);
        toward(rgba, q * 4, paper(q), 0.65 * open);
        const sx = px + Math.round(-Math.sin(a)), sy = py + Math.round(Math.cos(a));
        if (on(sx, sy)) shade(rgba, (sy * w + sx) * 4, -8 * open);
      }
    }
  }

  if (days) {
    // Yellowing: the print slowly warms like an old photo.
    const yellow = AGE.yellowMax * (1 - 0.5 ** (days / AGE.yellowHalfLife));
    for (let p = 0; p < w * h; p++) {
      const i = p * 4;
      if (rgba[i + 3] === 0 || !mask[p]) continue;
      const lum = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
      toward(rgba, i, [lum * 1.05 + 10, lum * 0.98 + 4, lum * 0.8], yellow);
    }

    // Stains: a little spill, sometimes drying into a ring.
    for (let n = count(AGE.stains * days); n > 0; n--) {
      const cx = w * (0.25 + rand() * 0.5), cy = h * (0.25 + rand() * 0.5), rad = 5 + rand() * 11;
      const ring = rand() < 0.5, strength = 0.08 + rand() * 0.1;
      for (let y = Math.floor(cy - rad - 2); y <= cy + rad + 2; y++) {
        for (let x = Math.floor(cx - rad - 2); x <= cx + rad + 2; x++) {
          if (!on(x, y)) continue;
          const r = Math.hypot(x - cx, y - cy) / rad;
          if (r > 1.15) continue;
          const k = ring ? Math.exp(-(((r - 1) / 0.12) ** 2)) + 0.25 * (r < 1 ? 1 : 0) : Math.max(0, 1 - r * r);
          const s = strength * k, i = (y * w + x) * 4;
          rgba[i] = clamp(Math.round(rgba[i] * (1 - s * 0.6)));
          rgba[i + 1] = clamp(Math.round(rgba[i + 1] * (1 - s * 0.85)));
          rgba[i + 2] = clamp(Math.round(rgba[i + 2] * (1 - s * 1.3)));
        }
      }
    }

    for (let n = count(AGE.peels * days); n > 0; n--) peel();
  }
}
