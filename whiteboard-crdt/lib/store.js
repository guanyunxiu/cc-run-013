'use strict';

/**
 * CollabStore —— 白板协作 CRDT 内核（纯 JS，浏览器 / Node 同构）。
 *
 * 冲突模型（为什么不靠服务端 seq 排冲突）：
 *  - 每个可写字段是一个 LWW 寄存器：同 key 的多次写按 (Lamport clock, clientId)
 *    全序决胜，顺序与消息到达顺序无关 → 任意投递顺序、任意副本，最终状态一致。
 *  - batch 之间用 deps 依赖向量 + clientSeq 做因果定序：因果未满足的 batch 进
 *    缓冲区，等缺口补齐再应用（乱序/丢包/重连补洞都能收敛）。
 *  - 删除不是“抹掉历史”，而是特殊 key __alive 的 LWW 写（tombstone）。
 *  - 每个字段保留自己的写入历史（LWW entries，附 epoch），这是“选择性撤销”
 *    不破坏他人后续操作的关键：撤销 = 把自己那个 batch 的写标记为 inactive，
 *    然后重新求 LWW；他人后续写天然胜出；若字段上已无活跃写，则回退到撤销前
 *    的上一个活跃值（可能是更早的自己，也可能是别人）。
 *  - 撤销/重做本身也是一个被复制的 batch（undoOf + active），epoch 也是 LWW，
 *    多端重复撤销/重做结果一致；只能撤销自己的 batch。
 *  - 对象“复活”规则（acceptance #2 的核心）：创建被自己撤销时，若其他客户端
 *    已经在该对象上留下过有效写（move/改色/…），对象保持存活，不抹掉别人结果。
 *
 * 原子性：一个 batch 的 ops[] 整体缓冲、整体应用、整体撤销。
 * 压缩：本地连续 move/scale/rotate 用 coalesceKey + replaces 原子替换未确认 batch；
 *       服务端日志也可对已确认的连续同 key batch 做 coalesceLog（见 server.js）。
 */

import { LamportClock, mergeVV, orderKey } from './clock.js';
import { makeBatch, makeUndoBatch } from './batch.js';

const ALIVE = '__alive';

export class CollabStore {
  /**
   * @param clientId 本客户端 ID
   * @param opts.onChange 状态变化回调（参数 {batch, local, changed})
   */
  constructor(clientId, opts = {}) {
    this.clientId = clientId;
    this.clock = new LamportClock(0);
    this.vv = Object.create(null);   // clientId -> 已应用的最大 clientSeq
    this.clientSeq = 0;              // 本客户端已发出的最大 seq

    this.applied = new Map();        // batchId -> batch（含 undo batches）
    this.buffer = new Map();         // 因果未满足：batchId -> batch
    this.byClient = new Map();       // clientId -> Map(seq -> batchId)，补洞用

    // objId -> { kind, creator, props: Map(key -> [{key,val,stamp,batchId,clientId,epoch}]) }
    this.objects = new Map();
    this.creators = new Map();       // objId -> creatorClientId
    // eraseMarkId -> { mark, batchId, clientId, epoch, objId(strokeId) }
    this.marks = new Map();
    // undo 目标 batchId -> { stamp, active }（epoch 是 LWW）
    this.epochs = new Map();

    this.onChange = opts.onChange || null;
  }

  /* ============================ 本地产生 batch ============================ */

  /**
   * 本地提交一个操作组（事务）。
   * @returns 已应用的 batch（同时推进本地时钟/向量），调用方负责发送给服务端
   */
  commit(ops, opts = {}) {
    const clientSeq = this.clientSeq + 1;
    const clock = this.clock.tick();
    this.clientSeq = clientSeq;
    const b = makeBatch({
      clientId: this.clientId,
      clientSeq,
      clock,
      deps: { ...this.vv, [this.clientId]: clientSeq },
      ops,
      tx: opts.tx,
      coalesceKey: opts.coalesceKey || null,
      replaces: opts.replaces || null
    });
    this._apply(b, true);
    return b;
  }

