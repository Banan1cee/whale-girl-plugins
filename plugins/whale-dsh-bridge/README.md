# DSH 桥接（whale-dsh-bridge）2.0.2

- 等级：**4 级 · Node.js（node-full）**
- 扩展点：`chat.generate@1`（replace / all）
- 宿主能力：`model.complete@1`（未启用/无 token/无文本/出错时交回原模型）
- 最低客户端：4.3.0
- 旧版对照：`legacy/plugin.json` + `legacy/plugin.js`（旧版没有 README）

## 设置

`url`（默认 `http://127.0.0.1:57321`）、`token`、`timeoutMs`、`enabled`、`personaSource`（`whale` / `custom`）。

兼容：旧用户把配置写在插件数据目录 `config.json`。新插件**优先读卡片 settings**，只有当某项设置缺失时才只读回退到旧 `config.json`（不写回、不删除），因此不会出现「双源互相覆盖」；建议用户把值迁到卡片设置后忽略旧文件。

## 从旧版迁移的变化（逐条）

1. **删除 `chat.prompt` 钩子**：新 `chat.generate@1` 输入直接带 `system`，不再需要把 system 缓存到 `state.persona`。DSH 看到的 system 内容取决于宿主本轮拼装，理论上等价，但若有差异需实测对比。
2. **历史来源变化**：旧 `ctx.history`（最多 12 条 `{role,text}`）→ 新 `input.turns`（`{role,content}`，最多 100 条，插件截取最后 12 条）。宿主提供的历史范围（是否含本轮、是否含被忽略消息）可能不同。
3. **`ctx.now` 移除**：messageId 用 `Date.now()`；id 冲突规避逻辑保留。
4. **失败回退方式变化**：旧版返回 `{}` 由宿主回退；新版显式调用 `model.complete@1` 交回原模型（需要模型调用授权，且是一次独立计费调用）。
5. **配置来源变化**：旧以 `config.json` 为主；新以卡片 settings 为主，旧文件只作只读回退。两者同时存在时旧值不会覆盖卡片设置（与旧版相反）。
6. **取消语义**：新增监听宿主 `signal`，被取消时中止本机 fetch 并返回空文本（不会再等待超时）。
7. **保留不变**：DSH wire format（`[[WHALE-BRIDGE v1]]` envelope + persona + 历史 + 当前消息）、SSE/JSON 两种解析、空响应回退、`last-error.json` 诊断、只访问设置地址、不执行 shell、不写别处。

## 已知限制

- `personaSource=custom` 的具体人设文本由 DSH 侧解析，不在本插件范围内。
- 旧 `exports.run`（旧 tool.run 占位）已删除：新协议不再需要，卡片不会出现手动运行。
- 4 级插件可联网；本插件只对设置里的地址发起请求，但宿主无法替用户校验该地址是否可信。

## 网络出口

- **只有一个目标主机**：`askBridge()` 里 `fetch(<url>/v1/chat/completions)` 发 POST，`<url>` 只来自卡片设置 `url`（默认 `http://127.0.0.1:57321`，结尾斜杠会被裁掉），令牌放在 `Authorization: Bearer` 头。没有第二处 `fetch`、没有其它主机、没有代理或 DNS 改写，也不 `listen` 端口。
- 超时受 `timeoutMs` 约束（`AbortController`，下限 1000 ms）；宿主下发的取消信号也会中止本次请求。非 2xx 只回 `http_<状态码>` 类别，不打印响应体。
- 连不上、超时、空文本、出错时都交回原模型：`hostReply()` 调宿主能力 `model.complete@1`，由宿主负责它自己的网络行为。
- 设置留空令牌时插件**不转发**（直接回退），因此默认配置不会外发任何内容。

## 写文件是否原子

- 只写一个文件：插件数据目录（`process.cwd()`）下的 `last-error.json`，内容是 `{at, reason}`，由 `noteFailure()` 用 `fs.writeFileSync` **直接覆盖，不原子**；每次失败整体重写，写失败被 `catch` 吞掉、不影响回复。
- `config.json`（旧配置兼容）只读不写：`legacyConfig()` 读不到或解析失败就返回 `{}`，不会创建、覆盖或删除该文件。
- **未做**：没有临时文件 + rename、没有 `fsync`、没有写锁；诊断文件损坏只会让下次读取拿到空对象，不影响转发。

## 聊天数据声明

清单明确申请 `model.prompt` 与 `chat.history`：生成替换及模型回退会使用本轮系统提示词与会话输入。启用时按声明披露，未授权时宿主不会下发 system，turns 为空数组。
