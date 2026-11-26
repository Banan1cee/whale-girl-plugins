# 锐评（ruiping）2.0.2 · whale-plugin/1

- 等级：**4 级 · Node.js（完整系统权限）**
- 扩展点：
  - `chat.search@1`：`replace` / `all`
  - `chat.pre_reply@1`：`gate` / `all`
  - `chat.generate@1`：`replace` / `all`
  - `tool.run@1`：`tool` / `manual`
- 调用（最小集）：`search.query@1`、`model.complete@1`
- 最低客户端：鲸鲸 4.3.0
- 版本：2.0.2（旧 Api 4 的 1.1.0 迁移；2.0.1 修跨进程搜索缓存；2.0.2 移除仅供测试的 `__test` 调试导出）

## 行为

1. **聊天搜索**：命中「锐评/暴论」关键词且设置 `inChat=true` 时，用整理后的事件检索事实；返回 `{status,text,items}`，并把本轮结果写进 worker 私有 cwd 的 `ruiping-search-cache.json` 供生成阶段复用（插件自己的文件缓存，不是宿主 state：键 = `chatType`+`chatId`+`text`，3 分钟 TTL，最多 16 条，取一次即删，单条 >128 KiB 不缓存）。未命中/关闭时返回空搜索。
2. **前置闸**：`wake=true` 且命中关键词时返回 `{action:'wake'}`，否则 `pass`；不会 `skip` 普通消息。
3. **生成**：优先复用同一消息的搜索缓存，否则重新检索；资料不足或数字无法核对时返回固定说明；模型/检索故障返回空文本（见差异 4）。
4. **手动工具**：卡片「设置 → 运行一次」输入事件或 JSON，返回完整诊断 JSON（含证据/候选/耗时）。

## 与旧 Api 4 逐条差异

1. **入口/权限**：旧 `Api 4` + `Hooks` + `Permissions: system.full` 改为 `whale-plugin/1`、`level: 4`、`node-full`；启用必须确认完整系统权限。旧 `Hooks: chat.search/chat.pre_reply/chat.generate/tool.run` 改名为 `chat.search@1`/`chat.pre_reply@1`/`chat.generate@1`/`tool.run@1`。
2. **`chat.pre_reply` → gate**：旧实现返回 `{}` 或 `{action:'wake'}`；新协议 `gate` 允许 `pass`/`skip`/`wake`。本插件命中关键词且 `wake=true` 时 `wake`，其余 `pass`；不再有“交回宿主”的隐式空对象。
3. **搜索输出字段缩减**：旧 `whale.search` 返回 `provider`、`attempts`、`dateFilter`、`requested`，新 `search.query@1`/`chat.search.output@1` 只有 `{text,items{title,url,snippet,publishedAt,fetchedAt},status}`；**渠道/尝试/日期过滤/请求回显已删除**，`showProvider` 设置不再有意义并从 settingsSchema 移除。
4. **生成失败不能回退宿主**：旧 `chat.generate` 失败返回 `{}`，宿主继续内置生成；新 `chat.generate@1 replace` 的输出必须是 `{text}`，没有“本插件不处理”的返回。失败时本插件返回空文本，宿主按 `plugin_empty` 处理（不发送），不会静默切回宿主生成。
5. **`replace` 独占互斥**：`chat.search@1` 与 `chat.generate@1` 都是 `replace`；同一能力/作用域只能有一个提供者，**不能与其它 search/generate 替换插件同时启用**，冲突会在调用前报 `capability_owner_conflict`。需要叠加请改用 `enhance`（本迁移按用户要求保留 replace）。
6. **模型参数缩减**：旧 `whale.model` 支持 `thinking`；新 `model.complete@1` 只有 `system/turns/maxTokens`。`thinking` 设置删除，模型调用不再传深度思考。
7. **日期提示**：旧搜索支持 `dateRange`（昨天/今天起止）；新 `search.query@1` 只有 `freshness`（today/yesterday/week/month/year）。`dateRange` 无法等价传入，插件只保留 freshness。
8. **设置迁移**：
   - 旧 `schemaVersion/showProvider/thinking` 删除；
   - `keywords` 从字符串数组改为逗号/空白分隔的字符串；
   - 旧 settings 里残留上述字段会被新 schema 判为非法，需在设置页重新保存（不自动迁移）；
   - 其余字段（mode/maxChars/facts/minItems/freshness/timeZone/inChat/wake/showSources/evidenceItems/searchTimeoutMs/modelMaxTokens）保留，默认值与旧版一致。
9. **来源标注**：旧版按 `items[].provider` 标 DeepSeek/知乎；新搜索结果没有 provider，`renderChat` 不再显示渠道，知乎观点也无法自动区分。
10. **打包内容**：ZIP 只含 `plugin.json` 与 `plugin.js`；`legacy/` 旧 Api 4 两文件仅留档，不打包。

## 适配难点：只有读代码才能解决的

