'use strict';

/**
 * 协作白板 v2 —— 服务端
 *
 * 角色定位（和 v1 的根本区别）：
 *  服务端【不再】用 seq 解决冲突。冲突解决在各端的 CRDT 内核（LWW + 因果缓冲 +
 *  选择性撤销）里完成。服务端只负责：
 *   1. 房间与连接管理、广播中继（附 server seq，仅用于日志排序/补漏游标）
 *   2. 每房间保留一份折叠后的 CRDT Store（用于给新成员/重连者出快照）
 *   3. 像素擦除的分块组装（chunk1..chunkN 到齐再作为一个原子 batch 入库/广播）
 *   4. 日志压缩：同一 coalesceKey 的连续中间帧合并，减小历史体积
 *   5. 选择（selection）等瞬态消息只中继、不入日志
 *   6. 心跳、静态文件、HTTP 观察 API
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { CollabStore } from './lib/store.js';
import { validateBatch } from './lib/batch.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8081;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const LOG_LIMIT = 20000; // 每房间日志 batch 数上限（压缩后仍超限时丢弃最旧日志，快照兜底）

/**
 * room: {
 *   clients: Set<client>,
 *   store: CollabStore(serverId),    // 折叠状态（出快照）
 *   log: Array<{seq, batch}>,        // 日志（按 seq；已压缩）
 *   seq: number,
 *   knownSeq: Map<userId/batchId,>,  // 幂等：batchId -> seq
 *   chunks: Map<chunkGroupId, {total, got:Map<seq,batch>, author, firstSeq}>,
 * }
 */
const rooms = new Map();
const SERVER_ID = 'server';

function getOrCreateRoom(roomId) {
  let room = rooms.get(roomId);
  if (!room) {
    room = {
      clients: new Set(),
      store: new CollabStore(SERVER_ID),
      log: [],
      seq: 0,
      known: new Map(),
      chunks: new Map()
    };
    rooms.set(roomId, room);
    console.log(`[room] created: ${roomId}`);
  }
  return room;
}

