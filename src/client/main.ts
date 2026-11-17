import './style.css';
import { Board } from './board.ts';
import { PIECE_COUNT } from '../shared/config.ts';
import { EVENT } from '../shared/payload.ts';

type PieceState = 'in' | 'out' | 'gift';
type Standing = 'current' | 'returned' | 'gifted' | 'ghost';

interface Memory {
  pieceId: number;
  seq: number;
  owners: number;
  total: number;
  events: { type: number; at: number }[];
  used: number;
  capacity: number;
}
interface Inspection extends Memory {
  standing: Standing;
  piece: { state: PieceState; seq: number };
}
interface PieceInfo {
  id: number;
  state: PieceState;
  seq: number;
  memory: Memory | null;
}

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const board = new Board($<HTMLCanvasElement>('#board'));
const panel = $<HTMLElement>('#panel');
let busy = false;

// ---------- info ----------

const INFO: [string, string][] = [
  ['One puzzle, shared by everyone.', 'Anyone can take a piece out. The hole stays until someone puts it back.'],
  ['The file is the piece.', 'Taking a piece downloads it as a PNG. Keep it somewhere safe: if you lose the file, that piece is gone forever.'],
  ['Bring it back.', 'Drop your PNG on this page any time. We\'ll show where it belongs and you can put it back in, or keep holding it.'],
  ['Give it away.', 'Wrap the piece as a gift and send the link. Whoever opens it first gets the piece. Your old file becomes a keepsake.'],
  ['Copies are ghosts.', 'Only the newest file counts. Older copies still open, but as ghosts, and the piece remembers seeing them.'],
  ['Pieces remember.', 'Every take, gift and return is written into the piece\'s own pixels and signed so it can\'t be faked. Memory is small, so the oldest moments fade.'],
  ['Pieces wear out.', 'Like real cardboard: every hand-off rubs print off the edges and tips, and sometimes it peels or creases. Time away yellows it. After ten or so owners a piece looks well loved.'],
];

function showInfo() {
  board.clearFloating();
  board.select(-1);
  showPanel(
    el('h2', {}, 'What is this?'),
    el('dl', { class: 'info' }, ...INFO.flatMap(([t, d]) => [el('dt', {}, t), el('dd', {}, d)])),
  );
}

// ---------- API ----------

class ApiError extends Error {
  status: number;
  standing?: Standing;
  constructor(message: string, status: number, standing?: Standing) {
    super(message);
    this.status = status;
    this.standing = standing;
  }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `Something went wrong (${res.status}).` }));
    throw new ApiError(body.error, res.status, body.standing);
  }
  return res.json();
}

async function apiPng(path: string, init?: RequestInit) {
  const res = await fetch(path, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `Something went wrong (${res.status}).` }));
    throw new ApiError(body.error, res.status);
  }
  return { id: Number(res.headers.get('x-piece-id')), seq: Number(res.headers.get('x-piece-seq')), blob: await res.blob() };
}

const pngBody = (file: Blob): RequestInit => ({ method: 'POST', body: file, headers: { 'content-type': 'image/png' } });

// ---------- helpers ----------

const LABELS: Record<number, string> = {
  [EVENT.take]: 'Taken from the puzzle',
  [EVENT.return]: 'Put back',
  [EVENT.gift]: 'Wrapped as a gift',
  [EVENT.redeem]: 'Gift opened',
  [EVENT.ghost]: 'A ghost of it surfaced',
};

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const when = (s: number) => dateFmt.format(new Date(s * 1000));

function el(tag: string, attrs: Record<string, string> = {}, ...children: (Node | string | null | false)[]) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const c of children) if (c) node.append(c);
  return node;
}

function button(label: string, onClick: () => void, cls = '') {
  const b = el('button', cls ? { class: cls } : {}, label) as HTMLButtonElement;
  b.addEventListener('click', onClick);
  return b;
}

function showPanel(...children: (Node | string | null | false)[]) {
  panel.replaceChildren(button('×', closePanel, 'close'), ...children.filter((c): c is Node | string => !!c));
  panel.hidden = false;
}

function closePanel() {
  panel.hidden = true;
  board.clearFloating();
  board.select(-1);
}

let toastTimer = 0;
function toast(msg: string) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.remove('show'), 4000);
}

