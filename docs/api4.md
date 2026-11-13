# JavaScript 完整权限插件（Api 4）

最低客户端 **4.1.2**，不能装到 4.1.0/4.1.1。具体是否已发布，以鲸鲸 GitHub Releases 为准。
旧 Wasm 目录、权限与预算保持原样。Api 4 单独进入 `index-v4.json`。

完整协议与示例见主仓库 [JavaScript API 4](https://github.com/Banan1cee/whale_girl/blob/main/docs/插件JavaScriptApi4.md)。
可复制 `examples/api4-search` 开发。`node examples/api4-search/test.js` 验证九个触发/日期案例和结构化来源传递。

包根目录仅 `plugin.json` + `plugin.js`；UTF-8 CommonJS，包 16 MiB、代码 8 MiB。
可以把 Node.js 第三方依赖打包进单个脚本；`whale` 和 Node 内置模块不要打包进去，不自动执行 npm 安装脚本。
权限必须明确为 `["system.full"]`：这是本机完整权限，不是 Wasm 沙箱。
用户可以使用全部主程序 API、网络、文件、命令、模型、检索、定时任务与发送队列。
开启实验总闸后仍需逐插件确认。只安装信任的来源，扫描与上架不保证安全。

同 ID、同作者提高 Version 后直接更新，保留设置、会话状态与插件数据目录。
新版默认停用，重新确认后运行。不要覆盖旧版本 ZIP；改变数据格式时由作者迁移，建议维护 schemaVersion。

投稿步骤：

1. 源码放 `plugins/<id>/`，清单声明 Api 4、MinAppVersion >= 4.1.2、Hooks 和 system.full。
2. `node scripts/submit.js plugins/<id>` 打包和校验，另生成 `provenance/<id>-<version>.json`，绑定发布账号数字 ID 和固定源码 commit。
3. PR 只提交源码、固定版本 ZIP、溯源文件；目录和 SHA-256 自动生成。首次流程更改合并后，默认分支门禁才会使用新策略。
4. 有正式客户端后验证启用/拒绝、设置、运行、停用、更新保留状态、卸载；缺正式客户端时明确注明未 GUI 试装。

市场静态校验声明、包内容、格式、大小、来源和哈希；Api 4 兼容性测试只在临时 Docker 容器中运行，
固定镜像与真实宿主 commit/哈希，无网络、无凭据、只读挂载，限制 CPU、内存、进程数并确保超时清理。
输入为合成聊天和模拟 SDK 返回，不连接微信或真实模型。
这只能发现部分兼容性故障，不能验证所有业务分支，也不能证明拥有完整权限的代码无害。
禁止在可信门禁宿主直接运行投稿代码或投稿构建脚本。
