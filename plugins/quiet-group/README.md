# 群聊安静模式（quiet-group）

- 等级：**4 级 · Node.js（完整系统权限）**
- 扩展点：`chat.pre_reply@1`（`gate`，`scope: all`）
- 调用：无（`calls: []`）；不联网、不读写文件、不监听端口、不调用 `/api/*`
- 最低客户端：鲸鲸 4.3.0
- 版本：1.1.1（旧 Api 4 的 1.0.0 → whale-plugin/1）

## 行为

在宿主前置闸（禁言/白名单/去重/静音等）之后、决定是否回复与生成之前运行：

1. 非微信群消息：`pass`。
2. 群会话 ID 不在 `settings.groups` 名单：`pass`。
3. 名单内的普通群消息：`skip`。
4. 名单内明确 `atMe: true` 或 `replyToBot: true`（引用回复机器人）：`pass`。

`groups` 是逗号/中文逗号/空白分隔的会话 ID，默认空字符串；留空时所有群都沿用宿主规则。

## 与旧版逐条差异

1. **入口协议**：旧 `Api 4 / Hooks: chat.pre_reply` 改为 `whale-plugin/1` 的 `chat.pre_reply@1` gate；旧 `Permissions: system.full` 改为 4 级 Node 授权，安装/启用时必须确认完整系统权限。
2. **清单字段**：删除旧 `Id/Name/Api/Kind/Hooks/Permissions/ResultLabel/Settings` 等字段，改为新协议 `format/level/id/name/author/version/minAppVersion/description/entry/runtime/provides/calls/settingsSchema/executionTimeoutMs`。
3. **`replyToBot` 已可用**：`chat.pre_reply.input@1` 的 `message` 里有可选的布尔 `replyToBot`（宿主 `providerMessage()` 用 `Boolean(msg.replyToBot)` 归一，所以插件拿到的要么是 `true`、要么是 `false`，不会是别的类型）。**何时为 `true`**：桥接把 `reply_to_bot` / `replyToBot` / `quote_from_bot` / `is_reply_to_bot` 任一标记映射上来（`src/adapters/gateway.js`），也就是这条消息确实是「引用回复机器人」；桥接没给标记时是 `false`，按普通群消息处理。引用回复机器人的群消息会按旧版语义放行，`atMe` 仍照旧放行。迁移期曾有一段时间没有该字段，插件当时保留的读取分支现在直接生效，**旧包（`legacy/` 的 Api 4 版）不需要改**。
4. **设置迁移**：旧 `Settings[0].Key = groups` 改为 `settingsSchema.properties.groups`，仍是字符串、默认空；旧设置值可原样复制。
5. **gate 语义**：多个 gate 提供者按 id 顺序询问，`pass` 继续，首个 `skip`/`wake` 生效；本插件只返回 `pass`/`skip`。提供者报错由宿主按 `pass` 处理（fail-open），不会因插件故障静默吞掉主人消息。
6. **流水线已接线**：当前宿主在 `src/pipeline/bot.js` 的判定阶段调用 `chat.pre_reply@1`（宿主基础闸之后、`wake` 早退之前），本插件不需要额外接入即可生效；`wake` 由其它 gate 插件使用，本插件不返回 `wake`。
7. **打包内容**：ZIP 只含 `plugin.json` 与 `plugin.js`；`legacy/` 下的旧 `Api 4` 两个文件仅留档，不进入 ZIP。
8. **旧 `groups` 空值**语义不变：空名单=全部 pass；不再有“插件自带默认群”的行为。

## 设置示例

```json
{
  "groups": "wxid_group_a,wxid_group_b"
}
```

## 打包与校验

```bash
node scripts/package.js plugins/quiet-group
python validate.py --root . --json
```

包内 `plugin.json` 与源码逐字节一致；不覆盖旧版本 ZIP。

## 适配难点：只有读代码才能解决的（已修，留作历史）

1. **`chat.pre_reply@1` 输入曾没有 `replyToBot`** —— **已修**。
   - 当时：`replyToBot` 不在 message schema 里，引用回复只能按普通消息 `skip`。
   - 现在：宿主把桥接的 `reply_to_bot`/`quote_from_bot` 映射进 message，`chat.pre_reply.input@1` 已包含 `replyToBot`（`src/adapters/gateway.js`、`src/pipeline/bot.js` 的 `providerMessage()`），本插件按 `replyToBot === true` 放行；桥接没给该标记时按普通消息处理。
2. **gate 的流水线调用点曾未实现** —— **已修**。
   - 当时：协议登记了 `chat.pre_reply@1`，但 `bot.js` 没有调用点，插件装上也吃不到消息。
   - 现在：`bot.js` 在宿主基础闸之后、触发判定之后、`wake` 早退之前调用 gate；`skip` 压制本轮，`wake` 可让原本不回复的消息开口，`pass` 保持原判定，提供者异常按 `pass`（fail-open）。本插件只返回 `pass`/`skip`。
