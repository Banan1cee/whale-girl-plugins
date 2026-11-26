# 鲸鲸插件投稿规范

本文件面向投稿作者和编码代理。协议以宿主仓库的 [插件协议](https://github.com/Banan1cee/whale_girl/blob/main/docs/插件协议.md) 为准，市场只负责目录、安装包、校验与检测。

## 1. 当前协议：whale-plugin/1

- 五个等级：0 级纯数据主题（`theme.json` / `theme-data`）、1–3 级受限 Wasm（`plugin.wasm` / `wasm-restricted`）、4 级 Node（`plugin.js` / `node-full`）。
- 安装包 ZIP 根目录只有 `plugin.json` 和该等级入口；`README.md`、`market.json`、源码、图片留在 `plugins/<id>/`，不打进 ZIP。
- 清单必须写 `format: "whale-plugin/1"`、`level`、`id`、`entry`、`runtime`、`provides`；`id` 小写字母开头，只含小写字母、数字和短横线。
- `provides` 的键必须是 `protocol.json` 里该等级允许的扩展点，`mode`/`scope` 必须合法；`task.tick@1` 还要写 `intervalSeconds`。
- `calls` 是宿主能力白名单：4 级只能声明 `protocol.json` 中 4 级 `calls` 列出的能力；1–3 级 `calls` 必须为空。
- 3 级可在清单写 `dataAccess`（`chat.history` / `model.prompt`），且必须同时声明 `chat.reply@1`；1–2 级不得声明。
- 0 级必须 `provides: {}`、`calls: []`，不得声明 `settingsSchema` / `dataAccess`，`minAppVersion` 不低于 4.3.0。
- `protocol.json` 是宿主 `pluginProtocolRegistry.json` 的副本，`_source` 记录来源仓库、提交与 sha256；等级、能力、schema 与大小限制都以它为准，升级协议时重新复制并更新 `_source`。

大小限制：清单 ≤8 KiB；1–3 级 Wasm ≤512 KiB；4 级 `plugin.js` ≤8 MiB；0 级 `theme.json` ≤64 KiB；安装包 ≤16 MiB。

## 2. 目录与生成规则

| 文件 | 内容 | 由谁生成 |
| --- | --- | --- |
| `index-personas.json` | 人设包 | `scripts/build-index.js` |
| `index-v5.json` | whale-plugin/1 插件与 0 级主题 | `scripts/build-index.js` |
| `index.json` / `index-v2.json` / `index-v3.json` / `index-v4.json` | 旧 Api 1–4 历史格式目录 | 历史条目，不再新增 |

`index-v5.json` 的条目形状是 `{ manifest, manifestSha256, package: { path, download, sha256, bytes }, display }`，下载地址固定在 `main/packages/<id>-<version>.zip`。

**不要手改任何 `index*.json`。** 合并后由 `.github/workflows/index.yml` 在可信 base 上运行 `scripts/build-index.js` 生成目录；`validate-market` 用 `validate.py` 校验目录与包；`market-security` 按 `security/` 的规则检测。

## 3. 投稿流程

1. 源码放 `plugins/<id>/`：`plugin.json` + 该等级入口；可加 `README.md`（≤64 KiB）、`GUIDE.md`、`market.json`、PNG/JPG/GIF 图片（≤8 张，单张 ≤2 MiB）。
2. 自检：

   ```bash
   node scripts/package.js plugins/<id>       # 生成 packages/<id>-<version>.zip，只含清单与入口
   node scripts/submit.js plugins/<id>        # 打包 + 生成目录副本 + 跑 validate.py
   python validate.py                         # 全仓目录与包校验
   ```

3. PR 只提交 `plugins/<id>/` 与 `packages/<id>-<version>.zip`，目标固定 `Banan1cee/whale-girl-plugins:main`；目录条目、下载地址和 SHA-256 由 CI 生成。
4. 同一 ID 更新提高 `Version`、作者不变；已发布的同版本 ZIP 不可覆盖，撤回只移除目录条目。
5. 没有可用客户端做安装自测时，在 PR 里写清自测范围（例如只跑了 `package.js`、`validate.py`），不要写成已验证客户端行为。

旧 Api 3/4 的投稿仍按历史流程带 `provenance/<id>-<version>.json`；whale-plugin/1 不需要溯源文件，也不需要作者签名——目录与包的完整性由 CI 生成的 SHA-256 保证。

## 4. 人设包

人设包是纯数据，走 `index-personas.json`，不属于 whale-plugin/1 的等级体系：`plugin.json` 写 `Api: 1`、`Kind: "persona"`，`persona.json` 只允许 `customPrompt`（正文 1–24000 字，文件 ≤64 KiB），ZIP 根目录只有这两个文件。人设包不执行代码、不需要授权、不做动态检测；作者也可以直接把 ZIP 发给别人，用启动器「从本地安装」导入。

## 5. 设置、文档与展示

- 用户可调的开关、阈值、触发条件放在插件卡片「设置」，用 `settingsSchema` 描述类型与范围；插件代码要消费保存值，并为缺项、旧配置和无效值提供安全默认值或明确错误。
- `plugins/<id>/README.md` 写清每个字段的用途、默认值、类型与范围，以及可直接复制的设置 JSON；`GUIDE.md` 可作为独立教程。
- `plugins/<id>/market.json` 只接受 `readme`、`images`、`donation`：`readme` 默认 `README.md`；`images` 最多 8 张；`donation` 只接受爱发电个人主页链接。更新时间由生成器从 Git 提交时间推导，作者不能手写。
- 插件不得在主工作台、状态栏、系统设置或托盘自行加入口；配置、权限确认、预览、运行和结果统一在「插件市场 → 已安装 → 设置」。

## 6. 检测、不可变性与发布证据

- `security.yml` 使用 `pull_request_target`，只 checkout 可信 base 的检查器；候选分支只作为数据读取，候选源码、构建脚本和自带测试都不执行。
- 静态检查覆盖清单、实际包内容、ZIP 白名单、大小、符号链接、重复 JSON 键与 SHA-256；声明与包内容不符即失败。
- 4 级需要完整系统权限，检测在固定镜像、固定宿主版本、无网络、无凭据、只读挂载和资源限制下运行；检测通过不代表代码无害。
- `security-selftest.yml` 验证检测流程本身；正式门禁与 attestation 以 `security.yml` 在默认分支的运行结果为准。
- 已发布的包不可变：不覆盖、不删除、不改目录里已绑定的哈希；需要修复时发新版本，撤回只移除目录条目。
- 检测器与工作流变更须维护者审核；不得在可信流程里执行候选源码或构建脚本。

## 7. 历史格式：Api 1–4

以下内容保留给历史版本与旧条目追溯，新投稿不再使用这些格式：

- **Api 1/2**：`index.json` / `index-v2.json`；Api 1 工具只能读取用户在该工具页面输入的文字，Wasm 没有联网、读取微信或代发消息接口；Api 2 支持 UTF-8 文本输出，可声明 `HostAction: chat.summary`。
- **Api 3**：`index-v3.json`，`Kind: message`，七个消息扩展点（`chat.received`、`chat.pre_reply`、`chat.prompt`、`chat.generate`、`chat.reply`、`chat.before_send`、`chat.dispatched`）。启用时确认持续参与消息处理，停用撤销授权，更新后重新启用；`chat.history` 与 `model.prompt` 分别声明、分别允许读取最近 12 条会话消息与读取/替换本轮系统提示词。每版本需要 `provenance/<id>-<version>.json`，并通过 `security.yml` 的检测。`chat.dispatched` 只是网关提交结果，不能据此声称微信已经送达。
- **Api 4**：`index-v4.json`，`plugin.js` + `system.full` 完整系统权限，说明见 [docs/api4.md](docs/api4.md)；逐版本溯源规则沿用。

旧目录不再产生新条目，也不再接收同 ID 的新版本。

## 8. 给 DSH 和其他编码代理

1. 收到「制作插件」「把功能做成插件」或「上架插件」时，先确认作者要支持的鲸鲸版本与 `protocol.json` 里已发布的扩展点；可以只读查看宿主源码核对接口。
2. 所有实现放在 `plugins/<id>/`；上架 PR 只发 `Banan1cee/whale-girl-plugins:main`，提交前核对 base repository 与 base branch。不得改宿主程序、给宿主仓库开 PR 或推送宿主分支。
3. 目标版本缺少所需扩展点时，暂停上架，保留可独立交付的源码与草稿，列出缺少的扩展点、输入输出需求和受影响版本；只有用户明确要求时才另开宿主任务。
4. 没有可用于投稿的 GitHub 登录时，交付 `plugins/<id>/` 与 `packages/<id>-<version>.zip` 供代交；目录条目、下载地址与 SHA-256 由 CI 生成，不需要附目录补丁。
5. 用户只要求制作插件时，交付源码与安装包并说明验证范围即可，不必强行投稿。

## 9. 可以直接复制给 DSH

> 按鲸鲸插件市场的 AGENTS.md 制作并上架这个功能。把实现放在独立插件里，清单用 `whale-plugin/1`，所有配置和操作放在插件卡片的「设置」。交付 README 中可复制的设置 JSON，验证保存另一个值确实改变行为。先核对 `protocol.json` 支持的扩展点，再交付源码、可独立安装的 ZIP 和测试结果（目录与 SHA-256 由市场 CI 生成，不手改 `index*.json`）。上架 PR 只发到 Banan1cee/whale-girl-plugins 的 main。缺宿主接口就停在插件草稿并列出缺口；未经我另行明确授权，不改鲸鲸主程序，也不给主仓库发 PR。
