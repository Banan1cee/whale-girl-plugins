# 示例薄荷主题

0 级纯数据主题，只改启动器外观：没有 `plugin.js` / `plugin.wasm`，安装和启用都不执行代码，
也不产生授权记录。

- 入口固定为 `theme.json`；`theme.json` 的 `id` 必须与 `plugin.json` 的 `id` 一致。
- 只允许有限的语义 token：7 个颜色键、字体白名单、字号/间距 0.85–1.15、圆角 0–24。
  安全信号色（成功/警告/危险）与顶栏不在主题范围内。
- 主题不包含页面布局、导航或弹窗行为；页面样式是启动器本地文件，不随插件包分发。

复制 `theme-minimal/` 到 `plugins/<id>/`，修改两个文件里的 `id`/`name`/`author`/`version` 后：

```bash
node scripts/package.js plugins/<id>
node scripts/submit.js plugins/<id>
```
