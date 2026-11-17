import { HEIGHT, PIECE_COUNT, PIECE_SIZE, WIDTH, PUZZLE, pieceOrigin } from '../shared/config.ts';
import { piecePolygon } from '../shared/shape.ts';

type Img = ImageBitmap | HTMLImageElement;
type St = 'i' | 'o' | 'g';

interface Sprite {
  id: number;
  img: Img;
  dx: number;
  dy: number;
  scale: number;
  rot: number;
  alpha: number;
  lift: number;
  glow: number;
  ghost: boolean;
}

interface Box {
  id: number;
  dy: number;
  scale: number;
  rot: number;
  squash: number;
  alpha: number;
  lidDx: number;
  lidDy: number;
  lidRot: number;
  lidAlpha: number;
  ribbon: number;
  bow: number;
  bowAlpha: number;
}

const HOLE = '#d4d4d4';
const BOX = {
  w: 150,
  h: 104,
  lidW: 168,
  lidH: 32,
  band: 22,
  body: '#c8202a',
  bodyShade: '#9c141c',
  lid: '#de2f38',
  line: '#5e0a10',
  gold: '#f3c24f',
  goldShade: '#c98f22',
  goldLight: '#ffe7a3',
  goldLine: '#8a5a10',
};
/** How deep inside the box a dropped-in piece sits, relative to the box's centre. */
const INSIDE = 4;

