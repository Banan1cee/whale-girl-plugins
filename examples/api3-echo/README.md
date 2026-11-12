# Api 3 消息插件模板（api3-echo）

改几行就能上架的最小消息插件。默认在 `chat.pre_reply` 返回 `{"action":"pass"}`——不改变宿主判定，先证明「装得上、跑得通」。

## 三步跑通

```bash
node src/build.js wake    # 1. 生成 plugin.wasm（不填参数就是 pass；可选 pass/wake/skip）
node test/run.js          # 2. 在 Node 里按宿主同样的导入跑一遍
```

需要复杂输出时把 JSON 写进文件再传：`node src/build.js my.json`。
（别在 PowerShell 里直接写 `'{"action":"wake"}'`，双引号会被 shell 剥掉。）

```bash
# 3. 打成安装包：ZIP 根目录只放这两个文件
zip -j /tmp/api3-echo-1.0.0.zip plugin.json plugin.wasm
```

然后在鲸鲸「插件市场 → 从本地安装」选这个 ZIP。没有 4.1 客户端时，先看 [`docs/插件消息流程Api3.md`](https://github.com/Banan1cee/whale_girl/blob/main/docs/插件消息流程Api3.md) 确认字段。

## 改成你自己的

| 想改什么 | 改哪里 |
| --- | --- |
| 判定结果（pass / wake / skip） | `node src/build.js '{"action":"wake"}'` 的参数 |
| 只对某些消息生效 | 在 `src/wasm.js` 里读输入：`whale.input_size()` / `whale.input_byte(i)`，判断后吐出不同 JSON |
| 记住状态 | 输出里带上 `"state": {...}`，最多 16 KiB，每次完整替换 |
| 声明更多环节 | `plugin.json` 的 `Hooks`：`chat.received`、`chat.prompt`、`chat.generate`、`chat.reply`、`chat.before_send`、`chat.dispatched` |
| 读取最近消息 / 改提示词 | `Permissions` 加 `chat.history` / `model.prompt` |

输入是 UTF-8 JSON，包含 `api`、`hook`、`message`、`now`、`lastBot`、`state`、`settings`。完整字段见宿主文档。想看真正做判定的写法，读同仓库的 [`plugins/followup-window`](../../plugins/followup-window)——它同样是手写字节码。

## 上架

把整个目录复制成 `plugins/<你的 id>/`，再把打包好的 ZIP 放到 `packages/<id>-<version>.zip`，提 PR 到本仓库 `main` 即可。目录条目、下载地址和 SHA-256 由 CI 生成，**不要手改 `index*.json`**。

> 注意：`plugin.json` 里的 `Id` 要和目录名、ZIP 名一致；`Version` 升了就换新 ZIP，旧包不要覆盖。
