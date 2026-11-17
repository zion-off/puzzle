// Cuts every piece out of art/master.png, signs it, and uploads it.
//   pnpm seed                         → local dev server (http://localhost:5173)
//   pnpm seed https://your.site       → production (keys from .prod.vars, or SIGNING_KEY / ADMIN_TOKEN in env)
import { readFileSync, existsSync } from 'node:fs';
import { PIECE_COUNT, PIECE_SIZE } from '../src/shared/config.ts';
import { cutPiece, freshPayload } from '../src/shared/cut.ts';
import { decodeRGBA, writePiece } from '../src/shared/piece-file.ts';
import { importKeys } from '../src/shared/crypto.ts';

function readVars(name: string): Record<string, string> {
  const file = new URL(`../${name}`, import.meta.url);
  if (!existsSync(file)) return {};
  const vars: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m) vars[m[1]] = m[2].replace(/^'(.*)'$|^"(.*)"$/, '$1$2');
  }
  return vars;
}

const base = (process.argv[2] ?? 'http://localhost:5173').replace(/\/$/, '');
const local = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(base);
const vars = { ...readVars(local ? '.dev.vars' : '.prod.vars'), ...process.env };
if (!vars.SIGNING_KEY || !vars.ADMIN_TOKEN) {
  console.error(`Missing SIGNING_KEY / ADMIN_TOKEN. Run \`pnpm keygen${local ? '' : ' --prod'}\` first.`);
  process.exit(1);
}

const keys = await importKeys(vars.SIGNING_KEY);
const master = decodeRGBA(readFileSync(new URL('../art/master.png', import.meta.url)));

let done = 0, skipped = 0;
async function upload(id: number) {
  const rgba = cutPiece(master.rgba, master.width, master.height, id);
  const { png } = await writePiece({ width: PIECE_SIZE, height: PIECE_SIZE, rgba }, freshPayload(id), keys);
  const res = await fetch(`${base}/api/admin/seed/${id}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${vars.ADMIN_TOKEN}`, 'content-type': 'image/png' },
    body: png as BodyInit,
  });
  if (res.status === 409) skipped++;
  else if (!res.ok) throw new Error(`piece ${id}: ${res.status} ${await res.text()}`);
  else done++;
}

const queue = Array.from({ length: PIECE_COUNT }, (_, i) => i);
await Promise.all(
  Array.from({ length: 8 }, async () => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) await upload(id);
  }),
);
console.log(`Seeded ${done} pieces${skipped ? `, skipped ${skipped} that already have a history` : ''}.`);
