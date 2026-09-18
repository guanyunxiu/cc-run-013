'use strict';

/**
 * 渲染器：把 CollabStore 的对象模型画到 Canvas2D。
 * 浏览器使用；Node 测试中通过 node --canvas 可选（本文件不依赖 DOM 以外的东西，
 * 传入任意 ctx 即可）。
 *
 * 关键：
 *  - 压感丝带：沿 Catmull-Rom / B 样条平滑后的中心线，用逐点宽度画连续四边形带，
 *    round join/ cap 补缝。宽度是点数据的确定性函数，两端逐像素一致。
 *  - 橡皮分块增量：erase mark 带 cells 网格提示；invalidateCells() 返回脏块，
 *    离屏画布只重绘脏块（先 restore 脏块底图 → 按 z 序重画落在块内的对象段，
 *    用 destination-out 挖掉该块内的擦除标记），不再每次全量重绘。
 */

import { catmullRomPath, bSplinePath, computeStrokeWidths } from './geometry.js';

export const CELL = 64; // 增量擦除的分块大小

function smoothPoints(points, mode) {
  if (mode === 'bspline') return bSplinePath(points, 8);
  if (mode === 'none') return points;
  return catmullRomPath(points, 8);
}

/* ------------------------------ 笔迹丝带 ------------------------------ */

function normals(points) {
  const n = new Array(points.length);
  for (let i = 0; i < points.length; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[Math.min(points.length - 1, i + 1)];
    let dx = p1.x - p0.x;
    let dy = p1.y - p0.y;
    const L = Math.hypot(dx, dy) || 1;
    dx /= L; dy /= L;
    n[i] = { x: -dy, y: dx };
  }
  return n;
}

/**
 * 压感变宽丝带。
 * widths 与平滑后点数量对齐：最近邻采样（保证两端同一算法同一结果）。
 */
