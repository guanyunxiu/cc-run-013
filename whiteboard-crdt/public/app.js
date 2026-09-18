'use strict';

/* ===========================================================================
 * 协作白板 v2 —— 前端
 *
 * 架构：
 *   CollabStore（CRDT 内核）—— 唯一状态真源
 *     ↑ 本地乐观 commit（零延迟上屏）      ↓ receive（远端 batch，因果缓冲）
 *   Editor（高层命令）  Network（WebSocket，中继/快照/分块/光标）
 *   SceneRenderer（离屏隔离合成 + 分块增量重绘）
 *
 * 关键：所有冲突解决在内核（LWW + 因果 + epoch），server seq 仅显示日志位置。
 * ========================================================================= */

import { CollabStore } from './lib/store.js';
import { Editor, eraseMark } from './lib/editor.js';
import { makePoint, rdp } from './lib/geometry.js';
import { SceneRenderer, traceStrokePath, CELL } from './lib/render.js';
import { recognizeShape, commitShapeReplacement } from './lib/recognize.js';
import { uid } from './lib/clock.js';


const $ = (id) => document.getElementById(id);

/* ------------------------------ 全局状态 ------------------------------ */
const state = {
  userId: localStorage.getItem('wb2-uid') || ('u-' + uid().slice(0, 8)),
  roomId: null,
  ws: null,
  store: null,
  editor: null,
  renderer: null,
  connected: false,
  reconnectAttempts: 0,
  reconnectTimer: null,
  lastSeq: 0,
  pending: new Map(),       // batchId -> batch（未 ack，重连重发）
  pendingChunks: new Map(),
  tool: 'pen',
  color: '#1f2937',
  width: 4,
  pressureOn: true,
  speedOn: true,
  ink2text: false,
  images: new Map(),
  // 手势临时状态
  gesture: null,
  selected: new Set(),
  selectedTransforms: new Map(),
  gestureKey: null,
  live: null,               // 当前在画的本地笔迹（尚未 commit）
  dpr: 1
};

const canvas = $('mainCanvas');
const ctx = canvas.getContext('2d');
const offCanvas = document.createElement('canvas');

/* ------------------------------ 工具函数 ------------------------------ */
function setStatus(kind, text) {
  $('statusDot').className = 'status-dot ' + kind;
  $('statusText').textContent = text;
}

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  state.dpr = window.devicePixelRatio || 1;
  // 离屏（SceneRenderer 工作区）统一 CSS 像素坐标系：几何/命中/分块计算都用它；
  // 主画布用 dpr 高清，drawImage 时把离屏整体放大。
  canvas.width = Math.round(rect.width * state.dpr);
  canvas.height = Math.round(rect.height * state.dpr);
  offCanvas.width = Math.round(rect.width);
  offCanvas.height = Math.round(rect.height);
  ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
  const off = offCanvas.getContext('2d');
  off.setTransform(1, 0, 0, 1, 0, 0);
  // SceneRenderer 直接在离屏上画；临时画布也用 CSS 像素
  state.viewW = rect.width;
  state.viewH = rect.height;
  if (state.renderer) state.renderer.invalidateAll();
  requestRender();
}

let renderQueued = false;
function requestRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function render() {
  const rect = canvas.getBoundingClientRect();
  if (!state.store || !state.renderer) return;
  // SceneRenderer 画在离屏；这里把离屏贴到主画布，再叠本地实时笔迹/选择框/光标
  state.renderer.flushDirty();
  ctx.clearRect(0, 0, state.viewW, state.viewH);
  ctx.drawImage(offCanvas, 0, 0, state.viewW, state.viewH);

  // 本地正在书写的笔迹（乐观实时，尚未提交）
  if (state.live) drawLiveStroke(ctx, state.live);

  // 远端像素橡皮渐进预览（分块帧，final 到达后由真实挖洞接管）
  drawErasePreviews(ctx);

  // 选择框
  if (state.selected.size) drawSelection(ctx);

  // 远端光标
  drawCursors(ctx);
}

