'use strict';

const usersService = require('../../services/users');
const referralsService = require('../../services/referrals');
const telegram = require('../../services/telegram');
const { BOT_USERNAME } = require('../../config/env');
const { mainMenuKeyboard } = require('../keyboards/mainMenu');

/**
 * Competition Link button / /competition command.
 * Shows invitation link only — never points or rankings.
 */
async function handleCompetitionLink(message) {
  const from = message.from || {};
  const chatId = message.chat.id;

  await usersService.upsertUser({
    telegramId: from.id,
    username: from.username,
    firstName: from.first_name,
  });

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
}

module.exports = {
  handleCompetitionLink,
};
