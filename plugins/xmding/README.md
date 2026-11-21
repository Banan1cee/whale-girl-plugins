# 小咪叮 · 鲸鲸主动发消息插件

按群名 / 人名 / 备注 / wxid 或会话 ID，向指定群聊或个人主动发消息。

| 项 | 值 |
|---|---|
| 插件 ID | `xmding`（显示名「小咪叮」） |
| 作者 | atroy |
| 版本 | 1.0.6 |
| Api | 4（JavaScript，最小客户端 4.1.2） |
| Kind | `tool` |
| Hooks | `tool.run` |
| 权限 | `system.full` |
| 兼容 | 旧 4.x 体系 4.1.2+ |

---

## 安装

从「插件市场 → 从本地安装」选择 `dist/xmding-1.0.6.zip`，然后在「已安装」卡片点「启用」。

**启用后需重启内核**，插件才会响应请求。

<details>
<summary>本地试装（开发调试用）</summary>

```bash
node build.js --local
```

直接写入 `<WhaleGirl>/data/plugins/`，自动计算授权 hash 并生成 `flow.json` / `flow-grant.json` / `.enabled`。

</details>

---

## 调用

地址 `http://127.0.0.1:8787/api/plugins/run`，认证头 `x-bot-token`（取自 `config.json` → `gateway.wechat.inboundToken`）。

### send · 发消息

```json
{ "id": "xmding", "input": { "to": "久客研发中心", "text": "开会了" } }
```

| 字段 | 说明 |
|---|---|
| `to` | 群名 / 人名 / 备注 / wxid / `xxx@chatroom`，**必须唯一命中** |
| `chatId` | 直接给会话 ID，跳过名称匹配（最稳） |
| `text` | 正文，≤ 4000 字。**三种 delivery 都必填** |
| `chatType` | `group` / `private`，仅影响搜索范围 |
| `delivery` | `text`（默认）/ `image` / `voice` |
| `file` | 仅 `delivery: "image"` 时使用，本机**绝对路径** |
| `dryRun` | `true` = 只解析目标不发送 |

### 发图片

```json
{
  "id": "xmding",
  "input": {
    "to": "文件传输助手",
    "delivery": "image",
    "file": "C:\\Users\\me\\Pictures\\chart.png",
    "text": "这是今天的报表"
  }
}
```

四个要点：

1. **`text` 仍然必填**。即使只发图，也要给一段文字，否则返回 `empty_text`。
2. **`file` 必须是绝对路径**。相对路径会以 `ENOENT` 失败。
3. **单张 ≤ 4 MB**，支持常见图片格式（png / jpg / gif 等）。
4. **需要表情包功能开启**（`config.json` 的 `features.stickers: true`）。关闭时会返回 `send_rejected`，原因里带「表情包功能未开启」。

图片走的是**表情包投递通道**，不是文字用的提醒队列，所以：

- 回执终态是 **`confirmed`**（不是文字那边的 `submitted` / `done`）
- 走桥接的图片发送流程，与文字通道相互独立

> 图片内容会先落进本机表情包库再发出去。这是宿主实现方式，插件无法绕开——介意的话请发文字或改用别的方式传图。


### 发语音

```json
{
  "id": "xmding",
  "input": {
    "to": "文件传输助手",
    "delivery": "voice",
    "text": "这段话会被合成为语音发出去"
  }
}
```

`text` 就是语音要说的话，不需要自己准备音频文件——宿主调用 TTS 接口合成，再用微信的录音通道发出去。

前置条件（缺一不可）：

| 条件 | 位置 | 缺失时表现 |
|---|---|---|
| 语音总开关 | `data/voice-send.json` 的 `"Enabled": true` | 直接失败，不进合成 |
| TTS Provider 与 Key | 同上 `Provider` / `Model`，Key 在 `data/voice-send-<provider>.key` | 合成阶段超时或 HTTP 报错 |
| **微信主窗在前台** | 微信窗口处于激活状态（非最小化、非被遮挡） | `failed 请保持微信目标聊天在前台` |
| **目标会话在前台** | 微信当前打开的正是要发的那个会话 | 同上 |

后两条是语音通道和文字通道最大的区别：文字走 UIA 后台输入，可以在微信不在前台时静默发送；而**语音必须真实点击录音按钮**，所以要求微信和该会话都处于前台。

### 实测结论

在本机 4.1.7.1 上连续测试 10 次：**成功 2 次，失败 8 次**。历史累计 29 次中成功 16 次。两种失败形态：

| 日志 | 含义 | 触发条件 |
|---|---|---|
| `uncertain 找不到元素 (0x80070490)` | 微信窗口不可见/被隐藏，录音控件读不到 | 微信不在前台 |
| `failed 请保持微信目标聊天在前台` | 会话对了但前台条件不满足 | 前台会话不是目标 |

**关键点**：这两条都是能被前置操作解决的，不是永久失效。成功那两次都是在「微信已前置 + 刚发过一条文字切到目标会话」之后立刻发语音。但只要中间焦点被抢走（比如你切了别的窗口、或桥接自己在处理别的任务），下一条就会失败。

所以**语音不适合无人值守的批量/定时发送**，更适合人在电脑前、微信开着目标会话时手动触发。

