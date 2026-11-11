# 接话窗口（followup-window）

Api 3 消息插件。把「她回完一句后只跟同一个人接着聊」这条规则做成插件，替代原来「被 @ 一次 → 之后谁说话都回」。

配套的宿主能力：`chat.pre_reply`（回复前判定）与 `chat.reply`（生成后回调），见主仓库 `docs/插件消息流程Api3.md`。

## 它做什么

| 时机 | 行为 |
|---|---|
| `chat.reply` | 她刚发完一句 → 把「还能再顺接 3 句」写进状态 |
| `chat.pre_reply` | 判断这条要不要接，见下 |

判定顺序（与 PR #104 的 `assistantMode.judge` 一致）：

1. 没有上一条机器人回复 / 没有回复对象 → `pass`
2. 被 @ 或点名 → 重置窗口（3 句）并 `pass`（宿主本来就会回）
3. **不是她刚回的那个人** → 收口（`interrupted=true`）并 `pass`
4. 已经收口 / 额度用完 → `pass`
5. 超过 180 秒窗口 → `pass`
6. 在叫别人（`mentionedNames` 非空）→ 收口并 `pass`
7. 纯捧场（好/嗯/收到/哈哈/ok…）→ `pass`
8. 她上一句是问句、这次是短句（≤240 字节）→ `wake`
9. 有追问线索（为啥/怎么/然后/帮我/在吗…，「你/您」+ 问句或请求动词，句首连接词）→ `wake`
10. 其余 → `pass`

`wake` 时额度减 1；`pass` 时如果是「别人插话」或「在叫别人」会显式收口。

## 权限与数据

- `Hooks`：`chat.pre_reply`、`chat.reply`
- `Permissions`：**空**。不需要 `chat.history`（不读聊天记录），也不需要 `model.prompt`（不改系统提示词）
- 插件只看到：当前这条消息、上一条机器人回复的摘要、自己的 state
- state（`{left, interrupted}`）由宿主按「插件 + 会话」隔离保存，插件每次交回完整对象

## 构建与测试

```bash
node build.js        # 生成 wasm、打包 ZIP、算 SHA-256、产出目录条目草稿
node test/run.js     # 差分测试：WASM vs src/reference.js
node test/host.js    # 用宿主真实运行时跑（会起 worker 进程）
```

本机没有 wasm 工具链，`src/wasm.js` 直接生成模块字节（5808 字节）。为了保证「手写字节码」不出错：

- `src/reference.js` 是同一套规则的 JS 实现，作为标准答案；
- `test/run.js` 做逐字节对比：25 个手写样例 + 300 组随机输入；
- `test/host.js` 直接 require 主仓库的 `src/services/messagePlugins.js`，走真实的 worker / 校验 / state 落盘路径。

当前结果：

```
✓ 差分测试通过：35 个样例 + 300 组随机（含随机字段顺序），wasm 6053 字节
✓ 宿主真实运行时集成通过：chat.reply / pre_reply / 收口 / atMe / 捧场
  单次调用耗时 56–64 ms（宿主预算 300 ms）
✓ 包：followup-window-1.0.0.zip 6787 字节
  SHA-256 d6b0383649f69ace2c51e1d79078bd749534453fc5ddd06172342a6eabdb9a2f
```

## 自查发现过的问题（已修，留了回归用例）

1. **字段顺序依赖**：最初靠「第一次出现 `"text":"`」定位正文，如果 `lastBot` 排在 `message` 前面，就会把机器人上一句当成用户消息。现在先定位 `"message":{` 再在内部取字段，随机测试也会打乱字段顺序。
2. **没做链接过滤**：原逻辑「一段网址多半不是接话」被我漏了，已补（`http(s)://` 开头直接 pass）。
3. **捧场词没 trim**：`" 好的 "` 这种带空格的捧场会被当成普通消息继续往下判，已按原逻辑 trim 后比较。
4. 顺带把 `senderId` 与 `targetId` 的比较改成**区分大小写**（原来是忽略大小写，可能把不同 id 当成同一人）。

## 已知差异与限制

与 PR #104 的原实现相比，有几处刻意的取舍，都不是 bug 但需要知道：

- **不支持自定义追问词**：原实现的 `group.assistantHints` 走配置，插件没有接 `settings`，只用内置词表；
- **「叫别人」只用 `mentionedNames`**：原实现还会比对群成员昵称表（`otherMemberNames`），插件拿不到那份名单；
- **上一句问句判定不剥尾部标点**：`"怎么啦？。"` 这类结尾不会被识别成问句；
- **私聊不主动 wake**：宿主对私聊本来就会回，插件在那条路径上返回 `pass`；
- **单条正文上限 900 字节**（约 300 汉字），超出直接不接，避免拿半截文本做判断。

## 安装

「插件市场 → 从本地安装」选 `packages/followup-window-1.0.0.zip`，启用时确认「持续读取当前消息和上一条机器人回复」。停用即撤销授权、删除 state。

更新消息插件后需要重新启用（宿主行为），配置保留。

## 还没做的部分（上架门禁）

- Api 3 目前只在主仓库的**本地开发版**里，没有发布过正式客户端；
- 市场仓库还没有 `index-v3.json`，`validate.py` 也只认识 Api 1/2。

所以这个插件现在是**草稿**：源码、ZIP、SHA-256、目录条目都齐了，等带 Api 3 的客户端发布后，
在同一市场 PR 里加 `index-v3.json` 并把 Api 3 校验接进 `validate.py`，再用正式客户端试装同一份 ZIP 才能合并。
