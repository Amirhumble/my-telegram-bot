'use strict';

const usersService = require('../../services/users');
const feedbackService = require('../../services/feedback');
const telegram = require('../../services/telegram');
const { setSession, getSession, clearSession } = require('../../utils/session');
const { mainMenuKeyboard } = require('../keyboards/mainMenu');
const { BUTTONS } = require('../keyboards/mainMenu');
const { sendLoading, sendUserError, LOADING } = require('../../utils/userFeedback');
const logger = require('../../utils/logger');

const FEEDBACK_STATE = 'awaiting_feedback';

/**
 * User pressed Feedback button or sent bare /feedback.
 * Enter multi-step flow: next free-text message is the feedback.
 *
 * No loading message here — we're just prompting the user,
 * which is itself the immediate response.
 */
async function promptFeedback(message) {
  const from = message.from || {};
  const chatId = message.chat.id;

  try {
    await usersService.upsertUser({
      telegramId: from.id,
      username: from.username,
      firstName: from.first_name,
    });
  } catch (err) {
    logger.warn('promptFeedback: upsertUser failed', { message: err.message });
    // Non-fatal — continue to show the prompt
  }

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

/**
 * Submit feedback.
 *
 * UX flow:
 *   1. Send immediate loading feedback
 *   2. Upsert user
 *   3. Save feedback (also notifies admin)
 *   4. Confirm to user
 */
async function submitFeedback(message, feedbackText) {
  const from = message.from || {};
  const chatId = message.chat.id;

  // Step 1 — Immediate feedback before DB work
  await sendLoading(chatId, LOADING.FEEDBACK);

  try {
    // Step 2 — Upsert user
    await usersService.upsertUser({
      telegramId: from.id,
      username: from.username,
      firstName: from.first_name,
    });

    // Step 3 — Save feedback
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

    // Step 4 — Confirm
    await telegram.sendMessage(chatId, '✅ እናመሰግናለን!', {
      reply_markup: mainMenuKeyboard(),
    });
  } catch (err) {
    logger.error('submitFeedback failed', { chatId, message: err.message });
    clearSession(from.id);
    await sendUserError(chatId, mainMenuKeyboard());
  }
}

module.exports = {
  promptFeedback,
  handleFeedbackCommand,
  maybeHandlePendingFeedback,
  FEEDBACK_STATE,
};
