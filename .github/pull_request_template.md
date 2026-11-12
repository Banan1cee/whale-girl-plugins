## 本次改动

<!-- 插件投稿请填下面的项目。市场文档或维护改动请说明改动范围，插件专用项可填不适用。 -->

- 插件 ID 和版本
- 最低鲸鲸版本和插件 API
- 源码位置（`plugins/<id>/` 内）和构建步骤
- 使用的宿主扩展点、权限和数据
- 实测版本、安装及启停结果
- 类型：纯人设 / Api 1-2 工具 / Api 3 消息插件
- Api 3：发布者 GitHub 数字 ID、固定源码 commit、provenance 文件及安全报告；纯人设填不适用

## 投稿自查

- [ ] PR 的目标仓库和分支是 `Banan1cee/whale-girl-plugins:main`。
- [ ] 只加了 `plugins/<id>/` 和 `packages/<id>-<version>.zip`，**没有手改 `index*.json`**。
- [ ] ZIP 根目录只有该类型允许的文件，清单与包内一致。
- [ ] 所有插件配置和操作均在插件卡片的「设置」。
- [ ] 所用扩展点在申报版本可用；本地跑过 `node scripts/build-index.js --out <目录>` 与 `python validate.py`。
