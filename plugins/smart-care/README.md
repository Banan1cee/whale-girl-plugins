# 智能搭话（smart-care）· whale-plugin/1

这是 `smart-care` 从旧 **Api 4** 迁移到 **4 级 `whale-plugin/1`** 的版本。旧源码保留在 `legacy/`，不进入安装包。

> **重要降级**：旧版直接读 `data/config.json`、`data/persona.json`、`contacts-cache.json`、与 bridge 共享的 `care-state.json`，并直连 DeepSeek Search API、`/api/care`、`/api/care/sent`。新协议禁止这些内部通道，本版改为 `host.call`；拿不到的能力如实降级，不硬编：
> - **无法写共享 care 账本** → 官方「主动与提醒」同时开着时，可能和插件双发；建议在官方页关闭内置主动搭话；
> - **无法调 `/api/care/sent`** → 插件主动发出的搭话/生气话不会出现在宿主「最近动态」；
> - **无法直连 DeepSeek Key** → 只用宿主 `search.query@1` 的摘要，不再拿网页正文/authority；没有 Key 可读；
> - **`persona.read@1` 只返回 name/ownerName/tone/style，不含 customPrompt** → 旧“从人设自动提取兴趣”改为设置项 `interestWords` 显式填写；留空则只用普通关心。

## 等级与声明

| 项 | 值 |
| --- | --- |
| 等级 | 4（`plugin.js` / `node-full`） |
| provides | `task.tick@1`（schedule/all，60 秒）、`chat.pre_reply@1`（gate/all）、`chat.prompt@1`（enhance/all）、`chat.search@1`（replace/all） |
| calls | `care.decide@1`、`contacts.list@1`、`persona.read@1`、`model.complete@1`、`message.send@1`、`search.query@1` |
| dataAccess | `model.prompt` |
| settings | 旧 11 项 + `interestWords`（见下） |
| 超时 | 45 秒 |

### 为什么没有 `chat.generate@1`

旧 `chat.generate` 是“命中点名指令才接管，未命中返回 `undefined` 交还宿主”。新 `chat.generate@1` 是 **replace**，没有 pass 语义，声明后必须为每条消息生成文本；用它做“可选拦截”会迫使插件接管全部生成或抑制正常回复。因此本版用 `chat.pre_reply@1` gate 实现同样的“命中才接管”（私聊点名指令，发完回执后 `skip`），未命中 `pass`。这是对卡片清单的**有意偏离**，也是协议 v2 仍缺的“可选 generate”能力。

`chat.prompt@1` 的怒气注入需要 system；清单已声明 `"dataAccess": ["model.prompt"]`（宿主 v2 已支持；市场 validate.py 尚未同步，见报告）。若宿主未授予该权限，插件拿不到 system 时抛错，宿主保留原提示词，怒气注入降级。

## 设置

```json
{
  "enabled": true,
  "minIntervalMinutes": 30,
  "maxPerHour": 4,
  "careInterestChance": 90,
  "autoCare": true,
  "angryEnabled": true,
  "ignoreThreshold": 2,
  "ignoreWindowMinutes": 20,
  "outboundGapMinutes": 10,
  "angryStartDelayMinutes": 30,
  "angryLevelUpMinutes": 60,
  "interestWords": ""
}
```

- `enabled`：总开关；关闭后点名/定时/搜索/生气全部停。
- `minIntervalMinutes` / `maxPerHour`：搜索增强的本地限流（与旧版一致）。
- `careInterestChance`：点名/定时搭话使用兴趣话题的百分比。
- `autoCare`：是否按宿主 care 配置做定时主动搭话。
- `angryEnabled`：是否启用被无视生气。
- `ignoreThreshold` / `ignoreWindowMinutes`：连续几次、多久没回算被无视。
- `outboundGapMinutes`：搭话与生气的发送间隔。
- `angryStartDelayMinutes` / `angryLevelUpMinutes`：达到阈值后多久发第一句、每级间隔。
- `interestWords`：逗号/空格分隔的兴趣词；旧版从 persona customPrompt 自动提取，新 `persona.read@1` 不返回 customPrompt，只能显式填写。

## 行为

