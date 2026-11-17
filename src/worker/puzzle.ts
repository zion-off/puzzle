import { DurableObject } from 'cloudflare:workers';
import { PIECE_COUNT, isPieceId } from '../shared/config.ts';
import { EVENT, SECRET_BYTES, type PieceEvent } from '../shared/payload.ts';
import { readPiece, writePiece, memoryOf, READ_ERRORS, type PieceFile, type Memory } from '../shared/piece-file.ts';
import { importKeys, randomBytes, sha256Hex, base64url, type Keys } from '../shared/crypto.ts';
import { applyWear } from '../shared/wear.ts';
import { pieceMask } from '../shared/shape.ts';

export interface Env {
  PUZZLE: DurableObjectNamespace<Puzzle>;
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  SIGNING_KEY: string;
  ADMIN_TOKEN?: string;
}

export type PieceState = 'in' | 'out' | 'gift';

/** How a presented file relates to the real piece. */
export type Standing =
  | 'current' // this file IS the piece
  | 'returned' // the piece was put back after this copy was made
  | 'gifted' // this copy was wrapped as a gift; the link holds the piece now
  | 'ghost'; // an outdated copy; the piece has moved on

type Row = {
  id: number;
  state: PieceState;
  seq: number;
  secret_hash: string | null;
  ghosts: string;
};

interface Ghost {
  seq: number;
  at: number;
}

export type Result<T> = { ok: true; value: T } | { ok: false; status: number; error: string; standing?: Standing };

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (status: number, error: string, standing?: Standing): Result<never> => ({ ok: false, status, error, standing });
const now = () => Math.floor(Date.now() / 1000);
const pieceKey = (id: number) => `pieces/${id}.png`;
const MAX_PENDING_GHOSTS = 20;

export interface Inspection extends Memory {
  standing: Standing;
  piece: { state: PieceState; seq: number };
}

