# 小咪叮（xmding · whale-plugin/1 4 级 · 2.0.2）

- 等级：`level 4`（`node-full`，`plugin.js`）
- provides：`tool.run@1`（mode `tool`，scope `manual`）
- calls：`contacts.list@1`、`message.send@1`
- 最低宿主：`minAppVersion 4.3.0`
- 旧 Api 4 源码在 `plugins/xmding/legacy/`，**不打包**；市场同 id 的 v4 旧条目需要由维护者在重建目录时移除（本卡未改 index）。

## 保留的 tool 契约

| action | 输入 | 输出 |
| --- | --- | --- |
| `send` | `{ to 或 chatId, text, delivery?: "text"\|"voice", dryRun?: true }` | 旧字段形状保留：`{ok, action, queued, delivered:false, confirmed:false, id, status, chat, note}`；`dryRun` 只解析目标 |
| `list` | `{ q?, type? }` | `{ok, action:"list", account, total, count, truncated, items:[{wxid,name,isGroup}]}` |
| `ping` | 无 | 版本/作者/等级/动作清单 + 已移除能力 |
| `status` | 无 | 明确 `unsupported`：新协议没有回执查询，不伪造送达 |

寻址规则与旧版一致：显式 ID → 精确 ID → 精确名称/备注 → 唯一包含；多命中返回 `ambiguous_target` 与候选。联系人来自 `contacts.list@1`（`plugins/xmding/plugin.js` 的 `resolveTarget`）。

## 2.0.2 修复

- 删除仅供本地测试的 `exports.__test` 调试导出（生产入口只留 `exports.providers`）。

## 2.0.1 修复

- 联系人数组防御：`dedupe` 跳过 `null`/字符串等非对象项；`contacts.list@1` 的 `items` 缺失或不是数组时按空列表处理，不再抛 `TypeError`，走「找不到联系人」的正常分支。
- 用户可见错误只回 `contacts_unavailable` / `xmding_failed` 固定文案，不回显宿主/内部错误文本（可能含路径、能力名与参数细节）。
- `message.send@1` 的 `chatId`/`name` 按 registry 上限截断（120/80），超长显式 ID 在调用前返回 `invalid_target`。

## 逐条差异（旧 → 新）

1. **独立监听转发（默认 0.0.0.0:8790）整段删除**：旧 `plugin.js:687` 的 `http.createServer`、`app.start`(:722)/`app.stop`、`timer.tick` 保活(:712) 全部移除。插件不得监听端口，新协议也没有 `/api/plugins/run` 与宿主 token；原先依赖 `http://127.0.0.1:8790` 的调用方需要改为在市场/宿主里手动运行 `tool.run`。
2. **图片发送删除**：旧 `whale.sendImage`（`legacy/plugin.js:421`）无对应能力；`delivery:"image"` 现在返回 `unsupported_delivery`，不会假装成功。
3. **投递回执查询删除**：旧 `whale.delivery(id)`（`legacy/plugin.js:469`）与 `action=status` 无对应；`message.send@1` 只返回 `{id,status:"queued",confirmed:false}`。新 `status` 返回明确不支持。
4. **联系人接口替换**：旧 `/api/wechat/contacts`（`legacy/plugin.js:236`）改为 `contacts.list@1`；字段 `wxid/name/remark/label/isGroup` 可用。联系人缓存缺失时返回空列表，不再有 `contacts_unavailable` 错误语义，因此"找不到"会走 `target_not_found`/候选分支。
5. **语音语义改变**：旧 `sendVoice` 要求微信与目标会话前台；新 `delivery:"voice"` 只是把"发语音"的意图交给宿主语音通道，是否 TTS/前台由宿主决定，插件不再承诺。
6. **app.start/app.stop 删除**：没有启停回调；停用后没有"恢复/清理"逻辑，也不需要（relay 已删）。
7. **宿主配置/token 读取删除**：不再读 `config.json` 的 `server.port`、`gateway.wechat.inboundToken`；`port/bind` 等 relay 设置没有对应字段。
8. **queued 语义**：旧版也强调 queued≠送达；新版连 `status` 都没有，用户可见的"查回执"功能缺失。
9. **多行换行**：旧版默认把 `\n` 换成 VT 以绕过旧 bg_sender；新发送队列未验证。本迁移默认原样发送，保留 `keepNewline:false` 作为可选压缩单行开关（未验证）。

## 适配难点：只有读代码才能解决的

1. **`host.call` 的真实签名与能力表不在市场文档里**：市场 `README.md`/`docs/api4.md` 只描述旧 Api 3/4，没有 whale-plugin/1 的 `host.call` 能力输入/输出。只能读宿主 `src/services/features/contacts.js:51`（`contacts.list@1` 的 `{q,type}` 与 `items` 字段）、`src/services/features/message.js:26`（`message.send@1` 必须有 `chatId/text/chatType`，返回 queued 不等于送达）、以及 `src/services/pluginProtocolRegistry.json:1119` 的 schema。绕过：按代码实际字段实现，不透传旧 `/api/*` 字段名。
2. **provider 的函数签名与导出形状**：协议文档没写"入口文件必须 `exports.providers = { '能力@版本': async (input, {host, settings}) }`"；只有 `examples/whale-plugin-v5/tool-node/plugin.js:6` 和宿主 `unifiedPluginRuntime.js` 的 provider 调用代码能确认。文档缺 → 读示例与运行时。
3. **`task.tick@1` 的输入结构**：文档只说"定时"，实际字段 `{scheduledAt, now, settings}` 只出现在 `src/services/pluginProtocolRegistry.json:1119`（`task.tick.input@1`），`settings` 由宿主注入。绕过：按 schema 解构 `input.settings`，不依赖旧 `ctx.state`。
4. **`settingsSchema` 的校验边界**（本插件用到 `keepNewline`）：哪些关键字/注解允许、`title` 不能为空、注解长度限制，只能从 `validate.py:305-369` 与宿主 `capabilitySchema.js` 反推；文档没有列出。绕过：只用 `type/title/description/properties/additionalProperties` 最小集合。
5. **打包用哪个入口文件**：`scripts/package.js:64-71` 按 `protocol.json` 的 `levels[level].runtime/entry` 选入口；文档只说"ZIP 两个文件"。绕过：运行 `node scripts/package.js plugins/xmding` 生成，`legacy/` 自动不进包。

