# deepseek-whale-persona · 鲸鲸 4.1 人设包

DeepSeek 小鲸鱼（傲娇向）人格预设。纯数据包：没有 Wasm、没有网络、没有权限声明，装进去只是往人格预设列表里加一条。

## 目录

```
deepseek-whale-persona/
├── plugin.json                 清单（Id / Name / Author / Version / MinAppVersion / Description / Api / Kind）
├── src/persona.txt             人设正文，唯一的可编辑源
├── build.py                    由源生成 persona.json 并打 ZIP
├── check.py                    离线对照市场 validate.py 的 persona 分支逐条自检
├── test/cases.json             五组「输入 → 预期」
├── test/check_cases.py         静态测试：每组的触发词与规则必须还在提示词里
└── dist/deepseek-whale-persona-1.1.2.zip   安装包（根目录只有 plugin.json + persona.json）
```

## 已核对的接口（目标版本：鲸鲸 4.1.0）

| 项 | 结论 | 依据 |
| --- | --- | --- |
| 人设包类型 | 支持，`Api: 1` + `Kind: "persona"` | `validate.py` 的 `check_capabilities(..., persona=True)` |
| 包内容 | 只能有 `plugin.json` + `persona.json`，多一个文件就不合法 | `validate.py:110-115` |
| `persona.json` | 只允许一个键 `customPrompt`，字符串 1~24000 字 | `validate.py:121-124`、客户端 `src/persona/presets.js:33` |
| 容量 | ZIP ≤ 1 MiB、清单 ≤ 8 KiB、正文 ≤ 64 KiB | `validate.py:107-116` |
| 客户端安装后落盘 | `data/plugins/<id>.persona.json`，由宿主补 `name/version/description` | `src/persona/presets.js:11-39` |
| 需要额外权限 | 不需要。`HostAction` / `Hooks` / `Permissions` 对人设包必须为空 | `validate.py:59-62` |
| 清单字段 | 按入门模板填全，含 `ResultLabel`；人设包不显示它，但会随清单进目录 | 入门文档·技术要求、`build-index.js` 的 `{...manifest}` |

所以：**没有缺接口**，不需要宿主改动，也不需要等测试版。

## 构建与自检

```bash
python build.py            # 生成 dist/<id>-<version>.zip
python check.py            # 对照市场规则的静态自检
python test/check_cases.py # 五组用例的静态覆盖
```

`build.py` 会拒绝这些情况：正文超过 24000 字、正文带 Markdown 标题、正文为空。
`check.py` 覆盖了市场校验里所有与包内容相关的规则；SHA-256 与下载地址由市场 CI 生成，本包不写。

## 本地试装（4.1.0）

1. 打开鲸鲸 →「插件市场」→「从本地安装」，选 `dist/deepseek-whale-persona-1.1.2.zip`。
2. 确认弹窗会显示包内自报作者与版本，看完再装。
3. 「已安装」里找到卡片 →「启用」。
4. 同一张卡片的「设置」→ 预览提示词 → 应用。
5. 到「人设 → 人格预设」确认列表里多了一条 `market-deepseek-whale-persona`。

配置、启用、预览、应用全在插件卡片的「设置」里，不新增任何工作台/托盘入口。

## 与 1.0.0 的差别

- 正文从 Markdown 版换成纯文本版。原人设卡自己写着「AI 味黑名单：Markdown 标题、列表、加粗」，而提示词里带着 `##`、`**` 会把这个格式示范给模型；纯文本版内容一字未改，只是排版换掉了。
- 清单按入门模板填全：`Id`、`Name`、`Author`、`Version`、`MinAppVersion`、`Description`、`ResultLabel`、`Api`，另加 `Kind: "persona"`。`ResultLabel` 在人设包里不参与显示，但模板要求填，市场目录也会原样带上。
- `Author` 从占位 `your-github-name` 换成 `Xiaokun2233`；`Name` 用「小鲸鱼（傲娇版）」。
- 版本升到 1.1.2：`Name`/`Author` 也进了清单，改它们同样是换包；同名同版本不能覆盖，所以每改一次清单升一版。1.1.0、1.1.2 都未对外发布，已由本版取代。

## 公开上架时（本次未做）

只需两处，目录与哈希由市场 CI 生成，不改 `index*.json`：

```
plugins/deepseek-whale-persona/plugin.json
packages/deepseek-whale-persona-1.1.2.zip
```

PR 目标固定为 `Banan1cee/whale-girl-plugins:main`，提交前核对 base 仓库与 base 分支。本次没有推送、没有开 PR。
