# 主动搭话增强（care-plus · whale-plugin/1 4 级）

- 等级：`level 4`（`node-full`，`plugin.js`）
- provides：`tool.run@1`（tool/manual）、`task.tick@1`（schedule/all，`intervalSeconds: 300`）
- calls：`persona.read@1`、`memory.recent@1`、`model.complete@1`、`message.send@1`、`care.decide@1`
- 最低宿主：`minAppVersion 4.3.0`
- 版本：1.0.2（1.0.1 → 1.0.2：移除仅供测试的 `exports.__test` 调试导出，生产入口只留 `exports.providers`）
- 旧 Api 4 源码在 `plugins/care-plus/legacy/`，**不打包**；市场同 id 的 v4 旧条目需要由维护者在重建目录时移除（本卡未改 index）。

> **风险：官方 care 开着会双份搭话。** 新协议没有关闭/恢复官方 care 的能力，本插件启动后不会
> PATCH `care.enabled`。启用前请手动关闭"主动搭话"，否则官方与本插件会各发一次。

## 保留与降级

- 保留：随机沉默锚点、时间窗、每天上限、候选生成与相似度淘汰、群/私聊按 `@chatroom` 判定、`dryRun`、手动 `tool.run` 触发一次判定。
- 采样：`memory.recent@1`（最近 12 条）与 `model.complete@1`；人设只来自 `persona.read@1` 的 4 个字段。
- 目标：来自插件设置 `targets`；为空时把 `care.decide@1` 的单个 `target` 当建议，不再与官方白名单同步。
- 状态：4 级 worker 每次调用都是新进程，模块级变量会清零；`task.tick` 也拿不到宿主 `state` 通道。因此日计数、每会话 `nextAt`/最近句子、`firstSeenAt` 都原子写在 worker 私有 cwd 的 `care-plus-state.json`（宿主 `data/plugins/care-plus/data/`），配合同目录的 `care-plus.lock` 防并发 tick；会话有 7 天 TTL、最多 32 个、文件最多 32 KiB。两次 tick 间隔超过 15 分钟按「宿主重启」重新计启动静默。卸载会随插件目录清空；旧版 `ctx.state` 不继承。
- 发送：`message.send@1` 只返回排队结果，`queued` 仅表示已入队，不是微信送达，官方 `sentToday` 也不会增长。
- 调用形状：`model.complete@1` 的 `turns` 只用 `{role,content}`（registry `additionalProperties:false` 会拒绝 `text` 字段）；`message.send@1` 只传 `chatId/text/chatType`，不传可选的 `name`。

## 逐条差异（旧 → 新）

1. **不再读官方 care 配置**：旧 `legacy/plugin.js:936` 的 `GET /api/config` 不可用；`settings.read@1` 也没有 care 字段。白名单/主人/群/时段/上限全部改为插件 `settingsSchema`，旧用户升级后必须重填。
2. **不能自动关闭官方 care**：旧 `enforceTakeover`（`legacy/plugin.js:973-985`，PATCH `care.enabled=false`）删除；改为 README 与 status 里提示用户手动关闭（见上方风险）。
3. **不能恢复官方 care**：旧 `app.stop` 的恢复逻辑（`legacy/plugin.js:1143-1157`）无对应，删除；没有启动/停止回调。
4. **提示词降级**：旧 `POST /api/debug/prompt`（`legacy/plugin.js:615`）不可用；改为 `persona.read@1` + `memory.recent@1` 自拼 system，拿不到官方完整人设、记忆块、关系块与 token 预算。
5. **发送记账消失**：旧 `POST /api/care/sent`（`legacy/plugin.js:779`）无对应；改为插件私有状态文件计数（只有 `message.send@1` 调用成功返回才 +1，失败/取消不计数），官方 care 的 sentToday 不变。
6. **`thinking` 失效**：旧 `W.model(...thinking)`（`legacy/plugin.js:568-573`）；`model.complete@1` 没有该字段，配置不再生效。
7. **多目标调度退化**：`care.decide@1` 只返回一个 `target` 且按官方节奏（宿主 `src/services/features/core.js:30-38`）；多目标靠插件设置 + `memory.recent@1` 逐个判断，精度依赖最近 12 条是否含时间戳。
8. **外部进程启停删除**：旧插件没有外部进程；新 `app.start/app.stop` observe 可用但没有需要观察的进程，因此不声明，避免空转。
9. **文件布局依赖删除**：旧直读 `messages.jsonl`、`people/*.json`、`contacts-cache.json`（`legacy/plugin.js:220-227,386-393,759-766`）不是契约；改为能力调用，空数据时跳过该会话。
10. **状态迁移**：旧 `ctx.state`（`legacy/plugin.js` 的 state 结构）由宿主保存；新协议聊天类 state 不覆盖 `task.tick`，改为插件私有文件（见上文「状态」），旧计数不继承。
11. **权限模型变化**：旧 `system.full` 单条授权 → 4 级 + 逐项能力授权（5 个 calls）。撤销/重装后队列里的插件消息按宿主授权规则处理。
12. **id 冲突**：与 `index-v4.json` 同 id；重建目录后 v4 旧条目消失（本卡不动 index，合并时由 build-index 重新生成）。

## 适配难点：只有读代码才能解决的

1. **`memory.recent@1` 的真实返回形状**：文档只说"最近消息"，实际是 `{messages:[...]}`，条数上限 50、默认 12，字段投影在宿主 `src/services/features/memory.js:26-32`；没有时间戳字段说明，迁移里只能兼容 `ts/time/createdAt/at` 并接受锚点降级。文档缺 → 读代码。
2. **`care.decide@1` 只给一个目标**：返回 `{due,reason,target,windows,gap,wait}` 的细节只在宿主 `src/services/features/core.js:30-38`；文档没写它按官方 care 节奏且不含多目标。绕过：把它当建议，不当作调度器。
3. **`task.tick@1` 没有 `state`**：输入只有 `{scheduledAt,now,settings}`（宿主 `src/services/pluginProtocolRegistry.json` 的 schema），旧 `ctx.state` 无对应；宿主 state 通道只对四个聊天类扩展点开放。改用 worker 私有 cwd 的状态文件 + 调用锁。文档缺 → 读 schema/运行时。
4. **`message.send@1` 的送达语义**：市场文档只写"queued"，代码注释明确"queued 不是送达"且返回 `{id,status,confirmed}`、必须有插件上下文（宿主 `src/services/features/message.js:6-10,26-30`）。绕过：输出只声明排队，不再提供 confirmed/status 查询。
5. **`persona.read@1` 只有 4 个字段**：`{name,ownerName,tone,style}` 在宿主 `src/services/features/personaSettings.js:32-35`，文档没有说明拿不到完整 system；只能自拼提示词。
6. **`settingsSchema` 注解限制**：`title` 非空、注解长度、允许关键字只见于市场 `validate.py:305-369` 与宿主 `capabilitySchema.js`；文档没列。绕过：只用最小关键字集合、控制文案长度。
7. **`app.lifecycle.input@1` 的 `at` 是 number 而非 ISO**：宿主 registry `1662` 行；文档没写。本插件不声明 app.*，但评估期需要看 schema 才能避免误用。
