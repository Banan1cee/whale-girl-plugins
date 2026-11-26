# 接话窗口（followup-window）

- 等级：**3 级 · 受限 Wasm**
- 入口：`plugin.wasm`
- provides：`chat.pre_reply@1`（gate / all）、`chat.reply@1`（enhance / all）
- calls：无
- 数据访问：无（不读历史、不改 system）
- 兼容：`compat: "api3"`；宿主用旧版消息插件信封喂给 Wasm，再把输出投影回新 schema
- 最低客户端：4.3.0

## 行为

- 回复后：记录「还能再顺接 3 句」的窗口。
- 回复前：判断当前消息是否来自刚回的那个人；不是同一人、超时、纯捧场、在叫别人、额度用完都不接；命中追问线索时返回 `wake`，其余返回 `pass`。

## state、wake 与接话闭环

- `state`：宿主已实现「安装包摘要 × `platform` × `chatType` × `chatId`」隔离的会话 state（首次 `{}`、输出校验通过后保存、单项 ≤8 KiB、单插件最多 200 个会话 LRU、停用/卸载/更新清除、进程重启丢失）。本插件通过 `compat:"api3"` 收到真实 state，回复后记录的窗口状态可以跨轮保存。
- `wake`：宿主已实现真正的唤醒：gate 在宿主基础闸之后、`wake` 早退之前询问；返回 `wake` 可以让本来不会回复的消息开口（reason `plugin_wake`），`skip` 压制已触发的消息，`pass` 保持原判定；提供者异常按 `pass`（fail-open）。
- `now` / `lastBot`：旧信封带宿主毫秒时间 `now` 和本会话最后一条助手回复的受控投影 `lastBot{text, at, targetId}`（没有时为 `null`）。本插件用 `lastBot.at` 判定 180 秒窗口，时间与宿主存档同源，不再用插件进程自己的时钟。
- 3 级 `chat.received@1` + compat：hook 已映射为 `chat.received`，输出按 observe 投影为 `{}`，不会再出现「安装成功、第一次派发就 invalid_wasm_compat / invalid_wasm_output」。

## 与迁移前的差异

- 旧版的两个独立钩子对应新协议两个 provider；调用时机与输入裁剪由新宿主统一链决定，gate 只处理 `skip`/`wake`/`pass`。
- `compat: "api3"` 仅保证旧信封字段与 whale 导入名兼容；旧版的 `chat.received` 已映射（observe，返回值丢弃），`chat.dispatched` 等 3 级未开放的能力不会因为这个兼容字段自动出现。
- 无 calls、无数据访问；失败时宿主按 gate fail-open / enhance 退化处理，不影响正常回复。
