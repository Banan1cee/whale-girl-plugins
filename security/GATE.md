# 可信投稿门禁（whale-plugin/1 市场投稿）

本目录是市场仓库的**可信门禁代码**，只从默认分支 checkout 后运行。投稿分支的内容
永远只作为数据（JSON/ZIP 字节）下载到临时目录，不会被 import、执行或当成脚本路径。

## 任务拆分

| 阶段 | 位置 | 权限 | 做什么 |
| --- | --- | --- | --- |
| 静态门禁 | `security/gate.py` | `contents: read` | 用可信 base 的 `validate.py --root --json` 校验候选数据；检查变更范围、ZIP 字节/哈希/大小、同版本不可替换、版本不倒退；输出报告与签署清单 |
| 隔离执行 | `security/isolated.py` | `permissions: {}`、无 token/secret、不 checkout 候选 | 只对 level 1-4 在固定 digest 镜像里执行；无网络、只读根、非 root、资源限额 |
| 签署 | `security/attest_subjects.py` | 仅 main、`id-token: write` | 只签报告列出的市场 ZIP 哈希清单，不签插件输出或任意路径 |

`security.yml` 使用 `pull_request_target`，但只 checkout **base sha**；候选通过
GitHub API 以数据形式进入临时目录。隔离任务不接收仓库 token；隔离不可用或
pinned runtime 未验证时 **fail closed** 并明确报告。

## 固定运行时与容器适配器

`security/plugin-runtime.json` 固定宿主 `Banan1cee/whale_girl` 的已发布 commit
`a450d05c7e568442542511644a6aebbc35642990`（feat/4.3）与各文件 SHA-256，执行前逐个
校验；容器内 `security/harness/run.cjs` 会再次按同一清单重算哈希。`harness.state` 为
`pending` 时 level 1-4 一律 fail closed。

当前状态是 **PENDING_BINDING**，不是“已验证”：固定 commit 早于现在的 13 provider/state
ABI，且 `files` 里没有 `unifiedCapabilityDispatcher.js`，而适配器需要同时驱动 Runtime 与
Dispatcher。适配器已实现并在主机用自建无副作用 fixture 做过端到端自测（含 Wasm tool），
但**尚未在该固定镜像内执行过**。要解除阻塞，维护者需要：

1. 把 commit/files 重新 pin 到包含 `harness.required_files` 全部文件的已发布提交；
2. 在固定镜像内成功跑一次隔离任务；
3. 确认 `security/harness/run.cjs` 的 SHA-256 与 `harness.adapter_sha256` 一致；
4. 才把 `harness.state` 改为 `verified` 并记录 `verified_at/by`。

容器适配器边界：

- 用合成 grant 安装候选，调用清单声明的**每个** provider，由固定 Runtime/Dispatcher
  校验输出；同时验证超时、取消与授权撤销。`host.call` 只返回按 schema 合成的只读/模拟值，
  不发送消息、不联网、不启动进程。
- 结果只有一行 `WHALE_ISOLATION_RESULT_V2 <json>`，用 `isolated.py` 通过 stdin 传入的
  每次随机 secret 做 HMAC；worker 环境是固定最小集合，正常候选代码拿不到 stdin。宿主还会
  拒绝重复 marker、尾随文本、超限输出、错误签名、不同 runtime 哈希，以及 subject
  （id/version/level/manifest/entry SHA-256）与已校验包不一致的结果。
- **这不等于完整敌对隔离证明**：候选与适配器同以非 root uid 运行，理论上仍可能通过
  `/proc`、ptrace 或文件系统等渠道接触父进程状态。因此宿主自己校验 runtime/包哈希，并
  逐 provider 重新校验输出 schema（容器返回的 `outputJson` + `outputSha256`）；HMAC 只
  保证“这份输出绑定到这一次运行、未被调包”，容器只承担非 root 约束。恶意候选的强隔离
  仍需更外层机制，当前结论不宣称做到。
- `docker run --pull=never`：镜像缺失时失败，不自动下载。
- 纯静态 / 0 级主题投稿**不需要**这个 pending pin：先校验包集合一致即可通过。

## 规则边界

- `whale-plugin/1` 的等级、清单、能力与限额以 base 的 `protocol.json` 为唯一事实源；
  候选自带的 `protocol.json` 不会生效。
- 静态危险能力声明和可疑代码信号只作为**审阅线索**，不是无毒证明；本门禁不替代杀毒
  软件，也不承诺插件无害。容器只能降低风险，不能证明没有延迟触发、特定输入或引擎漏洞。
- 变更范围：插件投稿只允许 `plugins/**`、`packages/**`、`provenance/**`、
  `discussion-issues.json`；维护类改动（`security/`、`.github/`、`docs/`、`scripts/`、
  `validate.py`、`protocol.json` 等）与投稿必须分开 PR，混在一起直接失败。
- 已发布包不可改、不可删；同 id/version 不能换包，版本不能回退。
- 隔离执行失败、超时、镜像不可用、pin 哈希不符、未验证 harness 都 fail closed，
  不会静默跳过可执行等级。

## 本地自测

