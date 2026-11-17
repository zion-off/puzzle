export const PUZZLE = {
  id: 1,
  cols: 20,
  rows: 14,
  /** Grid cell size in px. A piece image adds PAD on every side for its tabs. */
  cell: 128,
  /** Seed for every tab shape. Changing it reshapes the whole puzzle. */
  seed: 0x5eed1234,
  tab: 0.09,
  jitter: 0.04,
  /** Line segments per bezier when flattening tab curves. */
  segments: 12,
} as const;

export const PAD = Math.ceil(PUZZLE.cell * 0.32);
export const PIECE_SIZE = PUZZLE.cell + 2 * PAD;
export const PIECE_COUNT = PUZZLE.cols * PUZZLE.rows;
export const WIDTH = PUZZLE.cols * PUZZLE.cell;
export const HEIGHT = PUZZLE.rows * PUZZLE.cell;

/** Top-left of the piece image in board coordinates (may be negative for border pieces). */
export function pieceOrigin(id: number) {
  const col = id % PUZZLE.cols;
  const row = Math.floor(id / PUZZLE.cols);
  return { col, row, x: col * PUZZLE.cell - PAD, y: row * PUZZLE.cell - PAD };
}

export function isPieceId(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < PIECE_COUNT;
}
