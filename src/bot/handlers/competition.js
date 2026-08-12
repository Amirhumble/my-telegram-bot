'use strict';

const usersService = require('../../services/users');
const referralsService = require('../../services/referrals');
const telegram = require('../../services/telegram');
const { BOT_USERNAME } = require('../../config/env');
const { mainMenuKeyboard } = require('../keyboards/mainMenu');
const { sendLoading, sendUserError, LOADING } = require('../../utils/userFeedback');
const { acquire, release, OPS } = require('../../utils/userOperationLock');
const logger = require('../../utils/logger');

/**
 * Competition Link button / /competition command.
 * Shows invitation link only — never points or rankings.
 *
 * UX flow:
 *   1. Acquire per-user lock (bail if already running)
 *   2. Send immediate loading feedback
 *   3. Upsert user + build and send referral link
 *   4. Release lock in finally
 */
async function handleCompetitionLink(message) {
  const from = message.from || {};
  const chatId = message.chat.id;
  const userId = from.id;

  if (!acquire(userId, OPS.COMPETITION)) {
    await sendLoading(chatId, LOADING.ALREADY_PROCESSING);
    return;
  }

  try {
    await sendLoading(chatId, LOADING.COMPETITION);

    await usersService.upsertUser({
      telegramId: from.id,
      username: from.username,
      firstName: from.first_name,
    });

    const link = referralsService.buildInvitationLink(from.id, BOT_USERNAME);

    const text =
      `🔗 <b>የእርሶ የመጋበዣ ሊንክ</b>\n\n` +
      `${link}\n\n` +
      `ይሄን ሊንክ ኮፒ በማድረግ ያጋሩ\n\n` +
      `ያጋሩት ሰው ወደ ቻናሉ መቀላቀሉ ከተረጋገጠ በኋላ እርስዎ የግብዣ ነጥቦችኝ ያገኛሉ።\n\n`

    await telegram.sendMessage(chatId, text, {
      reply_markup: mainMenuKeyboard(),
      disable_web_page_preview: true,
    });
  } catch (err) {
    logger.error('handleCompetitionLink failed', { chatId, message: err.message });
    await sendUserError(chatId, mainMenuKeyboard());
  } finally {
    release(userId, OPS.COMPETITION);
  }
}

module.exports = {
  handleCompetitionLink,
};
