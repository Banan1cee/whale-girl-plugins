# 上下文便签（context-notes）

- 等级：**3 级 · 受限 Wasm**
- 入口：`plugin.wasm`
- provides：`chat.prompt@1`（enhance / all）、`chat.before_send@1`（enhance / all）
- calls：无
- 数据访问：`chat.history`、`model.prompt`（读取最近会话/系统提示词，这两项由宿主授权）
- 兼容：`compat: "api3"`；宿主用旧版消息插件信封喂给 Wasm，再把输出投影回新 schema
- 最低客户端：4.3.0

## 行为

- 生成前：在 system 末尾补一张「本轮上下文」便签（谁在连发、最后一句、悬着的问题等），只改本轮 system。
- 发送前：清掉 Markdown 痕迹、压缩空白、对跑飞的长回复截到最近的句末；文本没变化就不干预。

## state 与 now/lastBot

- 新版宿主已实现会话 state：按「安装包摘要 × `platform` × `chatType` × `chatId`」隔离，调用前下发（首次 `{}`），输出里的 `state` 在整份输出校验通过后保存；单个 state 上限 8 KiB、单插件最多 200 个会话（LRU 淘汰），停用/卸载/更新会清除，内核进程重启后丢失（内存实现，不落盘）。
- 本插件通过 `compat:"api3"` 收到旧信封里的真实 `state`，输出里的 `state` 也会被保存，跨轮次数/上次发言人等字段可以累计，不再退化为单轮。
- 同一信封还带 `now`（宿主毫秒时间）与 `lastBot`（本会话最后一条助手回复的受控投影 `{text, at, targetId}`，没有时为 `null`；只有这三个字段，不含整条聊天记录）。`chat.prompt@1` 与 `chat.before_send@1` 都属于支持 state 的四个聊天能力，输入里都有这两个字段。
- `decision`、`delivery` 等旧版其他字段仍不在新信封里，插件按空值处理；需要时应从能力输入本身推导。

## 与迁移前的差异

- 旧版是宿主的独立提示词/发送钩子；新协议对应两个 enhance 提供者，输入裁剪和调用时机由新宿主决定。
- `compat: "api3"` 只负责旧信封与 whale 导入别名；信封里的 `state`/`now`/`lastBot` 是真实值，`decision`、`delivery` 等旧字段仍不存在，缺失字段按空值处理。
- 触发器从「宿主直接调用旧钩子」变为「宿主在统一 provider 链中调用」；失败时宿主可退回上一轮结果，不会阻止正常回复。
