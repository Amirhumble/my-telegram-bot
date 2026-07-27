'use strict';

const { CHANNEL_INVITE_LINK } = require('../../config/env');

/**
 * Inline keyboard prompting the user to join the teaching channel
 * and confirm membership for referral verification.
 */
function channelJoinKeyboard() {
  const rows = [];

  if (CHANNEL_INVITE_LINK) {
    rows.push([{ text: '📢 Join Channel', url: CHANNEL_INVITE_LINK }]);
  }

  rows.push([{ text: '✅ I Joined', callback_data: 'joined_channel' }]);

  return {
    inline_keyboard: rows,
  };
}

module.exports = {
  channelJoinKeyboard,
};
