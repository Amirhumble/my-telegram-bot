'use strict';

const referralsService = require('../../services/referrals');
const telegram = require('../../services/telegram');
const { channelJoinKeyboard } = require('../keyboards/channelJoin');
const { sendLoading, LOADING } = require('../../utils/userFeedback');
const logger = require('../../utils/logger');

/**
 * Handle callback_query for "✅ I Joined"
 *
 * UX flow:
 *   1. answerCallbackQuery immediately (stops the Telegram spinner)
 *   2. Send loading message to chat (user sees "checking…" text)
 *   3. getChatMember() + verify referral in DB
 *   4. Send final result message
 */
async function handleJoinedCallback(callbackQuery) {
  const from = callbackQuery.from || {};
  const chatId = callbackQuery.message?.chat?.id;
  const callbackId = callbackQuery.id;

  // Step 1 — Answer callback immediately. Must happen before any slow work.
  await telegram.answerCallbackQuery(callbackId, '');

  // Step 2 — Show processing feedback in the chat window
  if (chatId) {
    await sendLoading(chatId, LOADING.MEMBERSHIP);
  }

  // Step 3 — Check membership and verify referral
  const result = await referralsService.verifyReferral(from.id);

  logger.info('Joined channel callback', {
    userId: from.id,
    result: result.reason,
  });

  // Step 4 — Final result
  if (result.reason === 'not_member') {
    if (chatId) {
      await telegram.sendMessage(
        chatId,
        '❌ ገና ቻናሉን አልተቀላቀሉም። እባክዎ መጀመሪያ ይቀላቀሉ፣ ከዚያ ✅ I Joined ይጫኑ።',
        { reply_markup: channelJoinKeyboard() }
      );
    }
    return;
  }

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
