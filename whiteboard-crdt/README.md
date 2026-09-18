# 协作白板 v2 · CRDT 协作内核

从 v1「单房间单笔迹、靠服务端 seq 排序」升级为支持**多用户并发编辑、对象化白板、选择性撤销**的协作内核。

- **冲突模型：CRDT（LWW 寄存器 + Lamport 时钟 + 依赖向量因果序）**。服务端 `seq` 只用于日志排序/补漏游标，**不参与冲突解决**。
- 浏览器与 Node 共用同一份内核（同构 ESM，零打包）。

## 启动

```bash
cd whiteboard-crdt
npm install        # 仅依赖 ws
npm start          # http://localhost:8081/
PORT=3000 npm start
```

浏览器多开几个标签页，输入同一房间号即可协作。

## 自动化测试

```bash
npm test
# 41 项：23 项纯 CRDT 内核 + 18 项真实 WebSocket 服务端协议
```

测试覆盖全部 5 个验收场景：

| 验收场景 | 测试 |
| --- | --- |
| 1. 三端同画一区域，最终一致无重复笔迹 | `场景1：三个客户端并发画同一区域…` |
| 2. A 撤销旧笔迹，B 已修改，不破坏 B | `场景2a/2b/2c` |
| 3. 多选移动要么全看到要么看不到 | `场景3：一次移动多个对象是单一原子 batch` |
| 4. 压感笔迹两端宽度一致 | `场景4：压感/速度变宽…确定性函数` |
| 5. 橡皮擦分块同步，两端结果一致 | `场景5：像素擦除分块传输…` |

另可用三个真实 WebSocket 客户端（经过服务器）跑端到端：`tests/` 下协议测试即为该形态。

## 目录结构

```
whiteboard-crdt/
├── package.json
├── server.js                # 中继服务：房间/快照/分块组装/日志压缩/presence
├── lib/                     # 浏览器/Node 同构内核
│   ├── clock.js             # Lamport 时钟、uid、依赖向量、因果判定
│   ├── batch.js             # 操作组/事务信封、校验（clientId/clock/deps/clientSeq）
│   ├── store.js             # ★ CRDT 内核：LWW / 因果缓冲 / 选择性撤销 / 复活 / 快照
│   ├── editor.js            # 高层命令：图形/文本/便签/图片/move/scale/rotate/层/组/橡皮
│   ├── geometry.js          # 压感·速度变宽、RDP 简化、Catmull-Rom、B 样条
│   ├── render.js            # 压感丝带渲染、逐对象隔离合成、分块增量重绘
│   └── recognize.js         # 图形识别 / 手写转文字接口（可插拔 OCR）
├── public/
│   ├── index.html  style.css  app.js        # 白板前端
│   └── lib/                 # 内核拷贝（构建时 cp lib/*.js public/lib/）
└── tests/
    ├── test-kernel.js       # CRDT 内核单测（23）
    ├── test-protocol.js     # 真实 ws 服务端协议测试（18，自动拉起 server）
    └── run-all.js
```

## 十个功能点与实现对应

