# 随手记（notes）2.0.2

- 等级：**4 级 · Node.js（node-full）**
- 扩展点：`chat.generate@1`（replace / all）
- 宿主能力：`message.send@1`（超长补发，排队）、`model.complete@1`（非命令消息交回原模型）
- 最低客户端：4.3.0
- 旧版对照：`legacy/plugin.json` + `legacy/plugin.js`（不参与打包）

## 命令

`/record 内容`、`/read [今天|昨天|本周|类别|关键词|序号]`、`/delete 关键词`、`/delete undo`、`/whoami`。
`/read`、`/delete` 只操作发送者自己的记录（按 `message.senderId` 隔离）。

## 从旧版迁移的变化（逐条）

1. **超长补发改为排队语义**：旧 `whale.sendText` 返回后当作已发；新版 `message.send@1` 只保证进入宿主发送通道（`queued`），因此提示文案改成「已排队/没发出去」，不再声称送达。
2. **补发需要额外授权**：清单声明 `message.send@1`，安装/启用时需确认；未授权或调用失败时只回第一段并给翻页提示（旧版无此限制）。
3. **删除候选状态从宿主 state 移到插件文件**：`state.json`（按 `chatId|senderId` 分键）。旧 state 与宿主消息处理同生命周期；新文件跨进程，极端并发下多轮可能互相覆盖。
4. **非命令消息的回退方式变了**：旧版 `chat.generate` 返回 `{}` 表示「交还宿主」；新 replace 协议没有这个语义，改为调用 `model.complete@1` 生成原模型回复（多一次宿主能力调用，需要模型调用授权）。
5. **`/whoami` 字段变少**：新协议 `message` 只有 platform/chatType/chatId/senderId/text 等固定字段，旧的 `conversationId/roomId/session` 等不再存在。
6. **noteDir 收紧**：旧版允许绝对路径；新版只允许插件数据目录下的相对目录（安全收紧，绝对路径会退回 `note`）。
7. **保留不变**：分类规则、索引与 Markdown 导出、去重、60 秒删除候选、24 小时 undo、身份隔离、只写本地不联网。

## 已知限制

- 未声明 `settings.write@1`：设置只由宿主卡片写入，插件只读。
- `message.send@1` / `model.complete@1` 被用户拒绝授权时，插件会少掉补发或回退能力（不会静默篡改）。

## 网络出口

- **插件自身不建连接**：`plugin.js` 只 `require('node:fs')` 与 `require('node:path')`，没有 `fetch`/`net`/`http`/`dgram`，也不 `listen` 任何端口。
- 需要网络的只有两条宿主能力，都走 `ctx.host.call`：`message.send@1`（`pushRemaining()`，把后面几段塞进宿主发送通道）与 `model.complete@1`（`hostReply()`，非命令消息交回原模型）。**是否真正出网、出到哪个地址由宿主与网关决定**，插件既不解析也不缓存网络细节。
- 声明与实现一致：`plugin.json` 的 `calls` 只有这两个能力，`dataAccess` 只有 `model.prompt`、`chat.history`。

## 写文件是否原子

- 只写插件数据目录（`dataDir()` = 4 级 worker 的 `process.cwd()`）。`noteDir` 只接受该目录下的相对路径，填绝对路径会被忽略并回落到 `note/`（`noteDir()` 的路径判断）。
- `note/state.json` 与 `note/index.json` 用「先写 `<file>.tmp`、再 `fs.renameSync`」（`writeState()`、`saveIndex()`）；rename 抛错时退回直接覆盖原文件再删 `.tmp`。**同目录 rename 是原子的，这条降级路径不是**。
- 分类导出的 `note/money.md`、`todos.md`、`links.md`、`code.md`、`ideas.md`、`memo.md` 由 `renderCatFile()` 用 `fs.writeFileSync` 直接覆盖，**不原子**；内容与旧文件逐字节相同时跳过写入。
- **未做**：没有 `fsync`、没有文件锁、没有跨进程互斥。宿主并发跑两轮时可能互相覆盖 state/index（见差异 3）。`index.json` 解析失败会被改名成 `index.broken-<时间戳>.json` 留在原目录（`loadIndex()`），这是改名不是删除。

## 聊天数据声明

清单明确申请 `model.prompt` 与 `chat.history`：生成替换及模型回退会使用本轮系统提示词与会话输入。启用时按声明披露，未授权时宿主不会下发 system，turns 为空数组。
