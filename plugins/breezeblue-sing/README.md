# Breezeblue 翻唱（breezeblue-sing）· whale-plugin/1

这是 `breezeblue-sing` 从旧 **Api 4 JavaScript** 迁移到 **4 级 `whale-plugin/1`** 的版本。旧源码完整保留在 `legacy/`，不进入安装包。

> **与 `breeze-sing` 共用同一份引擎代码**：两个目录的 `plugin.js` 逐字节相同（SHA-256 `9973ccd0cabd3c07a83ee210d6ea093603d015a217656e4eb4ec5b3f4c0f1188`，34959 字节），`plugin.json` 只有 `id`/`name`/`author`/`version` 四个字段不同（`description`、`settingsSchema`、`provides`、`calls` 完全一致）。也就是说两者是同一实现的两个目录条目，不是两套功能；改行为时两个目录都要改。是否合并成一条由维护者决定（见市场仓库 issue）。

> **先看限制：本版本不能把翻唱音频发成微信语音。**
> 新协议没有音频文件投递能力；`message.send@1` 的 `delivery:'voice'` 只是让宿主用文本走语音通道，不能送出 `[[cover:<id>]]` 或任意音频文件。旧版“本地发送器直接发微信语音”的链路在新协议下不存在；点歌、渲染、队列仍保留，成品留在本机 cover 数据目录，需要手动播放。

## 等级与声明

| 项 | 值 |
| --- | --- |
| 等级 | 4（`plugin.js` / `node-full`） |
| provides | `chat.pre_reply@1`（gate/all）、`task.tick@1`（schedule/all，10 秒）、`tool.run@1`（tool/manual） |
| calls | `message.send@1`（只发文本/语音意图；没有音频文件） |
| settings | `coverCli`、`dataDir`、`python`、`ffmpeg`、`engine`（仅 seedvc）、`maxSeconds`、`onlyGroup`、`autoRender` |
| 超时 | 单次 20 秒；渲染在 detached 子进程，不占 20 秒预算 |

4 级 Node 仍是完整系统权限，不是沙箱；插件会启动本机 `cover.mjs` / `breeze-prep.mjs`，安装前请自行审查。插件不读宿主 config，不调 `/api/*`，不注册端口。

## 设置

全部设置在插件卡片「设置」；卡片会把设置作为 `ctx.settings` 传给入口。留空/缺省时使用以下默认值：

```json
{
  "coverCli": "",
  "dataDir": "",
  "python": "",
  "ffmpeg": "",
  "engine": "seedvc",
  "maxSeconds": 54,
  "onlyGroup": true,
  "autoRender": true
}
```

- `coverCli`：本机 `whale-cover/tools/cover.mjs` 路径；留空按 `~/whale-cover/tools/cover.mjs`、desktop profile 的 `dsh-whale-cover` 顺序查找。
- `dataDir`：`orders/`、`work/`、`prep-status/`、`songs/` 根目录；留空用 `WHALE_COVER_DATA_DIR`，再留空用 `~/.dsh/whale-cover`。
- `python` / `ffmpeg`：只供 `breeze-prep.mjs` 使用；留空走默认路径。
- `engine`：当前只支持 `seedvc`。旧 RVC 订单不会被本插件处理。
- `maxSeconds`：10–180，默认 54。
- `onlyGroup`：默认 `true`；私聊只响应「唱」，不接管「点歌」。
- `autoRender`：默认 `true`；关闭后 `task.tick` 不做自动渲染，仍可用手动工具。

## 命令（聊天内）

宿主基础闸（禁言/白名单/去重/静音）通过后，`chat.pre_reply@1` 就会收到消息并处理这些命令；**不要求消息已经 @ 或已经被判定要回复**：

- `点歌 起风了`
- `点歌 起风了 - 买辣椒也用券`
- `点歌帮助` / `点歌菜单`
- `点歌单` / `排队`
- `取消点歌 起风了`
- `唱 起风了`：只返回文本说明成品位置；**不会发语音/音频**

插件用 `message.send@1` 发回复后返回 `{action:'skip'}`，宿主不再发默认回复。当前 `chat.pre_reply@1` 在宿主基础闸之后、`wake` 早退之前调用：`skip` 压制已触发的回复，`wake` 可让原本不回复的消息开口（本插件不返回 `wake`），`pass` 保持原判定。因此未 @ 的群友发「点歌」也会进入插件并落单，只要它没被禁言/白名单/去重/静音或「明确在叫别人」挡下；被挡下的消息不会进入 gate。需要完全绕开宿主闸时，请用私聊、@ 或手动工具。

