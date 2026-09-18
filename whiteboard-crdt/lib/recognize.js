'use strict';

/**
 * 图形识别 + 手写转文字（可插拔接口）。
 *
 * 内核只定义接口与内置的轻量几何识别器；真实场景可接入服务端模型
 * （手写 OCR）后替换 recognizeInk / recognizeText 的实现，协议不变：
 * 识别结果以「原子事务」落地——新建目标对象 + 删除原笔迹在同一个 batch，
 * 其他客户端要么同时看到替换，要么看不到。
 */

import { rdp } from './geometry.js';

function bbox(points) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of points) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function pathLength(points) {
  let L = 0;
  for (let i = 1; i < points.length; i++) L += dist(points[i - 1], points[i]);
  return L;
}

/**
 * 内置图形识别：基于闭合度、顶点数、边长/角度特征的轻量启发式。
 * @returns {shape:'rect'|'ellipse'|'triangle'|'diamond'|'line'|'arrow'|'star', confidence 0..1}
 */
export function recognizeShape(rawPoints) {
  const points = rdp(rawPoints, 3);
  const box = bbox(points);
  const L = pathLength(points);
  const diag = Math.hypot(box.w, box.h) || 1;
  const start = points[0];
  const end = points[points.length - 1];
  const closed = dist(start, end) < diag * 0.25;

  // 开放：直线 / 箭头（箭头暂用“开放且近直”表示，真实箭头识别可在此扩展）
  if (!closed) {
    if (L < diag * 1.3) return { shape: box.w > box.h * 3 || box.h > box.w * 3 ? 'line' : 'line', confidence: 0.6 };
    return null;
  }

  const vertices = points.length - 1; // RDP 后末点≈首点
  const perimeter = 2 * (box.w + box.h) || 1;
  const straightness = perimeter / L; // 矩形贴边程度

  if (vertices <= 5 && straightness > 0.92) {
    return { shape: 'rect', confidence: 0.9, bbox: box };
  }
  if (vertices === 4 && straightness > 0.8) {
    // 菱形：四个顶点靠近 bbox 四边中点
    return { shape: 'diamond', confidence: 0.65, bbox: box };
  }
  if (vertices === 3 || vertices === 4) {
    return { shape: 'triangle', confidence: 0.7, bbox: box };
  }
  if (vertices >= 8) {
    return { shape: 'ellipse', confidence: 0.75, bbox: box };
  }
  if (vertices >= 9) {
    return { shape: 'star', confidence: 0.5, bbox: box };
  }
  return null;
}

/**
 * 手写转文字接口。内置 mock：返回 null（不替换）。
 * 接入 OCR 后实现为 async (points) => ({ text, confidence })。
 */
export async function recognizeText(_points) {
  // 占位：接入服务端识别时替换。
  // 约定：识别确认后，由调用方在 editor.transact 里「建 text + 删 stroke」原子提交。
  return null;
}

/**
 * 用识别结果原子替换笔迹。
 * @param editor Editor 实例
 * @param shapeObj 目标图形对象（id 已分配）
 * @param strokeId 原笔迹 id
 */
export function commitShapeReplacement(editor, shapeObj, strokeId) {
  return editor.transact([
    { type: 'create', objectId: shapeObj.id, object: shapeObj },
    { type: 'delete', objectId: strokeId }
  ]);
}

export function commitTextReplacement(editor, textObj, strokeId) {
  return editor.transact([
    { type: 'create', objectId: textObj.id, object: textObj },
    { type: 'delete', objectId: strokeId }
  ]);
}
