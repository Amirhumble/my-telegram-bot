'use strict';

const referralsService = require('../../services/referrals');
const telegram = require('../../services/telegram');
const { channelJoinKeyboard } = require('../keyboards/channelJoin');
const logger = require('../../utils/logger');

/**
 * Handle callback_query for "✅ I Joined"
 */
async function handleJoinedCallback(callbackQuery) {
  const from = callbackQuery.from || {};
  const chatId = callbackQuery.message?.chat?.id;
  const callbackId = callbackQuery.id;

  const result = await referralsService.verifyReferral(from.id);

  logger.info('Joined channel callback', {
    userId: from.id,
    result: result.reason,
  });

  if (result.reason === 'not_member') {
    await telegram.answerCallbackQuery(
      callbackId,
      'You have not joined the channel yet. Please join first.',
      true
    );

    if (chatId) {
      await telegram.sendMessage(
        chatId,
        '❌ ገና ቻናሉን አልተቀላቀሉም። እባክዎ መጀመሪያ ይቀላቀሉ፣ ከዚያ ✅ I Joined ይጫኑ።',
        { reply_markup: channelJoinKeyboard() }
      );
    }
    return;
  }

  await telegram.answerCallbackQuery(callbackId, 'Thank you! Membership confirmed.');

  if (chatId) {
    // Do NOT reveal points/referral counts to the user
    await telegram.sendMessage(
      chatId,
      '✅ ቻናሉን በተሳካ ሁኔታ ተቀላቅለዋል። እናመሰግናለን!'
    );
  }
}

module.exports = {
  handleJoinedCallback,
};