| # | 需求 | 实现 |
| --- | --- | --- |
| 1 | CRDT/OT，并发最终一致 | `store.js`：每字段一个 **LWW 寄存器**，按 `(Lamport clock, clientId)` 全序决胜，与到达顺序无关；并发任意投递顺序收敛一致 |
| 2 | 操作类型扩展 | create/update/delete/reorder/group/ungroup/erase；对象 kind：stroke/shape/text/note/image/group；move/scale/rotate 统一改 transform（`editor.js`） |
| 3 | clientId/逻辑时钟/依赖向量/因果 | 每个 batch 带 `clientId / clock(Lamport) / deps(版本向量) / clientSeq`；因果未满足进缓冲区，缺口补齐自动冲刷（`store._causalCheck / _flushBuffer`）。**server seq 只排日志** |
| 4 | 选择性撤销，只撤自己、不破坏他人 | 撤销/重做本身是被复制的 batch（`undoOf+active`），epoch 是 LWW；字段保留全量 LWW 写历史，撤自己某条后重新求 LWW，他人后续写天然胜出；**保护性复活**：别人已操作时不抹对象。只能撤自己（`undo` 强校验）。历史面板支持挑选任意一条撤销 |
| 5 | 操作组/事务原子 | 一个 batch 的 `ops[]` 整体缓冲、整体应用、整体撤销；`tx:true`。粘贴多个、多选移动、建组、识别替换都是单 batch |
| 6 | 操作压缩 | 客户端连续 move/scale：`coalesceKey + replaces` 原子替换未确认中间帧（最终帧绝对定位，丢中间帧也对）；服务端 `coalesceLog` 合并已确认连续帧，减少历史体积；中间帧丢失可靠 `replaces` 跳过因果缺口 |
| 7 | 压感/倾斜/速度/时间戳 | 点 `{x,y,p,t,tiltX,tiltY,twist}`；`pointWidth = base·压感因子·(1−速度因子)·倾斜微调`，宽度是点数据的确定性函数，两端逐点相同；压感变宽、速度变细 |
| 8 | Catmull-Rom/B 样条 + RDP | `geometry.js`：传输前 `rdp()` 抽稀，渲染端 `catmullRomPath / bSplinePath` 重建（默认混合：RDP 简化 + Catmull-Rom） |
| 9 | 橡皮擦（像素/对象/整笔） | 像素：erase marks，**分块传输（chunk 渐进预览 + 唯一 final 原子 batch 权威提交）**，marks 带 cells 网格提示，渲染端只重绘脏块；逐对象离屏隔离合成，destination-out 只挖目标笔迹，不擦同位置他人内容。对象橡皮/整笔擦除 = delete；撤销像素擦除整组恢复 |
| 10 | 荧光笔/虚线/纹理/箭头/图形识别/手写转文字 | stroke 的 `tool`：pen/highlighter(半透明)/dash(断续)/texture(纹理)/arrow；`recognize.js` 内置几何启发式识别（矩形/椭圆/三角/菱形/直线/星），识别结果以「建 shape + 删 stroke」原子事务替换；`recognizeText()` 为可插拔 OCR 接口（前端有开关） |

## 协议（JSON over WebSocket，路径 `/ws`）

客户端 → 服务端：

```jsonc
{ "type": "join", "roomId": "crdt-101", "userId": "u-alice", "afterSeq": 0 }
{ "type": "batch", "batch": { /* batch 信封，见 lib/batch.js */ } }
{ "type": "chunk", "chunkGroupId", "seq", "total", "strokeId", "marks": [ /* 像素擦除渐进预览帧，不入日志 */ ] }
{ "type": "presence", "p": { "kind": "cursor", "x": 1, "y": 2 } }   // 只中继
{ "type": "ping" }
```

服务端 → 客户端：

```jsonc
{ "type": "joined", "roomId", "userId", "lastSeq" }
{ "type": "snapshot", "snapshot": { /* 折叠 CRDT 状态：对象 LWW 历史 + marks + epochs + vv */ },
  "afterSeq", "delta": [ /* 快照之后的日志 batch，客户端幂等去重 */ ] }
{ "type": "batch", "seq", "batch" }      // seq 仅日志顺序
{ "type": "chunk",  "chunkGroupId", "seq", "total", "strokeId", "marks" }  // 他端渐进预览
{ "type": "ack", "batchId", "seq" }
{ "type": "presence", "p" }
{ "type": "error", "message" }
```

观察接口：

```bash
curl http://localhost:8081/api/rooms
curl 'http://localhost:8081/api/room?roomId=crdt-101'
```

## 关键设计说明

- **为什么不靠服务端 seq 解决冲突**：seq 是单一日志源的到达顺序，无法表达「A、B 没见过彼此、并发各改一处」这类因果关系。CRDT 用每个副本独立维护的 Lamport 时钟给写操作定全序、用版本向量定因果，任意顺序投递都收敛，服务端只需中继。
- **选择性撤销为何不破坏别人**：撤销不是改历史，而是给目标 batch 翻一个被复制的 epoch（LWW）。物化状态时过滤掉非活跃 epoch 的写，再在每个字段上重新取 LWW——别人在你之后的写自然赢。若你撤销的是「创建」，但别人已经在该对象上留下有效写，对象保护性复活，并把缺失字段恢复到撤销前的活跃值。
- **原子组为何不会只移动一半**：多选移动/粘贴/建组在同一个 batch 的多个 op 里。远端因果缓冲保证整个 batch 要么未就绪（不应用任何 op），要么一次性应用。
- **压缩为何不丢最终状态**：移动采用「绝对定位」语义，pointermove 每帧是相对手势起点的最终位置；同 key 帧用 `replaces` 原子撤回。中间帧被合并/丢弃后，最终帧仍给出正确位置；只有最后一条会进撤销栈。
- **橡皮为何分块且不会擦到别人**：分块帧只做渐进预览，进入 CRDT/日志/撤销的永远是 final 一个原子 batch；挖洞在每笔自己的临时画布上 `destination-out` 后再合成回主离屏，物理上不可能挖掉同位置的其他对象。