function download(blob: Blob, name: string) {
  const a = el('a', { href: URL.createObjectURL(blob), download: name }) as HTMLAnchorElement;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function memoryView(m: Memory) {
  const pct = Math.min(100, Math.round((m.used / m.capacity) * 100));
  const forgotten = m.total - m.events.length;
  const list = el('ol', { class: 'history' });
  const events = [...m.events].reverse();
  events.forEach((e, i) => {
    const fading = forgotten > 0 && i >= events.length - 3;
    list.append(el('li', { class: `ev ev-${e.type}${fading ? ' fading' : ''}` }, el('b', {}, LABELS[e.type] ?? 'Something happened'), el('time', {}, when(e.at))));
  });
  if (forgotten > 0) list.append(el('li', { class: 'forgotten' }, `…and ${plural(forgotten, 'older moment')} it no longer remembers`));
  if (!m.events.length && !forgotten) list.append(el('li', { class: 'forgotten' }, 'Nothing yet. It has never left the puzzle.'));
  return el('section', { class: 'memory' },
    el('div', { class: 'stats' }, `${plural(m.owners, 'owner')} · remembers ${m.events.length} of ${plural(m.total, 'moment')}`),
    el('div', { class: 'meter', title: `${m.used} of ${m.capacity} bytes of memory used` }, el('span', { style: `width:${pct}%` })),
    el('div', { class: 'meter-label' }, `memory ${pct}% full`),
    list,
  );
}

async function guard(fn: () => Promise<void>) {
  if (busy) return;
  busy = true;
  document.body.classList.add('busy');
  try {
    await fn();
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e));
  } finally {
    busy = false;
    document.body.classList.remove('busy');
  }
}

// ---------- flows ----------

async function showPiece(id: number) {
  board.clearFloating();
  board.select(id);
  showPanel(el('h2', {}, `Piece #${id}`), el('p', { class: 'muted' }, 'Looking…'));
  const info = await api<PieceInfo>(`/api/piece/${id}`).catch((e) => {
    toast(e.message);
    return null;
  });
  if (!info) return;
  if (info.state === 'in') {
    showPanel(
      el('h2', {}, `Piece #${id}`),
      el('p', {}, info.seq === 0 ? 'Never been taken. Be its first owner.' : 'In the puzzle, waiting for someone.'),
      button('Take this piece', () => take(id), 'primary'),
      info.memory && info.seq > 0 ? memoryView(info.memory) : null,
    );
  } else if (info.state === 'out') {
    showPanel(el('h2', {}, `Piece #${id}`), el('p', {}, 'Out in the world. Somebody has it, and its memories are with them.'));
  } else {
    showPanel(el('h2', {}, `Piece #${id}`), el('p', {}, 'Wrapped as a gift and waiting to be opened. Whoever opens the link gets it.'));
  }
}

function take(id?: number) {
  return guard(async () => {
    const { id: got, blob } = await apiPng('/api/take', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(id === undefined ? {} : { id }),
    });
    closePanel();
    const img = await createImageBitmap(blob);
    if (id === undefined) await board.flyTo(got, 1300);
    await board.animateTake(got, img);
    download(blob, `piece-${got}.png`);
    showPanel(
      el('h2', {}, `Piece #${got} is yours`),
      el('p', {}, `It just downloaded as piece-${got}.png. The file is the piece. Keep it safe: if you lose it, this spot stays empty forever.`),
      el('p', { class: 'muted' }, "Come back any time and drop it here to see where it belongs. You can put it back, or wrap it as a gift for someone. If you send the file itself, any copies are ghosts, and whoever comes back first wins."),
    );
    poll();
  });
}

function bringBack(file: File | Blob) {
  return guard(async () => {
    const info = await api<Inspection>('/api/inspect', pngBody(file));
    const img = await createImageBitmap(file);
    board.select(-1);
    showPanel(el('h2', {}, `Piece #${info.pieceId}`), el('p', { class: 'muted' }, 'Finding its place…'));
    await board.showFloating(info.pieceId, img, info.standing !== 'current');
    showHeld(info, file, img);
  });
}

function showHeld(info: Inspection, file: Blob, img: ImageBitmap) {
  const id = info.pieceId;
  if (info.standing === 'current') {
    showPanel(
      el('h2', {}, `Piece #${id}`),
      el('p', {}, 'This is the real piece, and it is yours. This is where it belongs.'),
      el('div', { class: 'actions' },
        button('Put it back', () => putBack(file, img, id), 'primary'),
        button('Gift it', () => confirmGift(file, img, id)),
      ),
      memoryView(info),
    );
    return;
  }
  const where: Record<PieceState, string> = {
    in: 'The real piece is back in the puzzle.',
    out: 'The real piece is out with someone else.',
    gift: 'The real piece is wrapped as a gift, waiting to be opened.',
  };
  const story: Record<Exclude<Standing, 'current'>, [string, string]> = {
    returned: ['A keepsake', 'This piece was put back after this copy was made. The file no longer holds the piece, but it remembers.'],
    gifted: ['A keepsake', 'This copy was wrapped as a gift. The gift link holds the piece now.'],
    ghost: ['A ghost', `This copy is out of date. The piece has moved on without it. ${where[info.piece.state]} Its sighting will be written into the piece's memory.`],
  };
  const [title, text] = story[info.standing];
  showPanel(
    el('h2', {}, `Piece #${id}: ${title}`),
    el('p', {}, text),
    el('p', { class: 'muted' }, 'What this copy remembers:'),
    memoryView(info),
  );
}