- **点名搭话**：私聊发「去找 tree 搭话」等；`contacts.list@1` 反查联系人（排除群/系统号），`model.complete@1` 生成搭话，`message.send@1` 发给目标，再给主人发回执；回执成功后 `skip` 宿主默认回复，失败则 `pass` 让宿主补一句。
- **搜索增强**：`chat.search@1` replace；时效/兴趣命中时用 `search.query@1` 查最多 3 条并合并，否则用 `search.query@1` 做一次普通搜索作为兜底（旧版无命中时交还宿主默认搜索；新 replace 无 pass，只能这样近似）。
- **定时搭话**：`task.tick@1` 每 60 秒；`care.decide@1` 用宿主 care 的时间窗/白名单/频率/上限判定；`care.decide` 返回 due+target 后再生成/发送；用插件自己的 `autoLastTs/autoCount` 作为输入，不读共享账本。
- **生气**：`task.tick@1` 累计 pending 超时、按等级延迟/升级，生成一句抱怨发回原会话；`chat.prompt@1` 对当前会话的欠账对象注入怒气口吻；道歉会清怒气（简化版，见差异）。
- **状态**：`smart-care-state.json` 在插件 data 目录（`process.cwd()`）；`task.tick` 用 `smart-care.lock` 防重叠。

## 和旧版的逐条差异

1. **点名搭话从 `chat.generate` 改到 `chat.pre_reply@1` gate**：原因见上；查询指令只在私聊处理，命中且成功回执返回 `skip`，未命中或回执失败返回 `pass`。当前 gate 在宿主基础闸之后、`wake` 早退之前调用，所以未被 @/未被触发回复的私聊命令也会进入并处理，不再受「宿主已决定回复」限制；群消息仍按插件的私聊限制 pass。
2. **删除 `care-state.json` 共享账本**：无法把官方 care 的 count/lastTs 顶到上限；官方 care 同时开启时可能双发。建议在官方页关闭内置主动搭话；这是本版最重要的风险。
3. **删除 `/api/care/sent` 记录**：插件发出的搭话/生气话不会进入宿主「最近动态」；回执仍发给主人。
4. **删除 `/api/care?chat=` 生成**：改用 `model.complete@1` + 人设摘要生成；不再有宿主 care 模板/上下文。
5. **删除 DeepSeek Search API 直连和 Key 读取**：只用 `search.query@1`；没有网页正文、authority 排序、`after:` 时效语法。
6. **`persona.read@1` 只有 name/ownerName/tone/style**：不能从 customPrompt 自动提取兴趣；改为 `interestWords` 设置；旧用户需要重填。
7. **contacts-cache.json → `contacts.list@1`**：读的是宿主通讯录缓存；找不到/不可用时点名指令交还宿主（旧版也 pass）。
8. **`whale.model` → `model.complete@1`**：无 `thinking` 参数；返回 `{text,usage}`；计费仍走宿主。
9. **`whale.send` → `message.send@1`**：只返回 `queued`，不是送达；`name` 只做展示，寻址必须用 chatId；旧 bridge 的“按名字找会话”语义消失。
10. **`chat.search` replace 无 pass**：旧版无命中返回 `{}` 交还宿主默认搜索；新版 replace 只能自己调 `search.query@1` 近似，且多一次搜索调用；这是协议仍缺的 fallback 语义。
11. **生气状态机简化**：保留阈值/窗口/延迟/三级/道歉消气，但去掉了旧版的跨目标共享账本、软压、部分冷却细节；具体行为以本文件为准，不再声称与旧版逐字节一致。
12. **没有 `app.start/app.stop`、没有宿主事件记录**：旧版也没用 app 钩子；新清单不声明。
13. **不读宿主 config/Key、不走 `/api/*`、不 require('whale')**：全部删除；只保留声明过的 host calls。
14. **设置字段新增 `interestWords`**：旧 11 项之外的新字段，用于替代旧的人设自动提取；其余旧字段保留并带默认值。
15. **`chat.prompt` 的 dataAccess 已声明**：4 级 `dataAccess:["model.prompt"]` 已随 v2 生效；未授予时怒气注入降级（宿主保留原 system）。

## 旧源码

`legacy/plugin.js`、`legacy/plugin.json` 是迁移前原样文件，供对照/回滚，不打包；旧 README 也保留在 `legacy/README.md`（如有）。

## 验证记录

- `node scripts/package.js plugins/smart-care`：生成 `packages/smart-care-2.0.0.zip`。
- `node scripts/plugin-cli.js validate/test`：通过（静态，不执行）。
- 未 GUI 试装、未运行插件/模型/搜索、未联网。