/* ----------------------------- 加入 / 网络 ----------------------------- */

function initStore() {
  state.store = new CollabStore(state.userId, {
    onChange: ({ local, changed, batch }) => {
      // 远端渐进擦除块（chunk 帧）单独走；batch 变更统一标脏
      if (!state.renderer) return;
      if (changed.marks.size || changed.epochs.size || changed.objects.size) {
        if (changed.objects.size) state.renderer.invalidateObjects(changed.objects);
        if (changed.marks.size) {
          // 找出新 marks 的 cells
          const marks = [];
          for (const mid of changed.marks) {
            for (const m of state.store.listMarks()) if (m.id === mid) marks.push(m);
          }
          state.renderer.invalidateMarks(marks);
        }
        requestRender();
      }
      $('lamportText').textContent = state.store.clock.value();
      $('bufferText').textContent = state.store.buffer.size;
      if (!local) { /* 远端变更，历史面板刷新延后到面板打开时 */ }
    }
  });
  state.editor = new Editor(state.store);
  state.renderer = new SceneRenderer(offCanvas, state.store, { images: state.images });
}

function connect() {
  setStatus('connecting', '连接中…');
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.ws = ws;

  ws.onopen = () => {
    state.connected = true;
    state.reconnectAttempts = 0;
    setStatus('online', '已连接');
    ws.send(JSON.stringify({ type: 'join', roomId: state.roomId, userId: state.userId, afterSeq: state.lastSeq }));
  };

  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (_) { return; }
    handleMessage(msg);
  };

  ws.onclose = () => {
    state.connected = false;
    setStatus('connecting', '重连中…');
    scheduleReconnect();
  };
  ws.onerror = () => { try { ws.close(); } catch (_) {} };
}

function scheduleReconnect() {
  if (state.reconnectTimer) return;
  const delay = Math.min(10000, 500 * 2 ** state.reconnectAttempts) + Math.random() * 300;
  state.reconnectAttempts++;
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    connect();
  }, delay);
}

function sendBatch(batch) {
  state.pending.set(batch.batchId, batch);
  if (state.connected && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: 'batch', batch }));
  }
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'joined':
      $('membersLabel').textContent = '已加入';
      break;
    case 'snapshot': {
      // 首次全量快照装载；重连时也用快照（内核幂等，之后 delta 自动去重）
      state.store.loadSnapshot(msg.snapshot);
      state.lastSeq = msg.afterSeq;
      state.renderer.invalidateAll();
      state.store.receiveMany(msg.delta || []);
      // 重发未 ack 的本地 batch（服务端按 batchId 幂等）
      for (const b of state.pending.values()) {
        state.ws.send(JSON.stringify({ type: 'batch', batch: b }));
      }
      requestRender();
      break;
    }
    case 'ack':
      state.pending.delete(msg.batchId);
      if (msg.seq) { state.lastSeq = msg.seq; $('seqText').textContent = msg.seq; }
      break;
    case 'batch': {
      const r = state.store.receive(msg.batch);
      if (!r.duplicate && msg.seq) { state.lastSeq = msg.seq; $('seqText').textContent = msg.seq; }
      break;
    }
    case 'chunk':
      // 像素橡皮渐进预览：只用于渲染提示，不进 CRDT（final batch 才是权威）
      handleRemoteChunkPreview(msg);
      break;
    case 'presence':
      handlePresence(msg.p);
      break;
    case 'pong':
      break;
    case 'error':
      console.warn('[server error]', msg.message);
      break;
  }
}