  /**
   * 本地连续操作压缩：以新 batch 原子替换上一个“未确认、同 coalesceKey”的本地 batch。
   * 典型：pointermove 每 30ms 一帧 move，pointerup 才出最终 batch。
   * @returns {{batch, replaced} | {batch, replaced:null}}
   */
  commitCoalesced(ops, coalesceKey) {
    const pending = this._findCoalescable(coalesceKey);
    const batch = this.commit(ops, {
      coalesceKey,
      replaces: pending ? pending.batchId : null
    });
    return { batch, replaced: pending ? pending.batchId : null };
  }

  _findCoalescable(key) {
    for (let i = this.clientSeq; i >= 1; i--) {
      const id = `${this.clientId}:${i}`;
      const b = this.applied.get(id);
      if (!b) continue;
      if (b.undoOf) return null; // 中间夹过撤销，不再压缩
      if (b.coalesceKey === key) return b;
      return null; // 只压缩紧邻的同 key batch
    }
    return null;
  }

  /**
   * 选择性撤销。
   * @param targetBatchId 要撤销的 batch；必须是自己产生的，否则抛错（不能撤别人）
   * @returns undo batch
   */
  undo(targetBatchId) {
    const target = this.applied.get(targetBatchId);
    if (!target) throw new Error(`unknown batch: ${targetBatchId}`);
    if (target.clientId !== this.clientId) {
      throw new Error('can only undo your own operations');
    }
    const cur = this.epochs.get(targetBatchId);
    if (cur && !cur.active) throw new Error('already undone');
    return this._toggleEpoch(targetBatchId, false);
  }

  /** 重做（同样只能对自己的 batch） */
  redo(targetBatchId) {
    const target = this.applied.get(targetBatchId);
    if (!target) throw new Error(`unknown batch: ${targetBatchId}`);
    if (target.clientId !== this.clientId) throw new Error('can only redo your own operations');
    const cur = this.epochs.get(targetBatchId);
    if (!cur || cur.active) throw new Error('not undone');
    return this._toggleEpoch(targetBatchId, true);
  }

  /** 撤销“最近一个自己的、仍活跃的内容 batch” */
  undoLast() {
    const list = this.ownHistory();
    const last = list.find((b) => this.isActive(b.batchId));
    if (!last) return null;
    return this.undo(last.batchId);
  }

  redoLast() {
    // 取最近一个把自己内容 batch 置为 inactive 的 undo batch
    const undos = [];
    for (const b of this.applied.values()) {
      if (b.clientId === this.clientId && b.undoOf && !b.active && !b.snapshot) undos.push(b);
    }
    undos.sort((a, b) => b.clientSeq - a.clientSeq);
    const last = undos.find((b) => {
      const t = this.applied.get(b.undoOf);
      return t && t.clientId === this.clientId;
    });
    return last ? this.redo(last.undoOf) : null;
  }

  _toggleEpoch(targetBatchId, active) {
    const clientSeq = this.clientSeq + 1;
    const clock = this.clock.tick();
    this.clientSeq = clientSeq;
    const b = makeUndoBatch({
      clientId: this.clientId,
      clientSeq,
      clock,
      deps: { ...this.vv, [this.clientId]: clientSeq },
      targetBatchId,
      active
    });
    this._apply(b, true);
    return b;
  }

  /** 自己的内容 batch，按时间倒序（供撤销面板做“选择性撤销”） */
  ownHistory() {
    const out = [];
    for (const b of this.applied.values()) {
      if (b.clientId === this.clientId && !b.undoOf && !b.snapshot && Array.isArray(b.ops) && b.ops.length) {
        out.push(this._withActive(b));
      }
    }
    out.sort((a, b) => b.clientSeq - a.clientSeq);
    return out;
  }

  _withActive(b) {
    const e = this.epochs.get(b.batchId);
    return { ...b, active: e ? e.active : true };
  }

