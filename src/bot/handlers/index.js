'use strict';

const { BUTTONS } = require('../keyboards/mainMenu');
const { handleStart } = require('./start');
const { handleSoftCopies, handleDersProgram } = require('./resources');
const { handleCompetitionLink } = require('./competition');
const {
  promptFeedback,
  handleFeedbackCommand,
  maybeHandlePendingFeedback,
} = require('./feedback');
const { handleJoinedCallback } = require('./referral');
const { handleAdminCommand } = require('./admin');
const telegram = require('../../services/telegram');
const { mainMenuKeyboard } = require('../keyboards/mainMenu');
const logger = require('../../utils/logger');
const { safeRun } = require('../../utils/errors');

/**
 * Normalize command text: strip @botname suffix from /cmd@BotName
 */
function normalizeCommand(text) {
  if (!text) return '';
  const trimmed = text.trim();
  // /start@MyBot payload  → keep payload
  const match = trimmed.match(/^\/([a-zA-Z0-9_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
  if (!match) return trimmed;
  const cmd = match[1].toLowerCase();
  const rest = match[2] ? match[2].trim() : '';
  return rest ? `/${cmd} ${rest}` : `/${cmd}`;
}

/**
 * Route a single Telegram update (message or callback_query).
 */
async function handleUpdate(update) {
  if (update.callback_query) {
    await safeRun('callback_query', () => handleCallbackQuery(update.callback_query));
    return;
  }

  if (update.message) {
    await safeRun('message', () => handleMessage(update.message));
  }
}

async function handleCallbackQuery(callbackQuery) {
  const data = callbackQuery.data;

  if (data === 'joined_channel') {
    await handleJoinedCallback(callbackQuery);
    return;
  }

  // Unknown callback — just acknowledge
  await telegram.answerCallbackQuery(callbackQuery.id);
}

async function handleMessage(message) {
  // Only process text messages for this bot
  if (!message.text) return;

  const chatId = message.chat.id;
  const rawText = message.text.trim();
  const text = normalizeCommand(rawText);

  logger.debug('Incoming message', { chatId, text: rawText.slice(0, 80) });

  // 1) Multi-step feedback capture (before menu routing)
  const handledFeedback = await maybeHandlePendingFeedback(message);
  if (handledFeedback) return;

  // 2) Admin commands (silently no-op for non-admins when matched)
  if (text.startsWith('/admin_')) {
    const handled = await handleAdminCommand({ ...message, text });
    if (handled) return;
    // Non-admin: fall through to unknown / ignore
    return;
  }

  // 3) Reply keyboard buttons
  if (rawText === BUTTONS.SOFT_COPIES) {
    await handleSoftCopies(message);
    return;
  }
  if (rawText === BUTTONS.DERS_PROGRAM) {
    await handleDersProgram(message);
    return;
  }
  if (rawText === BUTTONS.COMPETITION_LINK) {
    await handleCompetitionLink(message);
    return;
  }
  if (rawText === BUTTONS.FEEDBACK) {
    await promptFeedback(message);
    return;
  }

  // 4) Slash commands (backward compatible)
  if (text === '/start' || text.startsWith('/start ')) {
    // Preserve original payload from raw text for deep links
    await handleStart({ ...message, text: rawText });
    return;
  }

  if (text === '/ders_program') {
    await handleDersProgram(message);
    return;
  }

  if (text === '/soft_copies') {
    await handleSoftCopies(message);
    return;
  }

  if (text === '/competition' || text === '/invite') {
    await handleCompetitionLink(message);
    return;
  }

  if (text === '/feedback' || text.startsWith('/feedback ')) {
    await handleFeedbackCommand({ ...message, text: rawText });
    return;
  }

  if (text === '/menu' || text === '/help') {
    await telegram.sendMessage(
      chatId,
      'ከታች ያለውን <b>Menu</b> በመጫን አገልግሎቶችን ያገኛሉ።',
      { reply_markup: mainMenuKeyboard() }
    );
    return;
  }

  // Unknown text — gently re-show menu (do not spam)
  await telegram.sendMessage(
    chatId,
    'እባክዎ ከታች ካለው Menu አንዱን ይምረጡ።',
    { reply_markup: mainMenuKeyboard() }
  );
}

module.exports = {
  handleUpdate,
  handleMessage,
  handleCallbackQuery,
  normalizeCommand,
};
