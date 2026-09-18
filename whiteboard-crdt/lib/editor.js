'use strict';

/**
 * Ops 工厂 + 高层编辑命令（Editor）。
 *
 * Editor 封装 CollabStore：产生的每个原子动作都返回 batch，供网络层发送；
 * 多对象动作（粘贴、多选移动、建组、识别替换）天然用一个事务 batch。
 *
 * 对象模型：
 *  - stroke : props {
 *      geom:{ points:[{x,y,p,t,tiltX,tiltY,twist}], width, color,
 *             tool:'pen'|'highlighter'|'dash'|'texture'|'arrow',
 *             smooth:'catmull-rom'|'bspline'|'none', texture, pressureFactor, speedFactor },
 *      transform:{tx,ty} }
 *  - shape  : props { geom:{ shape:'rect'|'ellipse'|'line'|'arrow'|'triangle'|'diamond'|'star',
 *                            x,y,w,h,r }, style:{color,width,fill,dash}, transform }
 *  - text   : props { geom:{x,y}, text:{content,font,size,color}, transform }
 *  - note   : props { geom:{x,y,w,h}, note:{content,color}, transform }
 *  - image  : props { geom:{x,y,w,h}, image:{src}, transform }
 *  - group  : 成员集合（__member:<id> = true 的 LWW 寄存器）
 *
 * move / scale / rotate 统一改 transform：{tx,ty,sx,sy,angle}，
 * 一次移动 N 个对象 = 一个 batch 里 N 个 update ops（原子组）。
 */

import { uid } from './clock.js';

export function newObjectId(prefix = 'o-') {
  return uid(prefix);
}

export function createOp(object) {
  return { type: 'create', objectId: object.id, object };
}
export function updateOp(objectId, values) {
  return { type: 'update', objectId, values };
}
export function deleteOp(objectId) {
  return { type: 'delete', objectId };
}
export function reorderOp(objectId, z) {
  return { type: 'reorder', objectId, z };
}
export function groupOp(groupId, members) {
  return { type: 'group', objectId: groupId, members };
}
export function ungroupOp(groupId) {
  return { type: 'ungroup', objectId: groupId };
}
export function eraseOp(strokeId, marks) {
  return { type: 'erase', objectId: strokeId, marks };
}

/** 一个擦除标记 = 橡皮走过的一条小块（点串简化后的多边形路径） */
export function eraseMark({ strokeId, points, chunkSeq, width }) {
  return {
    id: uid('em-'),
    strokeId,
    kind: 'pixel',
    points, // [{x,y}]，对象坐标系；RDP 已简化
    width,
    chunkSeq,
    cells: points.length ? cellHints(points, width) : [] // 受影响的网格块（分块增量重绘）
  };
}

/** 计算擦除影响的网格块（例如 64px 一格），渲染端只重绘受影响块，不全量重绘 */
export function cellHints(points, width, CELL = 64) {
  const set = new Set();
  const r = width / 2;
  for (const p of points) {
    const x0 = Math.floor((p.x - r) / CELL);
    const x1 = Math.floor((p.x + r) / CELL);
    const y0 = Math.floor((p.y - r) / CELL);
    const y1 = Math.floor((p.y + r) / CELL);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) set.add(`${cx}:${cy}`);
    }
  }
  return [...set];
}

/**
 * fractional index：在两个字符串索引之间取一个。
 * 图层调整（置顶/置底/上移/下移）只写一个 reorder op，两端排序一致。
 */
export function fractionBetween(before, after) {
  // 简化实现：数字小数位编码。before/after 形如 "a0.5231"。
  const lb = before ? parseFloat(before.slice(1)) : 0;
  const la = after ? parseFloat(after.slice(1)) : 1;
  const mid = (lb + la) / 2;
  return 'a' + mid.toFixed(12).replace(/0+$/, '');
}

export class Editor {
  constructor(store) {
    this.store = store;
  }

  /** 原子事务：一次提交任意 ops（粘贴多个元素、多选移动、识别替换……） */
  transact(ops) {
    return this.store.commit(ops, { tx: true });
  }

