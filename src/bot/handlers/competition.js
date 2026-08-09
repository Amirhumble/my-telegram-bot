'use strict';

const usersService = require('../../services/users');
const referralsService = require('../../services/referrals');
const telegram = require('../../services/telegram');
const { BOT_USERNAME } = require('../../config/env');
const { mainMenuKeyboard } = require('../keyboards/mainMenu');
const { sendLoading, sendUserError, LOADING } = require('../../utils/userFeedback');
const logger = require('../../utils/logger');

/**
 * Competition Link button / /competition command.
 * Shows invitation link only — never points or rankings.
 *
 * UX flow:
 *   1. Send immediate loading feedback
 *   2. Upsert user
 *   3. Build and send the referral link
 */
async function handleCompetitionLink(message) {
  const from = message.from || {};
  const chatId = message.chat.id;

  // Step 1 — Immediate feedback
  await sendLoading(chatId, LOADING.COMPETITION);

  try {
    // Step 2 — Upsert user
    await usersService.upsertUser({
      telegramId: from.id,
      username: from.username,
      firstName: from.first_name,
    });

    // Step 3 — Build link (synchronous, no DB needed) and send
    const link = referralsService.buildInvitationLink(from.id, BOT_USERNAME);

    const text =
      `🔗 <b>Your Invitation Link</b>\n\n` +
      `${link}\n\n` +
      `Share this link with others.\n\n` +
      `Eligible referrals are tracked automatically after channel membership verification.`;

    await telegram.sendMessage(chatId, text, {
      reply_markup: mainMenuKeyboard(),
      disable_web_page_preview: true,
    });
  } catch (err) {
    logger.error('handleCompetitionLink failed', { chatId, message: err.message });
    await sendUserError(chatId, mainMenuKeyboard());
  }
}

module.exports = {
  handleCompetitionLink,
};
