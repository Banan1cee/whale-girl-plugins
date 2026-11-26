# 鲸鲸插件市场

本仓库维护鲸鲸启动器的插件目录与安装包：人设包走 `index-personas.json`，`whale-plugin/1` 插件走 `index-v5.json`。目录条目、下载地址和 SHA-256 由 CI 从 `plugins/` 与 `packages/` 生成，投稿只提交源码和固定版本的 ZIP。

## 1. 仓库里有什么

| 文件                                                                 | 内容                                                      |
| ------------------------------------------------------------------ | ------------------------------------------------------- |
| `index-personas.json`                                              | 人设包（`plugin.json` + `persona.json`，纯数据，不执行代码）           |
| `index-v5.json`                                                    | `whale-plugin/1` 插件目录，包含 0 级主题与 1–4 级可执行插件              |
| `index.json` / `index-v2.json` / `index-v3.json` / `index-v4.json` | 旧 Api 1–4 的历史格式目录，不再接收新投稿                               |
| `packages/<id>-<version>.zip`                                      | 安装包，按版本不可覆盖                                             |
| `plugins/<id>/`                                                    | 作者源码与展示资料（`plugin.json`、入口、README、可选 `market.json` 与图片） |
| `protocol.json`                                                    | 宿主注册表副本，`_source` 记录来源仓库、提交与 sha256                     |
| `validate.py`                                                      | 目录与安装包的静态校验器，`index-v5.json` 也在校验范围内                    |
| `security/`                                                        | 分级检测、隔离运行与溯源工具                                          |

`index-v5.json` 由 `scripts/build-index.js` 从 `plugins/` 和 `packages/` 生成，任何人都不手改目录文件。

## 2. whale-plugin/1：等级与包结构

| 等级 | 入口 | 运行时 | 能做什么 | 授权 |
| --- | --- | --- | --- | --- |
| 0 | `theme.json` | `theme-data` | 纯数据主题，只改启动器外观，没有执行体 | 无 |
| 1 | `plugin.wasm` | `wasm-restricted` | 手动整数工具 `tool.run@1` | 无 |
| 2 | `plugin.wasm` | `wasm-restricted` | 手动文本工具 `tool.run@1` | 无 |
| 3 | `plugin.wasm` | `wasm-restricted` | 文本工具 + 回复草稿增强，可申请当前聊天最近 12 条或系统提示词 | 启用时确认聊天访问 |
| 4 | `plugin.js` | `node-full` | 现有扩展点 + 清单声明的宿主能力 `calls` | 启用时确认完整系统权限 |

- 安装包 ZIP 根目录只有 `plugin.json` 和该等级的一个入口文件；README、源码、密钥、图片都留在 `plugins/<id>/`，不打进 ZIP。
- 清单必须写 `format: "whale-plugin/1"`、`level`、`id`、`entry`、`runtime`、`provides`；4 级的 `calls` 只能取 `protocol.json` 里 4 级白名单内的能力，1–3 级 `calls` 必须为空。
- `protocol.json` 是宿主 `pluginProtocolRegistry.json` 的副本，等级、能力、模式/作用域、输入输出 schema 和大小限制都以它为准；升级协议时重新复制并更新 `_source`。
- 0 级主题只描述颜色、字体、间距与圆角，不描述布局、页面或行为；1–3 级是受限 Wasm，没有网络、文件、进程能力；4 级以当前 Windows 用户身份运行，不是沙箱。

## 3. 作者流程

源码目录：

```text
plugins/<id>/
  plugin.json          # 清单
  theme.json           # 0 级入口；1–3 级是 plugin.wasm；4 级是 plugin.js
  README.md            # 可选，卡片展示用，不进 ZIP
  market.json          # 可选展示元数据，不进 ZIP
  preview.png          # 可选配图，最多 8 张，单张不超过 2 MiB，不进 ZIP
```

四步交付：

```bash
node scripts/package.js plugins/<id>          # 只把清单和入口打进 packages/<id>-<version>.zip，打印 SHA-256
node scripts/submit.js plugins/<id>           # 打包 + 在临时副本里生成目录 + 跑 validate.py
node scripts/build-index.js --out <目录>      # 本地预览生成的目录：写到指定目录，不动工作区
node scripts/build-index.js --check           # 只比对不写文件：目录与 plugins/ + packages/ 同步则打印「目录已和源码同步。」并退出 0
python validate.py                            # 校验整个仓库的目录与包
```

`--check` 是改完 `plugins/` 或 `packages/` 之后的本地自查：它按源码重算目录条目，逐个比对已提交的 `index*.json`，漂移时列出不一致的文件名并退出 1，不会替你重生成。CI 不用 `--check`——`.github/workflows/index.yml` 用可信 base 的 `build-index.js` 在临时副本里**重新生成**目录再跑 `validate.py`，main 上则由 `sync-catalog` 把生成结果自动提交回仓库。

投稿 PR 只提交两处：`plugins/<id>/`（含源码与展示资料）和 `packages/<id>-<version>.zip`。不要手改 `index*.json`，不要自己填下载地址或哈希；目录条目由 CI 生成。