export class Puzzle extends DurableObject<Env> {
  private sql: SqlStorage;
  private keys?: Promise<Keys>;
  private locks = new Map<number, Promise<void>>();
  private stateCache: { states: string; seqs: number[] } | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS pieces (
        id INTEGER PRIMARY KEY,
        state TEXT NOT NULL DEFAULT 'in',
        seq INTEGER NOT NULL DEFAULT 0,
        secret_hash TEXT,
        ghosts TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE IF NOT EXISTS gifts (
        hash TEXT PRIMARY KEY,
        piece_id INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        wrapped_at INTEGER NOT NULL,
        opened_at INTEGER
      );
    `);
    const count = this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM pieces').one().n;
    if (count < PIECE_COUNT) {
      for (let id = 0; id < PIECE_COUNT; id++) this.sql.exec('INSERT OR IGNORE INTO pieces (id) VALUES (?)', id);
    }
  }

  // ---------- reads ----------

  getState(): { states: string; seqs: number[] } {
    if (!this.stateCache) {
      const rows = this.sql.exec<{ state: PieceState; seq: number }>('SELECT state, seq FROM pieces ORDER BY id').toArray();
      this.stateCache = {
        states: rows.map((r) => (r.state === 'in' ? 'i' : r.state === 'out' ? 'o' : 'g')).join(''),
        seqs: rows.map((r) => r.seq),
      };
    }
    return this.stateCache;
  }

  /** What anyone can see about a piece. Its memory is only readable while it sits in the puzzle. */
  async pieceInfo(id: number): Promise<Result<{ id: number; state: PieceState; seq: number; memory: Memory | null }>> {
    if (!isPieceId(id)) return fail(404, 'No such piece.');
    const row = this.row(id);
    let memory: Memory | null = null;
    if (row.state === 'in') {
      const file = await this.stored(id);
      if (file) memory = memoryOf(file);
    }
    return ok({ id, state: row.state, seq: row.seq, memory });
  }

  /** The stored image of a piece that is back in the puzzle (used to draw worn pieces). */
  async pieceImage(id: number): Promise<Uint8Array | null> {
    if (!isPieceId(id) || this.row(id).state !== 'in') return null;
    const obj = await this.env.BUCKET.get(pieceKey(id));
    return obj ? new Uint8Array(await obj.arrayBuffer()) : null;
  }

  async inspect(bytes: Uint8Array): Promise<Result<Inspection>> {
    const file = await this.read(bytes);
    if ('error' in file) return fail(400, file.error);
    const id = file.payload.pieceId;
    const row = this.row(id);
    const standing = await this.standing(row, file);
    if (standing === 'ghost') this.recordGhost(row, file.payload.seq);
    return ok({ ...memoryOf(file), standing, piece: { state: row.state, seq: row.seq } });
  }

  giftStatus(token: string): Promise<Result<{ wrappedAt: number; openedAt: number | null }>> {
    return this.findGift(token).then((g) =>
      g ? ok({ wrappedAt: g.wrapped_at, openedAt: g.opened_at }) : fail(404, 'There is no gift at this link.'),
    );
  }

  // ---------- writes ----------

  async take(requested?: number): Promise<Result<{ id: number; seq: number; png: Uint8Array }>> {
    let id = requested;
    if (id === undefined) {
      const free = this.sql.exec<{ id: number }>(`SELECT id FROM pieces WHERE state = 'in' ORDER BY random() LIMIT 1`).toArray();
      if (!free.length) return fail(409, 'The puzzle is empty. Every piece is out in the world.');
      id = free[0].id;
    }
    if (!isPieceId(id)) return fail(404, 'No such piece.');
    const pieceId = id;
    return this.withLock(pieceId, async () => {
      const row = this.row(pieceId);
      if (row.state !== 'in') return fail(409, 'Someone else just took that piece.');
      const file = await this.stored(pieceId);
      if (!file) return fail(503, "This piece hasn't been cut yet. Run `pnpm seed`.");
      if (file.payload.seq !== row.seq) return fail(500, 'Stored piece is out of sync.');
      return this.handOff(row, file, EVENT.take);
    });
  }

  async returnPiece(bytes: Uint8Array): Promise<Result<{ id: number; seq: number; memory: Memory }>> {
    const file = await this.read(bytes);
    if ('error' in file) return fail(400, file.error);
    const id = file.payload.pieceId;
    return this.withLock(id, async () => {
      const row = this.row(id);
      const refusal = await this.refuseUnlessCurrent(row, file);
      if (refusal) return refusal;
      this.age(file);
      const written = await this.rewrite(row, file, EVENT.return);
      await this.env.BUCKET.put(pieceKey(id), written.png);
      this.update(id, 'in', written.payload.seq, null);
      return ok({ id, seq: written.payload.seq, memory: memoryOf({ ...file, payload: written.payload }) });
    });
  }

  async gift(bytes: Uint8Array): Promise<Result<{ id: number; token: string }>> {
    const file = await this.read(bytes);
    if ('error' in file) return fail(400, file.error);
    const id = file.payload.pieceId;
    return this.withLock(id, async () => {
      const row = this.row(id);
      const refusal = await this.refuseUnlessCurrent(row, file);
      if (refusal) return refusal;
      this.age(file);
      const written = await this.rewrite(row, file, EVENT.gift);
      await this.env.BUCKET.put(pieceKey(id), written.png);
      const token = base64url(randomBytes(18));
      this.sql.exec(
        'INSERT INTO gifts (hash, piece_id, seq, wrapped_at) VALUES (?, ?, ?, ?)',
        await sha256Hex(token), id, written.payload.seq, now(),
      );
      this.update(id, 'gift', written.payload.seq, null);
      return ok({ id, token });
    });
  }

  async redeem(token: string): Promise<Result<{ id: number; seq: number; png: Uint8Array }>> {
    const gift = await this.findGift(token);
    if (!gift) return fail(404, 'There is no gift at this link.');
    return this.withLock(gift.piece_id, async () => {
      const current = (await this.findGift(token))!;
      if (current.opened_at) return fail(410, 'This gift has already been opened.');
      const row = this.row(gift.piece_id);
      if (row.state !== 'gift' || row.seq !== gift.seq) return fail(410, 'This gift has already been opened.');
      const file = await this.stored(gift.piece_id);
      if (!file) return fail(500, 'The wrapped piece has gone missing.');
      const result = await this.handOff(row, file, EVENT.redeem);
      if (result.ok) this.sql.exec('UPDATE gifts SET opened_at = ? WHERE hash = ?', now(), gift.hash);
      return result;
    });
  }

  /** Initial upload of a never-taken piece, made by `pnpm seed`. */
  async seed(id: number, bytes: Uint8Array): Promise<Result<null>> {
    if (!isPieceId(id)) return fail(404, 'No such piece.');
    const file = await this.read(bytes);
    if ('error' in file) return fail(400, file.error);
    if (file.payload.pieceId !== id || file.payload.seq !== 0) return fail(400, 'Not a fresh piece.');
    return this.withLock(id, async () => {
      const row = this.row(id);
      if (row.state !== 'in' || row.seq !== 0) return fail(409, 'This piece already has a history.');
      await this.env.BUCKET.put(pieceKey(id), bytes);
      return ok(null);
    });
  }

  // ---------- internals ----------

  /** A piece changes hands: wear it, give it a new secret, and send it off. Its stored copy is deleted. */
  private async handOff(row: Row, file: PieceFile, type: number): Promise<Result<{ id: number; seq: number; png: Uint8Array }>> {
    const secret = randomBytes(SECRET_BYTES);
    applyWear(file.rgba, file.width, file.height, { handling: 1, days: 0 }, pieceMask(row.id));
    const written = await this.rewrite(row, file, type, { secret, owners: file.payload.owners + 1 });
    this.update(row.id, 'out', written.payload.seq, await sha256Hex(secret));
    // A leftover stored copy is harmless (stale seq, never served while out), so don't fail the hand-off over it.
    await this.env.BUCKET.delete(pieceKey(row.id)).catch(() => {});
    return ok({ id: row.id, seq: written.payload.seq, png: written.png });
  }

  /** A piece coming back in (returned or wrapped) has aged for as long as it was out. */
  private age(file: PieceFile) {
    const left = file.payload.events.findLast((e) => e.type === EVENT.take || e.type === EVENT.redeem);
    if (!left) return;
    const days = Math.max(0, now() - left.at) / 86400;
    applyWear(file.rgba, file.width, file.height, { handling: 0, days }, pieceMask(file.payload.pieceId));
  }

  /** Append pending ghost sightings and the new event, bump seq, re-sign and embed. */
  private async rewrite(row: Row, file: PieceFile, type: number, changes: { secret?: Uint8Array; owners?: number } = {}) {
    const ghosts: PieceEvent[] = (JSON.parse(row.ghosts) as Ghost[]).map((g) => ({ type: EVENT.ghost, at: g.at }));
    const events = [...file.payload.events, ...ghosts, { type, at: now() }];
    return writePiece(file, {
      ...file.payload,
      seq: row.seq + 1,
      owners: changes.owners ?? file.payload.owners,
      total: file.payload.total + ghosts.length + 1,
      secret: changes.secret ?? new Uint8Array(SECRET_BYTES),
      events,
    }, await this.getKeys());
  }

  private async standing(row: Row, file: PieceFile): Promise<Standing> {
    const p = file.payload;
    if (row.state === 'out' && p.seq === row.seq && (await sha256Hex(p.secret)) === row.secret_hash) return 'current';
    if (p.seq === row.seq - 1 && row.state === 'in') return 'returned';
    if (p.seq === row.seq - 1 && row.state === 'gift') return 'gifted';
    return 'ghost';
  }

  private async refuseUnlessCurrent(row: Row, file: PieceFile): Promise<Result<never> | null> {
    const standing = await this.standing(row, file);
    if (standing === 'current') return null;
    if (standing === 'ghost') this.recordGhost(row, file.payload.seq);
    return fail(409, 'This copy is no longer the piece.', standing);
  }

  /** Each outdated generation can surface once per holder; sightings are written into the piece at its next change. */
  private recordGhost(row: Row, seq: number) {
    const ghosts = JSON.parse(row.ghosts) as Ghost[];
    if (ghosts.some((g) => g.seq === seq) || ghosts.length >= MAX_PENDING_GHOSTS) return;
    ghosts.push({ seq, at: now() });
    this.sql.exec('UPDATE pieces SET ghosts = ? WHERE id = ?', JSON.stringify(ghosts), row.id);
  }

  private update(id: number, state: PieceState, seq: number, secretHash: string | null) {
    this.sql.exec(`UPDATE pieces SET state = ?, seq = ?, secret_hash = ?, ghosts = '[]' WHERE id = ?`, state, seq, secretHash, id);
    this.stateCache = null;
  }

  private row(id: number): Row {
    return this.sql.exec<Row>('SELECT id, state, seq, secret_hash, ghosts FROM pieces WHERE id = ?', id).one();
  }

  private async findGift(token: string) {
    if (!/^[A-Za-z0-9_-]{10,64}$/.test(token)) return null;
    const rows = this.sql
      .exec<{ hash: string; piece_id: number; seq: number; wrapped_at: number; opened_at: number | null }>(
        'SELECT hash, piece_id, seq, wrapped_at, opened_at FROM gifts WHERE hash = ?',
        await sha256Hex(token),
      )
      .toArray();
    return rows[0] ?? null;
  }

  private async stored(id: number): Promise<PieceFile | null> {
    const obj = await this.env.BUCKET.get(pieceKey(id));
    if (!obj) return null;
    const file = await readPiece(new Uint8Array(await obj.arrayBuffer()), await this.getKeys());
    return 'error' in file ? null : file;
  }

  private async read(bytes: Uint8Array): Promise<PieceFile | { error: string }> {
    const file = await readPiece(bytes, await this.getKeys());
    return 'error' in file ? { error: READ_ERRORS[file.error] } : file;
  }

  private getKeys(): Promise<Keys> {
    return (this.keys ??= importKeys(this.env.SIGNING_KEY));
  }

  /** Serialise work per piece; R2 awaits would otherwise let requests interleave. */
  private async withLock<T>(id: number, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => mine);
    this.locks.set(id, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(id) === tail) this.locks.delete(id);
    }
  }
}
