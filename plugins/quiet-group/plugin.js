'use strict';

/**
 * 群聊安静模式 · whale-plugin/1 / 4 级 node-full
 *
 * 在宿主前置闸之后、决定是否回复与生成之前，只对名单内的微信群拦截普通消息；
 * 明确 @ 或引用回复机器人时继续放行，字段由宿主标准化后提供。
 */
exports.providers = {
  'chat.pre_reply@1': async (input, context) => {
    const message = input?.message;
    if (!message || message.platform !== 'wechat' || message.chatType !== 'group') {
      return { action: 'pass' };
    }
    const groups = String(context?.settings?.groups ?? '')
      .split(/[,，\s]+/)
      .map(item => item.trim())
      .filter(Boolean);
    if (!groups.includes(message.chatId)) return { action: 'pass' };
    // @ 与引用回复均为指向机器人的明确交互，安静模式不拦截。
    const quoted = message.replyToBot === true;
    return quoted || message.atMe === true
      ? { action: 'pass' }
      : { action: 'skip', reason: 'quiet-group: muted ordinary group message' };
  },
};
