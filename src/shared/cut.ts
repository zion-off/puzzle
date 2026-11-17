import { PIECE_SIZE, pieceOrigin } from './config.ts';
import { pieceMask } from './shape.ts';
import { EVENT, SECRET_BYTES, type Payload } from './payload.ts';
import { PUZZLE } from './config.ts';

/** Cut a fresh, never-taken piece out of the master image. */
export function cutPiece(master: Uint8Array, masterWidth: number, masterHeight: number, id: number): Uint8Array {
  const S = PIECE_SIZE;
  const { x: ox, y: oy } = pieceOrigin(id);
  const mask = pieceMask(id);
  const out = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const mx = ox + x, my = oy + y;
      if (!mask[y * S + x] || mx < 0 || my < 0 || mx >= masterWidth || my >= masterHeight) continue;
      const src = (my * masterWidth + mx) * 4, dst = (y * S + x) * 4;
      out[dst] = master[src];
      out[dst + 1] = master[src + 1];
      out[dst + 2] = master[src + 2];
      out[dst + 3] = 255;
    }
  }
  return out;
}

export function freshPayload(id: number): Payload {
  return {
    puzzleId: PUZZLE.id,
    pieceId: id,
    seq: 0,
    owners: 0,
    total: 0,
    secret: new Uint8Array(SECRET_BYTES),
    events: [],
  };
}

export { EVENT };