/* ------------------------- 远端橡皮渐进预览（分块） ------------------------- */
const previewErasePaths = []; // 远端 chunk 帧累积的世界坐标路径（仅预览）
function handleRemoteChunkPreview(msg) {
  if (!msg.strokeId) return;
  const o = state.store.getObject(msg.strokeId);
  if (!o) return;
  const t = o.props.transform || {};
  // mark 里是对象坐标，预览要画在世界坐标
  for (const m of msg.marks) {
    previewErasePaths.push({
      points: m.points.map((pt) => ({ x: pt.x + (t.tx || 0), y: pt.y + (t.ty || 0) })),
      width: m.width || 12,
      at: Date.now()
    });
  }
  // 预览最多保留 2s（final batch 到达后由离屏隔离合成的真实挖洞接管）
  requestRender();
}
function drawErasePreviews(c) {
  const now = Date.now();
  for (let i = previewErasePaths.length - 1; i >= 0; i--) {
    if (now - previewErasePaths[i].at > 2000) { previewErasePaths.splice(i, 1); continue; }
    const path = previewErasePaths[i];
    if (path.points.length < 2) continue;
    c.save();
    c.strokeStyle = 'rgba(220,38,38,.35)';
    c.lineWidth = path.width;
    c.lineCap = 'round'; c.lineJoin = 'round';
    c.beginPath();
    c.moveTo(path.points[0].x, path.points[0].y);
    for (let k = 1; k < path.points.length; k++) c.lineTo(path.points[k].x, path.points[k].y);
    c.stroke();
    c.restore();
  }
}

