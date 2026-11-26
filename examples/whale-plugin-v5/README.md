# whale-plugin/1 示例

这里放两份最小的 whale-plugin/1 源码，用来演示新协议在市场里的目录与打包方式。
它们不是已上架条目，只是可以直接复制的模板。

- `theme-minimal/`：0 级纯数据主题，没有执行体、不申请系统权限。
- `tool-node/`：4 级 Node 手动工具，只声明 `tool.run@1` 和只读的 `status.read@1`。

## 本地自检

```bash
# 先复制到 plugins/<你自己的 id>，并修改清单里的 id / name / author / version
node scripts/package.js plugins/<id>
node scripts/submit.js plugins/<id>
```

`package.js` 只把 `plugin.json` 和该等级入口（0 级 `theme.json`、4 级 `plugin.js`）打进 ZIP；
`README.md`、`market.json`、图片只随源码提交，供市场卡片展示，不进入安装包。

`protocol.json` 是宿主注册表的副本（含来源 commit 与 sha256），等级、能力、输入输出
schema 和大小限制都以它为准。不要手改 `index*.json`：`index-v5.json` 由
`scripts/build-index.js` 从 `plugins/` 与 `packages/` 生成。

## 展示元数据（可选）

`plugins/<id>/market.json`：

```json
{
  "readme": "README.md",
  "images": ["preview.png"],
  "donation": { "afdian": "https://afdian.com/a/your-name" }
}
```

- `readme`：插件目录内的 Markdown 文件名，默认 `README.md`；最大 64 KiB。
- `images`：最多 8 张，必须是插件目录内的 PNG/JPG/GIF，单张不超过 2 MiB；
  README 里引用的本地图片必须在这里声明。
- `donation`：可选；只接受 `https://afdian.com/a/<个人主页>`（或 `www.afdian.com`），
  不写就不展示。未配置或非法地址不会出现在目录里。
- 更新时间由生成器从 Git 提交时间推导，作者不能手写，因而不能伪造。
