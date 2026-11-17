/**
 * Data lives in the R, G, B least-significant bits of fully opaque pixels,
 * walked in row-major order: a 32-bit big-endian length, then the bytes.
 * Frayed (semi-transparent) pixels are skipped, so wear shrinks capacity.
 */

const LENGTH_BITS = 32;

function slotCount(rgba: Uint8Array): number {
  let n = 0;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] === 255) n++;
  return n * 3;
}

function slots(rgba: Uint8Array): Int32Array {
  const out = new Int32Array(slotCount(rgba));
  let k = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] === 255) {
      out[k++] = i;
      out[k++] = i + 1;
      out[k++] = i + 2;
    }
  }
  return out;
}

/** Bytes of payload this image can carry. */
export function capacityBytes(rgba: Uint8Array): number {
  return Math.max(0, Math.floor((slotCount(rgba) - LENGTH_BITS) / 8));
}

export function embed(rgba: Uint8Array, data: Uint8Array): void {
  const s = slots(rgba);
  const bits = LENGTH_BITS + data.length * 8;
  if (bits > s.length) throw new Error(`payload of ${data.length} bytes exceeds capacity`);
  const bit = (n: number) =>
    n < LENGTH_BITS
      ? (data.length >>> (LENGTH_BITS - 1 - n)) & 1
      : (data[(n - LENGTH_BITS) >> 3] >> (7 - ((n - LENGTH_BITS) & 7))) & 1;
  for (let n = 0; n < bits; n++) rgba[s[n]] = (rgba[s[n]] & 0xfe) | bit(n);
}

export function extract(rgba: Uint8Array): Uint8Array | null {
  const s = slots(rgba);
  if (s.length < LENGTH_BITS) return null;
  let len = 0;
  for (let n = 0; n < LENGTH_BITS; n++) len = ((len << 1) | (rgba[s[n]] & 1)) >>> 0;
  if (len === 0 || LENGTH_BITS + len * 8 > s.length) return null;
  const out = new Uint8Array(len);
  for (let n = 0; n < len * 8; n++) {
    out[n >> 3] |= (rgba[s[LENGTH_BITS + n]] & 1) << (7 - (n & 7));
  }
  return out;
}

/** Copy with every RGB LSB zeroed: the pixels as they look, minus the hidden data. */
export function visiblePixels(rgba: Uint8Array): Uint8Array {
  const out = rgba.slice();
  for (let i = 0; i < out.length; i += 4) {
    out[i] &= 0xfe;
    out[i + 1] &= 0xfe;
    out[i + 2] &= 0xfe;
  }
  return out;
}
