/**
 * The bytes hidden inside every piece:
 *
 *   "PZL" | version u8 | puzzleId u16 | pieceId u32 | seq u32 | owners u32 | total u32
 *   | secret[16] | count u16 | count × (type u8, at u32) | signature[64]
 *
 * seq     – number of state changes so far; a file is only live if it matches the server.
 * owners  – number of people who have held the piece.
 * total   – number of events ever; only differs from count if a record ever overflowed.
 * secret  – proves the holder of this exact file is the current holder (zeros while in the puzzle).
 */

export const EVENT = { take: 1, return: 2, gift: 3, redeem: 4, ghost: 5 } as const;

export interface PieceEvent {
  type: number;
  /** Unix seconds. */
  at: number;
}

export interface Payload {
  puzzleId: number;
  pieceId: number;
  seq: number;
  owners: number;
  total: number;
  secret: Uint8Array;
  events: PieceEvent[];
}

const MAGIC = [0x50, 0x5a, 0x4c];
const VERSION = 1;
export const HEADER_BYTES = 3 + 1 + 2 + 4 + 4 + 4 + 4 + 16 + 2;
export const EVENT_BYTES = 5;
export const SIG_BYTES = 64;
export const SECRET_BYTES = 16;

export function bodySize(eventCount: number): number {
  return HEADER_BYTES + eventCount * EVENT_BYTES;
}

export function encodeBody(p: Payload): Uint8Array {
  const out = new Uint8Array(bodySize(p.events.length));
  const v = new DataView(out.buffer);
  out.set(MAGIC, 0);
  v.setUint8(3, VERSION);
  v.setUint16(4, p.puzzleId);
  v.setUint32(6, p.pieceId);
  v.setUint32(10, p.seq);
  v.setUint32(14, p.owners);
  v.setUint32(18, p.total);
  out.set(p.secret.subarray(0, SECRET_BYTES), 22);
  v.setUint16(38, p.events.length);
  let o = HEADER_BYTES;
  for (const e of p.events) {
    v.setUint8(o, e.type);
    v.setUint32(o + 1, e.at);
    o += EVENT_BYTES;
  }
  return out;
}

export function decodeBody(bytes: Uint8Array): Payload | null {
  if (bytes.length < HEADER_BYTES) return null;
  if (bytes[0] !== MAGIC[0] || bytes[1] !== MAGIC[1] || bytes[2] !== MAGIC[2]) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v.getUint8(3) !== VERSION) return null;
  const count = v.getUint16(38);
  if (bytes.length !== bodySize(count)) return null;
  const events: PieceEvent[] = [];
  for (let i = 0, o = HEADER_BYTES; i < count; i++, o += EVENT_BYTES) {
    events.push({ type: v.getUint8(o), at: v.getUint32(o + 1) });
  }
  return {
    puzzleId: v.getUint16(4),
    pieceId: v.getUint32(6),
    seq: v.getUint32(10),
    owners: v.getUint32(14),
    total: v.getUint32(18),
    secret: bytes.slice(22, 38),
    events,
  };
}
