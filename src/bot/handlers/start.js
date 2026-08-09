'use strict';

const usersService = require('../../services/users');
const referralsService = require('../../services/referrals');
const telegram = require('../../services/telegram');
const { mainMenuKeyboard } = require('../keyboards/mainMenu');
const { channelJoinKeyboard } = require('../keyboards/channelJoin');
const { sendLoading, LOADING } = require('../../utils/userFeedback');
const logger = require('../../utils/logger');

/**
 * Handle /start and /start <referrerId>
 *
 * UX flow:
 *   1. Send immediate loading feedback
 *   2. Upsert user + record referral (DB work)
 *   3. Send welcome message
 *   4. If referred: send channel join prompt
 */
async function handleStart(message) {
  const chatId = message.chat.id;
  const from = message.from || {};
  const text = message.text || '';

  // Step 1 — Immediate feedback before any DB work
  await sendLoading(chatId, LOADING.START);

  // Step 2 — DB work
  const user = await usersService.upsertUser({
    telegramId: from.id,
    username: from.username,
    firstName: from.first_name,
  });

  // Parse deep-link payload: /start 123456789
  const parts = text.trim().split(/\s+/);
  const payload = parts.length > 1 ? parts[1].trim() : null;

  let referralNote = '';

  if (payload && /^\d+$/.test(payload)) {
    const result = await referralsService.recordReferral(payload, from.id);
    logger.info('Start with referral payload', {
      payload,
      userId: from.id,
      result: result.reason || 'ok',
    });

    if (result.ok) {
      referralNote =
        '\n\n📢 እባክዎ ቻናላችንን ይቀላቀሉ። ከተቀላቀሉ በኋላ ወደ እዚህ ተመልሰው<b>✅ I Joined</b> የሚለውን ይጫኑ።';
    }
  }

  // Step 3 — Welcome message
  const welcome =
    `እንኳን በደህና መጡ${user?.first_name ? ', ' + user.first_name : ''}።\n` +
    `ከታች ያለውን <b>Menu</b> በመጫን አገልግሎቶችን ያገኛሉ።` +
    referralNote;

  await telegram.sendMessage(chatId, welcome, {
    reply_markup: mainMenuKeyboard(),
  });

  // Step 4 — Channel join prompt for referred users
  if (payload && /^\d+$/.test(payload)) {
    await telegram.sendMessage(
      chatId,
      'ቻናሉን ከተቀላቀሉ በኋላ ከታች ያለውን ቁልፍ ይጫኑ፦',
      { reply_markup: channelJoinKeyboard() }
    );
  }
}

module.exports = {
  handleStart,
};
