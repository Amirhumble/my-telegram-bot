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
    await telegram.sendMessage(ADMIN_CHAT_ID, adminText);
  } catch (err) {
    logger.error('Failed to notify admin of feedback', { message: err.message });
  }

  return { ok: true, feedback: data };
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
  escapeHtml,
};
