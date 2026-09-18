'use strict';

/**
 * 笔迹几何：采样点、压感/速度变宽、RDP 简化、Catmull-Rom / B 样条平滑。
 * 全部是纯函数，两端跑同一份代码，所以同一批采样点在两端得到完全一致的宽度与形状。
 *
 * 采样点（完整数据）：
 *   { x, y, p, t, tiltX, tiltY, twist }
 *     p     压感 0..1（无压感设备回退 0.5）
 *     t     时间戳 ms（PointerEvent.timeStamp 对齐）
 *     tiltX/tiltY 倾斜（-1..1），twist 笔身旋转（0..359）
 */

export function makePoint(x, y, p = 0.5, t = 0, tiltX = 0, tiltY = 0, twist = 0) {
  return { x: +x, y: +y, p: p == null ? 0.5 : +p, t: +t || 0, tiltX: +tiltX || 0, tiltY: +tiltY || 0, twist: +twist || 0 };
}

/* ----------------------------- 速度与宽度 ----------------------------- */

/**
 * 计算每点速度（px/s），首点退化为第二点速度。
 * 速度是点数据的确定性函数，两端一致。
 */
export function computeSpeeds(points) {
  const speeds = new Array(points.length).fill(0);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const dt = Math.max(1, b.t - a.t);
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    speeds[i] = (d / dt) * 1000;
  }
  if (points.length > 1) speeds[0] = speeds[1];
  return speeds;
}

function median(nums) {
  const s = nums.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * 压感变宽 + 速度变细。
 * width(p) = base * ((1-ppMin) + ppMin*p) * (1 - spMin * clamp(v/vRef)) * 倾斜微调
 *
 * @param baseWidth 基准线宽
 * @param pressureFactor 压感影响幅度 0..1（0=压感不影响宽度）
 * @param speedFactor    速度变细幅度 0..1
 */
export function pointWidth(pt, speed, baseWidth, opts = {}) {
  const pressureFactor = opts.pressureFactor ?? 0.6;
  const speedFactor = opts.speedFactor ?? 0.35;
  const refSpeed = opts.refSpeed || 1200; // px/s，超过即达到最大变细量
  const pressure = Number.isFinite(pt.p) && pt.p > 0 ? pt.p : 0.5;

  let w = baseWidth * ((1 - pressureFactor) + pressureFactor * pressure);

  const sv = Math.min(1, Math.max(0, speed / refSpeed));
  w *= 1 - speedFactor * sv;

  // 倾斜越大，接触面越宽，轻微加粗（最多 +20%）
  const tilt = Math.hypot(pt.tiltX || 0, pt.tiltY || 0); // 0..~1.4
  w *= 1 + Math.min(0.2, tilt * 0.14);

  return Math.max(0.5, w);
}

/**
 * 为整条笔迹计算每点最终宽度（确定性；两端逐点相同）。
 * refSpeed 默认固定（不随笔迹自适应，否则“整笔都快/都慢”时差异会被归一化抹掉）；
 * 需要自适应时可显式传入。
 */
export function computeStrokeWidths(points, baseWidth, opts = {}) {
  const speeds = computeSpeeds(points);
  const fast = speeds.some((v) => v > 0);
  const ref = opts.refSpeed ||
    (opts.adaptiveRef && fast ? median(speeds.filter((v) => v > 0)) * 2 : 1200);
  return points.map((p, i) => pointWidth(p, speeds[i], baseWidth, { ...opts, refSpeed: ref }));
}

/* ------------------------------- RDP 简化 ------------------------------ */

function perpDistance(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const L = dx * dx + dy * dy;
  if (L === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / L;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * Ramer–Douglas–Peucker 点集简化（传输前使用，减少历史日志体积）。
 * 保留首末点；按垂直距离阈值 eps 抽稀。压感/倾斜等属性跟随被保留点。
 */
export function rdp(points, eps = 1.0) {
  if (points.length < 3) return points.slice();
  let maxD = 0;
  let idx = 0;
  const a = points[0];
  const b = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpDistance(points[i], a, b);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD > eps) {
    const left = rdp(points.slice(0, idx + 1), eps);
    const right = rdp(points.slice(idx), eps);
    return left.slice(0, -1).concat(right);
  }
  return [points[0], points[points.length - 1]];
}

/* --------------------------- 平滑：Catmull-Rom -------------------------- */

/**
 * Catmull-Rom 在 t∈[0,1] 上插值 p1→p2（p0、p3 为相邻控制点），tension=0.5 标准形式。
 * 返回 {x,y}。用于把稀疏采样点重建成平滑曲线。
 */
export function catmullRomPoint(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return {
    x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t +
      (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
      (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
    y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * t +
      (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
      (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3)
  };
}

/**
 * 把点集重采样为 Catmull-Rom 平滑折线。
 * @param points 输入点
 * @param segmentsPerSpan 每两个原始点之间的采样段数（默认 8，可随距离自适应）
 */
export function catmullRomPath(points, segmentsPerSpan = 8) {
  if (points.length < 3) return points.slice();
  const out = [];
  const n = points.length;
  for (let i = 0; i < n - 1; i++) {
    const p0 = points[i - 1] || points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] || p2;
    const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const seg = segmentsPerSpan
      ? Math.max(2, Math.min(24, Math.round((dist / 8) * 2)))
      : 2;
    for (let s = 0; s < seg; s++) {
      if (i > 0 && s === 0) continue; // 每段首点=上段末点，避免重复
      out.push(catmullRomPoint(p0, p1, p2, p3, s / seg));
    }
  }
  out.push(points[n - 1]);
  return out;
}

/* -------------------------------- B 样条 ------------------------------- */

/** 三次均匀 B 样条，de Boor 插值（返回平滑折线；天然不过控制点，更圆润） */
export function bSplinePath(points, segmentsPerSpan = 10) {
  if (points.length < 3) return points.slice();
  const ext = [points[0], ...points, points[points.length - 1]]; // 端点复制
  const out = [];
  for (let i = 0; i < ext.length - 3; i++) {
    const [p0, p1, p2, p3] = ext.slice(i, i + 4);
    for (let s = 0; s < segmentsPerSpan; s++) {
      const t = s / segmentsPerSpan;
      const t2 = t * t;
      const t3 = t2 * t;
      // 三次 B 样条基矩阵
      const x = (1 / 6) * ((-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3 +
        (3 * p0.x - 6 * p1.x + 3 * p2.x) * t2 + (-3 * p0.x + 3 * p2.x) * t +
        (p0.x + 4 * p1.x + p2.x));
      const y = (1 / 6) * ((-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3 +
        (3 * p0.y - 6 * p1.y + 3 * p2.y) * t2 + (-3 * p0.y + 3 * p2.y) * t +
        (p0.y + 4 * p1.y + p2.y));
      out.push({ x, y });
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

/**
 * 混合插值（默认推荐）：先用 RDP 抽稀噪声点，再用 Catmull-Rom 重建。
 * 传输前调 mix 得到少而精的点集；渲染端再 catmullRomPath 平滑。
 */
export function simplifyStroke(points, eps = 1.0) {
  return rdp(points, eps);
}
