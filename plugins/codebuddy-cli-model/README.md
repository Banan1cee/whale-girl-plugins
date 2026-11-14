# codebuddy-cli-model · 插件说明

鲸鲸 **4.1.2+** · Api 4 / `Kind=message` / `Permissions=["system.full"]` · **v1.2.0**
`Hooks = ["chat.prompt", "chat.generate"]` · 默认模型 `deepseek-v4.1-flash`

## 安装前置条件（置顶）

**必须先在左侧「插件市场」页顶部第一行勾选「启用 JavaScript 插件（实验性，完整系统权限）」。**
⚠️ 这个开关**不在**左侧「设置」页（设置页只有模型 / 采样等参数，找不到是正常的）。
总开关关闭时宿主的 `installed()` 根本不会收录 Api 4 插件，装了也不会运行、也不会报错。
可用仓库根目录 `tools/enable-javascript-plugins.cmd` 一键开启（先备份，附一键还原）。

插件本身**不会**修改宿主配置：开关没开时插件不加载；且擅自改宿主配置不符合市场安全检测。

## 🔧 怎么改模型（不用手敲）

完整说明见 [`../../docs/换模型.md`](../../docs/换模型.md)，这里只列最常用的：

| 操作 | 命令 / 输入 |
| --- | --- |
| 出编号菜单 | 微信发 `模型`（前 10 个常用）/ `模型 全部`（全部 22 个） |
| 切换 | 出菜单后回一个数字，如 `9`、`选9`、`第9个` |
| 查询 | `当前模型` |
| 还原默认 | `恢复默认模型` |

**v1.2.0 起清单不再声明 `tool.run`**：启动器只在 `Hooks.Contains("tool.run")` 时
渲染「手动运行 / 运行一次」那一整块，所以卡片「设置」页现在**只有最上面一个配置框**，
中间输入框和结果框都不再显示。换模型全部在微信里完成。

选择写入鲸鲸官方 `whale.paths.pluginData` 目录下的 `model-choice.json`，
**内容只有一个模型 ID**，升级插件会保留，不含 Key / 聊天内容 / 路径。
数字只在出菜单后 10 分钟内有效，平时发「3」不会误触。

⚠️ **卡片设置里的 `model` 留空，编号菜单才生效。** 优先级：
卡片 `model` > 本机已保存的选择 > 本次会话选择 > 内置默认 `deepseek-v4.1-flash`。

## 🔑 设置框怎么填（先读这段）

卡片「设置」页 **唯一的大框**（标题「… · 消息流程设置」）是配置输入，
内容必须是**一个完整的 JSON 对象**，不是一串裸文本。最小配置：

```json
{"apiKey":"在这里粘贴你的 CodeBuddy API Key"}
```

> 💡 懒得敲就运行仓库根目录 `tools/prefill-settings.cmd`：这段模板会**直接出现在设置框里**
> （先备份、自动生成一键还原），只需把示例文字换成自己的 Key。
> 模板里的示例文字会被插件识别为「未配置」，不会被当成真 Key 去调用 CLI。

填完点「保存设置」。宿主要求 `grant.settings` 是对象：用 4.1.2 宿主真实
`JavaScriptPlugins.installed()` 实测，**裸字符串会让插件直接不被加载**
（`installed()` 返回 0，连错误提示都没有），空对象 `{}` 能加载但没有 Key、
会回退原模型。所以 `{ck_xxx…}`、`ck_xxx…`、只填 Key 都**不行**。

**插件会在微信里主动给提示**：缺 Key 时回复里带可复制的模板和「最省事改法」
（在已粘的 `{ck_…}` 里，`{` 后加 `"apiKey":"`、`}` 前加 `"` 即可）。
`apiKey` 的常见别名（`key` / `api_key` / `token`）也能识别。

验证是否生效：发一条**普通**消息（不要发「模型」），没出现
「【CodeBuddy 直连 · 还没配置】」开头的提示才算成功。
> ⚠️ 发「模型」能收到菜单**不能**证明配置成功——菜单命令不读 Key、也不调用 CLI。

Key 只填一次；之后换模型用编号菜单，不必再动设置。

## 卡片「设置」项

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `apiKey` | **必填** | 你自己的 CodeBuddy API Key。只存在本机授权文件里，**不在安装包里**。也接受 `key` / `api_key` / `token` 等别名。 |
| `model` | **留空**（→ `deepseek-v4.1-flash`） | 填了就**固定**成这个值，且优先级最高。可填编号 `2`、别名 `ds` / `glm` / `fast` 或完整 ID；大小写不敏感；目录外 ID 原样透传给 CLI。**想用编号菜单就保持留空。** |
| `cliEntry` | 自动发现 | CLI 入口脚本路径。留空时按常见全局安装位置探测；装到非默认位置就手填。 |
| `cwd` | 用户主目录 | CLI 工作目录。 |
| `timeoutMs` | `110000` | 单次 CLI 超时（1000–115000）。清单 `ExecutionTimeoutMs=120000`。 |
| `useHostSystem` | `true` | 把鲸鲸的人设/规则作为 `--system-prompt` 传给 CLI（最长 12 000 字节）。 |
| `historyTurns` | `0` | 拼接最近 N 条聊天记录（0–12）。**默认不发送聊天记录**；开启后聊天片段会交给 CLI，可能产生费用。 |
| `skipPatterns` | 空 | 逗号/换行分隔的关键词；命中时插件不接管，保留宿主原回复。推荐 `提醒,取消提醒,提醒列表`。 |
| `internetEnvironment` | 空 | 需要内网环境的用户可填 `internal`；默认不注入。 |
| `onError` | `notify-once` | `notify-once` = 每个会话首次失败提示一次、之后静默回退；`fallback` = 全程静默。 |
| `debug` | `false` | 在失败提示里追加错误类别码（仍不回显 stderr / Key / 路径）。 |

