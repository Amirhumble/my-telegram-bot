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
const {
  handleAdminEntry,
  handleAdminCallback,
  handleAdminMessage,
} = require('./adminPanel');
const {
  handleFeedbackReplyCallback,
  maybeHandlePendingAdminReply,
} = require('./feedbackReply');
const referralsService = require('../../services/referrals');
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

  // ── Admin panel callbacks (highest priority) ─────────────
  if (data && data.startsWith('ap:')) {
    await handleAdminCallback(callbackQuery);
    return;
  }

  // ── Admin reply-to-feedback ───────────────────────────────
  if (data && data.startsWith('feedback:reply:')) {
    await handleFeedbackReplyCallback(callbackQuery);
    return;
  }

  // ── Existing callbacks ────────────────────────────────────
  if (data === 'joined_channel') {
    await handleJoinedCallback(callbackQuery);
    return;
  }

  // Unknown callback — just acknowledge
  await telegram.answerCallbackQuery(callbackQuery.id);
}

async function handleMessage(message) {
  const chatId = message.chat.id;
  const rawText = (message.text || '').trim();
  const text = rawText ? normalizeCommand(rawText) : '';

  if (rawText) {
    logger.debug('Incoming message', { chatId, text: rawText.slice(0, 80) });
  }

  // Layer 2 — Transparent referral auto-verification.
  // Fire-and-forget: runs in the background without blocking message routing
  // or sending anything to the user. One failure never affects message handling.
  _maybeAutoVerify(message.from?.id).catch((err) => {
    logger.warn('Layer 2 auto-verify threw unexpectedly', { message: err.message });
  });

  // 1) Admin reply-to-feedback interceptor — owns the pending-reply state
  //    so it is not swallowed by the admin-panel wizard or treated as
  //    user feedback.
  const handledReply = await maybeHandlePendingAdminReply(message);
  if (handledReply) return;

  // 2) Admin panel wizard interceptor — handles non-text wizard steps too
  //    (PDF uploads, photo uploads, etc.). Must come before all text routing.
  const adminHandled = await handleAdminMessage(message);
  if (adminHandled) return;

  // Only text messages pass through to the remaining routes
  if (!message.text) return;

  // 3) Multi-step feedback capture (before menu routing)
  const handledFeedback = await maybeHandlePendingFeedback(message);
  if (handledFeedback) return;

  // 4) /admin command — opens inline panel
  if (text === '/admin' || text.startsWith('/admin@')) {
    await handleAdminEntry({ ...message, text: rawText });
    return;
  }

  // 5) Legacy /admin_* text commands (silently no-op for non-admins)
  if (text.startsWith('/admin_')) {
    const handled = await handleAdminCommand({ ...message, text });
    if (handled) return;
    return;
  }

  // 6) Reply keyboard buttons
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

  // 7) Slash commands (backward compatible)
  if (text === '/start' || text.startsWith('/start ')) {
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

  // 7) Unknown text — gently re-show menu (do not spam)
  await telegram.sendMessage(
    chatId,
    'እባክዎ ከታች ካለው Menu አንዱን ይምረጡ።',
    { reply_markup: mainMenuKeyboard() }
  );
}

// ─── Layer 2: Transparent per-message auto-verification ──────

/**
 * Called fire-and-forget on every incoming message.
 * Checks whether the sender has a pending (unverified) referral and,
 * if so, silently verifies it if they are now a channel member.
 *
 * Never sends any message to the user — purely a background check.
 * Never throws — all errors are caught and logged.
 *
 * @param {number|undefined} userId
 */
async function _maybeAutoVerify(userId) {
  if (!userId) return;

  let referral;
  try {
    referral = await referralsService.getReferralByReferred(userId);
  } catch (err) {
    logger.warn('Layer 2: getReferralByReferred failed', {
      userId,
      message: err.message,
    });
    return;
  }

  // No referral, or already verified — nothing to do
  if (!referral || referral.verified) return;

  try {
    await referralsService.autoVerifyReferral(referral);
  } catch (err) {
    logger.warn('Layer 2: autoVerifyReferral failed', {
      userId,
      referral_id: referral.id,
      message: err.message,
    });
  }
}

module.exports = {
  handleUpdate,
  handleMessage,
  handleCallbackQuery,
  normalizeCommand,
};
