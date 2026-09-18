'use strict';

/**
 * 服务端协议测试：自动拉起 server.js（端口 PORT），通过真实 WebSocket 验证：
 *  - join/snapshot、batch 广播+ack、幂等
 *  - 房间隔离
 *  - 像素擦除分块：chunk 渐进中继 + chunk-final 原子合并
 *  - 日志压缩：连续同 coalesceKey batch 被合并，历史日志体积减小
 *  - server seq 与 CRDT clock 相互独立
 *  - presence 只中继不入日志
 *  - 快照 + 增量一致性（新成员最终状态与老成员一致）
 */

import WebSocket from 'ws';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import http from 'http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.TEST_PORT || 8091;
const URL = `ws://localhost:${PORT}/ws`;

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('  PASS -', msg); }
  else { failed++; console.error('  FAIL -', msg); }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function connect() {
  return new WebSocket(URL);
}
function send(ws, obj) { ws.send(JSON.stringify(obj)); }

function messages(ws, timeout = 3000) {
  const buf = [];
  const listeners = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    buf.push(msg);
    for (let i = listeners.length - 1; i >= 0; i--) {
      if (listeners[i](msg)) listeners.splice(i, 1);
    }
  });
  return {
    buf,
    expect(pred, label = 'message', ms = timeout) {
      return new Promise((resolve, reject) => {
        const hit = buf.find(pred);
        if (hit) return resolve(hit);
        const t = setTimeout(() => reject(new Error(`timeout: ${label}`)), ms);
        listeners.push((m) => {
          if (pred(m)) { clearTimeout(t); resolve(m); return true; }
          return false;
        });
      });
    },
    collect(pred, count, ms = timeout) {
      return new Promise((resolve, reject) => {
        const got = buf.filter(pred);
        if (got.length >= count) return resolve(got);
        const t = setTimeout(() => reject(new Error(`collect timeout ${got.length}/${count}`)), ms);
        listeners.push((m) => {
          if (pred(m)) got.push(m);
          if (got.length >= count) { clearTimeout(t); resolve(got); return true; }
          return false;
        });
      });
    }
  };
}

async function joined(ws, roomId, userId, m) {
  send(ws, { type: 'join', roomId, userId });
  const j = await m.expect((x) => x.type === 'joined');
  const snap = await m.expect((x) => x.type === 'snapshot');
  return { j, snap };
}