```bash
python -m unittest security.test_gate       # 合成 fixtures，不执行真实插件/容器
node --check security/harness/run.cjs
node security/harness/selftest.cjs          # pin 校验、fixture schema、MAC 输入
python security/selftest_workflows.py       # 工作流静态自检
```

自测只验证检查器逻辑；不下载镜像、不运行 Docker、不执行投稿代码。主机端适配器自测使用
当前宿主 checkout 的真实 Runtime/Dispatcher + 无副作用合成插件，产物不属于 CI，也不
代表固定镜像已验证。

## task-64 修复补充（2026-11-25）

- **v5 派生**：`index-v5.json` 不再信任候选自带文件。静态门禁先删除候选目录里的 `index-v5.json`，再用可信 base 的 `scripts/build-index.js --root <候选> --out <候选>` 从 `plugins/` + `packages/` 派生；派生后仍为 0 条 → `no_v5_entries` fail closed。快照同时抓取 `plugins/*/README.md`、`GUIDE.md`、`market.json` 与图片，供 display 校验。
- **顺序**：必须先取 base `protocol.json` 写进候选/基线根，再派生索引、再跑 `validate.py --root --json`；否则所有 v5 投稿都会因缺 protocol 失败。
- **fork 分离**：base 快照/协议/不可变性用 `github.repository`，候选用 `head.repo.full_name`；PR 变更文件由 workflow 用 base 仓库的 PR files API 生成 JSON（分页）传给门禁，不依赖跨 fork compare。
- **push main 签名**：门禁用 `github.event.before` 作基线并 `--only-changed`；`attest` 只签本次变更的包清单。没有可签名包时安全跳过（有显式输出，不伪造成功）。
- **updatedAt 与 Git**：维护类 CI 不再把候选 `.git` 复制进可信临时副本（git 元数据不是市场数据，也不让候选通过 `.git/config` 影响维护 CI）；同时用 `find -type l` 拒绝候选数据里的符号链接。缺 `.git` 时派生索引不写 `updatedAt`，校验器接受缺省，但拒绝无法核实的伪造时间。
- **维护类 PR 信任根**：`security/**`、`.github/workflows/**` 的变更必须由维护者人工审核后合并；CI 不能替维护者批准自身策略变更。建议在分支保护中把 `security.yml` 的 job 设为必需检查，并限制谁能改工作流。（未添加 CODEOWNERS，避免写入不存在的 GitHub 账号。）
- **签署 action**：改用官方 `actions/attest-build-provenance@v2`（原 `actions/attest@v4` 无法离线证实）。
- **已知未修（超出本卡写范围）**：市场 `validate.py` 的 afdian 主机/尾斜杠规则与宿主不一致（`www.afdian.com`、`/a/slug/`），需另开 validate 卡的维护者修复。

## task-107 隔离适配器与信任链修复（2026-11-25）

- **真实适配器**：`security/harness/run.cjs` 不再只返回 blocked。它在容器内校验 pin、安装合成 grant、经固定 `UnifiedPluginRuntime` + `UnifiedCapabilityDispatcher` 调用清单中每个 provider，验证 schema、超时、取消、授权撤销；`host.call` 只用按 schema 合成的模拟值。
- **结果认证与绑定**：stdout 只允许一行带固定 marker 的 JSON，使用 `isolated.py` 经 stdin 传入的一次性 secret 做 HMAC；宿主校验 subject（id/version/level/manifest/entry SHA-256）、provider 集合、runtime 摘要、四项检查，并逐 provider 重新校验 `outputJson` 的 schema 与 `outputSha256`。重复 marker/尾随文本/超限/错误签名一律拒绝。注意：候选与适配器同 UID，HMAC 只保证输出绑定/未被调包，不宣称完整敌对隔离（见上一节）。
- **不自动拉镜像**：`docker run --pull=never`；镜像不在本机时报 `isolation_unavailable`，不会下载。
- **纯静态/主题不再被 pending pin 挡住**：`isolated.py` 先判断是否有 1-4 级条目，全部静态时只校验包集合并通过；`main` 在静态模式不调用 `load_pin()`。
- **包集合**：拒绝重复报告条目、符号链接/目录等非普通文件，并逐个校验报告 SHA-256；push/main 只隔离 `subjects` 中的变更包，不再重跑全部可执行包。
- **签名清单**：`attest_subjects.py` 以报告 `subjects` 为准（PR=全部，push=变更包），并新增 `--isolation` 要求隔离结果 status=passed 且与包 SHA-256/manifest SHA-256 绑定。`security.yml` 的 attest 任务因此同时消费静态与隔离 artifact；maintenance push 显式跳过而不是失败。
- **工作流信任基线**：static job 需要 `pull-requests: read` 才能读取 PR 变更文件；attest 不再 checkout 工作区，改用可信副本里的 `attest_subjects.py`；`validate.yml`/`index.yml` 不再把候选 `.git` 复制进临时副本，并拒绝候选数据中的符号链接。
- **仍未完成（如实记录）**：固定镜像内从未执行过该适配器；pin 仍是 `pending`，且固定 commit 不含 `unifiedCapabilityDispatcher.js`，所以 `load_pin` 在 state=verified 时会先报 `runtime_pin_incomplete`。主机自测只覆盖自建 Node 与最小 Wasm fixture，不覆盖真实市场插件、真实镜像或真实微信。
