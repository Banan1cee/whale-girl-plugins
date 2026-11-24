# Breezeblue 翻唱 1.0.4

鲸鲸 Api 4 消息插件。群聊和私聊可点歌、看歌单、撤单和播放当前会话的已有成品。本机 seed-vc 制作整首翻唱，通过 VB-CABLE 和微信前台录成语音。

## 安装与升级

需要 Windows x64、微信 PC 4.2、鲸鲸 Api 4，原版 4.1.8.2 为实测目标及 NVIDIA GPU。安装 [Windows 运行时 1.0.17 或更新版本](https://github.com/RacOrange/breezeblue-sing-installer/releases/latest)。已有运行时可用安装器的插件步骤覆盖，保留设置与模型。RTX 50 系列若出现 CUDA 算子错误，运行新版安装器重新检查依赖。更新后在市场重新确认完整权限；两个同类唱歌插件只启用一个。

## 设置

空设置从用户目录下的 whale-cover 推导路径。非默认安装目录可使用安装器写入的绝对路径。

~~~json
{
  "coverCli": "D:\\whale-cover\\tools\\cover.mjs",
  "python": "D:\\whale-cover\\engine\\venv\\Scripts\\python.exe",
  "ffmpeg": "D:\\whale-cover\\tools\\ffmpeg",
  "dataDir": "D:\\whale-cover\\data",
  "voicePython": "D:\\whale-cover\\voice\\venv\\Scripts\\python.exe",
  "voiceSender": "D:\\whale-cover\\voice\\send_cover.py",
  "engine": "seedvc",
  "onlyGroup": false,
  "autoRender": true
}
~~~

| 字段 | 用途与默认 |
| --- | --- |
| coverCli、python、ffmpeg、dataDir | CLI、渲染 Python、FFmpeg 与运行数据的路径字符串，默认由运行时根目录推导。 |
| voicePython、voiceSender | 语音 Python 与发送脚本的路径字符串，默认由 CLI 根目录推导。 |
| engine | 引擎字符串，默认 seedvc。 |
| neteaseCookies | 可选的本地 Cookie 文件路径字符串，默认运行时根目录下 cookies.txt。设置只填路径。 |
| onlyGroup | 默认 false，私聊和群聊接收点歌。true 时私聊仅可播放已有成品。 |
| autoRender | 默认 true，false 暂停定时渲染和自动投递。 |

## 命令和发送

- 点歌 歌名，或点歌 歌名 - 歌手。
- 点歌单、取消点歌 歌名、唱 歌名。
- 发送时保持微信在前台，目标会话在最近列表可见，绑定账号与 UIA 核验通过，微信录音输入为 CABLE Output。
- 标题缺失、出现同名候选或账号核验失败时停止。请以本次新增、时长匹配的语音条为准。
- 如提示送达不确定，先核对微信，确认没有语音后再手动播放。定时器不会自动重发该订单。

1.0.1 使用独立发送器及本地结果回执。

## 整首播放、主动唱歌与代发

普通点歌渲染完整成品，在人声停顿附近按最多约 56 秒分段，每次确认一条后继续。已有 30 秒成品可播放；如要整首，需要重新点歌。首次参考音默认进入方案 B，由用户确认后复用鲸鲸现有语音，无 Windows TTS 回退。

闲时主动唱歌默认关闭。启用后可给已绑定主人私聊唱，也可给明确配置的群唱。每次选择本地未唱曲目，优先沿用旧历史做去重，送出一段并核验回执后才继续下一段。旧独立主动插件仍出现在宿主插件清单时暂停新调度。

| 字段 | 用途与默认 |
| --- | --- |
| proactiveEnabled | 布尔值，默认 false，启用闲时主动唱歌。 |
| proactivePrivateEnabled、proactiveRecipientIds | 私聊默认启用。可设为 false 只唱白名单群。可把绑定主人会话 ID 填入数组进一步限定私聊。 |
| proactiveGroupIds | 群会话 ID 字符串数组，默认空。只选择其中能唯一核验的群。 |
| proactiveIdleMinutes、proactiveCooldownMinutes、proactiveDailyMax | 空闲默认 120 分钟，最少 5 分钟。冷却默认 360 分钟，最少 30 分钟。每日次数默认 2，上限 5。 |
| proactiveQuietStart、proactiveQuietEnd | 本地时间 HH:mm，默认 22:30 到 09:00。 |
| proactiveFollowup、proactiveDryRun | 布尔值，默认 false。分别控制唱完后的文字、只演练且不发语音。 |
| proactiveAllowDownload、proactiveDownloadCandidates | 默认关闭下载。开启后候选语句数组适用于没有未唱本地曲目的场景。 |

代发默认关闭。设置 relaySingEnabled 为 true，relaySingWhitelist 填准确目标会话 ID 的数组。有宿主代发白名单时也必须在其范围内。已绑定主人在自己的私聊发送「去『目标群』唱《歌曲》」或「把《歌曲》唱给爸爸听」。收到预览后，同一主人在同一私聊内用「唱歌确认 六位码」二次确认，十分钟有效。每条发送前重新核验目标和名单。接收端语音条方向和时长有疑问时暂停后续语音。

1.0.4 与配套安装器 1.0.17 需联合验证。支持配置与安全说明见安装器使用文档。
安装器会实际执行 CUDA 算子检查兼容性，RTX 50 系列安装 cu128。渲染失败时，发送到会话的消息只含错误分类，详细日志保存在本机工作目录。
