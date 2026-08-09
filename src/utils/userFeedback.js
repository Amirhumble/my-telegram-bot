'use strict';

/**
 * User-facing loading / processing feedback helper.
 *
 * Provides a single consistent way to send immediate "please wait" feedback
 * to normal users before slow operations (Supabase queries, Telegram file sends,
 * getChatMember calls, etc.).
 *
 * ADMIN-ONLY commands and admin panel buttons intentionally do NOT use this
 * helper — the admin panel has its own UX managed via editMessageText.
 *
 * Usage:
 *   await sendLoading(chatId, LOADING.SOFT_COPIES);
 *   // ... slow operation ...
 *   await telegram.sendMessage(chatId, finalResult);
 *
 * The loading message is a plain sendMessage call — no polling, no timers,
 * no editing loop. It is intentionally left in chat once the result arrives
 * (Telegram users are accustomed to this from all major bots).
 */

const telegram = require('../services/telegram');

// ─── Standard loading texts ───────────────────────────────────
// Exported so callers can reference them directly if needed.

const LOADING = {
  GENERAL:      '⏳ እባክዎ ይጠብቁ...',
  SOFT_COPIES:  '⏳ እባክዎ ይጠብቁ...\n📚 ኪታቦቹ እየተዘጋጁ ነው።',
  DERS_PROGRAM: '⏳ እባክዎ ይጠብቁ...\n📅 የደርስ ፕሮግራሙ እየተዘጋጀ ነው።',
  COMPETITION:  '⏳ እባክዎ ይጠብቁ...\n🔗 የግል የግብዣ ሊንክዎ እየተዘጋጀ ነው።',
  FEEDBACK:     '⏳ እባክዎ ይጠብቁ...\n📩 አስተያየትዎን እየላክን ነው።',
  MEMBERSHIP:   '⏳ ቻናሉን እየተፈተሸ ነው...',
  START:        '⏳ እባክዎ ይጠብቁ...',
  ERROR:        '❌ ይቅርታ፣ አሁን ይህን አገልግሎት ማጠናቀቅ አልተቻለም።\nእባክዎ እንደገና ይሞክሩ።',
};

/**
 * Send an immediate loading message to the user.
 * Returns the sent message result (contains message_id if needed).
 *
 * Errors are caught and logged — a failure to send the loading indicator
 * must never prevent the actual operation from running.
 *
 * @param {number|string} chatId
 * @param {string}        [text]   — defaults to LOADING.GENERAL
 * @returns {Promise<object|null>}
 */
async function sendLoading(chatId, text = LOADING.GENERAL) {
  try {
    return await telegram.sendMessage(chatId, text);
  } catch (err) {
    // Non-fatal — the real operation will still run
    const logger = require('../utils/logger');
    logger.warn('sendLoading: failed to send loading message', {
      chatId,
      message: err.message,
    });
    return null;
  }
}

/**
 * Send an error message to the user after a failed operation.
 * Uses the standard error text so the UX is consistent.
 *
 * @param {number|string} chatId
 * @param {object}        [replyMarkup]  optional keyboard to restore
 */
async function sendUserError(chatId, replyMarkup = null) {
  try {
    await telegram.sendMessage(chatId, LOADING.ERROR, {
      reply_markup: replyMarkup || undefined,
    });
  } catch (_) { /* best-effort */ }
}

module.exports = {
  LOADING,
  sendLoading,
  sendUserError,
};
