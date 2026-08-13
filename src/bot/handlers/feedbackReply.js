'use strict';

/**
 * Admin "Reply to Feedback" flow.
 *
 * Triggered by the inline Reply button on a feedback notification
 * (callback_data: feedback:reply:<feedback_id>).
 *
 * State is stored in the existing adminSession store — one pending
 * reply per admin. No new table, no new admin-auth system.
 */

const adminService = require('../../services/admin');
const feedbackService = require('../../services/feedback');
const telegram = require('../../services/telegram');
const logger = require('../../utils/logger');
const {
  FLOWS,
  STEPS,
  startFlow,
  getAdminSession,
  updateAdminSession,
  clearAdminSession,
} = require('../../utils/adminSession');
const { BUTTONS } = require('../keyboards/mainMenu');

const REPLY_PREFIX = 'feedback:reply:';
const CANCEL_DATA = 'feedback:reply:cancel';

function parseFeedbackReplyCallback(data) {
  if (!data || typeof data !== 'string' || !data.startsWith(REPLY_PREFIX)) {
    return null;
  }
  const rest = data.slice(REPLY_PREFIX.length);
  if (rest === 'cancel') return { action: 'cancel' };
  if (/^\d+$/.test(rest)) return { action: 'reply', feedbackId: rest };
  return { action: 'invalid' };
}

function replyCancelKeyboard() {
  return {
    inline_keyboard: [[{ text: '❌ Cancel', callback_data: CANCEL_DATA }]],
  };
}

function isReplyFlow(session) {
  return (
    !!session &&
    session.flow === FLOWS.REPLY_FEEDBACK &&
    session.step === STEPS.AWAITING_REPLY
  );
}

async function ack(callbackId, text = '', showAlert = false) {
  try {
    await telegram.answerCallbackQuery(callbackId, text, showAlert);
  } catch (_) {
    /* already answered or expired */
  }
}

/**
 * Remove the Cancel button from the prompt message (best-effort).
 */
async function stripPromptKeyboard(session) {
  const chatId = session?.data?.promptChatId;
  const messageId = session?.data?.promptMessageId;
  if (!chatId || !messageId) return;
  try {
    await telegram.editMessageReplyMarkup(chatId, messageId, { inline_keyboard: [] });
  } catch (_) {
    /* prompt may already be gone */
  }
}

function isAuthorizedAdmin(adminId, chatId) {
  return adminService.isAdmin(adminId) || adminService.isAdmin(chatId);
}

/**
 * Route feedback:reply:* callback queries.
 * Always answers the callback immediately.
 */
async function handleFeedbackReplyCallback(callbackQuery) {
  const data = callbackQuery.data || '';
  const callbackId = callbackQuery.id;
  const adminId = callbackQuery.from?.id;
  const chatId = callbackQuery.message?.chat?.id;

  await ack(callbackId);

  const parsed = parseFeedbackReplyCallback(data);
  if (!parsed) return true;

  if (!isAuthorizedAdmin(adminId, chatId)) {
    try {
      await telegram.answerCallbackQuery(callbackId, 'Not authorized.', true);
    } catch (_) {
      /* already answered */
    }
    logger.warn('feedback reply callback rejected — not admin', { adminId, chatId });
    return true;
  }

  if (parsed.action === 'cancel') {
    return handleCancelReply(adminId, chatId);
  }

  if (parsed.action !== 'reply') {
    logger.warn('Invalid feedback reply callback', { data, adminId });
    try {
      await telegram.sendMessage(chatId, '❌ የማይታወቅ ጥያቄ።');
    } catch (_) {
      /* ignore */
    }
    return true;
  }

  return startReplyFlow(adminId, chatId, parsed.feedbackId);
}

async function handleCancelReply(adminId, chatId) {
  const session = getAdminSession(adminId);
  if (!isReplyFlow(session)) {
    try {
      await telegram.sendMessage(chatId, '🚫 ምላሹ ተሰርዟል።');
    } catch (err) {
      logger.warn('Failed to send cancel confirmation', { message: err.message });
    }
    return true;
  }

  await stripPromptKeyboard(session);
  clearAdminSession(adminId);

  try {
    await telegram.sendMessage(chatId, '🚫 ምላሹ ተሰርዟል።');
  } catch (err) {
    logger.warn('Failed to send cancel confirmation', { message: err.message });
  }

  logger.info('Admin cancelled feedback reply', {
    adminId,
    feedbackId: session.data?.feedbackId,
  });
  return true;
}

async function startReplyFlow(adminId, chatId, feedbackId) {
  let feedback;
  try {
    feedback = await feedbackService.getFeedbackById(feedbackId);
  } catch (err) {
    logger.error('getFeedbackById failed in startReplyFlow', {
      feedbackId,
      message: err.message,
    });
    await telegram.sendMessage(chatId, '❌ አስተያየቱን መጫን አልተቻለም። እባክዎ እንደገና ይሞክሩ።');
    return true;
  }

  if (!feedback) {
    logger.warn('Reply clicked for missing feedback', { adminId, feedbackId });
    await telegram.sendMessage(chatId, '❌ አስተያየቱ አልተገኘም።');
    return true;
  }

  const existing = getAdminSession(adminId);
  if (isReplyFlow(existing)) {
    await stripPromptKeyboard(existing);
    logger.info('Replacing existing admin reply state', {
      adminId,
      previousFeedbackId: existing.data?.feedbackId,
      feedbackId: feedback.id,
    });
  }

  startFlow(adminId, FLOWS.REPLY_FEEDBACK, {
    step: STEPS.AWAITING_REPLY,
    data: {
      feedbackId: feedback.id,
      targetUserId: feedback.telegram_id,
    },
  });

  let sent;
  try {
    sent = await telegram.sendMessage(chatId, 'መልስዎን ይጻፉ፦', {
      reply_markup: replyCancelKeyboard(),
    });
  } catch (err) {
    logger.error('Failed to prompt admin for reply', { adminId, message: err.message });
    clearAdminSession(adminId);
    return true;
  }

  const promptMessageId = sent?.result?.message_id || null;
  if (promptMessageId) {
    updateAdminSession(adminId, {
      data: { promptMessageId, promptChatId: chatId },
    });
  }

  logger.info('Admin reply flow started', {
    adminId,
    feedbackId: feedback.id,
    targetUserId: feedback.telegram_id,
  });
  return true;
}