export function traceStrokePath(ctx, geom) {
  const raw = geom.points;
  if (!raw || raw.length === 0) return;
  const pts = smoothPoints(raw, geom.smooth);
  const rawWidths = computeStrokeWidths(raw, geom.width, {
    pressureFactor: geom.pressureFactor,
    speedFactor: geom.speedFactor
  });
  const widths = pts.map((_, i) => {
    const idx = Math.min(raw.length - 1, Math.round((i / Math.max(1, pts.length - 1)) * (raw.length - 1)));
    return rawWidths[idx];
  });
  const ns = normals(pts);

  if (pts.length === 1) {
    ctx.beginPath();
    ctx.arc(pts[0].x, pts[0].y, widths[0] / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }

  // 上沿
  ctx.beginPath();
  ctx.moveTo(pts[0].x + ns[0].x * widths[0] / 2, pts[0].y + ns[0].y * widths[0] / 2);
  for (let i = 1; i < pts.length; i++) {
    ctx.lineTo(pts[i].x + ns[i].x * widths[i] / 2, pts[i].y + ns[i].y * widths[i] / 2);
  }
  // 下沿折返
  for (let i = pts.length - 1; i >= 0; i--) {
    ctx.lineTo(pts[i].x - ns[i].x * widths[i] / 2, pts[i].y - ns[i].y * widths[i] / 2);
  }
  ctx.closePath();
  ctx.fill();

  // 关节补圆，避免窄角裂缝
  for (let i = 0; i < pts.length; i++) {
    ctx.beginPath();
    ctx.arc(pts[i].x, pts[i].y, widths[i] / 2, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** 计算笔迹在对象坐标系下的包围盒（含线宽），用于脏块检测 */
export function strokeBounds(geom) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of geom.points) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  const w = geom.width || 4;
  return { x: x0 - w, y: y0 - w, w: x1 - x0 + 2 * w, h: y1 - y0 + 2 * w };
}

function applyStrokeStyle(ctx, geom) {
  switch (geom.tool) {
    case 'highlighter':
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = geom.color;
      ctx.strokeStyle = geom.color;
      break;
    case 'dash':
      ctx.globalAlpha = 1;
      ctx.fillStyle = geom.color;
      ctx.setLineDash([geom.width * 2.5, geom.width * 1.6]);
      ctx.lineCap = 'round';
      ctx.strokeStyle = geom.color;
      break;
    case 'texture':
      ctx.globalAlpha = 1;
      ctx.fillStyle = geom.color;
      break;
    default:
      ctx.globalAlpha = 1;
      ctx.fillStyle = geom.color;
  }
}

function drawStroke(ctx, obj) {
  const geom = obj.props.geom;
  ctx.save();
  applyTransform(ctx, obj.props.transform);
  applyStrokeStyle(ctx, geom);

  if (geom.tool === 'arrow') {
    drawArrow(ctx, geom);
  } else if (geom.tool === 'dash') {
    drawCenterline(ctx, geom);
  } else if (geom.tool === 'texture') {
    drawTextureStroke(ctx, geom, geom.texture || 'dot');
  } else {
    traceStrokePath(ctx, geom);
  }
  ctx.restore();
}

function drawCenterline(ctx, geom) {
  const pts = smoothPoints(geom.points, geom.smooth);
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.lineWidth = geom.width;
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawArrow(ctx, geom) {
  const pts = smoothPoints(geom.points, geom.smooth);
  const a = pts[0];
  const b = pts[pts.length - 1];
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.lineWidth = geom.width;
  ctx.lineCap = 'round';
  ctx.strokeStyle = geom.color;
  ctx.stroke();
  // 箭头
  const ang = Math.atan2(b.y - pts[pts.length - 2].y, b.x - pts[pts.length - 2].x);
  const head = geom.width * 4;
  ctx.beginPath();
  ctx.moveTo(b.x, b.y);
  ctx.lineTo(b.x - head * Math.cos(ang - 0.4), b.y - head * Math.sin(ang - 0.4));
  ctx.lineTo(b.x - head * Math.cos(ang + 0.4), b.y - head * Math.sin(ang + 0.4));
  ctx.closePath();
  ctx.fillStyle = geom.color;
  ctx.fill();
}

function drawTextureStroke(ctx, geom, texture) {
  // 纹理笔：沿丝带填充后叠纹理（点纹/斜纹），纹理坐标是点数据的确定性函数
  traceStrokePath(ctx, geom);
  const pts = smoothPoints(geom.points, geom.smooth);
  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  const step = 6;
  for (let i = 0; i < pts.length; i += 2) {
    const p = pts[i];
    const seed = (i * 2654435761) % 100;
    if (texture === 'dot' && seed < 40) {
      ctx.beginPath();
      ctx.arc(p.x + ((seed % 5) - 2), p.y + ((seed % 7) - 3), Math.max(0.8, geom.width / 6), 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

/* ------------------------------- 图形/文字 ------------------------------ */

function applyTransform(ctx, t) {
  if (!t) return;
  ctx.translate(t.tx || 0, t.ty || 0);
  if (t.angle) ctx.rotate(t.angle);
  if (t.sx && t.sx !== 1 || t.sy && t.sy !== 1) ctx.scale(t.sx || 1, t.sy || 1);
}

function drawShape(ctx, obj) {
  const g = obj.props.geom;
  const s = obj.props.style || {};
  ctx.save();
  applyTransform(ctx, obj.props.transform);
  ctx.strokeStyle = s.color || '#1f2937';
  ctx.lineWidth = s.width || 2;
  if (s.dash) ctx.setLineDash([8, 6]);
  ctx.fillStyle = s.fill || 'transparent';
  ctx.beginPath();
  switch (g.shape) {
    case 'rect':
      ctx.rect(g.x, g.y, g.w, g.h);
      break;
    case 'ellipse':
      ctx.ellipse(g.x + g.w / 2, g.y + g.h / 2, Math.abs(g.w / 2), Math.abs(g.h / 2), 0, 0, Math.PI * 2);
      break;
    case 'line':
      ctx.moveTo(g.x, g.y);
      ctx.lineTo(g.x + g.w, g.y + g.h);
      break;
    case 'arrow': {
      ctx.moveTo(g.x, g.y);
      ctx.lineTo(g.x + g.w, g.y + g.h);
      const ang = Math.atan2(g.h, g.w);
      const head = (s.width || 2) * 5;
      ctx.moveTo(g.x + g.w, g.y + g.h);
      ctx.lineTo(g.x + g.w - head * Math.cos(ang - 0.4), g.y + g.h - head * Math.sin(ang - 0.4));
      ctx.moveTo(g.x + g.w, g.y + g.h);
      ctx.lineTo(g.x + g.w - head * Math.cos(ang + 0.4), g.y + g.h - head * Math.sin(ang + 0.4));
      break;
    }
    case 'triangle':
      ctx.moveTo(g.x + g.w / 2, g.y);
      ctx.lineTo(g.x + g.w, g.y + g.h);
      ctx.lineTo(g.x, g.y + g.h);
      ctx.closePath();
      break;
    case 'diamond':
      ctx.moveTo(g.x + g.w / 2, g.y);
      ctx.lineTo(g.x + g.w, g.y + g.h / 2);
      ctx.lineTo(g.x + g.w / 2, g.y + g.h);
      ctx.lineTo(g.x, g.y + g.h / 2);
      ctx.closePath();
      break;
    case 'star':
      starPath(ctx, g.x + g.w / 2, g.y + g.h / 2, 5, Math.min(g.w, g.h) / 2, Math.min(g.w, g.h) / 4);
      break;
    default:
      ctx.rect(g.x, g.y, g.w, g.h);
  }
  if (s.fill) ctx.fill();
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

function starPath(ctx, cx, cy, spikes, outer, inner) {
  let rot = -Math.PI / 2;
  const step = Math.PI / spikes;
  ctx.moveTo(cx, cy - outer);
  for (let i = 0; i < spikes; i++) {
    ctx.lineTo(cx + Math.cos(rot) * outer, cy + Math.sin(rot) * outer);
    rot += step;
    ctx.lineTo(cx + Math.cos(rot) * inner, cy + Math.sin(rot) * inner);
    rot += step;
  }
  ctx.lineTo(cx, cy - outer);
  ctx.closePath();
}

function drawText(ctx, obj) {
  const { geom, text } = obj.props;
  ctx.save();
  applyTransform(ctx, obj.props.transform);
  ctx.font = `${text.size || 24}px ${text.font || 'sans-serif'}`;
  ctx.fillStyle = text.color || '#1f2937';
  ctx.textBaseline = 'top';
  const lines = String(text.content || '').split('\n');
  lines.forEach((line, i) => ctx.fillText(line, geom.x, geom.y + i * (text.size || 24) * 1.2));
  ctx.restore();
}

function drawNote(ctx, obj) {
  const { geom, note } = obj.props;
  ctx.save();
  applyTransform(ctx, obj.props.transform);
  ctx.fillStyle = note.color || '#fde68a';
  ctx.fillRect(geom.x, geom.y, geom.w, geom.h);
  ctx.strokeStyle = 'rgba(0,0,0,0.15)';
  ctx.strokeRect(geom.x, geom.y, geom.w, geom.h);
  ctx.fillStyle = '#1f2937';
  ctx.font = '16px sans-serif';
  ctx.textBaseline = 'top';
  String(note.content || '').split('\n').forEach((line, i) =>
    ctx.fillText(line, geom.x + 8, geom.y + 8 + i * 20));
  ctx.restore();
}

function drawImage(ctx, obj, images) {
  const { geom, image } = obj.props;
  const img = images && images.get(image.src);
  ctx.save();
  applyTransform(ctx, obj.props.transform);
  if (img && img.complete !== false) ctx.drawImage(img, geom.x, geom.y, geom.w, geom.h);
  else {
    ctx.fillStyle = '#e5e7eb';
    ctx.fillRect(geom.x, geom.y, geom.w, geom.h);
  }
  ctx.restore();
}

/* ------------------------------- 擦除路径 ------------------------------- */

function traceMark(ctx, mark) {
  if (!mark.points || mark.points.length === 0) return;
  const pts = mark.points;
  const w = mark.width || 12;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = w;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.stroke();
}

/**
 * 离屏全量渲染（首次 / resize / 快照重建时），逐对象隔离合成。
 * 按 z 序画全部对象；像素擦除在每个笔迹自己的临时画布上用 destination-out 挖洞，
 * 保证橡皮只擦目标笔迹，不会挖掉同位置的其他对象。
 */
export function renderScene(ctx, store, viewport, images) {
  ctx.clearRect(0, 0, viewport.w, viewport.h);
  for (const obj of store.listObjects()) {
    if (obj.kind === 'group') continue;
    drawIsolated(ctx, obj, store, images);
  }
}

function drawAny(ctx, obj, images) {
  switch (obj.kind) {
    case 'stroke': drawStroke(ctx, obj); break;
    case 'shape': drawShape(ctx, obj); break;
    case 'text': drawText(ctx, obj); break;
    case 'note': drawNote(ctx, obj); break;
    case 'image': drawImage(ctx, obj, images); break;
    default: break;
  }
}

/** 单对象隔离合成（函数式版本，供 renderScene 使用） */
function drawIsolated(mainCtx, obj, store, images) {
  if (obj.kind !== 'stroke') {
    drawAny(mainCtx, obj, images);
    return;
  }
  const tmp = getTmp(mainCtx.canvas.width, mainCtx.canvas.height);
  const tctx = tmp.getContext('2d');
  tctx.clearRect(0, 0, tmp.width, tmp.height);
  drawStroke(tctx, obj);
  const marks = store.marksForStroke(obj.id);
  if (marks.length) {
    tctx.save();
    tctx.globalCompositeOperation = 'destination-out';
    tctx.save();
    applyTransform(tctx, obj.props.transform);
    for (const m of marks) traceMark(tctx, m);
    tctx.restore();
    tctx.restore();
  }
  mainCtx.drawImage(tmp, 0, 0);
}

/**
 * SceneRenderer：严格的“逐对象隔离合成”，保证橡皮擦只挖目标笔迹，不挖同位置他人内容。
 * 同时维护脏块（cells），支持分块增量重绘。
 */
export class SceneRenderer {
  constructor(canvas, store, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.store = store;
    this.images = opts.images || new Map();
    this.dirtyCells = new Set();
  }

  setStore(store) {
    this.store = store;
  }

  invalidateAll() {
    this.dirtyCells = null; // null = 需要全量
  }

  /** 收集一批新擦除 mark 影响的网格块（不立即全量重绘） */
  invalidateMarks(marks) {
    if (this.dirtyCells === null) return;
    for (const m of marks) {
      for (const c of (m.cells && m.cells.length ? m.cells : computeCells(m.points, m.width))) {
        this.dirtyCells.add(c);
      }
    }
  }

  invalidateObjects(objects) {
    if (this.dirtyCells === null) return;
    for (const id of objects) {
      const o = this.store.getObject(id);
      if (!o) continue;
      for (const c of objectCells(o)) this.dirtyCells.add(c);
    }
  }

  /** 全量重绘 */
  render() {
    const { ctx } = this;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    for (const obj of this.store.listObjects()) this._drawObjectIsolated(obj);
    this.dirtyCells = new Set();
  }

  /** 只重绘脏块（像素擦除分块同步后的关键路径） */
  flushDirty() {
    if (this.dirtyCells === null) {
      this.render();
      return;
    }
    if (this.dirtyCells.size === 0) return;
    const { ctx } = this;
    for (const cellKey of this.dirtyCells) {
      const [cx, cy] = cellKey.split(':').map(Number);
      const x = cx * CELL, y = cy * CELL;
      ctx.clearRect(x, y, CELL, CELL);
      // z 序重画与块相交的对象；擦除笔迹走隔离合成
      for (const obj of this.store.listObjects()) {
        if (obj.kind === 'group') continue;
        if (!intersectsCell(obj, cx, cy)) continue;
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, CELL, CELL);
        ctx.clip();
        this._drawObjectIsolated(obj);
        ctx.restore();
      }
    }
    this.dirtyCells.clear();
  }

  /**
   * 单对象隔离合成：在临时画布画对象 + 对该对象挖洞，再整块贴回。
   * destination-out 永远只作用于这个对象自己的像素。
   */
  _drawObjectIsolated(obj) {
    drawIsolated(this.ctx, obj, this.store, this.images);
  }
}

/* ------------------------------ 脏块几何工具 ----------------------------- */

let _tmp = null;
function getTmp(w, h) {
  if (!_tmp || _tmp.width !== w || _tmp.height !== h) {
    if (typeof OffscreenCanvas !== 'undefined') _tmp = new OffscreenCanvas(w, h);
    else {
      _tmp = (typeof document !== 'undefined')
        ? Object.assign(document.createElement('canvas'), { width: w, height: h })
        : { width: w, height: h, getContext: () => null };
    }
  }
  return _tmp;
}

export function computeCells(points, width, CELL_SIZE = CELL) {
  const set = new Set();
  const r = (width || 12) / 2;
  for (const p of points || []) {
    const x0 = Math.floor((p.x - r) / CELL_SIZE);
    const x1 = Math.floor((p.x + r) / CELL_SIZE);
    const y0 = Math.floor((p.y - r) / CELL_SIZE);
    const y1 = Math.floor((p.y + r) / CELL_SIZE);
    for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) set.add(`${cx}:${cy}`);
  }
  return [...set];
}

function objectWorldBounds(obj) {
  const p = obj.props;
  const t = p.transform || {};
  const tx = t.tx || 0, ty = t.ty || 0;
  let x, y, w, h;
  if (obj.kind === 'stroke') {
    const b = strokeBounds(p.geom);
    x = b.x; y = b.y; w = b.w; h = b.h;
  } else if (p.geom) {
    x = p.geom.x; y = p.geom.y;
    w = p.geom.w ?? 50; h = p.geom.h ?? 30;
  } else {
    return null;
  }
  return { x: x + tx, y: y + ty, w, h };
}

function objectCells(obj) {
  const b = objectWorldBounds(obj);
  if (!b) return [];
  const set = new Set();
  const x0 = Math.floor(b.x / CELL), x1 = Math.floor((b.x + b.w) / CELL);
  const y0 = Math.floor(b.y / CELL), y1 = Math.floor((b.y + b.h) / CELL);
  for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) set.add(`${cx}:${cy}`);
  return [...set];
}

function intersectsCell(obj, cx, cy) {
  const b = objectWorldBounds(obj);
  if (!b) return true;
  return b.x < (cx + 1) * CELL && b.x + b.w > cx * CELL &&
    b.y < (cy + 1) * CELL && b.y + b.h > cy * CELL;
}
