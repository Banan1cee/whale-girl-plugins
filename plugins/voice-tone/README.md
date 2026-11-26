# 语音语气（voice-tone）· whale-plugin/1

这是 `voice-tone` 从旧 **Api 4** 迁移到 **4 级 `whale-plugin/1`** 的降级版。旧源码保留在 `legacy/`，不进入安装包。

> **重要限制**：旧版通过临时改写宿主 `data/voice-send.json` 的 `Probability` 决定“这条发语音还是文字”，并在发送后还原。新协议没有写宿主语音配置/发送通道的能力，`chat.dispatched@1` 只能观察、不能改回设置。因此：
> - `voiceChanceOverride` 字段保留但**不生效**；
> - 不再同步 `voice-send.json` 的 `Instructions`；
> - `chat.before_send` 只在用户**明确要语音**时给草稿加标签，无法确认宿主最终是否走语音，可能出现“文字回复带标签”或“语音没有标签”的偏差；
> - 不写临时概率，避免把用户设置永久改坏。

## 等级与声明

| 项 | 值 |
| --- | --- |
| 等级 | 4（`plugin.js` / `node-full`） |
| provides | `chat.prompt@1`（enhance/all）、`chat.before_send@1`（enhance/all）、`chat.dispatched@1`（observe/all） |
| calls | 无 |
| dataAccess | `model.prompt`（宿主 v2 已支持；市场 validate.py 待同步，见报告） |
| settings | `enabled`、`preset`、`voiceChanceOverride`（迁移占位）、`injectTagRules` |
| 超时 | 20 秒 |

### dataAccess

`chat.prompt@1` 需要读取 `system` 才能追加标签规则。清单已声明：

```json
"dataAccess": ["model.prompt"]
```

宿主 v2 运行时按 `model.prompt` 投影 system（市场 validate.py 仍只允许 3 级，待同步）；若宿主未授予该权限，插件拿不到 system 时会抛错，宿主保留原 system（不会清空提示词），标签规则注入降级。

## 设置

```json
{
  "enabled": true,
  "preset": "",
  "voiceChanceOverride": -1,
  "injectTagRules": true
}
```

- `enabled`：关闭后完全不干预。
- `preset`：内置预设 `irritable`（默认）/`adorkable`/`normal`/`gentle`/`cold`；留空用 `irritable`。旧版 `weixiwei` 自定义预设没有内置，填了会回退默认。
- `voiceChanceOverride`：-1~100，仅为旧设置迁移保留，**不参与任何行为**。
- `injectTagRules`：是否把“只用官方 34 个标签”的规则追加到 system（依赖 `dataAccess:model.prompt`）。

## 行为

- `chat.prompt@1`：`injectTagRules` 为 true 且拿到 system 时，追加标签规范；已有标记不重复追加。
- `chat.before_send@1`：`enabled` 开启、用户消息命中“明确要语音”（`发/来/说/讲/回复…语音`、`用语音`、`听你的声音` 等，且没有“不要语音/文字回复”否决）且 `voiceChanceOverride !== 0` 时，按预设 tags 插入一个官方标签；否则原样返回。
- `chat.dispatched@1`：空观察点；不修改任何状态，不假装能还原概率。

## 和旧版的逐条差异

1. **无法按 voiceChance 决定发语音/文字**：新协议没有发送通道控制；`voiceChanceOverride` 失效。
2. **无法发送后还原 Probability**：没有写宿主语音配置的能力；旧 `prob-state.json` 临时覆盖机制删除。
3. **无法同步 Breeze 语气 instructions**：旧版写 `voice-send.json` 的 `Instructions`/profile；新协议无对应 call，删除。
4. **无法读取 appRoot 的 `data/voice-presets.json`**：新插件只能读自己的 data 目录/设置；本版使用内置 5 套预设，不再自动生成/读取旧预设文件。
5. **标签只按“明确要语音”添加**：旧版能结合 `Probability` 确认发送通道；新协议不能，故仅保留最保守的显式路径，普通文字回复不加标签。
6. **`chat.dispatched` 不再是“还原”回调**：只观察，新协议不允许反向改宿主配置。
7. **`weixiwei` 等自定义预设不再自动可用**：内置只有 5 套；需要自定义只能等后续提供设置/导入能力。
8. **不再直读宿主 config、不走 `/api/*`、不 require('whale')**：全部删除。
9. **没有音频文件发送能力**：本插件本来也不发送音频，只控制标签/语音意图；语音由宿主决定。
10. **dataAccess 已声明**：4 级 `dataAccess:["model.prompt"]` 已随 v2 生效；宿主未授予时 prompt 抛错并保留原 system。

## 旧源码

`legacy/plugin.js`、`legacy/plugin.json` 是迁移前原样文件，供对照/回滚，不打包。旧 README 也保留在 `legacy/README.md`（如有）。

## 验证记录

- `node scripts/package.js plugins/voice-tone`：生成 `packages/voice-tone-2.0.0.zip`。
- `node scripts/plugin-cli.js validate/test`：通过（静态，不执行）。
- 未 GUI 试装、未运行插件、未联网。