function putBack(file: Blob, img: ImageBitmap, id: number) {
  return guard(async () => {
    try {
      const res = await api<{ id: number; seq: number; memory: Memory }>('/api/return', pngBody(file));
      panel.hidden = true;
      await board.animateReturn(id, img, res.seq);
      showPanel(el('h2', {}, `Piece #${id} is home`), el('p', {}, 'Back where it belongs, a little more worn than before. Someone else can take it now.'), memoryView(res.memory));
      poll();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        toast('Too late. Another copy got there first.');
        board.clearFloating();
        return bringBackAfterRace(file);
      }
      throw e;
    }
  });
}

async function bringBackAfterRace(file: Blob) {
  const info = await api<Inspection>('/api/inspect', pngBody(file));
  const img = await createImageBitmap(file);
  await board.showFloating(info.pieceId, img, true);
  showHeld(info, file, img);
  poll();
}

function confirmGift(file: Blob, img: ImageBitmap, id: number) {
  showPanel(
    el('h2', {}, `Gift piece #${id}`),
    el('p', {}, "You'll get a link. Whoever opens it first gets the piece, so send it to the right person, or post it somewhere for anyone to grab."),
    el('p', {}, 'Your file stops being the piece the moment you wrap it. It stays with you as a keepsake.'),
    el('div', { class: 'actions' },
      button('Wrap it', () => wrap(file, img, id), 'primary'),
      button('Not yet', () => bringBack(file)),
    ),
  );
}

function wrap(file: Blob, img: ImageBitmap, id: number) {
  return guard(async () => {
    const res = await api<{ id: number; url: string }>('/api/gift', pngBody(file));
    panel.hidden = true;
    await board.animateWrap(id, img);
    const input = el('input', { value: res.url, readonly: '' }) as HTMLInputElement;
    input.addEventListener('focus', () => input.select());
    showPanel(
      el('h2', {}, 'Wrapped'),
      el('p', {}, 'Send this link. The piece lives in it now, and it never expires.'),
      el('div', { class: 'link' }, input, button('Copy', async () => {
        await navigator.clipboard.writeText(res.url);
        toast('Link copied');
      }, 'primary')),
      el('p', { class: 'muted' }, 'Your file is a keepsake now. It still knows where it belongs, but it can no longer be put back.'),
    );
    poll();
  });
}

async function openGiftPage(token: string) {
  history.replaceState(null, '', '/');
  const status = await api<{ wrappedAt: number; openedAt: number | null }>(`/api/gift/${token}`).catch((e) => {
    toast(e.message);
    return null;
  });
  if (!status) return;
  if (status.openedAt) {
    showPanel(el('h2', {}, 'Already opened'), el('p', {}, `Someone opened this gift on ${when(status.openedAt)}.`));
    return;
  }
  showPanel(
    el('h2', {}, 'Someone gave you a puzzle piece'),
    el('p', {}, `It was wrapped on ${when(status.wrappedAt)}. Open it and it's yours.`),
    button('Unwrap it', () => unwrap(token), 'primary'),
  );
}

function unwrap(token: string) {
  return guard(async () => {
    const { id, blob } = await apiPng(`/api/gift/${token}/open`, { method: 'POST' });
    panel.hidden = true;
    const img = await createImageBitmap(blob);
    await board.animateUnwrap(id, img);
    download(blob, `piece-${id}.png`);
    const info = await api<Inspection>('/api/inspect', pngBody(blob));
    showPanel(
      el('h2', {}, `Piece #${id} is yours`),
      el('p', {}, `It just downloaded as piece-${id}.png. The file is the piece, so keep it safe.`),
      memoryView(info),
    );
    poll();
  });
}

// ---------- wiring ----------

async function poll() {
  try {
    const s = await api<{ states: string; seqs: number[] }>('/api/state');
    board.setState(s.states, s.seqs);
    const inside = [...s.states].filter((c) => c === 'i').length;
    $('#count').textContent = `${inside}/${PIECE_COUNT}`;
  } catch {
    /* try again next tick */
  }
}

board.onPieceClick = (id) => !busy && showPiece(id);
$('#random').addEventListener('click', () => take());
$('#bring').addEventListener('click', () => $('#upload').click());
$('#info').addEventListener('click', () => !busy && showInfo());
$<HTMLInputElement>('#upload').addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  if (input.files?.[0]) bringBack(input.files[0]);
  input.value = '';
});

const drop = $('#drop');
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  drop.hidden = false;
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) drop.hidden = true;
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  drop.hidden = true;
  const file = e.dataTransfer?.files[0];
  if (file) bringBack(file);
});
window.addEventListener('keydown', (e) => e.key === 'Escape' && !busy && closePanel());

await board.load('/master.jpg');
await poll();
setInterval(poll, 3000);

const gift = location.pathname.match(/^\/g\/([A-Za-z0-9_-]+)$/);
if (gift) openGiftPage(gift[1]);
else if (!localStorage.getItem('seen-info')) {
  localStorage.setItem('seen-info', '1');
  showInfo();
}
