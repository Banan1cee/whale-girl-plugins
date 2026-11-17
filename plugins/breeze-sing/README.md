# Breezeblue 翻唱（breeze-sing）

群聊点歌插件：点歌后自动搜索音源、切 54 秒副歌，用 breezeblue 音色经本地 seed-vc 翻唱，完成后把语音发回群。

## 重要：不是纯 JS 单文件插件

本插件是 Api 4 完整权限插件，但它依赖本机已安装的配套运行时，无法只靠 ZIP 独立工作：

- Windows + NVIDIA GPU（已在 GTX 1050 Ti 4GB / CUDA 12.1 / torch 2.4.1+cu121 验证）
- 本机存在 `%USERPROFILE%\whale-cover`（或通过 `settings.coverCli` 指向其他位置），其中包含 CLI、Python venv、seed-vc、ffmpeg、参考音与模型
- 鲸鲸 4.1.2+，并已加载本地语音发送补丁（`WhaleLauncher-patched.exe` + `bridge/voice_reply.py` 的 `[[cover:` 分流）
- 微信 PC 端目标会话需在前台，语音工作进程才能确认会话

若审核要求“ZIP 双击即可独立运行”，本插件不满足，请先不要合并；需要配套安装器或改为云端服务。

## 安装

1. 鲸鲸 4.1.2+ 打开「插件市场 → 从本地安装」，选择 `breeze-sing-0.6.2.zip`，确认 `system.full` 权限。
2. 确保配套运行时存在，且在插件卡片「设置」中按需填写：

```json
{
  "coverCli": "%USERPROFILE%\\whale-cover\\tools\\cover.mjs",
  "onlyGroup": true,
  "autoRender": true,
  "engine": "seedvc",
  "maxSeconds": 54
}
```

3. 在目标群发「点歌 歌名」或「点歌 歌名 - 原唱」。

## 命令

- `点歌 起风了`
- `点歌 起风了 - 买辣椒也用券`
- `点歌单`：查看去重后的队列
- `取消点歌 起风了`

## 测试用例

| 输入 | 预期 |
| --- | --- |
| 群里发「点歌 起风了」 | 回复排第 N 位；自动搜音源、切副歌，约 7–10 分钟后发 54 秒语音 + 「做好了～《起风了》」 |
| 群里发「点歌单」 | 同一群同歌名/歌手只显示一条；失败单不显示 |
| 私聊发「点歌 起风了」 | 不接管，交给鲸鲸正常聊天（`onlyGroup:true`） |
| 音源搜索失败 | 群里回「音源下载失败…」，不会卡在 making |

## 已知限制

- 54 秒是 WhaleGirl 语音工作进程 55 秒上限下的成品长度，不是完整歌曲。
- 免费音源可能只有翻唱/Live 版；VIP 原唱没有可下载地址。
- 语音发送依赖微信前台窗口；窗口被切走会报 `uncertain 无法确认当前微信会话`。
- 首次使用需配置好 seed-vc 参考音（`cover engine ref`）与引擎检查（`cover engine rvc check` 不适用；本插件用 `seedvc`）。
