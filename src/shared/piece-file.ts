import { decode, encode } from 'fast-png';
import { PIECE_SIZE, PUZZLE } from './config.ts';
import { bodySize, decodeBody, encodeBody, SIG_BYTES, type Payload } from './payload.ts';
import { capacityBytes, embed, extract } from './stego.ts';
import { concat, signPiece, verifyPiece, type Keys } from './crypto.ts';

export interface PieceFile {
  width: number;
  height: number;
  rgba: Uint8Array;
  payload: Payload;
}

export type ReadError = 'not-png' | 'wrong-size' | 'no-payload' | 'bad-signature' | 'wrong-puzzle';

export const READ_ERRORS: Record<ReadError, string> = {
  'not-png': "That file isn't a PNG.",
  'wrong-size': "That PNG isn't a puzzle piece (wrong size).",
  'no-payload': "No piece data found. If the image was re-saved, resized or sent through a chat app, its hidden data is gone.",
  'bad-signature': "This piece's data doesn't check out. It may have been edited.",
  'wrong-puzzle': 'That piece belongs to a different puzzle.',
};

/** Read width/height from IHDR without decoding, so oversized files are rejected cheaply. */
function pngSize(bytes: Uint8Array): { w: number; h: number } | null {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 24 || sig.some((b, i) => bytes[i] !== b)) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { w: v.getUint32(16), h: v.getUint32(20) };
}

export function decodeRGBA(bytes: Uint8Array): { width: number; height: number; rgba: Uint8Array } {
  const png = decode(bytes);
  if (png.depth !== 8 || png.palette) throw new Error('unsupported PNG format');
  const { width, height, channels } = png;
  const src = png.data as Uint8Array;
  if (channels === 4) return { width, height, rgba: src };
  const rgba = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    if (channels === 3) {
      rgba.set(src.subarray(p * 3, p * 3 + 3), p * 4);
    } else if (channels === 1 || channels === 2) {
      const g = src[p * channels];
      rgba[p * 4] = rgba[p * 4 + 1] = rgba[p * 4 + 2] = g;
    }
    rgba[p * 4 + 3] = channels === 2 ? src[p * 2 + 1] : 255;
  }
  return { width, height, rgba };
}

export async function readPiece(bytes: Uint8Array, keys: Keys): Promise<PieceFile | { error: ReadError }> {
  const size = pngSize(bytes);
  if (!size) return { error: 'not-png' };
  if (size.w !== PIECE_SIZE || size.h !== PIECE_SIZE) return { error: 'wrong-size' };
  let img;
  try {
    img = decodeRGBA(bytes);
  } catch {
    return { error: 'not-png' };
  }
  const data = extract(img.rgba);
  if (!data || data.length <= SIG_BYTES) return { error: 'no-payload' };
  const body = data.subarray(0, data.length - SIG_BYTES);
  const sig = data.subarray(data.length - SIG_BYTES);
  const payload = decodeBody(body);
  if (!payload) return { error: 'no-payload' };
  if (!(await verifyPiece(keys, body, sig, img.rgba, img.width, img.height))) return { error: 'bad-signature' };
  if (payload.puzzleId !== PUZZLE.id) return { error: 'wrong-puzzle' };
  return { width: img.width, height: img.height, rgba: img.rgba, payload };
}

/**
 * Sign and hide the payload in the pixels (mutates rgba). Safety net: if the
 * record ever outgrows the pixels, the oldest events are trimmed. Returns the PNG and what actually fit.
 */
export async function writePiece(file: Omit<PieceFile, 'payload'>, payload: Payload, keys: Keys) {
  const capacity = capacityBytes(file.rgba);
  let events = payload.events;
  while (events.length && bodySize(events.length) + SIG_BYTES > capacity) events = events.slice(1);
  if (bodySize(events.length) + SIG_BYTES > capacity) throw new Error('piece is too worn to hold any data');
  const stored: Payload = { ...payload, events };
  const body = encodeBody(stored);
  const sig = await signPiece(keys, body, file.rgba, file.width, file.height);
  embed(file.rgba, concat(body, sig));
  const png = encode({ width: file.width, height: file.height, data: file.rgba, channels: 4, depth: 8 });
  return { png, payload: stored };
}

export interface Memory {
  pieceId: number;
  seq: number;
  owners: number;
  total: number;
  events: { type: number; at: number }[];
  /** Bytes of hidden storage in use / available. */
  used: number;
  capacity: number;
}

export function memoryOf(file: PieceFile): Memory {
  const p = file.payload;
  return {
    pieceId: p.pieceId,
    seq: p.seq,
    owners: p.owners,
    total: p.total,
    events: p.events,
    used: bodySize(p.events.length) + SIG_BYTES,
    capacity: capacityBytes(file.rgba),
  };
}
