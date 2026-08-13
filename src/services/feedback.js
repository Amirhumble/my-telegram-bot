'use strict';

const { supabase } = require('../database/supabase');
const telegram = require('./telegram');
const { ADMIN_CHAT_ID } = require('../config/env');
const logger = require('../utils/logger');
const { AppError } = require('../utils/errors');

/**
 * Persist feedback and notify the admin.
 */
async function saveFeedback({ telegramId, username = null, firstName = null, message }) {
  const text = String(message || '').trim();
  if (!text) {
    return { ok: false, reason: 'empty' };
  }

  if (text.length > 4000) {
    return { ok: false, reason: 'too_long' };
  }

  const { data, error } = await supabase
    .from('feedbacks')
    .insert({
      telegram_id: Number(telegramId),
      username: username || null,
      message: text,
    })
    .select()
    .single();

  if (error) {
    logger.error('saveFeedback failed', { error: error.message, telegramId });
    throw new AppError('Failed to save feedback', {
      code: 'DB_SAVE_FEEDBACK',
      details: error,
    });
  }

  // Notify admin with full details
  const adminText =
    `📩 <b>New Feedback</b>\n\n` +
    `<b>Name:</b> ${escapeHtml(firstName || '—')}\n` +
    `<b>Username:</b> ${username ? '@' + escapeHtml(username) : '—'}\n` +
    `<b>Telegram ID:</b> <code>${telegramId}</code>\n\n` +
    `<b>Message:</b>\n${escapeHtml(text)}`;

  try {
    await telegram.sendMessage(ADMIN_CHAT_ID, adminText, {
      reply_markup: replyButtonKeyboard(data.id),
    });
  } catch (err) {
    logger.error('Failed to notify admin of feedback', { message: err.message });
  }

  return { ok: true, feedback: data };
}

/**
 * Inline keyboard attached to the admin's feedback notification.
 * callback_data format: feedback:reply:<feedback_id>
 */
function replyButtonKeyboard(feedbackId) {
  return {
    inline_keyboard: [
      [{ text: '💬 Reply', callback_data: `feedback:reply:${feedbackId}` }],
    ],
  };
}

/**
 * Load a single feedback row by primary key.
 * Returns null when the id is invalid or the row no longer exists.
 */
async function getFeedbackById(id) {
  const numericId = Number(id);
  if (!Number.isInteger(numericId) || numericId <= 0) {
    return null;
  }

  const { data, error } = await supabase
    .from('feedbacks')
    .select('id, telegram_id, username, message, created_at')
    .eq('id', numericId)
    .maybeSingle();

  if (error) {
    logger.error('getFeedbackById failed', { error: error.message, id });
    throw new AppError('Failed to load feedback', {
      code: 'DB_GET_FEEDBACK',
      details: error,
    });
  }

  return data || null;
}

function formatUserReplyMessage(replyText) {
  return `<b>ለእርስዎ የተላከ ምላሽ</b>\n\n${escapeHtml(replyText)}`;
}

/**
 * Detect Telegram "user blocked the bot" / deactivated-user errors.
 */
function isBlockedTelegramError(err) {
  const description = String(err?.details?.description || err?.message || '').toLowerCase();
  const code = err?.details?.error_code;
  return (
    code === 403 ||
    description.includes('blocked by the user') ||
    description.includes('bot was blocked') ||
    description.includes('user is deactivated') ||
    description.includes('chat not found')
  );
}

/**
 * Deliver an admin reply to the original feedback author.
 * Never includes the admin's Telegram ID.
 *
 * @returns {{ ok: boolean, reason?: string, error?: Error }}
 */
async function sendReplyToUser(targetUserId, replyText) {
  const text = String(replyText || '').trim();
  if (!text) {
    return { ok: false, reason: 'empty' };
  }
  if (text.length > 4000) {
    return { ok: false, reason: 'too_long' };
  }

  try {
    await telegram.sendMessage(targetUserId, formatUserReplyMessage(text));
    return { ok: true };
  } catch (err) {
    const blocked = isBlockedTelegramError(err);
    logger.error('sendReplyToUser failed', {
      targetUserId,
      blocked,
      message: err.message,
    });
    return {
      ok: false,
      reason: blocked ? 'blocked' : 'telegram_error',
      error: err,
    };
  }
}

async function countFeedbacks() {
  const { count, error } = await supabase
    .from('feedbacks')
    .select('*', { count: 'exact', head: true });

  if (error) {
    throw new AppError('Failed to count feedbacks', {
      code: 'DB_COUNT_FEEDBACK',
      details: error,
    });
  }
  return count || 0;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

module.exports = {
  saveFeedback,
  countFeedbacks,
  getFeedbackById,
  sendReplyToUser,
  formatUserReplyMessage,
  isBlockedTelegramError,
  replyButtonKeyboard,
  escapeHtml,
};
