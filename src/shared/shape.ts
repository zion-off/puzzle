import { PUZZLE, PIECE_SIZE, pieceOrigin } from './config.ts';

export type Pt = [number, number];

function hash(...values: number[]): number {
  let h = (2166136261 ^ PUZZLE.seed) >>> 0;
  for (const v of values) {
    h = Math.imul(h ^ (v >>> 0), 16777619) >>> 0;
    h ^= h >>> 15;
  }
  return h >>> 0;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * One tabbed edge from (0,0) to (1,0) as [along, across] pairs.
 * Classic three-bezier jigsaw tab; the tab may bulge to either side.
 */
function unitTab(kind: number, a: number, b: number): Pt[] {
  const rand = mulberry32(hash(kind, a, b));
  const { tab: t, jitter: j, segments } = PUZZLE;
  const u = () => (rand() * 2 - 1) * j;
  const flip = rand() < 0.5 ? 1 : -1;
  const ja = u(), jb = u(), jc = u(), jd = u(), je = u();
  const P: Pt[] = [
    [0, 0],
    [0.2, ja],
    [0.5 + jb + jd, -t + jc],
    [0.5 - t + jb, t + jc],
    [0.5 - 2 * t + jb - jd, 3 * t + jc],
    [0.5 + 2 * t + jb - jd, 3 * t + jc],
    [0.5 + t + jb, t + jc],
    [0.5 + jb + jd, -t + jc],
    [0.8, je],
    [1, 0],
  ];
  const out: Pt[] = [[0, 0]];
  for (let s = 0; s < 3; s++) {
    const [p0, p1, p2, p3] = [P[s * 3], P[s * 3 + 1], P[s * 3 + 2], P[s * 3 + 3]];
    for (let i = 1; i <= segments; i++) {
      const k = i / segments, m = 1 - k;
      const k0 = m * m * m, k1 = 3 * m * m * k, k2 = 3 * m * k * k, k3 = k * k * k;
      out.push([
        k0 * p0[0] + k1 * p1[0] + k2 * p2[0] + k3 * p3[0],
        (k0 * p0[1] + k1 * p1[1] + k2 * p2[1] + k3 * p3[1]) * flip,
      ]);
    }
  }
  return out;
}

const edgeCache = new Map<string, Pt[]>();

/** Horizontal boundary at y = row*cell spanning column `col`, left to right. */
function hEdge(row: number, col: number): Pt[] {
  const { cell, rows } = PUZZLE;
  const x0 = col * cell, y = row * cell;
  if (row === 0 || row === rows) return [[x0, y], [x0 + cell, y]];
  const key = `h${row},${col}`;
  let e = edgeCache.get(key);
  if (!e) {
    e = unitTab(0, row, col).map(([l, w]): Pt => [x0 + l * cell, y + w * cell]);
    edgeCache.set(key, e);
  }
  return e;
}

/** Vertical boundary at x = col*cell spanning row `row`, top to bottom. */
function vEdge(col: number, row: number): Pt[] {
  const { cell, cols } = PUZZLE;
  const x = col * cell, y0 = row * cell;
  if (col === 0 || col === cols) return [[x, y0], [x, y0 + cell]];
  const key = `v${col},${row}`;
  let e = edgeCache.get(key);
  if (!e) {
    e = unitTab(1, col, row).map(([l, w]): Pt => [x + w * cell, y0 + l * cell]);
    edgeCache.set(key, e);
  }
  return e;
}

/** Closed outline of a piece in board coordinates, clockwise. */
export function piecePolygon(id: number): Pt[] {
  const { col, row } = pieceOrigin(id);
  const edges = [
    hEdge(row, col),
    vEdge(col + 1, row),
    [...hEdge(row + 1, col)].reverse(),
    [...vEdge(col, row)].reverse(),
  ];
  const poly: Pt[] = [];
  for (const e of edges) for (let i = 1; i < e.length; i++) poly.push(e[i]);
  return poly;
}

/** Binary mask (1 = inside) of the piece image, PIECE_SIZE × PIECE_SIZE, sampled at pixel centres. */
export function pieceMask(id: number): Uint8Array {
  const { x: ox, y: oy } = pieceOrigin(id);
  const poly = piecePolygon(id).map(([x, y]): Pt => [x - ox, y - oy]);
  const size = PIECE_SIZE;
  const mask = new Uint8Array(size * size);
  const xs: number[] = [];
  for (let py = 0; py < size; py++) {
    const y = py + 0.5;
    xs.length = 0;
    for (let i = 0, n = poly.length; i < n; i++) {
      const [x1, y1] = poly[i];
      const [x2, y2] = poly[(i + 1) % n];
      if ((y1 <= y) !== (y2 <= y)) xs.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const from = Math.max(0, Math.ceil(xs[k] - 0.5));
      const to = Math.min(size - 1, Math.floor(xs[k + 1] - 0.5));
      for (let px = from; px <= to; px++) mask[py * size + px] = 1;
    }
  }
  return mask;
}