## 手动工具

卡片「设置 → 运行一次」输入 JSON：

```json
{ "action": "status" }
```

支持：

- `{"action":"status"}`：返回 cover 队列 JSON（不发送消息）。
- `{"action":"order","chatId":"...","chatType":"group","senderId":"...","senderName":"...","chatTitle":"...","text":"点歌 起风了"}`。
- `{"action":"list","chatId":"...","chatType":"group"}`。
- `{"action":"cancel","chatId":"...","senderId":"...","senderName":"...","song":"起风了"}`。
- `{"action":"sing","chatId":"...","chatType":"group","song":"起风了"}`：只回文本说明。
- `{"action":"tick"}`：立即跑一轮自动队列。

`chatId` 是宿主会话 id；`name` 仅展示，不能按群名搜索会话。

## 和旧版的逐条差异

1. **翻唱音频无法发语音（最严重）**：删除 `whale.sendVoice('[[cover:<id>]]')` 与 `cover voice ensure`；旧“本地发送器直接发微信语音”的链路不再存在。成品只能留在本机 cover 目录。
2. **聊天内点歌触发范围恢复**：旧 `chat.pre_reply` 在触发判定前运行；迁移初期新宿主只在已决定回复时调用 gate，未 @ 的群消息进不来。**已修**：当前 gate 在宿主基础闸之后、`wake` 早退之前调用，`skip` 压制默认回复，所以未 @ 的群友点歌也能落单；仍受禁言/白名单/去重/静音、以及宿主「明确在叫别人」判定约束，且本插件不返回 `wake`。
3. **删除宿主语音签名同步**：旧插件读宿主 `data/voice-send.json` 并调 `cover engine ref`；新协议没有对应宿主 config/call，相关代码已删除。参考音请在本机 cover 引擎配置。
4. **删除 `whale.*` 与 `/api/*`**：旧代码只用 `whale.sendText/sendVoice`，现改为 `host.call('message.send@1')`；不再读宿主目录/环境私货。
5. **不用宿主会话 `state`**：宿主的 state 通道现在可用于 `chat.pre_reply@1` 等聊天能力，但它是「插件 × 会话」级、≤8 KiB/200 会话且进程重启丢失；本插件的点歌队列/去重/自动渲染状态跨会话、跨 tick，所以继续写插件 data 目录（`process.cwd()`）的 `auto-state.json`、`recent.json`、`tick.lock`。旧版的模块级 `recent` 不再跨调用保留。
6. **`timer.tick` → `task.tick@1`**：10 秒间隔保留；每次是新执行上下文，队列由 `auto-state.json` 恢复；用 `tick.lock` 防重叠。
7. **旧设置不继承**：旧插件的授权 settings 不会自动映射到新的 `settingsSchema`，需要重新填写；缺省值见上。
8. **市场 id**：沿用 `breezeblue-sing`，版本升到 `2.0.0`；合并后 `build-index.js` 会从 `index-v4.json` 移除旧条目并生成 `index-v5.json`。旧包 `packages/breezeblue-sing-1.0.0.zip` 保留，不覆盖。
9. **引擎仅 seedvc**：旧 RVC 订单不会处理；schema 也不再提供 `rvc` 选项。
10. **README 宣称的 cookies / 主人1/主人2 / 闲时主动唱歌**：旧代码本来就不含这些逻辑，迁移后也没有本地发送器/宿主补丁入口；不要按旧 README 的承诺理解。
11. **没有 `ResultLabel`、没有 HostAction**：新协议清单没有这些字段；本插件只保留手动 `tool.run@1` 与文本回复。

## 旧源码

`legacy/plugin.js`、`legacy/plugin.json`、`legacy/README.md` 是迁移前原样文件，供对照/回滚，不会被打进 ZIP（`scripts/package.js` 只打包根目录的 `plugin.json` + 入口）。

## 验证记录

- `node scripts/package.js plugins/breezeblue-sing`：生成 `packages/breezeblue-sing-2.0.0.zip`。
- `node scripts/plugin-cli.js validate plugins/breezeblue-sing` / `test`：通过（静态，不执行）。
- `python validate.py --root . --json`：在生成 `index-v5.json` 的镜像根上通过；详见迁移报告。
- 未 GUI 试装、未运行 cover/seed-vc/ffmpeg、未联网。