  isActive(batchId) {
    const e = this.epochs.get(batchId);
    return e ? e.active : true;
  }

  /* ============================ 远端 batch 入口 =========================== */

  /**
   * 接收（来自服务端广播/sync 的）一个 batch。
   * 因果未满足 → 缓冲；满足 → 应用，并尝试冲刷缓冲区（可能连锁释放）。
   * @returns {buffered:boolean}
   */
  receive(batch) {
    if (this.applied.has(batch.batchId) || this.buffer.has(batch.batchId)) {
      return { buffered: false, duplicate: true };
    }
    // 已包含在快照里的旧 batch（vv 已越过）直接跳过，不进缓冲
    if ((this.vv[batch.clientId] || 0) >= batch.clientSeq) {
      return { buffered: false, duplicate: true };
    }
    const check = this._causalCheck(batch);
    if (!check.ready) {
      this.buffer.set(batch.batchId, batch);
      return { buffered: true, missing: check.missing };
    }
    this._apply(batch, false);
    this._flushBuffer();
    return { buffered: false };
  }

  /** 批量接收（sync 快照之后的补漏日志等） */
  receiveMany(batches) {
    let buffered = 0;
    const sorted = batches.slice().sort((a, b) =>
      (a.clientId === b.clientId)
        ? a.clientSeq - b.clientSeq
        : 0
    );
    for (const b of sorted) {
      if (this.receive(b).buffered) buffered++;
    }
    return { buffered };
  }

  /**
   * 因果就绪判定：
   *  - deps 里其他 client 的位置必须已见；
   *  - 同一 client 的 seq 必须连续，但「压缩替换」允许跳过被 replaces 的中间帧
   *    （中间帧可能已被服务端丢弃，对端从未见过）。
   */
  _causalCheck(batch) {
    for (const [client, need] of Object.entries(batch.deps || {})) {
      if (client === batch.clientId) continue;
      const have = this.vv[client] || 0;
      if (have < need) return { ready: false, missing: { client, need, have } };
    }
    const haveSender = this.vv[batch.clientId] || 0;
    if (batch.clientSeq !== haveSender + 1) {
      if (batch.replaces && this._isRetractableGap(batch.clientId, haveSender, batch.clientSeq, batch.replaces)) {
        return { ready: true };
      }
      return { ready: false, missing: { client: batch.clientId, need: batch.clientSeq, have: haveSender } };
    }
    return { ready: true };
  }

  _isRetractableGap(clientId, have, targetSeq, replacesId) {
    // replaces 指向缺口中的某个同作者中间帧（该帧已被压缩，服务端日志可能丢弃）。
    // 信任 batch.deps（由提交者基于其真实已见向量生成）：只要 replaces 指向的
    // 帧落在 (have, targetSeq) 缺口中，就允许跳过中间压缩帧。
    if (!replacesId || !replacesId.startsWith(`${clientId}:`)) return false;
    const repSeq = Number(replacesId.split(':')[1]);
    return Number.isInteger(repSeq) && repSeq > have && repSeq < targetSeq;
  }

  _flushBuffer() {
    let progressed = true;
    let guard = 0;
    while (progressed && guard++ < 100000) {
      progressed = false;
      for (const [id, b] of this.buffer) {
        const check = this._causalCheck(b);
        if (check.ready) {
          this.buffer.delete(id);
          this._apply(b, false);
          progressed = true;
        }
      }
    }
  }

  /** 因果缺口：当前缓冲但无法投递的 batch（调试/状态展示用） */
  pendingGaps() {
    const gaps = [];
    for (const b of this.buffer.values()) {
      const check = this._causalCheck(b);
      if (!check.ready) gaps.push({ batchId: b.batchId, missing: check.missing });
    }
    return gaps;
  }

  /* ============================== 应用一个 batch ========================== */

