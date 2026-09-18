'use strict';

/**
 * 协作内核单元测试（纯 CRDT，无需网络）。
 * 覆盖：LWW 并发收敛、因果缓冲与乱序投递、选择性撤销（不破坏他人）、
 * 事务原子性、操作压缩、压感宽度确定性、擦除分块幂等、图层/组、快照。
 */

import assert from 'node:assert';
import { CollabStore } from '../lib/store.js';
import { Editor, createOp, eraseMark, newObjectId } from '../lib/editor.js';
import { makePoint, computeStrokeWidths, rdp, catmullRomPath, bSplinePath } from '../lib/geometry.js';
import { uid } from '../lib/clock.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS - ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL - ${name}\n         ${err.stack.split('\n').slice(0, 3).join('\n         ')}`);
  }
}

export function runKernel() {
  passed = 0; failed = 0;

function prop(store, id, key) {
  const o = store.getObject(id);
  return o && o.alive ? o.props[key] : undefined;
}

/* ------------------------- 验收场景 1：三端并发收敛 ------------------------- */

test('场景1：三个客户端并发画同一区域，最终一致、无重复笔迹', () => {
  const A = new CollabStore('A');
  const B = new CollabStore('B');
  const C = new CollabStore('C');
  const edA = new Editor(A), edB = new Editor(B), edC = new Editor(C);

  // 三个端各画一笔，本地乐观提交
  const bA = edA.addStroke({ points: [makePoint(0, 0, 0.5, 1), makePoint(10, 10, 0.6, 10)], width: 4, color: '#f00' });
  const bB = edB.addStroke({ points: [makePoint(2, 0, 0.5, 1), makePoint(12, 10, 0.6, 10)], width: 4, color: '#0f0' });
  const bC = edC.addStroke({ points: [makePoint(4, 0, 0.5, 1), makePoint(14, 10, 0.6, 10)], width: 4, color: '#00f' });

  // 模拟乱序广播：每端以不同顺序收到另外两端的操作
  const all = [bA, bB, bC];
  const orderForB = [bC, bA];
  const orderForC = [bA, bB];
  const orderForA = [bC, bB];
  orderForB.forEach((b) => B.receive(b));
  orderForC.forEach((b) => C.receive(b));
  orderForA.forEach((b) => A.receive(b));

  for (const s of [A, B, C]) {
    const objs = s.listObjects();
    assert.strictEqual(objs.length, 3, '每个端都应恰好看到 3 笔（无重复无丢失）');
    const colors = objs.map((o) => o.props.geom.color).sort();
    assert.deepStrictEqual(colors, ['#00f', '#0f0', '#f00']);
  }
  // 同一对象 id 集合一致
  const idsA = A.listObjects().map((o) => o.id).sort();
  const idsB = B.listObjects().map((o) => o.id).sort();
  const idsC = C.listObjects().map((o) => o.id).sort();
  assert.deepStrictEqual(idsA, idsB);
  assert.deepStrictEqual(idsB, idsC);
});

test('LWW：同字段并发写按 (clock, clientId) 决胜，与到达顺序无关', () => {
  const A = new CollabStore('A');
  const B = new CollabStore('B');
  const edA = new Editor(A), edB = new Editor(B);
  const id = newObjectId();
  const create = {
    v: 2, batchId: 'A:1', clientId: 'A', clientSeq: 1, clock: 1, deps: {},
    t: 0, tx: false, coalesceKey: null, replaces: null, undoOf: null, active: true,
    ops: [{ type: 'create', objectId: id, object: { id, kind: 'shape', props: { color: 'x' } } }]
  };
  A.receive(create); B.receive(create);

  // 用真实编辑器产生两个“并发”的 color 写：
  // 先人为拉大时钟，让 B 的写逻辑时钟更高，再以不同到达顺序投递
  A.clock.t = 10;
  B.clock.t = 20;
  const aWrite = edA.transact([{ type: 'update', objectId: id, values: { color: 'red' } }]);
  const bWrite = edB.transact([{ type: 'update', objectId: id, values: { color: 'blue' } }]);
  assert.ok(bWrite.clock > aWrite.clock, `B 时钟更高（${bWrite.clock} > ${aWrite.clock}）`);

  // 两种相反的到达顺序，结果都应是 blue
  const A2 = new CollabStore('A2'); const B2 = new CollabStore('B2');
  A2.receive(create); B2.receive(create);
  A2.receive(aWrite); A2.receive(bWrite);
  B2.receive(bWrite); B2.receive(aWrite);
  assert.strictEqual(prop(A2, id, 'color'), 'blue');
  assert.strictEqual(prop(B2, id, 'color'), 'blue');

  // 另一组：A 时钟更高 → red 胜出（再建一个对象验证反向）
  const id2 = newObjectId();
  const c2 = {
    v: 2, batchId: 'B:1', clientId: 'B', clientSeq: 1, clock: 1, deps: {},
    t: 0, tx: false, coalesceKey: null, replaces: null, undoOf: null, active: true,
    ops: [{ type: 'create', objectId: id2, object: { id: id2, kind: 'shape', props: { color: 'x' } } }]
  };
  const A3 = new CollabStore('A3'); const B3 = new CollabStore('B3');
  A3.receive(c2); B3.receive(c2);
  A3.clock.t = 50; B3.clock.t = 30;
  const a2 = new Editor(A3).transact([{ type: 'update', objectId: id2, values: { color: 'red' } }]);
  const b2 = new Editor(B3).transact([{ type: 'update', objectId: id2, values: { color: 'blue' } }]);
  A3.receive(b2); B3.receive(a2); // 先互相收到对方的
  A3.receive(a2); B3.receive(b2);
  assert.strictEqual(prop(A3, id2, 'color'), 'red');
  assert.strictEqual(prop(B3, id2, 'color'), 'red');
});

/* ---------------------- 验收场景 2：选择性撤销不破坏他人 ---------------------- */

test('场景2a：A 撤销自己旧笔迹；B 未修改该对象 → 笔迹消失', () => {
  const A = new CollabStore('A');
  const B = new CollabStore('B');
  const edA = new Editor(A);
  const stroke = edA.addStroke({ points: [makePoint(0, 0, 0.5, 1), makePoint(10, 10, 0.6, 10)], width: 4 });
  B.receive(stroke);
  assert.strictEqual(B.getObject(stroke.ops[0].objectId).alive, true);

  const u = edA.undoLast();
  B.receive(u);
  assert.strictEqual(A.getObject(stroke.ops[0].objectId).alive, false, 'A 端撤销后消失');
  assert.strictEqual(B.getObject(stroke.ops[0].objectId).alive, false, 'B 端也消失');

  // 重做恢复
  const r = edA.redoLast();
  B.receive(r);
  assert.strictEqual(A.getObject(stroke.ops[0].objectId).alive, true);
  assert.strictEqual(B.getObject(stroke.ops[0].objectId).alive, true);
});

test('场景2b：A 撤销自己旧笔迹，但 B 已移动/改色该笔迹 → 不破坏 B 的结果（复活+保留B值）', () => {
  const A = new CollabStore('A');
  const B = new CollabStore('B');
  const edA = new Editor(A);
  const edB = new Editor(B);

  const create = edA.addStroke({ points: [makePoint(0, 0, 0.5, 1), makePoint(10, 10, 0.6, 10)], width: 4, color: '#000' });
  B.receive(create);
  const id = create.ops[0].objectId;

  // B 在 A 撤销前，把笔迹移动并改成红色
  const bMove = edB.move([id], 50, 60);
  const bColor = edB.transact([{ type: 'update', objectId: id, values: { geom: { ...B.getObject(id).props.geom, color: '#ff0000' } } }]);
  A.receive(bMove);
  A.receive(bColor);

  // A 现在撤销自己的“创建笔迹”
  const u = edA.undoLast();
  B.receive(u);

  const onA = A.getObject(id);
  const onB = B.getObject(id);
  assert.strictEqual(onA.alive, true, 'A 端：B 修改过，笔迹必须保留');
  assert.strictEqual(onB.alive, true, 'B 端：笔迹保留');
  assert.strictEqual(onA.props.transform.tx, 50, 'B 的移动结果保留');
  assert.strictEqual(onA.props.transform.ty, 60, 'B 的移动结果保留');
  assert.strictEqual(onA.props.geom.color, '#ff0000', 'B 的改色结果保留');
  assert.deepStrictEqual(onA.props.transform, onB.props.transform, '两端状态一致');
});

test('场景2c：A 撤销自己的“移动”，而 B 并发移动过同一对象 → B 的移动胜出，A 的撤销不能把它清掉', () => {
  // 构造两个“并发”（互不感知）的移动：
  //  A 基于 create 状态把对象移到 (100,0)
  //  B 也基于 create 状态把对象移到 (0,200)（B 没见过 A 的移动）
  const A = new CollabStore('A');
  const B = new CollabStore('B');
  const edA = new Editor(A);
  const edB = new Editor(B);
  const create = edA.addShape('rect', { x: 0, y: 0, w: 10, h: 10 });
  B.receive(create);
  const id = create.ops[0].objectId;

  const aMove = edA.move([id], 100, 0); // A:2
  const bMove = edB.move([id], 0, 200); // B:1（deps 里没有 A:2，是并发写）

  // 合并到两端：LWW 决定一个移动胜出（B 的 clock 基于 create(A:1) 观察后更大）
  A.receive(bMove);
  B.receive(aMove);
  const winnerTx = A.getObject(id).props.transform.tx;
  const winnerTy = A.getObject(id).props.transform.ty;
  assert.deepStrictEqual(B.getObject(id).props.transform, A.getObject(id).props.transform, '两端并发合并结果一致');

  // A 撤销自己的移动：B 的并发移动绝不能被破坏
  const u = edA.undo(aMove.batchId);
  B.receive(u);
  const o = A.getObject(id);
  assert.deepStrictEqual(o.props.transform, { tx: winnerTx, ty: winnerTy, sx: 1, sy: 1, angle: 0 },
    'A 撤销自己的移动后，B 的并发移动保持不变');
  assert.deepStrictEqual(B.getObject(id).props.transform, o.props.transform, '两端一致');
});

test('只能撤销自己的操作，撤别人会抛错', () => {
  const A = new CollabStore('A');
  const B = new CollabStore('B');
  const edA = new Editor(A);
  const b = edA.addShape('rect', { x: 0, y: 0, w: 1, h: 1 });
  B.receive(b);
  assert.throws(() => new Editor(B).undo(b.batchId), /only undo your own/);
});

test('选择性撤销：历史列表里可挑选任意一条自己的 batch 撤销（不要求是最后一条）', () => {
  const A = new CollabStore('A');
  const ed = new Editor(A);
  const s1 = ed.addShape('rect', { x: 0, y: 0, w: 1, h: 1 });
  const s2 = ed.addShape('ellipse', { x: 0, y: 0, w: 1, h: 1 });
  const s3 = ed.addShape('triangle', { x: 0, y: 0, w: 1, h: 1 });
  // 选择性撤销中间 s2
  ed.undo(s2.batchId);
  assert.strictEqual(A.getObject(s1.ops[0].objectId).alive, true);
  assert.strictEqual(A.getObject(s2.ops[0].objectId).alive, false);
  assert.strictEqual(A.getObject(s3.ops[0].objectId).alive, true);
});

/* ----------------------- 验收场景 3：事务原子（多选移动） ----------------------- */

test('场景3：一次移动多个对象是单一原子 batch（ops 数=对象数，tx=true）', () => {
  const A = new CollabStore('A');
  const B = new CollabStore('B');
  const ed = new Editor(A);
  const s1 = ed.addShape('rect', { x: 0, y: 0, w: 1, h: 1 });
  const s2 = ed.addShape('rect', { x: 0, y: 0, w: 1, h: 1 });
  const s3 = ed.addShape('rect', { x: 0, y: 0, w: 1, h: 1 });
  const id1 = s1.ops[0].objectId, id2 = s2.ops[0].objectId, id3 = s3.ops[0].objectId;
  [s1, s2, s3].forEach((b) => B.receive(b));

  const move = ed.move([id1, id2, id3], 30, 40);
  assert.strictEqual(move.ops.length, 3, '一个 batch 包含 3 个 update');
  assert.strictEqual(move.tx, true, '标记为事务');

  // B 要么没收到（没应用），要么收到后 3 个全部移动，不可能只动一半
  const before = [id1, id2, id3].map((id) => B.getObject(id).props.transform.tx);
  assert.deepStrictEqual(before, [0, 0, 0], '未应用前全都没动');
  B.receive(move);
  const after = [id1, id2, id3].map((id) => B.getObject(id).props.transform.tx);
  assert.deepStrictEqual(after, [30, 30, 30], '应用后全部移动');
});

test('事务原子：粘贴多个元素为一个 batch，整组撤销/重做', () => {
  const A = new CollabStore('A');
  const ed = new Editor(A);
  const objs = [1, 2, 3, 4].map((i) => ({ id: newObjectId(), kind: 'note', props: { geom: { x: i, y: i, w: 1, h: 1 }, note: { content: '', color: '#fff' } } }));
  const paste = ed.paste(objs);
  assert.strictEqual(paste.ops.length, 4);
  assert.strictEqual(A.listObjects().length, 4);
  ed.undo(paste.batchId);
  assert.strictEqual(A.listObjects().length, 0, '整组撤销');
  ed.redo(paste.batchId);
  assert.strictEqual(A.listObjects().length, 4, '整组重做');
});

/* ----------------------------- 因果顺序 / 乱序 ----------------------------- */

test('因果缓冲：deps 未满足的 batch 被缓冲，缺口补齐后自动冲刷', () => {
  const A = new CollabStore('A');
  const B = new CollabStore('B');
  const edA = new Editor(A);
  const edB = new Editor(B);

  const b1 = edA.addShape('rect', { x: 0, y: 0, w: 1, h: 1 });
  const id = b1.ops[0].objectId;
  // B 先基于 b1 做一个操作
  B.receive(b1);
  const b2 = edB.move([id], 5, 5); // B:1（依赖 A:1）
  const b3 = edB.transact([{ type: 'update', objectId: id, values: { color: 'z' } }]); // B:2（依赖 B:1）
  // 先给 A 投 b3（依赖 B:2=b2，尚未见到）→ 必须缓冲
  const r3 = A.receive(b3);
  assert.strictEqual(r3.buffered, true, '依赖未满足，b3 必须缓冲');
  assert.strictEqual(prop(A, id, 'color'), undefined, '缓冲期间不生效');
  A.receive(b2); // 补齐缺口
  assert.strictEqual(prop(A, id, 'color'), 'z', '缺口补齐后缓冲 batch 自动冲刷');
  assert.strictEqual(A.pendingGaps().length, 0);
});

test('因果缓冲：同一 client 的 clientSeq 空洞等待补齐，不乱序应用', () => {
  const A = new CollabStore('A');
  const B = new CollabStore('B');
  const edB = new Editor(B);
  const b1 = edB.addShape('rect', { x: 0, y: 0, w: 1, h: 1 });
  const id = b1.ops[0].objectId;
  const b2 = edB.move([id], 1, 1);
  // A 只收到 b1，然后“丢失 b2”，收到 b3
  A.receive(b1);
  const b3 = edB.move([id], 2, 2);
  assert.strictEqual(A.receive(b3).buffered, true);
  assert.strictEqual(A.getObject(id).props.transform.tx, 0);
  A.receive(b2);
  assert.strictEqual(A.getObject(id).props.transform.tx, 3, '按序应用后 tx=3');
});

/* ----------------------------- 验收场景 4：压感 ----------------------------- */

test('场景4：压感/速度变宽是点数据的确定性函数，两端逐点宽度一致', () => {
  const pts = [];
  for (let i = 0; i < 20; i++) {
    pts.push(makePoint(i * 3, Math.sin(i / 3) * 10, 0.2 + 0.6 * Math.abs(Math.sin(i / 2)), i * 16, 0.1 * (i % 5), 0));
  }
  const w1 = computeStrokeWidths(pts, 6, { pressureFactor: 0.7, speedFactor: 0.4 });
  const w2 = computeStrokeWidths(pts, 6, { pressureFactor: 0.7, speedFactor: 0.4 });
  assert.strictEqual(w1.length, pts.length);
  assert.deepStrictEqual(w1, w2, '相同输入两次计算完全相同');

  // 压感大的点比压感小的点宽（低速、同速条件下）
  const slow = [makePoint(0, 0, 0.1, 0), makePoint(1, 0, 0.1, 100), makePoint(2, 0, 0.1, 200)];
  const hard = slow.map((p) => ({ ...p, p: 0.95 }));
  const wSoft = computeStrokeWidths(slow, 10, { pressureFactor: 0.8, speedFactor: 0 })[1];
  const wHard = computeStrokeWidths(hard, 10, { pressureFactor: 0.8, speedFactor: 0 })[1];
  assert.ok(wHard > wSoft * 1.3, `重压(${wHard.toFixed(2)}) 应明显宽于轻压(${wSoft.toFixed(2)})`);

  // 速度越快越细
  const pSlow = [makePoint(0, 0, 0.5, 0), makePoint(1, 0, 0.5, 100), makePoint(2, 0, 0.5, 200)];
  const pFast = [makePoint(0, 0, 0.5, 0), makePoint(50, 0, 0.5, 5), makePoint(100, 0, 0.5, 10)];
  const ws = computeStrokeWidths(pSlow, 10, { pressureFactor: 0, speedFactor: 0.6 })[1];
  const wf = computeStrokeWidths(pFast, 10, { pressureFactor: 0, speedFactor: 0.6 })[1];
  assert.ok(wf < ws, `快速(${wf.toFixed(2)}) 应细于慢速(${ws.toFixed(2)})`);
});

test('RDP 简化减少点数且保留首末；Catmull-Rom/B 样条输出更密的平滑点', () => {
  const pts = [];
  for (let i = 0; i <= 50; i++) pts.push(makePoint(i, i % 2 ? 0.5 : 0, i * 10));
  const simp = rdp(pts, 1);
  assert.ok(simp.length < pts.length, `RDP 应减少点数 ${simp.length} < ${pts.length}`);
  assert.strictEqual(simp[0], pts[0]);
  assert.strictEqual(simp[simp.length - 1], pts[pts.length - 1]);
  const cr = catmullRomPath(simp, 8);
  const bs = bSplinePath(simp, 8);
  assert.ok(cr.length >= simp.length, 'Catmull-Rom 重采样点不少于输入');
  assert.ok(bs.length >= simp.length, 'B 样条重采样点不少于输入');
});

/* ------------------------ 验收场景 5：橡皮擦分块、隔离擦除 ------------------------ */

test('场景5：像素擦除分块传输，最终只有一个原子 batch；两端标记集合一致；整笔擦除后标记失效', () => {
  const A = new CollabStore('A');
  const B = new CollabStore('B');
  const edA = new Editor(A);
  const stroke = edA.addStroke({ points: [makePoint(0, 0, 0.5, 1), makePoint(100, 100, 0.6, 10)], width: 4 });
  const id = stroke.ops[0].objectId;
  B.receive(stroke);

  // 一次橡皮手势切成 3 个传输块，但 finalBatch 是唯一进 CRDT 的原子 batch
  const marks = [0, 1, 2].map((c) => eraseMark({
    strokeId: id,
    points: [makePoint(c * 20, c * 20), makePoint(c * 20 + 5, c * 20 + 5)],
    chunkSeq: c,
    width: 10
  }));
  const { finalBatch, chunks, group } = edA.chunkErase(id, marks, 1);
  assert.strictEqual(chunks.length, 3, '切为 3 个传输块');
  assert.strictEqual(chunks[0].chunkGroupId, group);
  assert.strictEqual(finalBatch.ops.length, 1, '内核里只有 1 个原子 erase batch');
  assert.strictEqual(finalBatch.ops[0].marks.length, 3);

  // 传输块乱序/延迟不影响内核：B 只在收到 finalBatch 时原子应用
  assert.strictEqual(B.marksForStroke(id).length, 0, '只收到分块帧（预览）不进入 CRDT');
  B.receive(finalBatch);
  assert.strictEqual(A.marksForStroke(id).length, 3);
  assert.strictEqual(B.marksForStroke(id).length, 3);
  const aIds = A.marksForStroke(id).map((m) => m.id).sort();
  const bIds = B.marksForStroke(id).map((m) => m.id).sort();
  assert.deepStrictEqual(aIds, bIds, '两端擦除标记一致');

  // 幂等：重复投递不增加
  B.receive(finalBatch);
  assert.strictEqual(B.marksForStroke(id).length, 3);

  // 整笔擦除后，像素标记不再生效
  const del = edA.eraseObjects([id]);
  B.receive(del);
  assert.strictEqual(B.marksForStroke(id).length, 0, '整笔删除后像素标记失效');
});

test('擦除标记带 cells 网格提示（增量重绘不全量）', () => {
  const m = eraseMark({
    strokeId: 's1',
    points: [makePoint(10, 10), makePoint(200, 200)],
    chunkSeq: 0,
    width: 12
  });
  assert.ok(m.cells.length > 1, `跨多个网格块，实际 ${m.cells.length}`);
});

test('撤销像素擦除整组恢复笔迹内容', () => {
  const A = new CollabStore('A');
  const ed = new Editor(A);
  const stroke = ed.addStroke({ points: [makePoint(0, 0, 0.5, 1), makePoint(100, 100, 0.6, 10)], width: 4 });
  const id = stroke.ops[0].objectId;
  const er = ed.erasePixels(id, [eraseMark({ strokeId: id, points: [makePoint(10, 10), makePoint(20, 20)], chunkSeq: 0, width: 10 })]);
  assert.strictEqual(A.marksForStroke(id).length, 1);
  ed.undo(er.batchId);
  assert.strictEqual(A.marksForStroke(id).length, 0, '撤销擦除 → 洞恢复');
  ed.redo(er.batchId);
  assert.strictEqual(A.marksForStroke(id).length, 1);
});

/* ------------------------------- 压缩 ------------------------------- */

test('操作压缩：连续移动通过 replaces 原子替换中间帧，最终状态正确', () => {
  const A = new CollabStore('A');
  const B = new CollabStore('B');
  const ed = new Editor(A);
  const create = ed.addShape('rect', { x: 0, y: 0, w: 10, h: 10 });
  const id = create.ops[0].objectId;
  B.receive(create);

  // 手势：起点 transform=(0,0)，连续 100 帧，每帧给出“相对起点的总位置”
  const start = { tx: 0, ty: 0, sx: 1, sy: 1, angle: 0 };
  let last = null;
  for (let i = 1; i <= 100; i++) {
    const r = ed.moveCoalesced(id, i, 0, start);
    last = r.batch;
    if (i % 7 === 0) B.receive(r.batch); // B 偶尔收到中间帧
  }
  B.receive(last); // 最终帧
  assert.strictEqual(A.getObject(id).props.transform.tx, 100);
  assert.strictEqual(B.getObject(id).props.transform.tx, 100, 'B 最终也是 100');
});

test('压缩：只收到最终帧（中间帧被服务端丢弃）也能因果通过（replaces 跳洞）', () => {
  const A = new CollabStore('A');
  const B = new CollabStore('B');
  const ed = new Editor(A);
  const create = ed.addShape('rect', { x: 0, y: 0, w: 1, h: 1 });
  const id = create.ops[0].objectId;
  B.receive(create);
  const start = { tx: 0, ty: 0, sx: 1, sy: 1, angle: 0 };
  ed.moveCoalesced(id, 1, 0, start); // 中间帧（B 永远收不到）
  ed.moveCoalesced(id, 2, 0, start);
  const finalM = ed.moveCoalesced(id, 3, 0, start); // 最终帧 replaces 前一帧
  assert.strictEqual(finalM.batch.clientSeq, 4);
  const r = B.receive(finalM.batch); // 只收到 seq=4
  assert.strictEqual(r.buffered, false, 'replaces 允许跳过压缩中间帧空洞');
  assert.strictEqual(B.getObject(id).props.transform.tx, 3);
});

/* ------------------------------- 图层 / 组 ------------------------------- */

test('图层：reorder 调整 z 序，两端顺序一致', () => {
  const A = new CollabStore('A');
  const B = new CollabStore('B');
  const ed = new Editor(A);
  const s1 = ed.addShape('rect', { x: 0, y: 0, w: 1, h: 1 });
  const s2 = ed.addShape('rect', { x: 0, y: 0, w: 1, h: 1 });
  [s1, s2].forEach((b) => B.receive(b));
  const id1 = s1.ops[0].objectId;
  ed.bringToFront(id1); // 会发 reorder
  // 同步所有 batch
  for (const b of A.ownHistory()) {
    if (!B.applied.has(b.batchId) && b.ops.length) B.receive(b);
  }
  const orderA = A.listObjects().map((o) => o.id);
  const orderB = B.listObjects().map((o) => o.id);
  assert.deepStrictEqual(orderA, orderB);
  assert.strictEqual(orderA[orderA.length - 1], id1, 's1 置顶');
});

test('组/解组：建组是原子 batch，成员集合 LWW；解组保留成员', () => {
  const A = new CollabStore('A');
  const ed = new Editor(A);
  const s1 = ed.addShape('rect', { x: 0, y: 0, w: 1, h: 1 });
  const s2 = ed.addShape('rect', { x: 0, y: 0, w: 1, h: 1 });
  const id1 = s1.ops[0].objectId, id2 = s2.ops[0].objectId;
  const g = ed.group([id1, id2]);
  assert.strictEqual(g.ops.length, 1, 'group 是单个 group op 的原子 batch');
  assert.strictEqual(g.ops[0].type, 'group');
  const gid = g.ops[0].objectId;
  const members = A.groupMembers(gid).sort();
  assert.deepStrictEqual(members, [id1, id2].sort());
  ed.ungroup(gid);
  assert.strictEqual(A.groupMembers(gid).length, 0, '解组后无成员');
  assert.strictEqual(A.getObject(id1).alive, true, '成员对象保留');
  assert.strictEqual(A.getObject(id2).alive, true);
});

/* ------------------------------- 快照 ------------------------------- */

test('快照：新成员装载快照后状态与老成员一致，且能继续接收增量', () => {
  const A = new CollabStore('A');
  const edA = new Editor(A);
  for (let i = 0; i < 5; i++) edA.addShape('rect', { x: i, y: 0, w: 1, h: 1 });
  const snap = A.snapshot();

  const C = new CollabStore('C');
  C.loadSnapshot(snap);
  assert.strictEqual(C.listObjects().length, 5);

  // 快照后 A 又有新操作，C 增量接收
  const next = edA.addShape('ellipse', { x: 0, y: 0, w: 1, h: 1 });
  C.receive(next);
  assert.strictEqual(C.listObjects().length, 6);
});

test('撤销/重做 epoch 是 LWW：重复/乱序的 undo 消息结果一致', () => {
  const A = new CollabStore('A');
  const B = new CollabStore('B');
  const edA = new Editor(A);
  const s = edA.addShape('rect', { x: 0, y: 0, w: 1, h: 1 });
  B.receive(s);
  const id = s.ops[0].objectId;
  const u = edA.undoLast();
  // B 收到两次 undo（重复投递）
  B.receive(u);
  B.receive(u);
  assert.strictEqual(B.getObject(id).alive, false);
});

/* ------------------------------- 操作类型覆盖 ------------------------------- */

test('操作类型覆盖：图形/文本/便签/图片/旋转/缩放 均可建可同步', () => {
  const A = new CollabStore('A');
  const B = new CollabStore('B');
  const ed = new Editor(A);
  const shape = ed.addShape('diamond', { x: 0, y: 0, w: 10, h: 10 });
  const text = ed.addText(1, 2, 'hello');
  const note = ed.addNote(0, 0, 10, 10, 'n');
  const img = ed.addImage(0, 0, 10, 10, 'data:,');
  const id = shape.ops[0].objectId;
  for (const b of [shape, text, note, img]) B.receive(b);
  assert.strictEqual(B.listObjects().length, 4);
  const rot = ed.rotate(id, Math.PI / 2);
  B.receive(rot);
  assert.ok(Math.abs(B.getObject(id).props.transform.angle - Math.PI / 2) < 1e-9);
  const scale = ed.scaleCoalesced(id, { tx: 0, ty: 0, sx: 2, sy: 2, angle: 0.2 });
  B.receive(scale.batch);
  assert.strictEqual(B.getObject(id).props.transform.sx, 2);
});

  return { passed, failed };
}

export { passed, failed };