const ease = {
  inOut: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  out: (t: number) => 1 - (1 - t) ** 3,
  in: (t: number) => t * t * t,
  back: (t: number) => 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2,
  linear: (t: number) => t,
};

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export class Board {
  onPieceClick: (id: number) => void = () => {};

  private ctx: CanvasRenderingContext2D;
  private sheet = document.createElement('canvas');
  private sctx: CanvasRenderingContext2D;
  private hit = document.createElement('canvas').getContext('2d')!;
  private master?: Img;
  private paths: Path2D[] = [];
  private states: St[] = Array(PIECE_COUNT).fill('i');
  private seqs: number[] = Array(PIECE_COUNT).fill(0);
  private pinned = new Map<number, St>();
  private overlays = new Map<number, { seq: number; img: Img }>();
  private loading = new Set<string>();
  private sprites = new Set<Sprite>();
  private boxes = new Set<Box>();
  private tweens = new Set<(now: number) => boolean>();
  private floating: { sprite: Sprite; stop: () => void } | null = null;
  private cam = { x: WIDTH / 2, y: HEIGHT / 2, z: 0.3 };
  private size = { w: 0, h: 0, dpr: 1 };
  private hover = -1;
  private selected = -1;
  private sheetDirty = true;
  private frame = 0;

  private canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.sheet.width = WIDTH;
    this.sheet.height = HEIGHT;
    this.sctx = this.sheet.getContext('2d')!;
    for (let id = 0; id < PIECE_COUNT; id++) {
      const p = new Path2D();
      piecePolygon(id).forEach(([x, y], i) => (i ? p.lineTo(x, y) : p.moveTo(x, y)));
      p.closePath();
      this.paths.push(p);
    }
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
    this.cam.z = this.fitZoom();
    this.bindInput();
  }

  async load(url: string) {
    const img = new Image();
    img.src = url;
    await img.decode();
    this.master = img;
    this.dirty();
  }

  // ---------- state ----------

  setState(states: string, seqs: number[]) {
    for (let id = 0; id < PIECE_COUNT; id++) {
      const st = states[id] as St;
      if (st !== this.states[id] || seqs[id] !== this.seqs[id]) {
        this.states[id] = st;
        this.seqs[id] = seqs[id];
        this.sheetDirty = true;
      }
      if (st === 'i' && seqs[id] > 0 && this.overlays.get(id)?.seq !== seqs[id]) this.loadOverlay(id, seqs[id]);
    }
    if (this.sheetDirty) this.invalidate();
  }

  stateOf(id: number): St {
    return this.pinned.get(id) ?? this.states[id];
  }

  select(id: number) {
    this.selected = id;
    this.invalidate();
  }

  private mark(id: number, st: St, seq?: number) {
    this.states[id] = st;
    if (seq !== undefined) this.seqs[id] = seq;
    this.dirty();
  }

  private pin(id: number, st: St) {
    this.pinned.set(id, st);
    this.dirty();
  }

  private unpin(id: number) {
    this.pinned.delete(id);
    this.dirty();
  }

  private async loadOverlay(id: number, seq: number) {
    const key = `${id}:${seq}`;
    if (this.loading.has(key)) return;
    this.loading.add(key);
    try {
      const res = await fetch(`/api/piece/${id}.png?v=${seq}`);
      if (!res.ok) return;
      const img = await createImageBitmap(await res.blob());
      if ((this.overlays.get(id)?.seq ?? -1) < seq) {
        this.overlays.set(id, { seq, img });
        this.dirty();
      }
    } finally {
      this.loading.delete(key);
    }
  }

  // ---------- animations ----------

  /** Lift the piece off the board and send it away (to your downloads). */
  async animateTake(id: number, img: Img) {
    this.clearFloating();
    this.mark(id, 'o');
    const s = this.addSprite(id, img);
    await this.tween(380, (t) => Object.assign(s, { scale: 1 + 0.14 * t, rot: -0.07 * t, lift: t }), ease.out);
    await this.sleep(150);
    const { cx, cy } = this.centre(id);
    const away = this.toBoard(this.size.w / 2, this.size.h + PIECE_SIZE * this.cam.z);
    await this.tween(750, (t) => Object.assign(s, {
      dx: (away.x - cx) * t,
      dy: (away.y - cy) * t,
      rot: -0.07 + 0.6 * t,
      scale: 1.14 - 0.5 * t,
      alpha: 1 - t * t,
    }), ease.in);
    this.sprites.delete(s);
  }

  /** The piece hovers over its spot while you decide what to do with it. */
  async showFloating(id: number, img: Img, ghost: boolean, fly = true) {
    this.clearFloating();
    if (fly) await this.flyTo(id);
    const s = this.addSprite(id, img);
    Object.assign(s, { ghost, alpha: 0, lift: 0.8, scale: 1.08 });
    let alive = true;
    const t0 = performance.now();
    this.tweens.add((now) => {
      const t = (now - t0) / 1000;
      s.alpha = (fly ? Math.min(1, t * 3) : 1) * (ghost ? 0.45 : 1);
      s.dy = -PIECE_SIZE * 0.22 + Math.sin(t * 2.2) * 4;
      s.rot = Math.sin(t * 1.3) * 0.025;
      return alive;
    });
    this.kick();
    this.floating = { sprite: s, stop: () => (alive = false) };
  }

  clearFloating() {
    if (!this.floating) return;
    this.floating.stop();
    this.sprites.delete(this.floating.sprite);
    this.floating = null;
    this.invalidate();
  }

  /** Fly to the spot, drop the piece in, and snap. */
  async animateReturn(id: number, img: Img, seq: number) {
    this.pin(id, 'o');
    let s: Sprite;
    if (this.floating?.sprite.id === id) {
      s = this.floating.sprite;
      this.floating.stop();
      this.floating = null;
    } else {
      await this.flyTo(id);
      s = this.addSprite(id, img);
      Object.assign(s, { dy: -PIECE_SIZE * 0.6, rot: 0.3, scale: 1.2, lift: 1, alpha: 0 });
      await this.tween(250, (t) => (s.alpha = t));
    }
    const from = { dy: s.dy, rot: s.rot, scale: s.scale, lift: s.lift };
    await this.tween(300, (t) => Object.assign(s, { dy: lerp(from.dy, -PIECE_SIZE * 0.35, t), scale: lerp(from.scale, 1.18, t), rot: lerp(from.rot, 0.12, t) }), ease.out);
    await this.tween(520, (t) => Object.assign(s, {
      dy: lerp(-PIECE_SIZE * 0.35, 0, t),
      rot: lerp(0.12, 0, t),
      scale: lerp(1.18, 1, t),
      lift: Math.max(0, lerp(from.lift, 0, t)),
    }), ease.back);
    this.overlays.set(id, { seq, img });
    this.unpin(id);
    this.mark(id, 'i', seq);
    s.lift = 0;
    await this.tween(700, (t) => Object.assign(s, { glow: 1 - t, alpha: 1 - t }), ease.out);
    this.sprites.delete(s);
  }

  /** The piece drops into a gift box, the lid lands, the ribbon gets tied, and the box settles into the spot. */
  async animateWrap(id: number, img: Img) {
    let s: Sprite;
    if (this.floating?.sprite.id === id) {
      s = this.floating.sprite;
      this.floating.stop();
      this.floating = null;
    } else {
      await this.flyTo(id);
      s = this.addSprite(id, img);
      Object.assign(s, { dy: -PIECE_SIZE * 0.22, lift: 0.8, scale: 1.08 });
    }
    const b = this.addBox(id);
    const base = PIECE_SIZE * 0.08;
    b.dy = base;
    await this.tween(380, (t) => (b.scale = t), ease.back);

    const from = { dy: s.dy, scale: s.scale, rot: s.rot, lift: s.lift };
    await this.tween(260, (t) => Object.assign(s, { dy: lerp(from.dy, -PIECE_SIZE * 0.55, t), rot: lerp(from.rot, 0, t), scale: lerp(from.scale, 0.6, t) }), ease.out);
    await this.tween(340, (t) => Object.assign(s, { dy: lerp(-PIECE_SIZE * 0.55, base + INSIDE, t), scale: lerp(0.6, 0.5, t), lift: lerp(from.lift, 0, t) }), ease.in);
    this.sprites.delete(s);
    await this.tween(160, (t) => (b.squash = 0.06 * Math.sin(Math.PI * t)));

    b.lidAlpha = 1;
    await this.tween(380, (t) => (b.lidDy = lerp(-PIECE_SIZE * 1.3, 0, t)), ease.in);
    this.mark(id, 'g');
    await this.tween(180, (t) => (b.squash = 0.1 * Math.sin(Math.PI * t)));

    await this.tween(260, (t) => (b.ribbon = t), ease.out);
    await this.tween(420, (t) => (b.bow = t), ease.back);
    await this.sleep(120);
    await this.tween(480, (t) => Object.assign(b, { dy: base - 38 * Math.sin(Math.PI * t), rot: 0.08 * Math.sin(Math.PI * 2 * t) }));
    await this.tween(160, (t) => (b.squash = 0.07 * Math.sin(Math.PI * t)));
    await this.sleep(350);
    await this.tween(450, (t) => Object.assign(b, { alpha: 1 - t, scale: 1 - 0.35 * t, dy: base + 10 * t }), ease.in);
    this.boxes.delete(b);
  }

  /** A gift opens: the box shakes, the bow pops, the lid flies off, and the piece rises out. */
  async animateUnwrap(id: number, img: Img) {
    await this.flyTo(id);
    const b = this.addBox(id);
    const base = PIECE_SIZE * 0.08;
    Object.assign(b, { dy: base, lidAlpha: 1, ribbon: 1, bow: 1 });
    await this.tween(420, (t) => (b.scale = t), ease.back);
    await this.sleep(200);
    for (const amp of [0.1, 0.16]) {
      await this.tween(380, (t) => Object.assign(b, { rot: amp * Math.sin(Math.PI * 4 * t) * (1 - t), dy: base - 8 * Math.sin(Math.PI * t) }), ease.linear);
      await this.sleep(160);
    }
    await this.tween(300, (t) => Object.assign(b, { bow: 1 + 0.5 * t, bowAlpha: 1 - t, ribbon: 1 - t }), ease.out);
    await this.tween(480, (t) => Object.assign(b, { lidDy: -PIECE_SIZE * 0.9 * t, lidDx: -PIECE_SIZE * 0.5 * t, lidRot: -0.9 * t, lidAlpha: 1 - t * t }), ease.out);

    const s = this.addSprite(id, img);
    Object.assign(s, { scale: 0.5, dy: base + INSIDE });
    await this.tween(900, (t) => {
      Object.assign(s, { dy: lerp(base + INSIDE, -PIECE_SIZE * 0.25, t), scale: lerp(0.5, 1.15, t), lift: t, glow: t });
      Object.assign(b, { alpha: 1 - Math.max(0, (t - 0.35) / 0.65), dy: base + 30 * Math.max(0, t - 0.35) });
    }, ease.out);
    this.boxes.delete(b);
    this.mark(id, 'o');
    await this.tween(500, (t) => (s.glow = 1 - t));
    await this.sleep(400);
    this.sprites.delete(s);
    await this.showFloating(id, img, false, false);
  }

  async flyTo(id: number, duration = 1100) {
    const { cx, cy } = this.centre(id);
    const z1 = Math.min(3, Math.max(this.fitZoom(), Math.min(this.size.w, this.size.h) * 0.32 / PIECE_SIZE));
    const from = { ...this.cam };
    const dist = Math.hypot(cx - from.x, cy - from.y) / Math.max(WIDTH, HEIGHT);
    const dip = Math.min(1.2, dist * 2.5);
    await this.tween(duration, (t) => {
      this.cam.x = lerp(from.x, cx, t);
      this.cam.y = lerp(from.y, cy, t);
      this.cam.z = Math.exp(lerp(Math.log(from.z), Math.log(z1), t) - dip * Math.sin(Math.PI * t));
    }, ease.inOut);
  }

  // ---------- rendering ----------

  private addSprite(id: number, img: Img): Sprite {
    const s: Sprite = { id, img, dx: 0, dy: 0, scale: 1, rot: 0, alpha: 1, lift: 0, glow: 0, ghost: false };
    this.sprites.add(s);
    return s;
  }

  private addBox(id: number): Box {
    const b: Box = { id, dy: 0, scale: 0, rot: 0, squash: 0, alpha: 1, lidDx: 0, lidDy: 0, lidRot: 0, lidAlpha: 0, ribbon: 0, bow: 0, bowAlpha: 1 };
    this.boxes.add(b);
    return b;
  }

  private centre(id: number) {
    const o = pieceOrigin(id);
    return { cx: o.x + PIECE_SIZE / 2, cy: o.y + PIECE_SIZE / 2 };
  }

  private drawHole(g: CanvasRenderingContext2D, id: number, gift: boolean) {
    const path = this.paths[id];
    g.save();
    g.fillStyle = HOLE;
    g.fill(path);
    g.clip(path);
    g.lineWidth = 10;
    g.strokeStyle = 'rgba(0,0,0,0.25)';
    g.stroke(path);
    g.restore();
    if (gift) {
      g.save();
      g.setLineDash([7, 5]);
      g.lineWidth = 2.5;
      g.strokeStyle = '#0000ee';
      g.stroke(path);
      g.restore();
    }
  }

  private redrawSheet() {
    const g = this.sctx;
    if (!this.master) {
      g.fillStyle = HOLE;
      g.fillRect(0, 0, WIDTH, HEIGHT);
      return;
    }
    g.drawImage(this.master, 0, 0);
    for (let id = 0; id < PIECE_COUNT; id++) {
      const st = this.stateOf(id);
      if (st !== 'i') {
        this.drawHole(g, id, st === 'g');
        continue;
      }
      const ov = this.overlays.get(id);
      if (this.seqs[id] > 0 && ov) {
        const o = pieceOrigin(id);
        this.drawHole(g, id, false);
        g.drawImage(ov.img, o.x, o.y);
      }
    }
    g.save();
    g.lineJoin = 'round';
    g.lineWidth = 1.4;
    g.strokeStyle = 'rgba(25, 12, 0, 0.28)';
    for (let id = 0; id < PIECE_COUNT; id++) if (this.stateOf(id) === 'i') g.stroke(this.paths[id]);
    g.translate(-0.9, -0.9);
    g.lineWidth = 0.8;
    g.strokeStyle = 'rgba(255, 245, 225, 0.16)';
    for (let id = 0; id < PIECE_COUNT; id++) if (this.stateOf(id) === 'i') g.stroke(this.paths[id]);
    g.restore();
    this.sheetDirty = false;
  }

  private render() {
    const { ctx } = this;
    const { w, h, dpr } = this.size;
    const { x, y, z } = this.cam;
    if (this.sheetDirty) this.redrawSheet();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * (w / 2 - x * z), dpr * (h / 2 - y * z));

    ctx.fillStyle = HOLE;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.lineWidth = 1 / z;
    ctx.strokeStyle = '#000';
    ctx.strokeRect(0, 0, WIDTH, HEIGHT);

    ctx.imageSmoothingEnabled = z < 1.5;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.sheet, 0, 0);

    for (const [id, color, width] of [[this.hover, 'rgba(0,0,0,0.6)', 1.5], [this.selected, '#0000ee', 3]] as const) {
      if (id < 0) continue;
      ctx.lineWidth = width / z;
      ctx.strokeStyle = color;
      ctx.stroke(this.paths[id]);
    }

    for (const s of this.sprites) this.drawSprite(s);
    for (const b of this.boxes) this.drawBox(b);
  }

  private drawBox(b: Box) {
    const { ctx } = this;
    const { cx, cy } = this.centre(b.id);
    const { w, h, lidW, lidH, band } = BOX;
    const top = -h / 2;
    ctx.save();
    ctx.translate(cx, cy + b.dy + h / 2);
    ctx.rotate(b.rot);
    ctx.scale(b.scale * (1 + b.squash), b.scale * (1 - b.squash));
    ctx.translate(0, -h / 2);
    ctx.globalAlpha = Math.max(0, Math.min(1, b.alpha));
    ctx.lineJoin = 'round';
    ctx.lineWidth = 2;

    // body, with a darker right side and the lid's shadow along the top
    ctx.fillStyle = BOX.body;
    ctx.fillRect(-w / 2, top, w, h);
    ctx.fillStyle = BOX.bodyShade;
    ctx.fillRect(w / 2 - 16, top, 16, h);
    if (b.lidAlpha > 0 && b.lidDy > -lidH) {
      ctx.save();
      ctx.globalAlpha *= 0.35 * Math.max(0, b.lidAlpha);
      ctx.fillStyle = '#000';
      ctx.fillRect(-w / 2, top, w, 9);
      ctx.restore();
    }
    if (b.ribbon > 0) {
      const r = b.ribbon;
      this.ribbonBand(-band / 2, top, band, h * r, true);
      const half = (w / 2) * r;
      this.ribbonBand(-half, top + h * 0.42, half * 2, band, false);
    }
    ctx.strokeStyle = BOX.line;
    ctx.strokeRect(-w / 2, top, w, h);

    if (b.lidAlpha > 0) {
      ctx.save();
      ctx.globalAlpha *= Math.max(0, b.lidAlpha);
      ctx.translate(b.lidDx, top - lidH / 2 + 5 + b.lidDy);
      ctx.rotate(b.lidRot);
      ctx.fillStyle = BOX.lid;
      ctx.fillRect(-lidW / 2, -lidH / 2, lidW, lidH);
      ctx.fillStyle = BOX.bodyShade;
      ctx.fillRect(lidW / 2 - 18, -lidH / 2, 18, lidH);
      ctx.fillRect(-lidW / 2, lidH / 2 - 6, lidW, 6);
      if (b.ribbon > 0) {
        ctx.save();
        ctx.globalAlpha *= Math.min(1, b.ribbon * 2);
        this.ribbonBand(-band / 2, -lidH / 2, band, lidH, true);
        ctx.restore();
      }
      ctx.strokeStyle = BOX.line;
      ctx.strokeRect(-lidW / 2, -lidH / 2, lidW, lidH);
      if (b.bow > 0 && b.bowAlpha > 0) {
        ctx.save();
        ctx.globalAlpha *= Math.max(0, b.bowAlpha);
        ctx.translate(0, -lidH / 2 + 4);
        ctx.scale(b.bow, b.bow);
        this.drawBow();
        ctx.restore();
      }
      ctx.restore();
    }
    ctx.restore();
  }

  /** A satin ribbon strip: gold with darker edges and a soft highlight down the middle. */
  private ribbonBand(x: number, y: number, w: number, h: number, vertical: boolean) {
    const { ctx } = this;
    ctx.save();
    ctx.fillStyle = BOX.gold;
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = BOX.goldShade;
    if (vertical) {
      ctx.fillRect(x, y, 3, h);
      ctx.fillRect(x + w - 3, y, 3, h);
      ctx.fillStyle = BOX.goldLight;
      ctx.fillRect(x + w * 0.3, y, w * 0.18, h);
    } else {
      ctx.fillRect(x, y, w, 3);
      ctx.fillRect(x, y + h - 3, w, 3);
      ctx.fillStyle = BOX.goldLight;
      ctx.fillRect(x, y + h * 0.3, w, h * 0.18);
    }
    ctx.strokeStyle = BOX.goldLine;
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
  }

  /** Two tails with notched ends, two puffy loops with folded insides, and a knot. Drawn around (0, 0). */
  private drawBow() {
    const { ctx } = this;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = BOX.goldLine;
    for (const d of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(d * 3, -2);
      ctx.lineTo(d * 15, -4);
      ctx.lineTo(d * 40, 30);
      ctx.lineTo(d * 32, 27);
      ctx.lineTo(d * 30, 38);
      ctx.lineTo(d * 6, 6);
      ctx.closePath();
      ctx.fillStyle = BOX.goldShade;
      ctx.fill();
      ctx.stroke();
    }
    for (const d of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(0, -4);
      ctx.bezierCurveTo(d * 6, -40, d * 56, -50, d * 56, -20);
      ctx.bezierCurveTo(d * 56, 0, d * 22, 2, 0, -4);
      ctx.fillStyle = BOX.gold;
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(d * 8, -8);
      ctx.bezierCurveTo(d * 16, -28, d * 42, -34, d * 44, -18);
      ctx.bezierCurveTo(d * 34, -14, d * 18, -10, d * 8, -8);
      ctx.fillStyle = BOX.goldShade;
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(d * 10, -26);
      ctx.bezierCurveTo(d * 20, -40, d * 40, -42, d * 48, -32);
      ctx.strokeStyle = BOX.goldLight;
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.strokeStyle = BOX.goldLine;
      ctx.lineWidth = 1.5;
    }
    ctx.beginPath();
    ctx.roundRect(-10, -15, 20, 20, 5);
    ctx.fillStyle = BOX.gold;
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = BOX.goldLight;
    ctx.fillRect(-5, -12, 4, 13);
  }

  private drawSprite(s: Sprite) {
    const { ctx } = this;
    const { dpr } = this.size;
    const z = this.cam.z;
    const o = pieceOrigin(s.id);
    const half = PIECE_SIZE / 2;
    ctx.save();
    ctx.translate(o.x + half + s.dx, o.y + half + s.dy);
    ctx.rotate(s.rot);
    ctx.scale(s.scale, s.scale);
    ctx.globalAlpha = Math.max(0, Math.min(1, s.alpha));
    if (s.ghost) ctx.filter = 'grayscale(1)';
    if (s.lift > 0) {
      ctx.shadowColor = `rgba(0,0,0,${0.55 * s.lift})`;
      ctx.shadowBlur = 34 * s.lift * dpr * z;
      ctx.shadowOffsetY = 18 * s.lift * dpr * z;
    }
    ctx.drawImage(s.img, -half, -half);
    ctx.shadowColor = 'transparent';
    if (s.glow > 0) {
      ctx.translate(-(o.x + half), -(o.y + half));
      ctx.shadowColor = `rgba(0, 0, 238, ${s.glow})`;
      ctx.shadowBlur = 24 * dpr * z;
      ctx.lineWidth = 3 / z;
      ctx.strokeStyle = `rgba(0, 0, 238, ${s.glow})`;
      ctx.stroke(this.paths[s.id]);
    }
    ctx.restore();
  }

  // ---------- frame loop ----------

  private tween(duration: number, fn: (t: number) => void, curve = ease.inOut): Promise<void> {
    return new Promise((resolve) => {
      const start = performance.now();
      this.tweens.add((now) => {
        const t = Math.min(1, (now - start) / duration);
        fn(curve(t));
        if (t >= 1) {
          resolve();
          return false;
        }
        return true;
      });
      this.kick();
    });
  }

  private sleep(ms: number) {
    return this.tween(ms, () => {}, ease.linear);
  }

  private kick() {
    if (!this.frame) this.frame = requestAnimationFrame(this.loop);
  }

  private loop = (now: number) => {
    this.frame = 0;
    for (const tw of [...this.tweens]) if (!tw(now)) this.tweens.delete(tw);
    this.render();
    if (this.tweens.size) this.kick();
  };

  private invalidate() {
    this.kick();
  }

  private dirty() {
    this.sheetDirty = true;
    this.kick();
  }

  // ---------- camera & input ----------

  private fitZoom() {
    const { w, h } = this.size;
    return Math.min(w / WIDTH, h / HEIGHT) * 0.9 || 0.3;
  }

  private resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.size = { w: r.width, h: r.height, dpr };
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.invalidate();
  }

  private toBoard(sx: number, sy: number) {
    const { w, h } = this.size;
    return { x: this.cam.x + (sx - w / 2) / this.cam.z, y: this.cam.y + (sy - h / 2) / this.cam.z };
  }

  private pieceAt(bx: number, by: number): number {
    const { cell, cols, rows } = PUZZLE;
    const col = Math.floor(bx / cell), row = Math.floor(by / cell);
    for (const [dc, dr] of [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const c = col + dc, r = row + dr;
      if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
      const id = r * cols + c;
      if (this.hit.isPointInPath(this.paths[id], bx, by)) return id;
    }
    return -1;
  }

  private zoomAt(sx: number, sy: number, factor: number) {
    const before = this.toBoard(sx, sy);
    this.cam.z = Math.min(4, Math.max(this.fitZoom() * 0.6, this.cam.z * factor));
    const after = this.toBoard(sx, sy);
    this.cam.x += before.x - after.x;
    this.cam.y += before.y - after.y;
    this.invalidate();
  }

  private bindInput() {
    const c = this.canvas;
    const pointers = new Map<number, { x: number; y: number }>();
    let drag: { x: number; y: number; moved: boolean } | null = null;
    let pinch: { d: number } | null = null;

    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) drag = { x: e.clientX, y: e.clientY, moved: false };
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) };
        if (drag) drag.moved = true;
      }
    });

    c.addEventListener('pointermove', (e) => {
      const prev = pointers.get(e.pointerId);
      if (!prev) {
        const b = this.toBoard(e.offsetX, e.offsetY);
        const id = this.pieceAt(b.x, b.y);
        if (id !== this.hover) {
          this.hover = id;
          c.style.cursor = id >= 0 ? 'pointer' : 'grab';
          this.invalidate();
        }
        return;
      }
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        this.zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, d / pinch.d);
        pinch.d = d;
        return;
      }
      if (drag) {
        const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
        if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 5) drag.moved = true;
        this.cam.x -= dx / this.cam.z;
        this.cam.y -= dy / this.cam.z;
        c.style.cursor = 'grabbing';
        this.invalidate();
      }
    });

    const end = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (drag && pointers.size === 0) {
        if (!drag.moved && e.type === 'pointerup') {
          const b = this.toBoard(e.offsetX, e.offsetY);
          const id = this.pieceAt(b.x, b.y);
          if (id >= 0) this.onPieceClick(id);
        }
        drag = null;
        c.style.cursor = 'grab';
      }
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => {
      if (this.hover >= 0) {
        this.hover = -1;
        this.invalidate();
      }
    });

    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const scale = e.deltaMode === 1 ? 16 : 1;
      if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) > 40 && !e.deltaX) {
        this.zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY * scale * (e.ctrlKey ? 0.01 : 0.0015)));
      } else {
        this.cam.x += (e.deltaX * scale) / this.cam.z;
        this.cam.y += (e.deltaY * scale) / this.cam.z;
        this.invalidate();
      }
    }, { passive: false });
  }
}
