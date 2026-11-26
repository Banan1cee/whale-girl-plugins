'use strict';

exports.hooks = {
  'chat.pre_reply': ({ message, settings }) => {
    if (message?.platform !== 'wechat' || message.chatType !== 'group') {
      return { action: 'pass' };
    }
    const groups = String(settings?.groups ?? '').split(/[,，\s]+/).filter(Boolean);
    if (!groups.includes(message.chatId)) {
      return { action: 'pass' };
    }
    return { action: message.atMe === true || message.replyToBot === true ? 'pass' : 'skip' };
  },
};