1. **`chat.search.output@1` 删掉了旧搜索元数据**
   - 问题：旧插件依赖 `search.items[].provider`、`search.attempts`、`search.dateFilter`、`search.requested` 做渠道标注、API 失败回退说明和日期提示；新 schema 没有这些字段，`additionalProperties:false` 会拒绝多传。
   - 文件/行号：旧 `plugins/ruiping/plugin.js:315-357`（`normalizeSearch`）、`:674-689`（`hostSearch`）、`:560-581`（模型）；宿主 `src/services/pluginProtocolRegistry.json` 的 `chat.search.output@1`（只有 text/items/status）。
   - 为什么文档查不到：不是文档缺，而是**接口本身不支持**——协议只保留统一检索结果；旧宿主的 provider/attempts/dateFilter 是旧搜索 API 的实现细节，未进入 whale-plugin/1 schema。
   - 绕过：`toChatSearch()` 只输出 schema 允许的字段；`showProvider` 删除；`searchMeta` 仍保留给手动诊断但不再作为聊天输出；日期只传 `freshness`。
2. **`chat.generate@1` 没有“交回宿主”语义**
   - 问题：旧 `chat.generate` 返回 `{}` 让宿主继续内置生成；新 replace 必须返回 `{text}`，空文本会触发 `plugin_empty`，宿主不会自动回退。
   - 文件/行号：旧 `plugins/ruiping/plugin.js:724-741`；宿主 `docs/插件协议.md` 的 replace 说明与 `src/pipeline/bot.js:429-451`（空文本处理）。
   - 为什么文档查不到：**接口本身不支持** pass-through；replace 的语义就是独占生成，协议没有“本插件不处理”的返回。
   - 绕过：失败时返回 `{text:''}` 并在此 README 明确说明；没有尝试伪造宿主生成。
3. **`chat.search` 与 `chat.generate` 之间没有搜索上下文**
   - 问题：旧宿主把本轮 `chat.search` 结果放进 `ctx.search` 供 `chat.generate` 复用；新 `chat.generate.input@1` 只有 message/system/turns，没有 search。
   - 文件/行号：旧 `plugins/ruiping/plugin.js:724-727`（`ctx.search`）；宿主 `chat.generate.input@1` schema。
   - 核实过的宿主语义：`chat.search@1` 与 `chat.generate@1` 是两次独立 invocation，各自新 worker 进程；`chat.generate.input.turns` 是聊天历史，宿主把搜索结果作为散文塞进最后一条 user 消息（`src/persona/prompt.js` 的 `webSearchContext`），拿不回结构化 `items`，`msgId` 也不在 `chat.generate.message` 里（宿主 `src/pipeline/bot.js` 组装）。所以「从 turns 复用结构化 context」不可行。
   - 绕过：worker 私有 cwd 的 `ruiping-search-cache.json`（键=chatType+chatId+text，senderId/msgId 两边都有时再校验），3 分钟 TTL、最多 16 条、取一次即删、单条 >128 KiB 不缓存；`chat.search` 写入、`chat.generate` 取一次，未命中时重新 `search.query@1`，可能多一次检索（README 差异 3/4 已说明）。
4. **`chat.pre_reply@1` 输入曾没有 `replyToBot`（quiet-group 同类问题）—— 已修**
   - 当时：旧 quiet-group 用 `message.replyToBot` 区分“引用回复机器人”与普通群消息；迁移初期的 schema 没有该字段。
   - 现在：`chat.pre_reply.input@1`（以及 prompt/before_send/reply 等同类 message）已包含 `replyToBot`，宿主从桥接的引用回复标记映射；quiet-group 已能按引用回复放行。ruiping 不依赖该字段。
5. **settingsSchema 不支持数组/default**
   - 问题：旧 `keywords` 是字符串数组，`Settings` 有默认值；新 settingsSchema 只允许标量/对象/枚举，没有 `default`，数组也不在 allowedTypes。
   - 文件/行号：旧 `plugins/ruiping/plugin.js:84-108`、旧 `plugin.json`（无 settingsSchema）；宿主 `settingsSchema.allowedTypes/supportedKeywords`。
   - 为什么文档查不到：文档描述了 schema 能力，但**没有说明旧 Settings 如何迁移**；需要读代码确认没有数组/default。
   - 绕过：`keywords` 改字符串并在 `normalizeSettings` 里拆分；默认值由代码兜底；旧数组配置需用户重存。
6. **`gate` 的宿主调用点曾未接入 —— 已修**
   - 当时：协议核心已支持 gate，但 `bot.js` 还没有调用 `chat.pre_reply@1`。
   - 现在：`bot.js` 在宿主基础闸之后、触发判定之后、`wake` 早退之前调用 gate；`skip` 压制本轮、`wake` 可让原本不回复的消息开口、`pass` 保持原判定，提供者异常按 `pass`（fail-open）。ruiping 的 `wake=true` 命中关键词时返回 `wake`，已能真正接话；同一条消息只问一次 gate。

## 设置示例

```json
{
  "mode": "金句",
  "maxChars": 40,
  "facts": 2,
  "minItems": 2,
  "freshness": "",
  "timeZone": "Asia/Shanghai",
  "inChat": true,
  "wake": false,
  "showSources": true,
  "evidenceItems": 4,
  "searchTimeoutMs": 12000,
  "modelMaxTokens": 700,
  "keywords": "锐评,暴论"
}
```

## 打包与校验

```bash
node scripts/package.js plugins/ruiping
python validate.py --root . --json
```

包内 `plugin.json` 与源码逐字节一致；不覆盖旧版本 ZIP（旧 1.1.0 保留）。