  _apply(batch, local) {
    if (this.applied.has(batch.batchId)) return;

    // 压缩替换：原子撤回被替换的旧 batch（连续 move 的中间帧）
    if (batch.replaces) this._retract(batch.replaces, batch);

    this.applied.set(batch.batchId, batch);
    let seqMap = this.byClient.get(batch.clientId);
    if (!seqMap) { seqMap = new Map(); this.byClient.set(batch.clientId, seqMap); }
    seqMap.set(batch.clientSeq, batch.batchId);

    this.clock.observe(batch.clock);
    this.clock.tick();
    if (!local) {
      // 远端/缓冲路径：用 batch 推进向量
      this.vv[batch.clientId] = Math.max(this.vv[batch.clientId] || 0, batch.clientSeq);
    }
    // 本地路径：clientSeq 由 commit() 负责，deps 补齐他人位置
    mergeVV(this.vv, batch.deps);

    const changed = { objects: new Set(), marks: new Set(), epochs: new Set() };

    if (batch.undoOf) {
      // 撤销/重做：epoch 寄存器 LWW
      const stamp = orderKey(batch.clock, batch.clientId);
      const cur = this.epochs.get(batch.undoOf);
      if (!cur || stamp > cur.stamp) {
        this.epochs.set(batch.undoOf, { stamp, active: batch.active, by: batch.clientId });
        changed.epochs.add(batch.undoOf);
        // 该 batch 影响的所有对象/笔迹标记都要重算
        const tgt = this.applied.get(batch.undoOf);
        if (tgt) {
          for (const op of tgt.ops) {
            if (op.objectId) changed.objects.add(op.objectId);
            if (op.type === 'erase') op.marks.forEach((m) => changed.marks.add(m.id));
          }
        }
      }
    } else {
      for (const op of batch.ops) this._applyOp(op, batch, changed);
    }

    if (this.onChange) this.onChange({ batch, local, changed });
  }

  _applyOp(op, batch, changed) {
    const stamp = orderKey(batch.clock, batch.clientId);
    switch (op.type) {
      case 'create': {
        let rec = this.objects.get(op.objectId);
        if (!rec) {
          rec = { kind: op.object.kind, creator: batch.clientId, props: new Map() };
          this.objects.set(op.objectId, rec);
          this.creators.set(op.objectId, batch.clientId);
        }
        this._write(rec, ALIVE, true, stamp, batch);
        for (const [k, v] of Object.entries(op.object.props || {})) {
          this._write(rec, k, v, stamp, batch);
        }
        changed.objects.add(op.objectId);
        break;
      }
      case 'update': {
        const rec = this._ensure(op.objectId, batch, 'obj');
        for (const [k, v] of Object.entries(op.values)) {
          this._write(rec, k, v, stamp, batch);
        }
        changed.objects.add(op.objectId);
        break;
      }
      case 'delete': {
        const rec = this._ensure(op.objectId, batch, 'obj');
        this._write(rec, ALIVE, false, stamp, batch);
        changed.objects.add(op.objectId);
        break;
      }
      case 'reorder': {
        const rec = this._ensure(op.objectId, batch, 'obj');
        this._write(rec, '__z', op.z, stamp, batch);
        changed.objects.add(op.objectId);
        break;
      }
      case 'group': {
        // 建组：创建 group 对象（__member:<id> 的 LWW 寄存器集合）
        let rec = this.objects.get(op.objectId);
        if (!rec) {
          rec = { kind: 'group', creator: batch.clientId, props: new Map() };
          this.objects.set(op.objectId, rec);
          this.creators.set(op.objectId, batch.clientId);
        }
        this._write(rec, ALIVE, true, stamp, batch);
        for (const id of op.members || []) {
          this._write(rec, `__member:${id}`, true, stamp, batch);
        }
        changed.objects.add(op.objectId);
        break;
      }
      case 'ungroup': {
        // 解组：原子地清空全部成员寄存器（LWW 写 false）。
        // 组对象保留为“空组”（可审计/可撤销重做），成员对象本身不受影响。
        const rec = this.objects.get(op.objectId);
        if (rec) {
          for (const key of rec.props.keys()) {
            if (key.startsWith('__member:')) this._write(rec, key, false, stamp, batch);
          }
          changed.objects.add(op.objectId);
        }
        break;
      }
      case 'erase': {
        for (const m of op.marks) {
          if (this.marks.has(m.id)) continue; // 幂等（分块重传）
          this.marks.set(m.id, {
            mark: m,
            strokeId: op.objectId || m.strokeId,
            batchId: batch.batchId,
            clientId: batch.clientId
          });
          changed.marks.add(m.id);
          if (op.objectId || m.strokeId) changed.objects.add(op.objectId || m.strokeId);
        }
        break;
      }
      default:
        break;
    }
  }

