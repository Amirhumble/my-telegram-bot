'use strict';

const referralsService = require('../../services/referrals');
const telegram = require('../../services/telegram');
const { channelJoinKeyboard } = require('../keyboards/channelJoin');
const { sendLoading, LOADING } = require('../../utils/userFeedback');
const { acquire, release, OPS } = require('../../utils/userOperationLock');
const logger = require('../../utils/logger');

/**
 * Handle callback_query for "✅ I Joined"
 *
 * UX flow:
 *   1. answerCallbackQuery immediately (stops the Telegram spinner)
 *   2. Acquire per-user lock (bail if already checking)
 *   3. Send loading message to chat
 *   4. getChatMember() + verify referral in DB
 *   5. Send final result
 *   6. Release lock in finally
 */
async function handleJoinedCallback(callbackQuery) {
  const from = callbackQuery.from || {};
  const chatId = callbackQuery.message?.chat?.id;
  const callbackId = callbackQuery.id;
  const userId = from.id;

  // Step 1 — Answer callback immediately (must be first, always)
  await telegram.answerCallbackQuery(callbackId, '');

  // Step 2 — Acquire lock
  if (!acquire(userId, OPS.MEMBERSHIP)) {
    if (chatId) await sendLoading(chatId, LOADING.ALREADY_PROCESSING);
    return;
  }

  try {
    // Step 3 — Loading feedback
    if (chatId) {
      await sendLoading(chatId, LOADING.MEMBERSHIP);
    }

    // Step 4 — Check membership and verify referral
    const result = await referralsService.verifyReferral(userId);

    logger.info('Joined channel callback', {
      userId,
      result: result.reason,
    });

    // Step 5 — Final result
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
      await telegram.sendMessage(
        chatId,
        '✅ ቻናሉን በተሳካ ሁኔታ ተቀላቅለዋል። እናመሰግናለን!'
      );
    }
  } catch (err) {
    logger.error('handleJoinedCallback failed', { userId, message: err.message });
    if (chatId) {
      await telegram.sendMessage(
        chatId,
        '❌ ይቅርታ፣ ለማረጋገጥ አልተቻለም። እንደገና ይሞክሩ።',
        { reply_markup: channelJoinKeyboard() }
      ).catch(() => {});
    }
  } finally {
    // Step 6 — Always release, even on error
    release(userId, OPS.MEMBERSHIP);
  }
}

module.exports = {
  handleJoinedCallback,
};