/**
 * If this admin has an active reply-to-feedback state, consume the message.
 * Returns true when handled (caller must stop routing).
 */
async function maybeHandlePendingAdminReply(message) {
  const from = message.from || {};
  const chatId = message.chat.id;
  const adminId = from.id;

  if (!isAuthorizedAdmin(adminId, chatId)) {
    return false;
  }

  const sessionKey = adminService.isAdmin(adminId) ? adminId : chatId;
  const session = getAdminSession(sessionKey);
  if (!isReplyFlow(session)) return false;

  const text = (message.text || '').trim();

  if (text === '/cancel' || /^\/cancel@/i.test(text) || text === '❌ Cancel') {
    await handleCancelReply(sessionKey, chatId);
    return true;
  }

  // Slash commands exit reply mode and continue through normal routing
  if (text.startsWith('/')) {
    await stripPromptKeyboard(session);
    clearAdminSession(sessionKey);
    logger.info('Admin reply state cleared by command', {
      adminId: sessionKey,
      command: text.slice(0, 24),
    });
    return false;
  }

  // Main-menu buttons must not be forwarded as a reply
  if (Object.values(BUTTONS).includes(text)) {
    await stripPromptKeyboard(session);
    clearAdminSession(sessionKey);
    logger.info('Admin reply state cleared by menu button', { adminId: sessionKey });
    return false;
  }

  if (!message.text) {
    await telegram.sendMessage(chatId, '⚠ እባክዎ የጽሁፍ መልስ ይላኩ።', {
      reply_markup: replyCancelKeyboard(),
    });
    return true;
  }

  if (!text) {
    await telegram.sendMessage(chatId, '⚠ መልስዎ ባዶ መሆን አይችልም። እባክዎ እንደገና ይጻፉ።', {
      reply_markup: replyCancelKeyboard(),
    });
    return true;
  }

  return submitAdminReply(sessionKey, chatId, session, text);
}

async function submitAdminReply(adminId, chatId, session, replyText) {
  const { feedbackId, targetUserId } = session.data || {};

  if (!feedbackId || !targetUserId) {
    clearAdminSession(adminId);
    await telegram.sendMessage(chatId, '❌ የምላሽ ሁኔታ ጊዜው አልፏል። እባክዎ እንደገና Reply ይጫኑ።');
    logger.warn('Stale reply state missing ids', { adminId, feedbackId, targetUserId });
    return true;
  }

  let feedback;
  try {
    feedback = await feedbackService.getFeedbackById(feedbackId);
  } catch (err) {
    logger.error('getFeedbackById failed on submit', {
      feedbackId,
      message: err.message,
    });
    await telegram.sendMessage(chatId, '❌ አስተያየቱን መጫን አልተቻለም። እባክዎ እንደገና ይሞክሩ።', {
      reply_markup: replyCancelKeyboard(),
    });
    return true;
  }

  if (!feedback) {
    await stripPromptKeyboard(session);
    clearAdminSession(adminId);
    await telegram.sendMessage(chatId, '❌ አስተያየቱ አልተገኘም።');
    return true;
  }

  const result = await feedbackService.sendReplyToUser(feedback.telegram_id, replyText);

  if (!result.ok) {
    if (result.reason === 'empty') {
      await telegram.sendMessage(chatId, '⚠ መልስዎ ባዶ መሆን አይችልም። እባክዎ እንደገና ይጻፉ።', {
        reply_markup: replyCancelKeyboard(),
      });
      return true;
    }
    if (result.reason === 'too_long') {
      await telegram.sendMessage(chatId, '⚠ መልሱ በጣም ረጅም ነው (ከ4000 ፊደል በታች)።', {
        reply_markup: replyCancelKeyboard(),
      });
      return true;
    }
    if (result.reason === 'blocked') {
      await telegram.sendMessage(
        chatId,
        '❌ ተጠቃሚው ቦቱን ታግዷል። መልሱ አልተላከም።\nእባክዎ እንደገና ይሞክሩ ወይም Cancel ይጫኑ።',
        { reply_markup: replyCancelKeyboard() }
      );
      return true;
    }
    await telegram.sendMessage(chatId, '❌ መልሱ መላክ አልተቻለም። እባክዎ እንደገና ይሞክሩ።', {
      reply_markup: replyCancelKeyboard(),
    });
    return true;
  }

  await stripPromptKeyboard(session);
  clearAdminSession(adminId);
  await telegram.sendMessage(chatId, '✅ መልሱ ተልኳል።');
  logger.info('Admin feedback reply sent', {
    adminId,
    feedbackId,
    targetUserId: feedback.telegram_id,
  });
  return true;
}

module.exports = {
  handleFeedbackReplyCallback,
  maybeHandlePendingAdminReply,
  parseFeedbackReplyCallback,
  replyCancelKeyboard,
  isReplyFlow,
  REPLY_PREFIX,
  CANCEL_DATA,
};