  _ensure(objectId, batch) {
    let rec = this.objects.get(objectId);
    if (!rec) {
      // 对一个尚未见到 create 的对象做 update（快照之后洞补齐前的极端乱序）：
      // 建一个空壳，等 create 到达后字段自然合并（CRDT 允许任意顺序）。
      rec = { kind: 'unknown', creator: batch.clientId, props: new Map() };
      this.objects.set(objectId, rec);
    }
    return rec;
  }

  _write(rec, key, val, stamp, batch) {
    let entries = rec.props.get(key);
    if (!entries) { entries = []; rec.props.set(key, entries); }
    // 同一 batch 内对同一 key 多次写：后者覆盖（罕见，事务内允许）
    const sameBatch = entries.findIndex((e) => e.batchId === batch.batchId);
    const entry = { val, stamp, batchId: batch.batchId, clientId: batch.clientId };
    if (sameBatch >= 0) entries[sameBatch] = entry;
    else entries.push(entry);
  }

  /** 某条写记录当前是否活跃（epochs 是唯一真源，撤销/重做即时反映） */
  _entryActive(entry) {
    const e = this.epochs.get(entry.batchId);
    return e ? e.active : true;
  }

  /** 原子撤回（压缩 replaces）：移除旧 batch 引入的 entries/marks */
  _retract(oldBatchId, _newBatch) {
    const old = this.applied.get(oldBatchId);
    if (!old || old.clientId !== this.clientId) return;
    const markIds = new Set();
    for (const op of old.ops) {
      if (op.type === 'erase') op.marks.forEach((m) => markIds.add(m.id));
      const rec = this.objects.get(op.objectId);
      if (!rec) continue;
      for (const [key, entries] of [...rec.props]) {
        const kept = entries.filter((e) => e.batchId !== oldBatchId);
        if (kept.length === 0) rec.props.delete(key);
        else rec.props.set(key, kept);
      }
    }
    for (const id of markIds) this.marks.delete(id);
    // 本地压缩路径：新 batch 紧接着在 commit() 里占住 clientSeq，
    // 这里先把“旧帧占用的一格”退回，使新 batch 与旧帧序号连续（seq 复用旧位置）。
    if (old.clientId === this.clientId && old.clientSeq === this.clientSeq) {
      this.clientSeq = old.clientSeq - 1;
      this.vv[this.clientId] = this.clientSeq;
    }
    this.applied.delete(oldBatchId);
  }

  /* ============================== 状态物化（读模型） ====================== */

  /** 某个 key 当前生效的 LWW entry（epoch 过滤 + stamp 决胜） */
  _activeEntry(entries) {
    let best = null;
    for (const e of entries) {
      if (!this._entryActive(e)) continue; // 所属 batch 已被撤销
      if (!best || e.stamp > best.stamp) best = e;
    }
    return best;
  }

