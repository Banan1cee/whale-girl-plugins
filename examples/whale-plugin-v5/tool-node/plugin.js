'use strict';

// 4 级 Node 工具示例：只使用清单声明的只读宿主能力。
// 注意：Node 插件以完整系统权限运行，不是沙箱；这里的 calls 约束的是宿主 SDK 接口，
// 不会限制代码本身的文件/网络/系统访问，启用时用户需要确认完整系统权限。
exports.providers = {
  'tool.run@1': async (input, { host }) => {
    const status = await host.call('status.read@1', {});
    return {
      chars: [...String(input.text || '')].length,
      appVersion: status.version,
    };
  },
};
