# 插件分级检测与溯源

## 普通作者怎么投稿

1. 人格预设 ZIP 只放 `plugin.json` 与 `persona.json`，`Api: 1`、`Kind: persona`，进入 `index-personas.json`。正文只允许 `customPrompt`。不需要运行测试、GitHub 实名认证或额外审核材料；也可直接本地分享 ZIP。
2. Api 1/2 工具保留原目录，做格式、文件和哈希检查，不宣称经过 Api 3 动态检测。
3. Api 3 消息插件进入 `index-v3.json`，每个版本增加 `provenance/<id>-<version>.json`。参考现有接话窗口文件填写发布者 GitHub login、数字 ID、源码仓库、完整 40 位 commit 和源码目录。作者名称可以署笔名，GitHub 账号验证不是现实实名验证。
4. 安装包一律放在市场 `packages/<id>-<version>.zip`。目录条目、下载地址和 SHA-256 由 `scripts/build-index.js` 生成，投稿人不用手填、也不要手改 `index*.json`。不要覆盖旧包；更新增加版本号。已有包禁止更改或删除，撤回只移除目录条目。
5. 提 PR 后查看 Actions 的「插件安全门禁」和运行摘要，下载 `market-security-<run-id>` 报告。失败时按原因修改，再次提交会重新检测。无需在自己的电脑搭虚拟机。

源码仓库的 owner ID 必须等于声明的发布者 ID。组织账号可以作为发布主体。代交者另记为报告中的 submitter，不冒充作者；当前不证明发布者的真实姓名或源码与安装包可重现构建一致。

## 检测范围

所有包检查清单、实际内容、精确 ZIP 白名单、大小、符号链接、重复 JSON 键和 SHA-256。人设仅静态读取，夹带 Wasm、脚本或可执行文件即失败。

Api 3 在 GitHub 托管的 Ubuntu 完整虚拟机内，用固定 commit 与 SHA-256 的鲸鲸真实 `MessagePlugins` 运行时执行。Wasm 字节接口可跨平台模拟，不需要启动微信；Windows 启动器兼容性仍由宿主仓库的 Windows CI 验证。逐个声明的 hook 输入空消息、普通消息、注入式消息和长消息，覆盖群私聊模拟、状态解析、停用和授权哈希篡改。未知 Wasm imports、超时、非法输出、未授权输出及宿主错误回退均判失败。最长单次 300ms（含宿主 worker 启动）；整个外层进程另有 35 秒上限。

只提供宿主的输入/输出字节接口，不提供 WASI、网络、文件或进程接口。不接真实微信、不传真实聊天或 API Key。检测进程环境不传 GitHub Token；真实源码、构建脚本和插件自带测试均不执行。它是受限运行时测试，不是完整杀毒软件，也没有系统调用级监控或真实微信全流程测试。延迟触发、特定输入、社会工程及引擎漏洞仍可能漏检。

每份报告绑定包 SHA-256、提交版本、发布账号数字 ID、源码 commit、宿主 commit、检测时间和 Actions 运行地址。普通 PR 只提供未签署的预览；默认分支成功检测后，在另一独立任务使用 GitHub OIDC 为实际测试的 ZIP 和报告生成 artifact attestations，不需要团队维护私钥。

拿到安装 ZIP 后可用 GitHub CLI 验证正式来源：

```sh
gh attestation verify plugin.zip --repo Banan1cee/whale-girl-plugins --signer-workflow Banan1cee/whale-girl-plugins/.github/workflows/security.yml
```

验证时还应打开该运行的报告，对照包哈希和 `status: passed`。签名只证明来源与流程，不证明无毒。当前客户端仍校验目录 SHA-256，尚未内置上述签名证明的自动验证。离线包保持明确的来源风险提示。

## 三人团队怎么维护

- 日常只需处理检测失败、发布者迁移及能力变更；通常无需逐行审核普通插件。自动检测不等于自动合并 PR，本轮不授予机器人合并权限。
- `security.yml` 使用 `pull_request_target`，仅 checkout 可信 base 的扫描器；候选分支通过 GitHub API 只读取目录、包和溯源数据。候选文件永远不能覆盖或作为 Python/JS 模块加载。任务为 `contents: read`、不保留 checkout 凭据、不引用仓库密钥；签署任务独立且不运行插件。
- 检测器/工作流变更仍需要维护者审核。不能把候选工作流产生的预览当正式门禁，也不能为方便而在可信流程中执行候选源码或构建脚本。
- 当前初始 PR 的 `security-selftest` 验证新流程；可信 `pull_request_target` 只有文件合入默认分支后才正式服务后续投稿。合并后，在市场仓库 main 规则中把「插件安全门禁」设为必需检查，并保护工作流和检测策略。不要在首次引导 PR 合并前添加一个尚不存在的必需检查而锁死仓库。
- 首次合并后查看 main 的检测与签署任务，确认 artifact attestations 成功。报告 artifact 默认保留 90 天，正式包的证明可通过 GitHub attestation 查询；需要长期保存明细时备份每次正式报告。
- 遇到风险先从目录撤回版本，再发通知；当前没有客户端自动远程停用机制。不要在发现风险后覆盖旧 ZIP 来“修复”同一版本。

本轮提供上架检测与可核验的发布证据，不宣称现实实名、完整恶意软件检测、自动合并或客户端签名强制执行已经实现。