  /**
   * 求对象当前属性 + 存活状态。
   *
   * 复活规则（selective undo 不破坏他人结果）：
   *  - 常规：__alive 的活跃 LWW 决定死活；没有任何 __alive 写则存活（空壳等 create）。
   *  - 当 create / delete 被作者自己撤销，导致对象“本应消失”，但存在“他人”
   *    在该对象上的任意活跃写（move/改色/几何…），对象保持存活；缺少的字段
   *    从被撤销写的最新值恢复（别人操作时对象还是完整的）。
   *  - 他人显式 delete 仍按 LWW 正常删除，不会被误复活。
   */
  getObject(id) {
    const rec = this.objects.get(id);
    if (!rec) return null;
    const creator = this.creators.get(id) || rec.creator;
    const props = {};
    let aliveEntry = null;
    let foreignTouch = false;

    for (const [key, entries] of rec.props) {
      if (key === ALIVE) {
        aliveEntry = this._activeEntry(entries);
        continue;
      }
      const active = this._activeEntry(entries);
      if (active) {
        props[key] = active.val;
        // 保护性复活只看“业务字段”上的他人写；
        // __member:/__z 等内部寄存器（如他人把对象加进组）不应单独让一个被删对象复活。
        const internal = key.startsWith('__');
        if (!internal && active.clientId !== creator) foreignTouch = true;
      }
    }

    const aliveEntries = rec.props.get(ALIVE) || [];
    let alive;
    if (!aliveEntry) {
      // 无任何活跃 __alive 写：
      //  - 从没见过 create（空壳，等 create 到达）→ 视为存活
      //  - 存在（被撤销的）__alive:true（create 被作者自己撤销）→ 死亡，除非有他人有效写
      const hadCreate = aliveEntries.some((e) => e.val === true);
      alive = !hadCreate;
    } else {
      alive = aliveEntry.val === true;
    }

    // 当对象“按 __alive 寄存器本应不存活”时，检查是否需要保护性复活：
    //  - 自己撤销了 create，或自己 delete 后撤回删除；
    //  - 但存在“他人”留下的活跃写（move/改色/几何…），说明别人在你操作之前/期间
    //    已经基于该对象做了事，撤销不能抹掉别人的结果。
    // 他人显式 delete 的活跃 __alive:false 不触发复活。
    if (!alive) {
      const ownTombstone = aliveEntry && aliveEntry.val === false && aliveEntry.clientId === creator;
      const createUndone = !aliveEntry && aliveEntries.some(
        (e) => e.val === true && e.clientId === creator && !this._entryActive(e)
      );
      if ((ownTombstone || createUndone) && foreignTouch) {
        alive = true;
        for (const [key, entries] of rec.props) {
          if (key === ALIVE || key in props) continue;
          // 字段在复活对象上缺失：优先恢复最近的【活跃】写（撤销自己的移动后
          // 回到移动前的值，而不是被撤销的最新值）；没有则退回最新值兜底。
          let bestActive = null;
          let latestAny = null;
          for (const e of entries) {
            if (!latestAny || e.stamp > latestAny.stamp) latestAny = e;
            if (this._entryActive(e) && (!bestActive || e.stamp > bestActive.stamp)) bestActive = e;
          }
          props[key] = (bestActive || latestAny).val;
        }
      }
    }

    return { id, kind: rec.kind, creator, alive, props, foreignTouch };
  }

  /** 当前全部存活对象，按图层序（__z fractional index；无 z 用最早写 stamp 兜底） */
  listObjects() {
    const out = [];
    for (const id of this.objects.keys()) {
      const o = this.getObject(id);
      if (o && o.alive) out.push(o);
    }
    out.sort((a, b) => (this._zOf(a) > this._zOf(b) ? 1 : -1) || a.id.localeCompare(b.id));
    return out;
  }

  _zOf(o) {
    const v = o.props.__z;
    if (typeof v === 'string') return v;
    // 无显式图层：用对象最早写 stamp 兜底（稳定、两端一致）
    const rec = this.objects.get(o.id);
    let min = null;
    for (const entries of rec.props.values()) {
      for (const e of entries) {
        if (min === null || e.stamp < min) min = e.stamp;
      }
    }
    return min || '';
  }

  /** 组成员（存活的） */
  groupMembers(groupId) {
    const g = this.getObject(groupId);
    if (!g || g.kind !== 'group') return [];
    const ids = [];
    for (const [k, v] of Object.entries(g.props)) {
      if (k.startsWith('__member:') && v === true) ids.push(k.slice('__member:'.length));
    }
    return ids.filter((id) => {
      const o = this.getObject(id);
      return o && o.alive;
    });
  }