/* ------------------------------- 光标 --------------------------------- */
const cursors = new Map();
let cursorSendTimer = 0;
function handlePresence(p) {
  if (!p || p.userId === state.userId) return;
  cursors.set(p.userId, { ...p, at: Date.now() });
  requestRender();
}
function drawCursors(c) {
  for (const [uid2, p] of cursors) {
    if (Date.now() - p.at > 8000) continue;
    if (p.kind !== 'cursor') continue;
    c.save();
    c.fillStyle = colorFor(uid2);
    c.beginPath(); c.arc(p.x, p.y, 4, 0, Math.PI * 2); c.fill();
    c.font = '11px sans-serif';
    c.fillText(uid2.slice(0, 6), p.x + 8, p.y - 6);
    c.restore();
  }
}
function colorFor(id) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h},70%,45%)`;
}

/* ------------------------------ 工具栏 UI ------------------------------ */

document.querySelectorAll('.tool[data-tool]').forEach((btn) => {
  btn.addEventListener('click', () => setTool(btn.dataset.tool));
});
function setTool(tool) {
  state.tool = tool;
  document.querySelectorAll('.tool[data-tool]').forEach((b) =>
    b.classList.toggle('active', b.dataset.tool === tool));
  canvas.className = tool.startsWith('eraser') ? 'tool-eraser-pixel'
    : tool === 'select' ? 'tool-select' : '';
  state.selected.clear();
  requestRender();
  if (tool === 'image') $('imageFile').click();
}
$('colorInput').addEventListener('input', (e) => { state.color = e.target.value; });
$('widthInput').addEventListener('input', (e) => {
  state.width = +e.target.value;
  $('widthValue').textContent = e.target.value;
});
$('pressureChk').addEventListener('change', (e) => { state.pressureOn = e.target.checked; });
$('speedChk').addEventListener('change', (e) => { state.speedOn = e.target.checked; });
$('ink2textChk').addEventListener('change', (e) => { state.ink2text = e.target.checked; });

$('undoBtn').addEventListener('click', () => {
  const b = state.editor.undoLast();
  if (b) { sendBatch(b); requestRender(); refreshHistory(); }
});
$('redoBtn').addEventListener('click', () => {
  const b = state.editor.redoLast();
  if (b) { sendBatch(b); requestRender(); refreshHistory(); }
});
$('deleteBtn').addEventListener('click', deleteSelected);
$('frontBtn').addEventListener('click', () => {
  if (!state.selected.size) return;
  for (const id of state.selected) sendBatch(state.editor.bringToFront(id));
});
$('backBtn').addEventListener('click', () => {
  if (!state.selected.size) return;
  for (const id of state.selected) sendBatch(state.editor.sendToBack(id));
});
$('groupBtn').addEventListener('click', () => {
  if (state.selected.size >= 2) {
    const b = state.editor.group([...state.selected]);
    sendBatch(b);
    state.selected.clear(); requestRender();
  }
});
$('ungroupBtn').addEventListener('click', () => {
  for (const id of state.selected) {
    const o = state.store.getObject(id);
    if (o && o.kind === 'group') sendBatch(state.editor.ungroup(id));
  }
});

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
    e.preventDefault(); $('undoBtn').click();
  } else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' ||
    (e.key.toLowerCase() === 'z' && e.shiftKey))) {
    e.preventDefault(); $('redoBtn').click();
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && state.selected.size) {
    deleteSelected();
  }
});

function deleteSelected() {
  if (!state.selected.size) return;
  const b = state.editor.remove([...state.selected]);
  sendBatch(b);
  state.selected.clear();
  requestRender();
}

/* ---------------------------- 选择性撤销面板 ---------------------------- */
$('historyBtn').addEventListener('click', () => {
  const panel = $('historyPanel');
  panel.classList.toggle('hidden');
  if (!panel.classList.contains('hidden')) refreshHistory();
});
function opSummary(b) {
  const op = b.ops[0];
  const n = b.ops.length;
  if (op.type === 'create') return `${n > 1 ? `粘贴 ${n} 个对象` : '新建 ' + op.object.kind}`;
  if (op.type === 'update') return `${n > 1 ? `移动/变换 ${n} 个对象（原子组）` : '修改对象'}`;
  if (op.type === 'delete') return `删除 ${n} 个对象`;
  if (op.type === 'erase') return '像素擦除';
  if (op.type === 'group') return '组合';
  if (op.type === 'ungroup') return '解组';
  if (op.type === 'reorder') return '图层调整';
  return op.type;
}
function refreshHistory() {
  const list = $('historyList');
  list.innerHTML = '';
  const hist = state.editor.ownHistory();
  if (!hist.length) { list.innerHTML = '<p class="hint">暂无我的操作</p>'; return; }
  for (const b of hist.slice(0, 30)) {
    const active = state.store.isActive(b.batchId);
    const item = document.createElement('div');
    item.className = 'hist-item' + (active ? '' : ' inactive');
    item.innerHTML = `
      <div>${opSummary(b)}${b.coalesceKey ? ' <span class="meta">(已压缩)</span>' : ''}
        ${b.tx && b.ops.length > 1 ? ' <span class="meta">事务×' + b.ops.length + '</span>' : ''}</div>
      <div class="meta">LC ${b.clock} · ${new Date(b.t).toLocaleTimeString()}</div>`;
    const btn = document.createElement('button');
    btn.textContent = active ? '选择性撤销' : '已撤销 · 重做';
    btn.onclick = () => {
      const ub = active ? state.editor.undo(b.batchId) : state.editor.redo(b.batchId);
      sendBatch(ub);
      requestRender();
      refreshHistory();
    };
    item.appendChild(btn);
    list.appendChild(item);
  }
}

/* ============================ 指针手势处理 ============================ */

function pos(e) {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

canvas.addEventListener('pointerdown', onDown);
canvas.addEventListener('pointermove', onMove);
window.addEventListener('pointerup', onUp);
canvas.addEventListener('pointercancel', onUp);

function onDown(e) {
  canvas.setPointerCapture(e.pointerId);
  const p = pos(e);
  const t = state.tool;

  if (t === 'text' || t === 'note') return startFloatingInput(p, t);
  if (t.startsWith('shape-')) return beginShape(p, t.slice(6));
  if (t === 'recognize') return beginInk(p, { recognize: 'shape' });
  if (t === 'eraser-pixel') return beginErasePixel(e, p);
  if (t === 'eraser-object') return eraseObjectAt(p);
  if (t === 'select') return beginSelect(e, p);

  // 笔刷：pen / highlighter / dash / texture / arrow
  return beginInk(p, { tool: t });
}

function onMove(e) {
  const p = pos(e);
  scheduleCursorPresence(p);
  const g = state.gesture;
  if (!g) return;
  if (e.getCoalescedEvents) {
    for (const ce of e.getCoalescedEvents()) handleMove(g, pos(ce), ce);
  }
  handleMove(g, p, e);
}

function onUp(e) {
  const g = state.gesture;
  if (!g) return;
  state.gesture = null;
  const p = pos(e);
  finishGesture(g, p);
  state.selectedTransforms.clear();
}

function scheduleCursorPresence(p) {
  const now = performance.now();
  if (now - cursorSendTimer < 50) return;
  cursorSendTimer = now;
  if (state.connected) {
    state.ws.send(JSON.stringify({ type: 'presence', p: { kind: 'cursor', x: p.x, y: p.y } }));
  }
}

/* ------------------------------ 笔迹手势 ------------------------------ */

function beginInk(p, opts) {
  const points = [readPoint(p, null)];
  state.gesture = { kind: 'ink', points, opts, start: p };
  state.live = { points, geom: {
    color: state.color, width: state.width, tool: opts.tool || 'pen',
    smooth: 'catmull-rom', pressureFactor: state.pressureOn ? 0.6 : 0,
    speedFactor: state.speedOn ? 0.35 : 0
  } };
}

function readPoint(p, prev) {
  return makePoint(p.x, p.y, p.pressure && p.pressure > 0 ? p.pressure : 0.5,
    performance.now(), p.tiltX || 0, p.tiltY || 0, p.twist || 0);
}

function beginErasePixel(e, p) {
  state.gesture = {
    kind: 'erase',
    raw: [readPoint(p, null)],
    chunksByStroke: new Map(), // strokeId -> [ {marks:[...]}, ... ] 分块
    targetIds: new Set(),
    lastSendLen: 0,
    width: Math.max(8, state.width * 3)
  };
  collectEraseTargets(state.gesture, p);
}

/* ------------------------------ 图形手势 ------------------------------ */
function beginShape(p, shape) {
  state.gesture = { kind: 'shape', shape, start: p, current: p };
}

/* ------------------------------ 选择手势 ------------------------------ */
function beginSelect(e, p) {
  const hit = hitTest(p);
  if (hit) {
    if (e.shiftKey) state.selected.add(hit);
    else if (!state.selected.has(hit)) { state.selected.clear(); state.selected.add(hit); }
    // 记录手势起点 transform（多选移动的绝对定位基准）
    for (const id of state.selected) {
      const o = state.store.getObject(id);
      state.selectedTransforms.set(id, { ...(o.props.transform || {}) });
    }
    state.gesture = { kind: 'drag', start: p, moved: false };
    state.gestureKey = uid('g-');
  } else {
    state.selected.clear();
    state.gesture = { kind: 'marquee', start: p, current: p };
  }
  requestRender();
}

function hitTest(p) {
  // 从顶层往下找（z 序倒序）
  const objs = state.store.listObjects();
  for (let i = objs.length - 1; i >= 0; i--) {
    const o = objs[i];
    if (o.kind === 'group') continue;
    if (pointInObject(p, o)) return o.id;
  }
  return null;
}

function pointInObject(p, o) {
  const t = o.props.transform || {};
  const tx = t.tx || 0, ty = t.ty || 0;
  if (o.kind === 'stroke') {
    // 点到笔迹折线附近
    const pts = o.props.geom.points;
    for (let i = 0; i < pts.length; i++) {
      if (Math.hypot(p.x - pts[i].x - tx, p.y - pts[i].y - ty) < (o.props.geom.width || 4) + 4) return true;
    }
    return false;
  }
  const g = o.props.geom;
  if (!g) return false;
  const w = g.w ?? 60, h = g.h ?? 24;
  return p.x >= g.x + tx && p.x <= g.x + tx + w && p.y >= g.y + ty && p.y <= g.y + ty + h;
}

/* ----------------------------- 手势移动处理 ----------------------------- */
function handleMove(g, p, rawEvent) {
  if (g.kind === 'ink') {
    g.points.push(readPoint(p, g.points[g.points.length - 1]));
    requestRender();
  } else if (g.kind === 'erase') {
    g.raw.push(readPoint(p, g.raw[g.raw.length - 1]));
    collectEraseTargets(g, p);
    // 分块发送：每积累一定点数，切一块（分块同步，不发整笔全量）
    if (g.raw.length - g.lastSendLen >= 24) sendEraseChunk(g);
    requestRender();
  } else if (g.kind === 'shape') {
    g.current = p;
    requestRender();
  } else if (g.kind === 'marquee') {
    g.current = p;
    requestRender();
  } else if (g.kind === 'drag') {
    const dx = p.x - g.start.x, dy = p.y - g.start.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) g.moved = true;
    // 多选连续移动：一个事务 batch（多 op），按 gestureKey 压缩中间帧
    const ids = [...state.selected].filter((id) => state.store.getObject(id)?.kind !== 'group');
    const starts = Object.fromEntries(state.selectedTransforms);
    const { batch } = state.editor.moveMultiCoalesced(ids, dx, dy, state.gestureKey, starts);
    sendBatch(batch);
    requestRender();
  }
}

/* ----------------------------- 手势完成处理 ----------------------------- */
function finishGesture(g, p) {
  if (g.kind === 'ink') finishInk(g, p);
  else if (g.kind === 'erase') finishErase(g);
  else if (g.kind === 'shape') finishShape(g);
  else if (g.kind === 'drag') refreshHistory();
  else if (g.kind === 'marquee') finishMarquee(g);
}

function finishInk(g) {
  state.live = null;
  // 传输前 RDP 简化（保留压感/倾斜等属性）
  const simplified = rdp(g.points, 1.2);
  if (simplified.length < 2) { requestRender(); return; }

  // 图形识别：一笔画成基本图形 → 替换为 shape 对象
  if (g.opts.recognize === 'shape' || state.tool === 'recognize') {
    const r = recognizeShape(g.points);
    if (r && r.confidence >= 0.65) {
      const strokeBatch = state.editor.addStroke({ points: simplified, width: state.width, color: state.color });
      const id = 'sh-' + uid();
      const shapeObj = {
        id, kind: 'shape',
        props: {
          geom: { shape: r.shape, ...normalizeBox(r.bbox || bboxOf(g.points)) },
          style: { color: state.color, width: 2, fill: null, dash: null },
          transform: { tx: 0, ty: 0, sx: 1, sy: 1, angle: 0 }
        }
      };
      // 原子事务：建图形 + 删笔迹（其他端同时看到替换）
      const rep = commitShapeReplacement(state.editor, shapeObj, strokeBatch.ops[0].objectId);
      sendBatch(rep);
      requestRender();
      refreshHistory();
      return;
    }
  }

  const batch = state.editor.addStroke({
    points: simplified,
    width: state.width,
    color: state.color,
    tool: g.opts.tool || 'pen',
    smooth: 'catmull-rom',
    pressureFactor: state.pressureOn ? 0.6 : 0,
    speedFactor: state.speedOn ? 0.35 : 0
  });
  sendBatch(batch);
  refreshHistory();
  requestRender();
}

function bboxOf(points) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const pt of points) {
    x0 = Math.min(x0, pt.x); y0 = Math.min(y0, pt.y);
    x1 = Math.max(x1, pt.x); y1 = Math.max(y1, pt.y);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
function normalizeBox(b) {
  return { x: b.x, y: b.y, w: Math.max(2, b.w), h: Math.max(2, b.h) };
}

function finishShape(g) {
  const box = normalizeBox({
    x: Math.min(g.start.x, g.current.x),
    y: Math.min(g.start.y, g.current.y),
    w: Math.abs(g.current.x - g.start.x),
    h: Math.abs(g.current.y - g.start.y)
  });
  if (box.w < 4 && box.h < 4) { requestRender(); return; }
  const batch = state.editor.addShape(g.shape, box, { color: state.color, width: 2 });
  sendBatch(batch);
  refreshHistory();
  requestRender();
}

function finishMarquee(g) {
  const x0 = Math.min(g.start.x, g.current.x), x1 = Math.max(g.start.x, g.current.x);
  const y0 = Math.min(g.start.y, g.current.y), y1 = Math.max(g.start.y, g.current.y);
  state.selected.clear();
  for (const o of state.store.listObjects()) {
    if (o.kind === 'group') continue;
    const c = o.props.geom;
    if (!c) continue;
    const t = o.props.transform || {};
    const cx = (c.x || 0) + (t.tx || 0), cy = (c.y || 0) + (t.ty || 0);
    if (cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1) state.selected.add(o.id);
  }
  requestRender();
}

/* --------------------------- 像素橡皮（分块） --------------------------- */

function collectEraseTargets(g, p) {
  // 橡皮路径当前点覆盖到的笔迹（世界坐标命中测试）
  for (const o of state.store.listObjects()) {
    if (o.kind !== 'stroke') continue;
    if (hitStrokeAt(o, p, g.width / 2)) g.targetIds.add(o.id);
  }
}

function hitStrokeAt(o, p, radius) {
  const pts = o.props.geom.points;
  const t = o.props.transform || {};
  const tx = t.tx || 0, ty = t.ty || 0;
  const threshold = radius + (o.props.geom.width || 4) / 2 + 2;
  // 到折线各段的距离
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const ax = a.x + tx, ay = a.y + ty, bx = b.x + tx, by = b.y + ty;
    const dx = bx - ax, dy = by - ay;
    const L2 = dx * dx + dy * dy || 1;
    let tt = ((p.x - ax) * dx + (p.y - ay) * dy) / L2;
    tt = Math.max(0, Math.min(1, tt));
    const d = Math.hypot(p.x - (ax + tt * dx), p.y - (ay + tt * dy));
    if (d < threshold) return true;
  }
  return Math.hypot(p.x - (pts[0].x + tx), p.y - (pts[0].y + ty)) < threshold;
}

/** 把一段世界坐标点转换成相对某笔迹对象坐标的 mark（含 cells 网格提示） */
function marksFromSegment(strokeId, worldPoints, width, chunkSeq) {
  const tx = txOf(strokeId), ty = tyOf(strokeId);
  const local = worldPoints.map((pt) => ({ x: pt.x - tx, y: pt.y - ty }));
  return [eraseMark({ strokeId, points: local, chunkSeq, width })];
}

function sendEraseChunk(g) {
  const segment = g.raw.slice(g.lastSendLen);
  g.lastSendLen = g.raw.length;
  if (segment.length < 2 || !g.targetIds.size) return;
  const simple = rdp(segment, 1.0);
  for (const strokeId of g.targetIds) {
    const marks = marksFromSegment(strokeId, simple, g.width, g.chunksByStroke.get(strokeId)?.length || 0);
    if (!g.chunksByStroke.has(strokeId)) g.chunksByStroke.set(strokeId, []);
    const list = g.chunksByStroke.get(strokeId);
    const seq = list.length;
    list.push(marks);
    if (state.connected) {
      // 渐进预览帧：total 暂不定，服务端只中继不入日志；final batch 权威化
      state.ws.send(JSON.stringify({
        type: 'chunk', chunkGroupId: null, seq, total: -1, strokeId, marks
      }));
    }
  }
}

function txOf(id) { return state.store.getObject(id)?.props.transform?.tx || 0; }
function tyOf(id) { return state.store.getObject(id)?.props.transform?.ty || 0; }

function finishErase(g) {
  // 处理最后一段
  if (g.raw.length - g.lastSendLen >= 1 && g.targetIds.size) sendEraseChunk(g);
  if (!g.targetIds.size) { requestRender(); return; }

  // 为每个被擦笔迹，把整条简化路径作为一个 mark（分块已在过程中渐进预览）
  const simple = rdp(g.raw, 1.0);
  const ops = [];
  const chunkFrames = [];
  for (const strokeId of g.targetIds) {
    const marks = marksFromSegment(strokeId, simple, g.width, 0);
    ops.push({ type: 'erase', objectId: strokeId, marks });
    // final 阶段也补发一个与 final 对齐的分块组（让中途观察者逐块显示）
    chunkFrames.push({ strokeId, marks });
  }
  // 一次橡皮手势（可能擦多笔、多段）= 一个原子事务 batch，整组可撤销
  const finalBatch = state.editor.transact(ops);
  finalBatch.chunkGroupId = finalBatch.batchId;
  if (state.connected) {
    chunkFrames.forEach((cf, seq) => {
      state.ws.send(JSON.stringify({
        type: 'chunk', chunkGroupId: finalBatch.batchId, seq,
        total: chunkFrames.length, strokeId: cf.strokeId, marks: cf.marks
      }));
    });
  }
  sendBatch(finalBatch);
  refreshHistory();
  requestRender();
}

/* ----------------------------- 对象橡皮 ----------------------------- */
function eraseObjectAt(p) {
  const hit = hitTest(p);
  if (hit) {
    const b = state.editor.eraseObjects([hit]);
    sendBatch(b);
    refreshHistory();
  }
}

/* ----------------------------- 文本/便签 ----------------------------- */
function startFloatingInput(p, kind) {
  const input = $('floatInput');
  input.classList.remove('hidden');
  input.style.left = p.x + 'px';
  input.style.top = p.y + 'px';
  input.value = '';
  input.focus();
  const commit = () => {
    const content = input.value.trim();
    input.classList.add('hidden');
    if (content) {
      const b = kind === 'text'
        ? state.editor.addText(p.x, p.y, content, { color: state.color, size: 24 })
        : state.editor.addNote(p.x, p.y, 140, 90, content);
      sendBatch(b);
      refreshHistory();
      requestRender();
    }
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') input.classList.add('hidden');
  };
  input.onblur = commit;
}

/* ------------------------------- 图片 ------------------------------- */
$('imageFile').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const src = reader.result;
    const img = new Image();
    img.onload = () => {
      const w = Math.min(240, img.width), h = img.height * (w / img.width);
      state.images.set(src, img);
      const b = state.editor.addImage(80, 80, w, h, src);
      sendBatch(b);
      requestRender();
    };
    img.src = src;
  };
  reader.readAsDataURL(file);
  e.target.value = '';
});

/* --------------------------- 实时笔迹 / 选择框 --------------------------- */
function drawLiveStroke(c, live) {
  // 本地正在书写、尚未提交的笔迹：用渲染器同一套压感丝带算法实时上屏
  c.save();
  c.globalAlpha = 0.92;
  c.fillStyle = live.geom.color;
  const obj = { kind: 'stroke', props: { geom: { ...live.geom, points: live.points }, transform: { tx: 0, ty: 0 } } };
  traceStrokePath(c, obj.props.geom);
  c.restore();
}

function drawSelection(c) {
  c.save();
  c.strokeStyle = '#2563eb';
  c.lineWidth = 1.5;
  c.setLineDash([5, 4]);
  for (const id of state.selected) {
    const o = state.store.getObject(id);
    if (!o || !o.alive) continue;
    const g = o.props.geom;
    if (!g) continue;
    const t = o.props.transform || {};
    const w = g.w ?? 40, h = g.h ?? 20;
    c.strokeRect((g.x || 0) + (t.tx || 0) - 4, (g.y || 0) + (t.ty || 0) - 4, w + 8, h + 8);
  }
  c.restore();
}

/* ============================== 启动流程 ============================== */

function boot() {
  localStorage.setItem('wb2-uid', state.userId);
  window.addEventListener('resize', resizeCanvas);

  $('joinForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const roomId = $('roomInput').value.trim();
    if (!roomId) return;
    state.roomId = roomId;
    const name = $('nameInput').value.trim();
    if (name) { state.userId = 'u-' + name.slice(0, 12); localStorage.setItem('wb2-uid', state.userId); }
    $('roomLabel').textContent = roomId;
    $('userLabel').textContent = state.userId;
    $('joinScreen').classList.add('hidden');
    $('app').classList.remove('hidden');
    // 用最终 userId 初始化内核与渲染器
    initStore();
    resizeCanvas();
    connect();
    setInterval(() => {
      if (state.connected) state.ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
    }, 20000);
  });
}

boot();