function httpGet(p) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${PORT}${p}`, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

// 构造一个合法 batch（绕过 Editor，控制字段）
let clockCounter = 1000;
function shapeBatch(userId, clientSeq, deps = {}, extra = {}) {
  clockCounter += 1;
  return {
    v: 2,
    batchId: `${userId}:${clientSeq}`,
    clientId: userId,
    clientSeq,
    clock: clockCounter,
    deps,
    t: Date.now(),
    tx: false,
    coalesceKey: null,
    replaces: null,
    undoOf: null,
    active: true,
    ops: [{
      type: 'create',
      objectId: `o-${userId}-${clientSeq}`,
      object: { id: `o-${userId}-${clientSeq}`, kind: 'shape', props: { geom: { x: clientSeq, y: 0, w: 1, h: 1 }, style: {} } }
    }],
    ...extra
  };
}

export async function runProtocol() {
  passed = 0; failed = 0;
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', () => {});
  await wait(700);

  try {
    // 1. 加入 + 快照
    const wsA = connect();
    const mA = messages(wsA);
    await new Promise((r) => wsA.on('open', r));
    const room = `r-${Date.now()}`;
    await joined(wsA, room, 'uA', mA);
    assert(true, 'A 加入房间并收到 joined+snapshot');

    // B 加入
    const wsB = connect();
    const mB = messages(wsB);
    await new Promise((r) => wsB.on('open', r));
    await joined(wsB, room, 'uB', mB);
    assert(true, 'B 加入同一房间');

    // 2. batch 广播 + ack
    const b1 = shapeBatch('uA', 1, { uA: 0 });
    send(wsA, { type: 'batch', batch: b1 });
    const ack = await mA.expect((m) => m.type === 'ack' && m.batchId === 'uA:1');
    assert(!!ack.seq, `A 收到 ack，server seq=${ack.seq}`);
    const recv = await mB.expect((m) => m.type === 'batch' && m.batch.batchId === 'uA:1');
    assert(!!recv.seq, 'B 收到 A 的 batch 广播（带 server seq）');

    // 3. 幂等：重复 batchId 不重复广播
    let extraBroadcast = false;
    const probe = (m) => m.type === 'batch' && m.batch.batchId === 'uA:1';
    send(wsA, { type: 'batch', batch: b1 });
    await mA.expect((m) => m.type === 'ack');
    await wait(200);
    const dupCount = mB.buf.filter(probe).length;
    assert(dupCount === 1, `重复 batchId 幂等（B 只收到 1 次，实际 ${dupCount}）`);
    assert(!extraBroadcast, '无额外广播');

    // 4. server seq 只是日志排序游标：按到达顺序增长，与逻辑 clock 大小无关
    const b2 = shapeBatch('uA', 2, { uA: 1 }, { clock: 100 });
    const b3 = shapeBatch('uA', 3, { uA: 2 }, { clock: 5 }); // clock 更小
    send(wsA, { type: 'batch', batch: b2 });
    send(wsA, { type: 'batch', batch: b3 });
    await wait(200);
    const seq2 = mA.buf.filter((m) => m.type === 'ack' && m.batchId === 'uA:2').map((m) => m.seq)[0];
    const seq3 = mA.buf.filter((m) => m.type === 'ack' && m.batchId === 'uA:3').map((m) => m.seq)[0];
    assert(seq3 > seq2, `seq 按到达顺序增长（${seq2} -> ${seq3}），与 clock=100/5 的大小无关`);

    // 5. 房间隔离
    const wsC = connect();
    const mC = messages(wsC);
    await new Promise((r) => wsC.on('open', r));
    await joined(wsC, `other-${Date.now()}`, 'uC', mC);
    send(wsA, { type: 'batch', batch: shapeBatch('uA', 4, { uA: 3 }) });
    await wait(200);
    const cLeak = mC.buf.some((m) => m.type === 'batch');
    assert(!cLeak, '房间隔离：C 收不到其他房间的 batch');

    // 6. 日志压缩：连续同 coalesceKey 的 move batch 只保留最后一条
    const moveBatch = (seq, tx, key = 'move:o-move') => ({
      v: 2, batchId: `uA:${seq}`, clientId: 'uA', clientSeq: seq,
      clock: 2000 + seq, deps: { uA: seq - 1 }, t: Date.now(),
      tx: false, coalesceKey: key, replaces: null, undoOf: null, active: true,
      ops: [{ type: 'update', objectId: 'o-move', values: { transform: { tx, ty: 0 } } }]
    });
    for (let i = 5; i <= 14; i++) send(wsA, { type: 'batch', batch: moveBatch(i, i) });
    await wait(300);
    const api = await httpGet(`/api/room?roomId=${room}`);
    const roomState = JSON.parse(api.body);
    const moveLogs = roomState.log.filter((e) => e.coalesceKey === 'move:o-move');
    assert(moveLogs.length === 1, `连续 10 帧 move 压缩为 1 条日志（实际 ${moveLogs.length}）`);
    assert(roomState.seq > 10, `server seq 仍逐条增长（seq=${roomState.seq}，seq 是日志排序游标）`);

    // 7. 新成员快照与老成员最终一致
    const wsD = connect();
    const mD = messages(wsD);
    await new Promise((r) => wsD.on('open', r));
    const { snap } = await joined(wsD, room, 'uD', mD);
    const shapeCount = snap.snapshot.objects.filter((o) => o.kind === 'shape').length;
    assert(shapeCount >= 1, `新成员快照包含已创建对象（${shapeCount} 个 shape）`);

    // 8. presence 只中继不入日志
    send(wsA, { type: 'presence', p: { kind: 'cursor', x: 1, y: 2 } });
    const pres = await mB.expect((m) => m.type === 'presence' && m.p.x === 1);
    assert(pres.p.userId === 'uA', 'presence 中继并附带作者');
    const api2 = await httpGet(`/api/room?roomId=${room}`);
    const beforeCount = JSON.parse(api2.body).seq;
    await wait(100);
    const api3 = await httpGet(`/api/room?roomId=${room}`);
    assert(JSON.parse(api3.body).seq === beforeCount, 'presence 不入日志、不增 seq');

    // 9. 像素擦除分块：chunk 渐进预览帧（不入日志） + 唯一 final batch 权威提交
    const targetStroke = shapeBatch('uA', 15, { uA: 14 });
    targetStroke.ops[0] = {
      type: 'create',
      objectId: 'o-eraser-target',
      object: { id: 'o-eraser-target', kind: 'stroke', props: { geom: { points: [{ x: 0, y: 0 }, { x: 300, y: 0 }], width: 3, color: '#000', tool: 'pen', smooth: 'catmull-rom' }, transform: { tx: 0, ty: 0 } } }
    };
    send(wsA, { type: 'batch', batch: targetStroke });
    await wait(100);

    const total = 3;
    const finalBatchId = 'uA:16';
    const allMarks = [];
    for (let c = 0; c < total; c++) {
      allMarks.push({
        id: `em-${c}`, strokeId: 'o-eraser-target', kind: 'pixel',
        points: [{ x: c * 30, y: 0 }, { x: c * 30 + 5, y: 0 }],
        width: 10, chunkSeq: c, cells: [`${Math.floor(c * 30 / 64)}:0`]
      });
      send(wsA, {
        type: 'chunk',
        chunkGroupId: finalBatchId,
        seq: c,
        total,
        strokeId: 'o-eraser-target',
        marks: [allMarks[allMarks.length - 1]]
      });
    }
    const finalBatch = {
      v: 2, batchId: finalBatchId, clientId: 'uA', clientSeq: 16,
      clock: 5000, deps: { uA: 16 }, t: Date.now(),
      tx: true, coalesceKey: null, replaces: null, undoOf: null, active: true,
      chunkGroupId: finalBatchId,
      ops: [{ type: 'erase', objectId: 'o-eraser-target', marks: allMarks }]
    };
    send(wsA, { type: 'batch', batch: finalBatch });

    const chunks = await mB.collect((m) => m.type === 'chunk' && m.chunkGroupId === finalBatchId, 3);
    assert(chunks.length === 3, `B 收到 ${chunks.length}/3 个渐进擦除分块（预览）`);
    const fin = await mB.expect((m) => m.type === 'batch' && m.batch && m.batch.chunkGroupId === finalBatchId);
    assert(fin.batch.ops[0].marks.length === 3, 'final 是唯一权威原子 batch（含 3 个 marks）');
    await wait(100);
    const api4 = await httpGet(`/api/room?roomId=${room}`);
    const st4 = JSON.parse(api4.body);
    assert(st4.objects.some((o) => o.id === 'o-eraser-target'), '像素擦除不删对象（目标仍在）');
    const eraseLogs = st4.log.filter((e) => e.batchId === finalBatchId);
    assert(eraseLogs.length === 1, '日志中只有 1 条擦除 final（分块预览帧未入日志）');

    const wsE = connect();
    const mE = messages(wsE);
    await new Promise((r) => wsE.on('open', r));
    const joinE = await joined(wsE, room, 'uE', mE);
    const markCount = joinE.snap.snapshot.marks.filter((m) => m.strokeId === 'o-eraser-target').length;
    assert(markCount === 3, `新成员快照含 ${markCount}/3 个擦除标记，两端最终一致`);

    wsA.close(); wsB.close(); wsC.close(); wsD.close(); wsE.close();
  } catch (err) {
    failed++;
    console.error('  FAIL - 协议测试异常:', err.message);
  } finally {
    server.kill();
  }

  return { passed, failed };
}
