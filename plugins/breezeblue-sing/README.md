# Breezeblue 翻唱 1.0.4

鲸鲸 Api 4 消息插件。群聊和私聊可点歌、看歌单、撤单和播放当前会话的已有成品。本机 seed-vc 制作整首翻唱，通过 VB-CABLE 和微信前台录成语音。

第一次安装请看 [从安装到第一次点歌](GUIDE.md)。教程也说明了方案 B、代发、闲时主动唱歌和常见故障。

## 安装与升级

需要 Windows x64、微信 PC 4.2、支持 Api 4 的鲸鲸和兼容的 NVIDIA GPU。安装 [Windows 运行时 1.0.17](https://github.com/RacOrange/breezeblue-sing-installer/releases/tag/v1.0.17)。升级运行时会保留设置与模型。更新后在插件市场重新确认完整权限，并停用旧的同类唱歌插件。

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
- 发送时保持微信前台可用，微信录音输入为 CABLE Output。目标不在最近列表时，发送器会搜索并核对唯一匹配的会话。
- 只有出现本次新增、可确认是己方发出的语音条才记录成功。找不到唯一目标、账号校验失败或只能看到不明方向的气泡时，按失败或结果不确定处理。
- 如提示送达不确定，先核对微信中的语音条或附件。分段播放会在回执不明确时暂停，定时器不会重发该订单。

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
| proactiveLiked | 布尔值，默认 false。启用后优先尝试网易云「我喜欢的音乐」，需要可读取该列表的本机 Cookie 文件。 |
| relaySingEnabled、relaySingWhitelist | 代发开关默认 false。白名单是微信目标会话 ID 字符串数组，默认空。 |

代发默认关闭。启用后，已绑定主人可在自己的私聊说「去『目标群』唱《歌曲》」或「把《歌曲》唱给另一位主人听」。收到预览后，在同一私聊回复「发」确认或「算了」取消，十分钟有效。宿主白名单生效时，目标也必须在该范围内。「刚才那首」只会查找本人在原私聊点过的整首成品。每条发送前重新核验目标和名单。

原版鲸鲸 4.1.8.2 走分段语音。宿主具备 WAV 附件和格式选择能力时，点歌超过 2 分钟可回复「发文件吧」或「分段发吧」。具备 WAV 能力的宿主上，闲时超过 2 分钟默认发整首文件。 [原版插件发送接口](https://github.com/Banan1cee/whale_girl/blob/v4.1.8.2/src/services/pluginHost.js#L104)

安装器会执行 CUDA 算子检查兼容性，为 Blackwell 选择 cu128。渲染失败时，会话提示会给出错误分类，详细日志保存在本机工作目录。
