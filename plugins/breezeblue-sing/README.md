# Breezeblue 翻唱 1.0.1

鲸鲸 Api 4 消息插件。群聊和私聊可点歌、看歌单、撤单和播放当前会话的已有成品。本机 seed-vc 制作副歌，通过 VB-CABLE 和微信前台录成语音。

## 安装与升级

需要 Windows x64、微信 PC 4.2、鲸鲸 4.1.2 或更新版本及 NVIDIA GPU。安装 [Windows 运行时 1.0.14 或更新版本](https://github.com/RacOrange/breezeblue-sing-installer/releases/latest)。已有运行时可用安装器的插件步骤覆盖，保留设置与模型。更新后在市场重新确认完整权限；两个同类唱歌插件只启用一个。

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
  "maxSeconds": 30,
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
| maxSeconds | 副歌秒数，默认 30，建议 10–54。 |
| onlyGroup | 默认 false，私聊和群聊接收点歌。true 时私聊仅可播放已有成品。 |
| autoRender | 默认 true，false 暂停定时渲染和自动投递。 |

## 命令和发送

- 点歌 歌名，或点歌 歌名 - 歌手。
- 点歌单、取消点歌 歌名、唱 歌名。
- 发送时保持微信在前台，目标会话在最近列表可见，绑定账号与 UIA 核验通过，微信录音输入为 CABLE Output。
- 标题缺失、出现同名候选或账号核验失败时停止。请以本次新增、时长匹配的语音条为准。
- 如提示送达不确定，先核对微信，确认没有语音后再手动播放。定时器不会自动重发该订单。

1.0.1 使用独立发送器及本地结果回执。
