# Breezeblue 翻唱（本地发送器版，breezeblue-sing）

点歌插件：群聊/私聊点歌后自动找音源、切 30 秒副歌，用 breezeblue 音色经本机 seed-vc 翻唱，并通过**本地发送器直接发成微信语音**。

这是独立实现的新插件 ID（`breezeblue-sing`），不改动市场上的旧 `breeze-sing`；运行时由配套安装器部署，**不修改鲸鲸主程序、不需要宿主语音补丁**。

## 重要：不是纯 JS 单文件插件

本插件是 Api 4 完整权限插件，但只靠 ZIP 不能独立跑起来：

- Windows 10/11 x64 + NVIDIA GPU（建议 ≥6GB 显存）
- 微信 PC 4.2
- 鲸鲸 4.1.2+
- 磁盘 ≥10GB
- 配套安装器负责：Python/torch/seed-vc/模型/ffmpeg、语音发送 venv、VB-CABLE、参考音、插件写入

## 安装

1. 先运行安装器（运行时 + 发送器 + VB-CABLE + 参考音 + 插件写入）；
2. 打开鲸鲸「插件市场 → 已安装 → Breezeblue 翻唱（本地发送器版）→ 设置」确认路径；
3. 重启鲸鲸内核，私聊发 `点歌 起风了` 做冒烟测试。

设置示例：

```json
{
  "coverCli": "%USERPROFILE%\\whale-cover\\tools\\cover.mjs",
  "python": "%USERPROFILE%\\whale-cover\\engine\\venv\\Scripts\\python.exe",
  "ffmpeg": "%USERPROFILE%\\whale-cover\\tools\\ffmpeg",
  "dataDir": "%USERPROFILE%\\whale-cover\\data",
  "voicePython": "%USERPROFILE%\\whale-cover\\voice\\venv\\Scripts\\python.exe",
  "voiceSender": "%USERPROFILE%\\whale-cover\\voice\\send_cover.py",
  "engine": "seedvc",
  "maxSeconds": 30,
  "onlyGroup": false,
  "neteaseCookies": "%USERPROFILE%\\whale-cover\\cookies.txt",
  "proactiveEnabled": true,
  "proactiveIdleMinutes": 120,
  "proactiveDailyMax": 2,
  "proactiveQuietStart": "22:30",
  "proactiveQuietEnd": "09:00",
  "proactiveCooldownMinutes": 360,
  "allowDownload": true,
  "downloadCandidates": ["晴天", "后来", "小幸运"]
}
```

- `neteaseCookies` 只填 **cookie 文件路径**，插件不保存、不打包账号数据。
- 单主人/双主人都支持：双主人显示「主人1/主人2」，单主人显示「主人」。
- 主动唱歌默认开启；`proactiveEnabled: false` 关闭。

## 命令

- `点歌 起风了` / `点歌 起风了 - 买辣椒也用券`
- 私聊点歌先回 `是《起风了》对吧，我先找原曲～`；群聊回排队位次
- `点歌单`、`取消点歌 起风了`
- `唱 安荣`
- `把《安荣》唱给主人2听`（单主人用「主人」）
- 唱完约 12 秒补一句“我唱了《歌名》，你觉得好听吗？”
- 闲时主动唱歌：文字 → 语音 → 追问

## 测试用例

| 组 | 输入 | 预期 |
| --- | --- | --- |
| 1 点歌 | 群里发 `点歌 起风了` | 回排队位次；完成后 30 秒语音，无“收到/进度/做好了”过程话术 |
| 2 私聊点歌 | 私聊发 `点歌 起风了` | 立即回 `是《起风了》对吧，我先找原曲～`；完成后语音 + 追问 |
| 3 唱成品 | 私聊发 `唱 安荣` | 只发语音；约 12 秒后补“主人1，我唱了《安荣》，你觉得好听吗？” |
| 4 唱给主人 | 私聊发 `把《安荣》唱给主人2听` | 给主人2发“主人1让我把这首《安荣》唱给你听～”+ 语音 + 追问；回执 |
| 5 容错 | 私聊发 `唱 不存在的歌` | 回“《不存在的歌》还没唱好，等做好了再喊我。” |

第 1–4 组需要运行时、VB-CABLE、微信前台；仅验证安装/设置时测第 5 组。

## 已知限制

- 成品是副歌片段，不是完整歌曲；音源可能只有翻唱/Live 版。
- 语音发送依赖微信 UIA 与前台窗口；被遮挡或窗口切走会失败并提示，不会发到错误会话。
- 渲染约 8–14 分钟（6GB 显卡建议 ≤30 秒），由独立子进程完成，插件 timer 只轮询状态。
- 换机器需迁移运行时数据（`dataDir` 下 orders/work）。
- 微信升级可能破坏 UIA；当前只保证 4.2。

## 1.0.0

- 新插件 ID `breezeblue-sing`，与旧 `breeze-sing` 并存。
- 本地发送器直连，不需要鲸鲸宿主补丁。
- 支持群聊/私聊点歌、`唱`、`唱给主人`、闲时主动唱歌、网易云 cookies 路径、30 秒成品。
