'use strict';

/**
 * Batch（操作组 / 事务）信封。
 *
 * 一个 batch 是协作内核里的原子单位：要么整组被应用，要么整组缓冲等待，
 * 不存在“只看到一半”的状态。一次粘贴多个元素、一次移动多个选中对象，
 * 都在同一个 batch 的 ops[] 里。
 *
 * Batch 结构：
 * {
 *   v: 2,
 *   batchId: "<clientId>:<clientSeq>",
 *   clientId, clientSeq, clock,          // 客户端 ID + 逻辑时钟
 *   deps: { clientId: maxClientSeq },    // 依赖向量（因果顺序）
 *   t: 1700000000000,                    // 墙钟（仅展示/调试，不参与决胜）
 *   tx: true,                            // 是否为显式事务（>=2 个原子 ops）
 *   coalesceKey: "move:objId" | null,    // 压缩键（连续移动/缩放合并）
 *   replaces: "oldBatchId" | null,       // 压缩替换：原子性撤回旧的未确认 batch
 *   ops: [ op, ... ],
 *   // 选择性撤销不是直接改历史，而是发一个 undo batch：
 *   undoOf: "targetBatchId" | null,      // 撤销目标（只能是自己的 batch）
 *   active: true|false                   // undoOf 非空时：false=撤销, true=重做
 * }
 *
 * 服务端另外附加 seq（日志顺序），seq 不参与冲突解决。
 *
 * Op 结构（ops[] 的元素）：
 *   { type:'create',  objectId, object:{ id, kind, props } }
 *   { type:'update',  objectId, values:{ key:value }, base:{ key:clockKey } }
 *   { type:'delete',  objectId }
 *   { type:'reorder', objectId, z:'<fractional index>' }
 *   { type:'group',   objectId, members:[ids...] }   // 建组 + 成员入组
 *   { type:'ungroup', objectId }                     // 解组（保留成员对象）
 *   { type:'erase',   marks:[ {id,strokeId,kind,points,...} ] } // 像素擦除分块
 *
 * 约定：所有坐标/几何都是“对象坐标”。stroke/shape 等带 transform 的对象，
 * 其几何放在 props.geom 中，旋转/缩放/平移统一改 props.transform（move/scale/rotate）。
 */

export function makeBatch({ clientId, clientSeq, clock, deps, ops, tx, coalesceKey = null, replaces = null }) {
  if (!Array.isArray(ops) || ops.length === 0) {
    throw new Error('batch requires at least one op');
  }
  return {
    v: 2,
    batchId: `${clientId}:${clientSeq}`,
    clientId,
    clientSeq,
    clock,
    deps: { ...deps },
    t: Date.now(),
    tx: !!tx || ops.length > 1,
    coalesceKey,
    replaces,
    undoOf: null,
    active: true,
    ops
  };
}

export function makeUndoBatch({ clientId, clientSeq, clock, deps, targetBatchId, active }) {
  return {
    v: 2,
    batchId: `${clientId}:${clientSeq}`,
    clientId,
    clientSeq,
    clock,
    deps: { ...deps },
    t: Date.now(),
    tx: false,
    coalesceKey: null,
    replaces: null,
    undoOf: targetBatchId,
    active: !!active,
    ops: []
  };
}

/** 校验 batch 基本结构（服务端也用，防止坏消息） */
export function validateBatch(b) {
  if (!b || typeof b !== 'object') return 'not an object';
  if (b.v !== 2) return 'unsupported version';
  if (typeof b.clientId !== 'string' || !b.clientId) return 'missing clientId';
  if (!Number.isInteger(b.clientSeq) || b.clientSeq <= 0) return 'bad clientSeq';
  if (!Number.isInteger(b.clock) || b.clock <= 0) return 'bad clock';
  if (!b.deps || typeof b.deps !== 'object') return 'missing deps';
  if (!Array.isArray(b.ops)) return 'ops must be array';
  if (b.ops.length > 5000) return 'too many ops in one batch';
  if (b.undoOf !== null && b.undoOf !== undefined && typeof b.undoOf !== 'string') {
    return 'bad undoOf';
  }
  for (const op of b.ops) {
    if (!op || typeof op !== 'object' || typeof op.type !== 'string') return 'bad op';
    if (!op.objectId && op.type !== 'erase') return 'op missing objectId';
    switch (op.type) {
      case 'create':
        if (!op.object || typeof op.object !== 'object') return 'create needs object';
        break;
      case 'update':
        if (!op.values || typeof op.values !== 'object') return 'update needs values';
        break;
      case 'erase':
        if (!Array.isArray(op.marks) || op.marks.length === 0) return 'erase needs marks';
        break;
      case 'delete':
      case 'reorder':
      case 'group':
      case 'ungroup':
        break;
      default:
        return `unknown op type: ${op.type}`;
    }
  }
  return null;
}

/** 估算 batch 体积（用于压缩阈值/日志统计） */
export function batchBytes(b) {
  return JSON.stringify(b).length;
}