  /** 某笔迹上当前有效的像素擦除标记（分块同步，按 chunkSeq 排序，两端顺序一致） */
  marksForStroke(strokeId) {
    const out = [];
    for (const m of this.marks.values()) {
      if (m.strokeId !== strokeId || !this._entryActive({ batchId: m.batchId })) continue;
      const o = this.getObject(strokeId);
      if (o && !o.alive) continue; // 整笔擦除/删除后像素标记不生效
      out.push(m);
    }
    out.sort((a, b) =>
      (a.mark.chunkSeq ?? 0) - (b.mark.chunkSeq ?? 0) ||
      a.mark.id.localeCompare(b.mark.id));
    return out.map((m) => m.mark);
  }

  /** 当前全部有效擦除标记（渲染分块增量重绘用） */
  listMarks() {
    const out = [];
    for (const m of this.marks.values()) {
      if (!this._entryActive({ batchId: m.batchId })) continue;
      const o = this.getObject(m.strokeId);
      if (o && !o.alive) continue;
      out.push(m);
    }
    return out.map((m) => ({ ...m.mark, strokeId: m.strokeId }));
  }

  /* ============================== 快照 / 序列化 ========================== */

  /**
   * 紧凑快照（新加入房间 / 重连时服务端下发）。只含当前状态所需的最小历史：
   * 每个 key 的全量 LWW 历史（选择性撤销时需要回退到更早的活跃写）。
   */
  snapshot() {
    const objects = [];
    for (const [id, rec] of this.objects) {
      const props = {};
      for (const [k, entries] of rec.props) {
        props[k] = entries.map((e) => ({ v: e.val, s: e.stamp, b: e.batchId, c: e.clientId }));
      }
      objects.push({ id, kind: rec.kind, creator: rec.creator, props });
    }
    const marks = [...this.marks.values()].map((m) => ({
      mark: m.mark, strokeId: m.strokeId, batchId: m.batchId, clientId: m.clientId
    }));
    const epochs = [...this.epochs.entries()].map(([batchId, e]) => [batchId, e]);
    return { v: 2, vv: { ...this.vv }, clock: this.clock.value(), objects, marks, epochs };
  }

  /**
   * 从快照装载（加入房间后初始化）。
   * 快照已经是折叠后的当前状态 + epochs 表；装载后再 receiveMany() 快照之后的新 batch。
   */
  loadSnapshot(snap) {
    if (!snap || snap.v !== 2) throw new Error('bad snapshot');
    this.objects.clear();
    this.marks.clear();
    this.epochs.clear();
    this.applied.clear();
    this.buffer.clear();
    this.byClient.clear();
    this.vv = Object.create(null);
    this.clock = new LamportClock(snap.clock || 0);

    for (const client of Object.keys(snap.vv || {})) this.vv[client] = snap.vv[client];
    this.clientSeq = this.vv[this.clientId] || 0;

    for (const o of snap.objects || []) {
      const props = new Map();
      for (const [k, list] of Object.entries(o.props || {})) {
        props.set(k, list.map((e) => ({
          val: e.v, stamp: e.s, batchId: e.b, clientId: e.c
        })));
      }
      this.objects.set(o.id, { kind: o.kind, creator: o.creator, props });
      this.creators.set(o.id, o.creator);
    }
    for (const m of snap.marks || []) {
      this.marks.set(m.mark.id, {
        mark: m.mark, strokeId: m.strokeId, batchId: m.batchId, clientId: m.clientId
      });
    }
    for (const [batchId, e] of snap.epochs || []) {
      this.epochs.set(batchId, { stamp: e.stamp, active: e.active, by: e.by });
    }
    // 快照折叠了历史 batch，无法再对快照之前的单条 batch 做撤销
    // （重连客户端的撤销面板只展示快照之后自己的 batch）
  }
}