⚠️ **回执可能骗人**：语音的 `confirmed` / `sent_unconfirmed` 只代表「已交给语音工作进程并开始录音」，**不等于对方收到了**。
实测有失败记录在 `reminders.json` 里仍是 `status: done`、`confirmed: true`。所以语音请**以微信里实际有没有收到为准**，不要只看回执。

> 需要稳定送达请优先用文字；文字通道不受窗口焦点影响。


### status · 查回执

```json
{ "id": "xmding", "input": { "action": "status", "id": "<send 返回的 id>" } }
```

### list · 搜联系人 / 群

```json
{ "id": "xmding", "input": { "action": "list", "q": "研发", "chatType": "group" } }
```

### ping · 探活

```json
{ "id": "xmding", "input": { "action": "ping" } }
```

### curl 范例

```bash
# 纯 ASCII 可内联
curl -s -X POST "http://127.0.0.1:8787/api/plugins/run" \
  -H "x-bot-token: <token>" -H "Content-Type: application/json" \
  -d '{"id":"xmding","input":{"action":"ping"}}'

# 含中文用文件传，避免编码问题
cat > /tmp/xm.json <<'EOF'
{"id":"xmding","input":{"to":"久客研发中心","text":"开会了","dryRun":true}}
EOF
curl -s -X POST "http://127.0.0.1:8787/api/plugins/run" \
  -H "x-bot-token: <token>" -H "Content-Type: application/json" \
  --data-binary @/tmp/xm.json
```

> **Windows PowerShell 5.1**：它会剥掉内联 `-d` 两侧的引号，`{"id":...}` 变成 `{id:...}`，服务端报 `JSON 格式错误`。用 `curl.exe --% ...` 停止解析，或改走文件。`Set-Content -Encoding UTF8` 还会写入 BOM，同样失败，请用 `[System.IO.File]::WriteAllText(..., New-Object System.Text.UTF8Encoding($false))`。

---

## 判断发送成功

`send` 返回 `queued: true` **只代表入队**，不代表送达。必须查 `status`：

| status | 含义 |
|---|---|
| `queued` / `pending` | 已入队，桥接还没取 |
| `sending` | 桥接正在发 |
| `submitted` / `done` | 文字：**发出去了**（`confirmed: true`） |
| `confirmed` | 图片：**发出去了**（`confirmed: true`） |
| `unconfirmed` | 未确认，按策略不自动重发 |
| `failed` / `expired` / `cancelled` | 失败 / 过期 / 取消 |

文字正常是 `queued → pending → submitted`，图片是 `queued → sending → confirmed`，都在几秒到十几秒内。

判断成功请直接看 `confirmed` 字段，它会同时覆盖文字和图片两种终态；只比对 `status` 字符串时注意上面这两组差异。

⚠️ **语音例外**：`voice` 的 `confirmed` 只代表「已交给语音工作进程」，**不代表录音真的发出去了**。
实测失败的语音仍会返回 `confirmed: true`，请以微信里实际收到为准。

---

## 发送链路

本插件不操作微信窗口，只把消息交给内核的主动发送队列：

```
whale.sendText() → reminders 入队 → 桥接 /api/reminders/due → 零焦点通道 → 微信
```

依赖条件：

- **内核在线**：`http://127.0.0.1:8787`（`/healthz` 探活）
- **桥接在线**：`/api/status` 里 `gateways[0].bridge.online === true`
- **微信窗口非最小化**：最小化时零焦点通道返回 `minimized`
- **插件总开关**：`config.json` 的 `features.javascriptPlugins: true`
- **发图片额外需要**：`config.json` 的 `features.stickers: true`

文字走「提醒」队列，图片走「表情包」通道，两者独立，所以开关也是分开的。

---

## 兼容声明

本包只兼容旧 4.x 体系，不声明正式代 1.x：

```json
"MinAppVersion": "4.1.2",
"appEpoch": 1
```

单代包用整数 `appEpoch` 简写。客户端先比代次、再比范围，不跨代比较 4.x 与 1.x。

不设版本上限（最低 4.1.2，向上不限）。需要限制上限时用数组项的 `maxAppVersion`：

```json
"appCompatibility": [
  { "appEpoch": 1, "minAppVersion": "4.1.2", "maxAppVersion": "4.1.9" }
]
```

已在 **4.1.7.1** 实机验证安装、启用、发送与回执。

---

## 开发

```bash
node build.js             # 生成 dist/xmding-<version>.zip + 校验信息
node build.js --local     # 额外部署到本机，便于回归
node verify.js            # 独立校验包结构 / 清单 / 兼容声明 / 源码
node smoke.js             # 功能回归（对运行中的内核发真实请求）
```

`build.js` 与 `verify.js` 的 ZIP 解析是两套独立实现，避免「自己写错自己验过」。构建固定时间戳，同输入产生相同字节，便于核对 SHA-256。

安装包根目录只含 `plugin.json` 和 `plugin.js` 两个文件（上限 16 MiB，代码 8 MiB，UTF-8、CommonJS）。

---

## 安全

`system.full` 意味着插件以当前 Windows 用户权限执行，可访问网络、文件、系统命令和主程序全部 API。**JavaScript 不是沙箱**。

本插件实际用到的能力仅：`require('whale')` 的 `api()` / `sendText()` / `sendVoice()` / `sendImage()` / `delivery()`。源码 `plugin.js` 完全可读，安装前建议自行审阅。