  /* ------------------------------- 创建 -------------------------------- */

  addObject(kind, props) {
    const object = { id: newObjectId(), kind, props };
    const batch = this.store.commit([createOp(object)]);
    // 便捷访问：batch.objectId / batch.object
    batch.objectId = object.id;
    batch.object = object;
    return batch;
  }

  /** 一次粘贴多个元素 → 原子 batch */
  paste(objects) {
    return this.transact(objects.map(createOp));
  }

  addStroke(geom, style = {}) {
    const object = {
      id: newObjectId('s-'),
      kind: 'stroke',
      props: {
        geom: {
          points: geom.points,
          width: geom.width ?? 4,
          color: geom.color || '#1f2937',
          tool: geom.tool || 'pen',
          smooth: geom.smooth || 'catmull-rom',
          texture: geom.texture || null,
          pressureFactor: geom.pressureFactor ?? 0.6,
          speedFactor: geom.speedFactor ?? 0.35
        },
        transform: { tx: 0, ty: 0, sx: 1, sy: 1, angle: 0 },
        ...style
      }
    };
    const batch = this.store.commit([createOp(object)]);
    batch.objectId = object.id;
    batch.object = object;
    return batch;
  }

  addShape(shape, geom, style = {}) {
    const object = {
      id: newObjectId('sh-'),
      kind: 'shape',
      props: {
        geom: { shape, ...geom },
        style: { color: '#1f2937', width: 2, fill: null, dash: null, ...style },
        transform: { tx: 0, ty: 0, sx: 1, sy: 1, angle: 0 }
      }
    };
    const batch = this.store.commit([createOp(object)]);
    batch.objectId = object.id;
    batch.object = object;
    return batch;
  }

  addText(x, y, content, opts = {}) {
    return this.addObject('text', {
      geom: { x, y },
      text: { content, font: opts.font || 'sans-serif', size: opts.size || 24, color: opts.color || '#1f2937' },
      transform: { tx: 0, ty: 0, sx: 1, sy: 1, angle: 0 }
    });
  }

  addNote(x, y, w, h, content, color = '#fde68a') {
    return this.addObject('note', {
      geom: { x, y, w, h },
      note: { content, color },
      transform: { tx: 0, ty: 0, sx: 1, sy: 1, angle: 0 }
    });
  }

  addImage(x, y, w, h, src) {
    return this.addObject('image', {
      geom: { x, y, w, h },
      image: { src },
      transform: { tx: 0, ty: 0, sx: 1, sy: 1, angle: 0 }
    });
  }
  /* ------------------------- 移动 / 缩放 / 旋转 ------------------------- */

  /** 一次移动多个对象（事务原子组）：在现有 transform 上累加平移 */
  move(ids, dx, dy) {
    const ops = ids.map((id) => {
      const cur = this.store.getObject(id);
      const t = baseTransform(cur);
      return updateOp(id, { transform: { ...t, tx: (t.tx || 0) + dx, ty: (t.ty || 0) + dy } });
    });
    return this.transact(ops);
  }

  /**
   * 连续移动的压缩帧（绝对定位语义）：
   * 调用方在手势开始时记录 startTransforms，pointermove 每次传“相对手势起点的
   * 总位移” dx/dy；同 coalesceKey 的未确认帧被 replaces 原子替换，
   * 因此中间帧无论发多少、丢多少，最终帧都给出正确绝对位置。
   */
  moveCoalesced(id, dx, dy, start = null) {
    const s = start || { tx: 0, ty: 0, sx: 1, sy: 1, angle: 0 };
    return this.store.commitCoalesced(
      [updateOp(id, { transform: { ...s, tx: s.tx + dx, ty: s.ty + dy } })],
      `move:${id}`
    );
  }

