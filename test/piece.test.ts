import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PIECE_SIZE, PIECE_COUNT } from '../src/shared/config.ts';
import { pieceMask } from '../src/shared/shape.ts';
import { cutPiece, freshPayload } from '../src/shared/cut.ts';
import { readPiece, writePiece } from '../src/shared/piece-file.ts';
import { importKeys } from '../src/shared/crypto.ts';
import { applyWear } from '../src/shared/wear.ts';
import { EVENT } from '../src/shared/payload.ts';
import { WIDTH, HEIGHT, pieceOrigin } from '../src/shared/config.ts';
import { decode } from 'fast-png';

async function testKeys() {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  return importKeys(JSON.stringify(await crypto.subtle.exportKey('jwk', pair.privateKey)));
}

const master = new Uint8Array(WIDTH * HEIGHT * 4).map((_, i) => (i % 4 === 3 ? 255 : (i * 7) % 256));

test('neighbouring pieces tile the board exactly', () => {
  const owner = new Int16Array(WIDTH * HEIGHT).fill(-1);
  for (let id = 0; id < PIECE_COUNT; id++) {
    const mask = pieceMask(id);
    const { x: ox, y: oy } = pieceOrigin(id);
    for (let y = 0; y < PIECE_SIZE; y++) {
      for (let x = 0; x < PIECE_SIZE; x++) {
        if (!mask[y * PIECE_SIZE + x]) continue;
        const bx = ox + x, by = oy + y;
        assert.ok(bx >= 0 && by >= 0 && bx < WIDTH && by < HEIGHT, `piece ${id} leaks off the board`);
        assert.equal(owner[by * WIDTH + bx], -1, `pixel ${bx},${by} claimed twice`);
        owner[by * WIDTH + bx] = id;
      }
    }
  }
  assert.equal(owner.indexOf(-1), -1, 'some pixel belongs to no piece');
});

test('a piece survives a full take → wear → re-sign → read cycle', async () => {
  const keys = await testKeys();
  const rgba = cutPiece(master, WIDTH, HEIGHT, 42);
  const fresh = await writePiece({ width: PIECE_SIZE, height: PIECE_SIZE, rgba }, freshPayload(42), keys);

  const read = await readPiece(fresh.png, keys);
  assert.ok(!('error' in read));
  applyWear(read.rgba, read.width, read.height, { handling: 1, days: 30 }, pieceMask(42));
  const taken = await writePiece(read, { ...read.payload, seq: 1, owners: 1, total: 1, events: [{ type: EVENT.take, at: 1_800_000_000 }] }, keys);

  const again = await readPiece(taken.png, keys);
  assert.ok(!('error' in again));
  assert.equal(again.payload.pieceId, 42);
  assert.equal(again.payload.seq, 1);
  assert.deepEqual(again.payload.events, [{ type: EVENT.take, at: 1_800_000_000 }]);
});

test('editing the pixels or the history breaks the signature', async () => {
  const keys = await testKeys();
  const rgba = cutPiece(master, WIDTH, HEIGHT, 7);
  const { png } = await writePiece({ width: PIECE_SIZE, height: PIECE_SIZE, rgba }, freshPayload(7), keys);
  const { decodeRGBA } = await import('../src/shared/piece-file.ts');
  const { encode } = await import('fast-png');

  const painted = decodeRGBA(png);
  const centre = ((PIECE_SIZE / 2) * PIECE_SIZE + PIECE_SIZE / 2) * 4;
  painted.rgba[centre] ^= 0x80;
  const res = await readPiece(encode({ width: PIECE_SIZE, height: PIECE_SIZE, data: painted.rgba, channels: 4, depth: 8 }), keys);
  assert.deepEqual(res, { error: 'bad-signature' });

  const other = await testKeys();
  assert.deepEqual(await readPiece(png, other), { error: 'bad-signature' });
});

test('a record too big to fit still writes, keeping the newest events', async () => {
  const keys = await testKeys();
  const rgba = cutPiece(master, WIDTH, HEIGHT, 3);
  const events = Array.from({ length: 5000 }, (_, i) => ({ type: EVENT.take, at: i }));
  const { png, payload } = await writePiece({ width: PIECE_SIZE, height: PIECE_SIZE, rgba }, { ...freshPayload(3), total: 5000, events }, keys);
  assert.ok(payload.events.length < 5000 && payload.events.length > 100);
  assert.equal(payload.events.at(-1)!.at, 4999);
  const read = await readPiece(png, keys);
  assert.ok(!('error' in read));
  assert.equal(read.payload.total, 5000);
  assert.equal(decode(png).width, PIECE_SIZE);
});
