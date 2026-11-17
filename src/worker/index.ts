import { Puzzle, type Env, type Result } from './puzzle.ts';

export { Puzzle };

const MAX_UPLOAD = 2 * 1024 * 1024;

const json = (data: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });

function fromResult<T>(r: Result<T>, render: (v: T) => Response): Response {
  return r.ok ? render(r.value) : json({ error: r.error, standing: r.standing }, r.status);
}

const png = (bytes: Uint8Array, id: number, headers: HeadersInit = {}) =>
  new Response(bytes as BodyInit, {
    headers: {
      'content-type': 'image/png',
      'content-disposition': `attachment; filename="piece-${id}.png"`,
      'x-piece-id': String(id),
      'access-control-expose-headers': 'x-piece-id, x-piece-seq',
      ...headers,
    },
  });

async function upload(req: Request): Promise<Uint8Array | Response> {
  const len = Number(req.headers.get('content-length') ?? 0);
  if (len > MAX_UPLOAD) return json({ error: 'That file is far too big to be a puzzle piece.' }, 413);
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.length > MAX_UPLOAD) return json({ error: 'That file is far too big to be a puzzle piece.' }, 413);
  if (!bytes.length) return json({ error: 'No file received.' }, 400);
  return bytes;
}

export default {
  async fetch(req, env, ctx): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;
    const puzzle = env.PUZZLE.get(env.PUZZLE.idFromName('main'));
    let m: RegExpMatchArray | null;

    if (path === '/api/state' && method === 'GET') {
      const cache = caches.default;
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = json(await puzzle.getState(), 200, { 'cache-control': 'public, max-age=2' });
      ctx.waitUntil(cache.put(req, res.clone()));
      return res;
    }

    if ((m = path.match(/^\/api\/piece\/(\d+)\.png$/)) && method === 'GET') {
      const bytes = await puzzle.pieceImage(Number(m[1]));
      if (!bytes) return json({ error: 'Not in the puzzle.' }, 404);
      return new Response(bytes as BodyInit, {
        headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=31536000, immutable' },
      });
    }

    if ((m = path.match(/^\/api\/piece\/(\d+)$/)) && method === 'GET') {
      return fromResult(await puzzle.pieceInfo(Number(m[1])), (v) => json(v));
    }

    if (path === '/api/take' && method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as { id?: unknown };
      const id = typeof body.id === 'number' ? body.id : undefined;
      return fromResult(await puzzle.take(id), (v) => png(v.png, v.id, { 'x-piece-seq': String(v.seq) }));
    }

    if (path === '/api/inspect' && method === 'POST') {
      const bytes = await upload(req);
      if (bytes instanceof Response) return bytes;
      return fromResult(await puzzle.inspect(bytes), (v) => json(v));
    }

    if (path === '/api/return' && method === 'POST') {
      const bytes = await upload(req);
      if (bytes instanceof Response) return bytes;
      return fromResult(await puzzle.returnPiece(bytes), (v) => json(v));
    }

    if (path === '/api/gift' && method === 'POST') {
      const bytes = await upload(req);
      if (bytes instanceof Response) return bytes;
      return fromResult(await puzzle.gift(bytes), (v) => json({ id: v.id, url: `${url.origin}/g/${v.token}` }));
    }

    if ((m = path.match(/^\/api\/gift\/([A-Za-z0-9_-]+)$/)) && method === 'GET') {
      return fromResult(await puzzle.giftStatus(m[1]), (v) => json(v));
    }

    if ((m = path.match(/^\/api\/gift\/([A-Za-z0-9_-]+)\/open$/)) && method === 'POST') {
      return fromResult(await puzzle.redeem(m[1]), (v) => png(v.png, v.id, { 'x-piece-seq': String(v.seq) }));
    }

    if ((m = path.match(/^\/api\/admin\/seed\/(\d+)$/)) && method === 'PUT') {
      if (!env.ADMIN_TOKEN || req.headers.get('authorization') !== `Bearer ${env.ADMIN_TOKEN}`) {
        return json({ error: 'Unauthorized' }, 401);
      }
      const bytes = await upload(req);
      if (bytes instanceof Response) return bytes;
      return fromResult(await puzzle.seed(Number(m[1]), bytes), () => json({ ok: true }));
    }

    if (path.startsWith('/api/')) return json({ error: 'Not found' }, 404);
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