  /**
   * 多选连续移动（橡皮筋拖动一批），按手势 key 压缩；全部对象在同一事务 batch 里，
   * 其他端要么整组看到移动，要么看不到。
   */
  moveMultiCoalesced(ids, dx, dy, gestureKey, starts = {}) {
    const ops = ids.map((id) => {
      const s = starts[id] || { tx: 0, ty: 0, sx: 1, sy: 1, angle: 0 };
      return updateOp(id, { transform: { ...s, tx: s.tx + dx, ty: s.ty + dy } });
    });
    return this.store.commitCoalesced(ops, `multi-move:${gestureKey}`);
  }

  /** 连续缩放到指定 transform（控制点拖拽），同 key 压缩 */
  scaleCoalesced(id, transform) {
    return this.store.commitCoalesced([updateOp(id, { transform })], `transform:${id}`);
  }

  rotate(id, angle) {
    const cur = this.store.getObject(id);
    return this.store.commit([updateOp(id, {
      transform: { ...baseTransform(cur), angle }
    })]);
  }

  /* ------------------------------ 删除 / 层 ---------------------------- */

  remove(ids) {
    if (ids.length === 1) return this.store.commit([deleteOp(ids[0])]);
    return this.transact(ids.map(deleteOp));
  }

  /** 整笔擦除：就是 delete（对象橡皮擦也是它） */
  eraseObjects(ids) {
    return this.remove(ids);
  }

  bringToFront(id) {
    const all = this.store.listObjects();
    const top = all[all.length - 1];
    return this.store.commit([reorderOp(id, fractionBetween(top ? top.props.__z || 'a0.9' : 'a0.9', null))]);
  }

  sendToBack(id) {
    const all = this.store.listObjects();
    const bottom = all[0];
    return this.store.commit([reorderOp(id, fractionBetween(null, bottom ? bottom.props.__z || 'a0.1' : 'a0.1'))]);
  }

  /* ------------------------------ 组 / 解组 ----------------------------- */

  group(ids) {
    const groupId = newObjectId('g-');
    // 建组是原子的：group 对象创建 + 成员写入在同一个 batch
    return this.transact([groupOp(groupId, ids)]);
  }

  ungroup(groupId) {
    return this.store.commit([ungroupOp(groupId)]);
  }

  /* ------------------------------ 像素擦除 ----------------------------- */

  /**
   * 像素擦除（推荐用法）：一次橡皮手势的全部 marks 作为【一个原子 batch】。
   * 网络层可把 marks 拆成多个 chunk 渐进发送（见 chunkErase 消息），但进入
   * CRDT / 日志 / 撤销栈的永远是这一个原子 batch。
   */
  erasePixels(strokeId, marks) {
    return this.store.commit([eraseOp(strokeId, marks)]);
  }

  /**
   * 分块传输切分（不影响内核原子性）：
   * 返回 { finalBatch, chunks }：
   *  - finalBatch：唯一进入 CRDT 的原子 batch（整体撤销/压缩）
   *  - chunks：把 marks 按 chunkSize 切片后的传输帧（chunk:true, group, seq,total），
   *    接收端只用于渐进预览；收到 chunk-final 后以 finalBatch 为准应用。
   */
  chunkErase(strokeId, allMarks, chunkSize = 64) {
    const finalBatch = this.store.commit([eraseOp(strokeId, allMarks)]);
    const chunks = [];
    for (let i = 0; i < allMarks.length; i += chunkSize) {
      chunks.push(allMarks.slice(i, i + chunkSize));
    }
    return {
      finalBatch,
      group: finalBatch.batchId, // 用最终 batchId 作为 chunk group
      chunks: chunks.map((marks, seq) => ({
        chunk: true,
        chunkGroupId: finalBatch.batchId,
        seq,
        total: chunks.length,
        marks
      }))
    };
  }

  /* ------------------------------- 撤销 -------------------------------- */

  undo(batchId) { return this.store.undo(batchId); }
  undoLast() { return this.store.undoLast(); }
  redo(batchId) { return this.store.redo(batchId); }
  redoLast() { return this.store.redoLast(); }
  ownHistory() { return this.store.ownHistory(); }
}

function baseTransform(obj) {
  const t = (obj && obj.props && obj.props.transform) || {};
  return { tx: 0, ty: 0, sx: 1, sy: 1, angle: 0, ...t };
}
