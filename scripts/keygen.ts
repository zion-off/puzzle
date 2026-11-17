// Generates an Ed25519 signing key and an admin token.
//   pnpm keygen          → .dev.vars (local dev)
//   pnpm keygen --prod   → .prod.vars (production; upload with `pnpm wrangler secret bulk .prod.vars`)
import { existsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const name = process.argv.includes('--prod') ? '.prod.vars' : '.dev.vars';
const file = new URL(`../${name}`, import.meta.url);
if (existsSync(file) && !process.argv.includes('--force')) {
  console.error(`${name} already exists. Re-run with --force to replace it (this invalidates every existing piece!).`);
  process.exit(1);
}

const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
const { kty, crv, x, d } = await crypto.subtle.exportKey('jwk', pair.privateKey);
const signingKey = JSON.stringify({ kty, crv, x, d });
const adminToken = randomBytes(24).toString('base64url');

writeFileSync(file, `SIGNING_KEY='${signingKey}'\nADMIN_TOKEN='${adminToken}'\n`);
console.log(`Wrote ${name}`);
