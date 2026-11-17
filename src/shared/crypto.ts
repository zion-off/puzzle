import { visiblePixels } from './stego.ts';

const DOMAIN = new TextEncoder().encode('jigsaw-piece/v1');
const ALG = { name: 'Ed25519' } as const;

export interface Keys {
  sign?: CryptoKey;
  verify: CryptoKey;
}

/** SIGNING_KEY is an Ed25519 private JWK (with `d` and `x`), as written by `pnpm keygen`. */
export async function importKeys(jwkJson: string): Promise<Keys> {
  const { kty, crv, x, d } = JSON.parse(jwkJson) as JsonWebKey;
  const verify = await crypto.subtle.importKey('jwk', { kty, crv, x }, ALG, false, ['verify']);
  const sign = d ? await crypto.subtle.importKey('jwk', { kty, crv, x, d }, ALG, false, ['sign']) : undefined;
  return { sign, verify };
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource));
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return [...(await sha256(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The signature covers the payload AND how the piece looks, so neither can be edited. */
async function message(body: Uint8Array, rgba: Uint8Array, w: number, h: number): Promise<Uint8Array> {
  const dims = new Uint8Array(8);
  new DataView(dims.buffer).setUint32(0, w);
  new DataView(dims.buffer).setUint32(4, h);
  return concat(DOMAIN, body, await sha256(concat(dims, visiblePixels(rgba))));
}

export async function signPiece(keys: Keys, body: Uint8Array, rgba: Uint8Array, w: number, h: number) {
  if (!keys.sign) throw new Error('no signing key');
  const msg = await message(body, rgba, w, h);
  return new Uint8Array(await crypto.subtle.sign(ALG, keys.sign, msg as BufferSource));
}

export async function verifyPiece(keys: Keys, body: Uint8Array, sig: Uint8Array, rgba: Uint8Array, w: number, h: number) {
  const msg = await message(body, rgba, w, h);
  return crypto.subtle.verify(ALG, keys.verify, sig as BufferSource, msg as BufferSource);
}
