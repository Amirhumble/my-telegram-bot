'use strict';

const usersService = require('../../services/users');
const feedbackService = require('../../services/feedback');
const telegram = require('../../services/telegram');
const { setSession, getSession, clearSession } = require('../../utils/session');
const { mainMenuKeyboard } = require('../keyboards/mainMenu');
const { BUTTONS } = require('../keyboards/mainMenu');

const FEEDBACK_STATE = 'awaiting_feedback';

/**
 * User pressed Feedback button or sent bare /feedback.
 * Enter multi-step flow: next free-text message is the feedback.
 */
async function promptFeedback(message) {
  const from = message.from || {};
  const chatId = message.chat.id;

  await usersService.upsertUser({
    telegramId: from.id,
    username: from.username,
    firstName: from.first_name,
  });

  setSession(from.id, { state: FEEDBACK_STATE });

  await telegram.sendMessage(chatId, 'Please send your feedback message.', {
    reply_markup: mainMenuKeyboard(),
  });
}

/**
 * Legacy: /feedback my message  (single command with text)
 */
async function handleFeedbackCommand(message) {
  const text = message.text || '';
  const feedbackText = text.replace(/^\/feedback(@\w+)?/i, '').trim();

  if (!feedbackText) {
    return promptFeedback(message);
  }

  return submitFeedback(message, feedbackText);
}

/**
 * If user is in awaiting_feedback state, treat this message as feedback.
 * Returns true if handled.
 */
async function maybeHandlePendingFeedback(message) {
  const from = message.from || {};
  const session = getSession(from.id);

  if (!session || session.state !== FEEDBACK_STATE) {
    return false;
  }

  const text = (message.text || '').trim();

  // If they pressed another menu button, cancel feedback mode and let router handle it
  const menuValues = Object.values(BUTTONS);
  if (menuValues.includes(text) || text.startsWith('/')) {
    clearSession(from.id);
    return false;
  }

  await submitFeedback(message, text);
  return true;
}

async function submitFeedback(message, feedbackText) {
  const from = message.from || {};
  const chatId = message.chat.id;

  await usersService.upsertUser({
    telegramId: from.id,
    username: from.username,
    firstName: from.first_name,
  });

  const result = await feedbackService.saveFeedback({
    telegramId: from.id,
    username: from.username,
    firstName: from.first_name,
    message: feedbackText,
  });

  clearSession(from.id);

  if (!result.ok) {
    if (result.reason === 'empty') {
      await telegram.sendMessage(chatId, 'Feedback cannot be empty. Please try again.', {
        reply_markup: mainMenuKeyboard(),
      });
      setSession(from.id, { state: FEEDBACK_STATE });
      return;
    }
    if (result.reason === 'too_long') {
      await telegram.sendMessage(
        chatId,
        'Feedback is too long (max 4000 characters). Please shorten it.',
        { reply_markup: mainMenuKeyboard() }
      );
      setSession(from.id, { state: FEEDBACK_STATE });
      return;
    }
  }

  await telegram.sendMessage(chatId, '✅ እናመሰግናለን!', {
    reply_markup: mainMenuKeyboard(),
  });
}

module.exports = {
  promptFeedback,
  handleFeedbackCommand,
  maybeHandlePendingFeedback,
  FEEDBACK_STATE,
};
