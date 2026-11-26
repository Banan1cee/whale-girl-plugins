# CodeBuddy CLI 直连（codebuddy-cli-model）2.0.2

- 等级：**4 级 · Node.js（node-full）**
- 扩展点：`chat.generate@1`（replace / all）
- 宿主能力：`model.complete@1`（跳过/失败/未配置时交回原模型）
- 最低客户端：4.3.0
- 旧版对照：`legacy/plugin.json`、`legacy/plugin.js`；旧 `build.js`/`tests/` 保留在目录里便于离线回归（不参与打包）

## 设置

`apiKey`、`model`、`cliEntry`、`cwd`、`internetEnvironment`、`useHostSystem`、`historyTurns`、`skipPatterns`、`onError`（notify-once / fallback）、`debug`、`timeoutMs`。

## 从旧版迁移的变化（逐条）

1. **删除 `chat.prompt` 钩子**：新 `chat.generate@1` 输入直接带 `system`，不需要再借 prompt 把 system 存进会话 state。正常路径等价；若宿主新版 system 的拼装内容有差异，CLI 看到的人设可能略有不同。
2. **会话状态改为插件文件**：菜单有效期、失败「只提示一次」标记从 `input.state` 移到 `state.json`（按 `chatId|senderId`）。多进程并发时可能互相覆盖；文件损坏会导致重复提示。
3. **模型选择持久化仍在插件数据目录**：`model-choice.json`，只存模型 ID，不含 Key 或聊天内容。
4. **非接管路径改为显式回退**：旧版返回 `{}` 让宿主用原模型；新版调用 `model.complete@1`。需要模型调用授权，且这是一次独立计费调用（与宿主内置生成同模型，但不是同一条内部调用路径）。
5. **历史格式变化**：旧 `input.history` 是 `{role,text}`；新 `input.turns` 是 `{role,content}`，且宿主提供的历史范围可能不同（`historyTurns` 截取逻辑保留）。
6. **`ctx.now` 不再提供**：菜单 TTL 与 message 相关时间改用 `Date.now()`；无实质行为差异。
7. **保留不变**：CLI 调用方式（`-p`、`--output-format json`、`--no-session-persistence`、`--tools ""`、`--max-turns 1`、`shell:false`、argv 传参）、Key 占位识别、错误只给类别码、不写日志、不回显 stderr/Key、菜单命令与编号切换、`skipPatterns` 保护词、默认不发历史。
8. **失败提示文案**：去掉了旧的「复制模板」长文案，只保留明确的「去设置填 apiKey」提示；`onError=fallback` 时静默交回原模型。
9. **端口不再监听**：旧实现用 `net.createServer().listen(0,'127.0.0.1')` 探测空闲端口，违反「插件不监听端口」约定。2.0.1 改为给 CLI 一个 20000–59999 的随机高位端口提示，插件本身不 bind/listen；端口被占用时 CLI 可能报错，会换一个随机端口重试一次，仍失败则按 `cli_error` 交回原模型。冲突概率约为 1/40000，不能完全消除。
10. **CLI 输出上限**：stdout/stderr 各自最多 1 MiB；超过会终止子进程并返回 `output_limit`，避免异常输出撑爆内存。

## 已知限制

- 4 级不是沙箱：插件可起本机进程、可联网（由 CLI 自身行为决定）。启用时必须确认完整系统权限。
- 若宿主未授权 `model.complete@1`，失败/跳过路径无法交回原模型（会直接报错或按提示返回），不会伪造回复。

## 网络出口

- **插件自身没有 HTTP 客户端**：只 `require` `node:fs`、`node:os`、`node:path`、`node:child_process`，没有 `fetch`/`net`/`http`/`dgram`，也不 `listen` 端口。
- **真正出网的是被 spawn 的 CodeBuddy CLI 子进程**：`runCli()` 用 `spawn(process.execPath, [entry, '-p', …])` 起子进程（`shell:false`、参数走 argv、`--tools ""`、`--max-turns 1`、`--no-session-persistence`）。目标地址与协议由该 CLI 自己决定，本插件不代理、不解析、不重写请求。
- 子进程环境由 `cliEnv()` 组装：剔除继承来的 `CODEBUDDY_*`/`WORKBUDDY_*` 与 `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY`，再注入 `CODEBUDDY_API_KEY` 与可选的 `CODEBUDDY_INTERNET_ENVIRONMENT`——**插件不替用户决定代理**，也不会把宿主环境里别的密钥一起带进去。
- 插件不监听端口：`randomCliPort()` 只生成 20000–59999 的随机数交给 CLI 的 `--port`，不 bind、不探测；端口冲突只表现为 CLI 报错，随后换一个随机端口重试一次。
- 另一条出口是宿主能力 `model.complete@1`（`hostReply()`，回退原模型），由宿主负责实际网络行为。

## 写文件是否原子

- 只写插件数据目录（`dataDir()` = worker 的 `process.cwd()`）：`model-choice.json`（只存模型 ID）与 `state.json`（菜单有效期、「已提示一次」标记），都走 `writeJson()`。
- `writeJson()` 的顺序是 `mkdirSync` → 写 `<file>.tmp` → `fs.renameSync`；rename 抛错时退回直接覆盖原文件再删 `.tmp`。**同目录 rename 是原子的，降级路径不是**；**未做** `fsync`、文件锁和跨进程互斥。
- `clearChoice()` 在用户发「恢复默认模型」时删除自己的 `model-choice.json`，不碰别的路径。
- 不写日志、不落盘 CLI 的 stdout/stderr（只在内存里保留，且各自上限 1 MiB，超过就杀子进程并返回 `output_limit`）。

## 聊天数据声明

清单明确申请 `model.prompt` 与 `chat.history`：生成替换及模型回退会使用本轮系统提示词与会话输入。启用时按声明披露，未授权时宿主不会下发 system，turns 为空数组。 `historyTurns` 默认 0，向外部 CLI 发送历史仍由该设置控制；申请历史权限也供宿主模型回退使用。