> 「模型 / 当前模型 / 恢复默认模型」和菜单后的纯数字是**插件命令**，会被接管而不交给模型；
> 如果这些词命中了 `skipPatterns`，命令也会被跳过。

## 工作原理

```
chat.prompt  ── 把 input.system 存进按会话隔离的 state（不改提示词）
chat.generate ── 先判模型命令（菜单 / 选择 / 查询 / 还原，不需要 Key）
                 → 否则读 state.system + input.message.text
                 → readKey()：apiKey / 别名 / 自定义键名，占位文字视为未配置
                 → resolveModel()：卡片 model > 已保存选择 > 会话选择 > 默认
                 → spawn(node <cliEntry> -p <prompt> --output-format json
                         --no-session-persistence --tools "" --max-turns 1
                         --port <动态端口> --model <model> [--system-prompt ...])
                 → 解析 type=result 的 result 字段
                 → 清洗控制字符 / @所有人 / 长度
                 → 返回 { text }，宿主跳过默认模型调用
```

几个来自宿主源码的真实约束：

- `chat.generate` 的 input **不含 `system`**，也不含 `canned` 标记；`chat.prompt` 才带 system。
  两者共用同一会话 key 的 state，所以先存后取。state 是**整体覆盖**写入，返回时必须合并。
- 只要 `chat.generate` 返回 `text`，宿主就把它当作本轮回复；提醒确认等规则话术也会被覆盖，
  插件无法自动区分，只能靠 `skipPatterns`。
- `text` 上限 16 000 字符，含控制字符或 `@所有人` 会被宿主判 `invalid_text`，
  所以本插件会先自行清洗，避免整轮回退。
- worker 的环境变量被宿主裁剪过（只有 SystemRoot/PATH/TEMP/TMP/LANG），
  Key 必须从卡片设置显式注入，不能依赖继承。
- worker 会把 `whale` SDK 直接注入 hook 入参（`ctx.whale` / `ctx.host`），
  `whale.paths.pluginData` 是官方的插件持久目录；离线测试传入同形状的 mock 即可。

## 构建与测试（零依赖，只需 Node）

```bash
cd plugins/codebuddy-cli-model
node build.js                 # 从 plugin.json 读版本，生成 ../../packages/<id>-<version>.zip
node tests/run.js             # 52/52 离线契约测试（mock CLI，无需 Key / 网络）
WHALE_ROOT=<鲸鲸目录> node tests/host-e2e.js   # 宿主真实执行器端到端
```

`build.js` 用固定时间戳生成 ZIP，同样源码 → 同样 ZIP（便于核对哈希）。
ZIP 根目录只允许 `plugin.json` 和 `plugin.js` 两个文件。

市场校验（在仓库根目录跑）：

```bash
python tools/privacy-scan.py --path .          # 必须 0 findings
# 官方 validate.py 需要临时拼一个 index-v4.json 条目，详见根目录 README 的验证记录
```

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 装了完全没反应 | 十有八九是总开关没开；开关在「插件市场」页顶部，不在「设置」页。看 `GET /api/plugins/capabilities` 的 `enabled`。 |
| 提示「还没配置」 | 大框填的是 `{}` 或没点「保存设置」；改成 `{"apiKey":"你的Key"}` 再保存。缺 Key 时插件会把模板直接发到微信里。 |
| 框里还是示例文字 | 把「在这里粘贴…」整段换成自己的 Key 再保存；示例文字不会触发 CLI 调用。 |
| **保存设置后插件完全没反应** | 配置框里粘了裸 Key / `{ck_xxx…}`，不是 JSON 对象，宿主会拒绝加载插件；按上一节改成 `{"apiKey":"..."}`。 |
| 提示「没找到 CLI 入口」 | 在设置里填 `cliEntry`；可用 `npm root -g` 查全局目录，再拼 `@tencent-ai/codebuddy-code/bin/codebuddy`。 |
| 提示「鉴权失败」 | Key 无效或过期，换一个；也确认填的不是示例文字。 |
| 经常超时 | 调大 `timeoutMs`，或换更快的模型（发「模型」选编号 1–5）；清单上限是 120 000 ms。 |
| **选了模型没生效** | 卡片设置 `model` 还填着值（优先级最高），清空即可；更新插件后要重新启用。 |
| 发「模型」没反应 | 总开关 / 插件启用状态 / 该轮是否被宿主接话判定挡掉；或 `skipPatterns` 命中。 |
| 想固定回某个模型 | 发「恢复默认模型」，或在卡片 `model` 直接填完整 ID。 |
| 提醒功能变了 | 填 `skipPatterns`，或停用本插件。 |
| 想彻底不提示 | `onError=fallback`。 |
| Windows 安全软件报 `reg.exe` | CLI 在探测系统代理，通常不影响结果；本插件不为此放行或重试。 |

## 隐私边界

源码里没有 API Key、账号、主机名、绝对路径或真实聊天数据。
不写日志、不落盘聊天内容、不主动发消息、不修改宿主配置；
用户输入通过 argv（`shell:false`）传递；CLI 禁用工具与会话持久化。
错误提示只含类别码，不回显 stderr / Key / 路径。
缺 Key 时发出的提示里只有配置模板（占位文字），不含任何真实 Key。

**唯一写盘**：菜单选模型时写 `<插件数据目录>/model-choice.json`，内容仅 `{"model":"<id>"}`。
不写 Key、聊天记录、时间戳或路径；不发往任何外部服务。