function sendJSON(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

/* ------------------------------ 日志与压缩 ----------------------------- */

function appendLog(room, batch) {
  // 幂等
  if (room.known.has(batch.batchId)) return room.known.get(batch.batchId);

  // 压缩：batch.replaces 指向的旧中间帧从日志中移除（原子替换）
  if (batch.replaces && room.known.has(batch.replaces)) {
    const oldSeq = room.known.get(batch.replaces);
    const idx = room.log.findIndex((e) => e.seq === oldSeq);
    if (idx >= 0) room.log.splice(idx, 1);
    room.known.delete(batch.replaces);
  } else {
    coalesceLog(room, batch);
  }

  room.seq += 1;
  const seq = room.seq;
  room.log.push({ seq, batch });
  room.known.set(batch.batchId, seq);
  if (room.log.length > LOG_LIMIT) {
    const cut = room.log.splice(0, room.log.length - LOG_LIMIT);
    for (const e of cut) room.known.delete(e.batch.batchId);
  }
  return seq;
}

/**
 * 已确认历史的压缩：如果新 batch 与日志中【最后一条】内容 batch
 * 同作者 + 同 coalesceKey（连续 move/scale），直接丢弃旧的中间帧——
 * CRDT 下中间帧对最终状态无贡献（同 key 被同作者更新的 LWW 覆盖；
 * 新 batch.deps 已包含旧帧因果位置）。
 */
function coalesceLog(room, batch) {
  if (!batch.coalesceKey || (batch.ops || []).length !== 1 || batch.undoOf) return;
  const last = room.log[room.log.length - 1];
  if (!last || last.batch.undoOf) return;
  const ob = last.batch;
  // 只在“紧邻的、同一作者、同一 key”两帧之间压缩
  if (ob.clientId === batch.clientId && ob.coalesceKey === batch.coalesceKey) {
    room.log.pop();
    room.known.delete(ob.batchId);
  }
}

function applyToRoomState(room, batch) {
  try {
    room.store.receive(batch);
  } catch (err) {
    console.error('[room-state] apply failed:', err.message);
  }
}

/* ------------------------------ 消息处理 ------------------------------- */

function handleJoin(client, msg) {
  const roomId = String(msg.roomId || '').trim();
  if (!roomId || roomId.length > 64) {
    sendJSON(client.ws, { type: 'error', message: 'invalid roomId' });
    return;
  }
  leaveRoom(client);

  const userId = String(msg.userId || '').slice(0, 64) || crypto.randomBytes(4).toString('hex');
  client.userId = userId;
  client.roomId = roomId;
  const room = getOrCreateRoom(roomId);
  room.clients.add(client);

  sendJSON(client.ws, { type: 'joined', roomId, userId, lastSeq: room.seq });

  // 快照（折叠后的完整状态）+ 快照之后的日志增量。
  // 服务端日志可能已裁剪，因此以快照为主、日志补增量；去重在客户端 CRDT 完成。
  const afterSeq = Math.floor(msg.afterSeq || 0);
  const snapshot = room.store.snapshot();
  const delta = room.log.filter((e) => e.seq > afterSeq).map((e) => e.batch);
  sendJSON(client.ws, { type: 'snapshot', roomId, snapshot, afterSeq: room.seq, delta });

  console.log(`[join] room=${roomId} user=${userId} members=${room.clients.size} seq=${room.seq} delta=${delta.length}`);
}

function leaveRoom(client) {
  if (!client.roomId) return;
  const room = rooms.get(client.roomId);
  if (room) {
    room.clients.delete(client);
    if (room.clients.size === 0) console.log(`[room] empty (state retained): ${client.roomId}`);
  }
  client.roomId = null;
}

function handleBatch(client, msg) {
  if (!client.roomId) {
    sendJSON(client.ws, { type: 'error', message: 'join a room first' });
    return;
  }
  const batch = msg.batch;
  const err = validateBatch(batch);
  if (err) {
    sendJSON(client.ws, { type: 'error', message: `invalid batch: ${err}` });
    return;
  }
  // 作者身份以登录 userId 为准，防止伪造他人操作
  batch.clientId = client.userId;
  batch.batchId = `${client.userId}:${batch.clientSeq}`;

  const room = rooms.get(client.roomId);
  if (room.known.has(batch.batchId)) {
    sendJSON(client.ws, { type: 'ack', batchId: batch.batchId, seq: room.known.get(batch.batchId) });
    return;
  }

  applyToRoomState(room, batch);
  const seq = appendLog(room, batch);

  sendJSON(client.ws, { type: 'ack', batchId: batch.batchId, seq });
  broadcast(room, client, { type: 'batch', seq, batch });
  if (batch.chunkGroupId && room.chunks.has(batch.chunkGroupId)) {
    room.chunks.delete(batch.chunkGroupId);
    console.log(`[eraser] group=${batch.chunkGroupId} finalized -> seq=${seq} marks=${(batch.ops[0] && batch.ops[0].marks || []).length}`);
  }
  console.log(`[batch] seq=${seq} room=${client.roomId} user=${client.userId} ops=${batch.ops.length}${batch.undoOf ? ` undo=${batch.undoOf}:${batch.active}` : ''}${batch.coalesceKey ? ` ~${batch.coalesceKey}` : ''}`);
}

/**
 * 像素擦除分块协议：
 *  - 客户端在 pointerup 前已本地原子应用最终 batch（乐观）；
 *  - 手势过程中把擦除点切成 N 个 chunk 帧（{chunkGroupId,seq,total,strokeId,marks}）
 *    逐块发出，服务端原样中继给其他端做【渐进预览】（chunk 帧不入 CRDT/日志）；
 *  - 收齐 N 块后客户端发 final batch（普通 batch 消息，带 chunkGroupId），
 *    服务端入日志/广播；其他端以 final 为准（预览标记 mark.id 与 final 相同→幂等）。
 *  - 这样“分块同步”只影响传输与渲染，原子性、因果、撤销都只有一个 batch。
 */
function handleChunk(client, msg) {
  if (!client.roomId) return;
  const room = rooms.get(client.roomId);
  const { chunkGroupId, seq, total, strokeId, marks } = msg;
  if (!Array.isArray(marks)) {
    sendJSON(client.ws, { type: 'error', message: 'invalid chunk' });
    return;
  }

  // 流式预览帧（group 未定 / total<0）：只中继，绝不建组/改状态
  if (!chunkGroupId || total < 0) {
    broadcast(room, client, { type: 'chunk', chunkGroupId: null, seq, total, strokeId, marks, preview: true });
    return;
  }

  let g = room.chunks.get(chunkGroupId);
  if (!g) {
    g = { total, got: new Set(), strokeId };
    room.chunks.set(chunkGroupId, g);
  }
  if (g.got.has(seq)) {
    sendJSON(client.ws, { type: 'ack', chunkGroupId, chunkSeq: seq, chunk: true });
    return;
  }
  g.got.add(seq);
  g.total = total;
  g.strokeId = strokeId || g.strokeId;

  // 仅中继给其他客户端做渐进预览，绝不修改房间 CRDT 状态/日志
  broadcast(room, client, { type: 'chunk', chunkGroupId, seq, total, strokeId, marks });
  sendJSON(client.ws, { type: 'ack', chunkGroupId, chunkSeq: seq, chunk: true });
}

function broadcast(room, sender, msg) {
  const data = JSON.stringify(msg);
  for (const c of room.clients) {
    if (sender && c === sender) continue;
    if (c.ws.readyState === c.ws.OPEN) c.ws.send(data);
  }
}

/** 瞬态消息（光标、选择框、橡皮预览）：只中继，不入库、不改状态 */
function handlePresence(client, msg) {
  if (!client.roomId) return;
  const room = rooms.get(client.roomId);
  msg.p = { ...(msg.p || {}), userId: client.userId };
  broadcast(room, client, { type: 'presence', p: msg.p });
}

/* -------------------------------- HTTP --------------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/api/room') {
    const room = rooms.get(url.searchParams.get('roomId'));
    if (!room) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'room not found' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      roomId: url.searchParams.get('roomId'),
      members: room.clients.size,
      seq: room.seq,
      logCount: room.log.length,
      log: room.log.map((e) => ({
        seq: e.seq,
        batchId: e.batch.batchId,
        clientId: e.batch.clientId,
        clock: e.batch.clock,
        ops: e.batch.ops.length,
        undoOf: e.batch.undoOf,
        coalesceKey: e.batch.coalesceKey,
        deps: e.batch.deps
      })),
      objects: room.store.listObjects().map((o) => ({ id: o.id, kind: o.kind, creator: o.creator }))
    }, null, 0));
    return;
  }

  if (url.pathname === '/api/rooms') {
    const summary = [];
    for (const [roomId, room] of rooms) {
      summary.push({ roomId, members: room.clients.size, seq: room.seq, logCount: room.log.length });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(summary));
    return;
  }

  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

/* -------------------------------- WebSocket ----------------------------- */

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  const client = {
    id: crypto.randomBytes(6).toString('hex'),
    ws, userId: null, roomId: null, lastSeen: Date.now()
  };
  ws.on('pong', () => { client.lastSeen = Date.now(); });

  ws.on('message', (raw) => {
    client.lastSeen = Date.now();
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) {
      sendJSON(ws, { type: 'error', message: 'invalid json' });
      return;
    }
    switch (msg.type) {
      case 'join': handleJoin(client, msg); break;
      case 'batch': handleBatch(client, msg); break;
      case 'chunk': handleChunk(client, msg); break;
      case 'presence': handlePresence(client, msg); break;
      case 'ping': sendJSON(ws, { type: 'pong', ts: Date.now() }); break;
      default: sendJSON(ws, { type: 'error', message: `unknown type: ${msg.type}` });
    }
  });

  ws.on('close', () => leaveRoom(client));
  ws.on('error', (err) => {
    console.error('[ws error]', err.message);
    try { ws.terminate(); } catch (_) { /* noop */ }
    leaveRoom(client);
  });
});

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    for (const client of room.clients) {
      if (now - client.lastSeen > 45000) {
        console.warn(`[timeout] user=${client.userId}`);
        try { client.ws.terminate(); } catch (_) { /* noop */ }
      }
    }
  }
}, 15000);

server.listen(PORT, HOST, () => {
  console.log('==============================================');
  console.log('  Collaborative Whiteboard CRDT server v2');
  console.log(`  HTTP : http://localhost:${PORT}/`);
  console.log(`  WS   : ws://<host>:${PORT}/ws`);
  console.log('  冲突解决：客户端 CRDT（LWW+因果+选择性撤销）；server seq 仅日志排序');
  console.log('==============================================');
});

process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));