合并后由 `.github/workflows/index.yml` 运行 `scripts/build-index.js` 生成 `index-v5.json`，`validate-market` 用 `validate.py` 校验目录与包，`market-security` 按 `security/` 的规则做检测并产出报告与 attestation。

### 人设包（纯数据，当前仍在使用）

人设包不走 whale-plugin/1 的等级体系：`plugins/<id>/plugin.json` 写 `Api: 1`、`Kind: "persona"`，加一份只含 `customPrompt` 正文的 `persona.json`，由 `scripts/build-index.js` 写进 `index-personas.json`。作者也可以直接把 ZIP 发给别人，用启动器「从本地安装」导入。

## 4. 市场规则

- 同一 ID 更新必须提高 `Version`、保持作者一致；已发布的同版本 ZIP 不可覆盖，撤回只移除目录条目。
- 展示元数据 `plugins/<id>/market.json` 只接受 `readme`、`images`、`donation`；`readme` 默认 `README.md`（≤64 KiB），`images` 最多 8 张（PNG/JPG/GIF，单张 ≤2 MiB），`donation` 只接受爱发电个人主页链接。
- 更新时间由生成器从 Git 提交时间推导，作者不能手写。
- 目录条目的 `manifest`、`package.sha256`、`display` 由 CI 生成；`manifestSha256` 绑定清单原始字节。
- 旧目录 `index.json`–`index-v4.json` 保留历史条目，不再接收新投稿；新插件与主题投 `index-v5.json`。

## 5. 安全检测

`security/README.md` 是完整说明。要点：

- `security.yml` 使用 `pull_request_target`，只 checkout 可信 base 的检查器；候选分支只作为数据读取，候选源码、构建脚本和自带测试都不执行。
- 0–3 级与 4 级都做静态检查：清单、实际包内容、ZIP 白名单、大小、符号链接、重复 JSON 键、SHA-256；声明与包内容不符即失败。
- 4 级需要完整系统权限，检测使用固定镜像与固定宿主版本、无网络、无凭据、只读挂载和资源限制；检测通过不代表代码无害。
- `security-selftest.yml` 验证检测流程本身；正式门禁与 attestation 以 `security.yml` 在默认分支的运行结果为准。

## 6. 展示资料（可选）

`plugins/<id>/market.json`：

```json
{
  "readme": "README.md",
  "images": ["preview.png"],
  "donation": { "afdian": "https://afdian.com/a/your-name" }
}
```

字段超出白名单、图片越界或 donation 非爱发电地址会导致目录生成失败。README 里引用的本地图片必须在 `images` 里声明。

## 7. 历史格式（Api 1–4）

旧 Api 1–4 的目录、溯源与文档仍保留在仓库里，便于历史版本与旧条目追溯：

- Api 1/2 工具：`index.json`、`index-v2.json`。
- Api 3 消息插件：`index-v3.json`，每版本需要 `provenance/<id>-<version>.json`。
- Api 4 完整权限插件：`index-v4.json`，说明见 [docs/api4.md](docs/api4.md)。

这些都按历史格式处理，不再接收新投稿；新插件请用 `whale-plugin/1`。旧条目照常按各自的校验规则工作。

## 8. 参考文档

| 想知道 | 去哪看 |
| --- | --- |
| 新协议作者配方（Node/Wasm/主题） | [宿主仓库·插件作者入门](https://github.com/Banan1cee/whale_girl/blob/main/docs/插件作者入门.md) |
| 协议细节、能力表与失败码 | [宿主仓库·插件协议](https://github.com/Banan1cee/whale_girl/blob/main/docs/插件协议.md) |
| whale-plugin/1 最小示例 | [`examples/whale-plugin-v5/`](examples/whale-plugin-v5/) |
| 检测、隔离与溯源 | [`security/README.md`](security/README.md) |
| 投稿与设置规范 | [`AGENTS.md`](AGENTS.md) |

发现问题请提交 Issue，注明插件 ID、版本与复现步骤；不要公开密钥或聊天记录。

## 9. 第三方插件免责声明

社区插件由各自作者开发和维护。市场收录、源码公开、哈希校验、扫描或审核不构成官方安全担保，不能保证无病毒、无恶意行为、无漏洞或始终兼容。分享或导入的 ZIP 需自行确认来源可信。

插件可能造成隐私泄露、数据损坏、程序崩溃、异常发言、账号风险或第三方服务费用。安装、更新和启用前请核对来源、版本及权限，备份重要数据并在可控环境测试。发现异常立即停用或卸载，并向作者和市场维护者反馈插件 ID、版本及问题；不要公开密钥或聊天记录。卸载不能撤销已发送的消息、已披露的数据或已产生的费用。

在适用法律允许的范围内，第三方插件按现状提供，鲸鲸项目及插件市场维护者不就其作额外保证，亦不承担超出法定或另行明确约定范围的责任。插件作者应对自己发布的内容和行为承担相应责任。本说明不排除依法不得免除的责任，也不剥夺用户法定权利，不能替代安全控制和必要审核。

[完整免责声明](https://github.com/Banan1cee/whale_girl/blob/main/docs/插件免责声明.md)也可在含此说明的新版客户端「插件市场 → 免责声明」离线阅读。
