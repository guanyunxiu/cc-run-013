'use strict';

/**
 * 逻辑时钟与 ID 工具（浏览器 / Node 通用 ESM）。
 *
 * 每个操作（batch）携带：
 *  - clientId : 产生该操作的客户端
 *  - clock    : Lamport 逻辑时钟（仅依赖消息 happens-before，与墙钟无关）
 *  - deps     : 依赖向量（Version Vector 摘要：每个 client 已知的最大 clientSeq）
 *  - clientSeq: 本客户端单调递增序号（去重 + 因果缺口检测）
 *  - batchId  : 全局唯一操作 ID（clientId + ':' + clientSeq 天然唯一）
 */

let runtimeCrypto = null;
try {
  runtimeCrypto = globalThis.crypto; // 浏览器 / Node 19+
} catch (_) { /* ignore */ }

export function uid(prefix = '') {
  if (runtimeCrypto && typeof runtimeCrypto.randomUUID === 'function') {
    return prefix + runtimeCrypto.randomUUID();
  }
  // 退化实现（老 Node）
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

/**
 * Lamport 时钟：
 *   本地产生事件：t = t + 1
 *   收到远端事件：t = max(t, remoteClock) + 1
 * 相同 clock 时用 clientId 字典序决胜 → 全序、确定性。
 */
export class LamportClock {
  constructor(initial = 0) {
    this.t = initial;
  }
  tick() {
    this.t += 1;
    return this.t;
  }
  observe(remote) {
    if (Number.isFinite(remote) && remote > this.t) this.t = remote;
    return this.t;
  }
  value() {
    return this.t;
  }
}

/**
 * 确定性全序键：(clock, clientId)
 * 用于并发写操作的 LWW（Last-Writer-Wins）决胜。
 */
export function orderKey(clock, clientId) {
  return `${String(clock).padStart(12, '0')}#${clientId}`;
}

/**
 * 向量因果判定。
 * @param {Record<string, number>} deps 远端 batch 声明的依赖向量
 * @param {Record<string, number>} vv   本地已见向量
 * @returns {{ready: boolean, missing?: {client: string, need: number, have: number}}}
 *
 * ready 条件：对 deps 中除发送者自身外的每个 client，本地 vv[client] >= deps[client]。
 * 发送者自身的前序 batch 用 clientSeq 严格连续来保证（缺一个就要等）。
 */
export function causalReady(deps, vv, senderId, senderSeq) {
  for (const [client, need] of Object.entries(deps || {})) {
    if (client === senderId) continue;
    const have = vv[client] || 0;
    if (have < need) return { ready: false, missing: { client, need, have } };
  }
  const haveSender = vv[senderId] || 0;
  if (senderSeq !== haveSender + 1) {
    return { ready: false, missing: { client: senderId, need: senderSeq, have: haveSender } };
  }
  return { ready: true };
}

export function mergeVV(target, source) {
  for (const [client, seq] of Object.entries(source || {})) {
    if ((target[client] || 0) < seq) target[client] = seq;
  }
}

export function cloneVV(vv) {
  return { ...vv };
}

/**
 * happens-before：a 是否先于 b（a.deps[b.author] >= a 自身 seq 的逆判断）。
 * 这里比较两个 batch：a 在 b 的因果过去中 ⇔ b.deps[a.clientId] >= a.clientSeq。
 */
export function isBefore(a, b) {
  const dep = (b.deps && b.deps[a.clientId]) || 0;
  return dep >= a.clientSeq;
}
