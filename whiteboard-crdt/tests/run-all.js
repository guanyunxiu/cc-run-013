'use strict';

/** 测试总入口：node tests/run-all.js */
import { runKernel } from './test-kernel-runner.js';
import { runProtocol } from './test-protocol.js';

let totalPass = 0;
let totalFail = 0;

for (const [name, run] of [
  ['协作内核（CRDT / 撤销 / 事务 / 压缩 / 压感 / 橡皮）', runKernel],
  ['服务端协议（中继 / 快照 / 分块擦除 / 日志压缩 / 隔离）', runProtocol]
]) {
  console.log(`\n=== ${name} ===`);
  const { passed, failed } = await run();
  totalPass += passed;
  totalFail += failed;
}

console.log(`\n----------------------------------------`);
console.log(`TOTAL: ${totalPass} passed, ${totalFail} failed`);
process.exit(totalFail === 0 ? 0 : 1);
