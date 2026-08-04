'use strict';

const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const { TELEGRAM_API, CHANNEL_ID } = require('../config/env');
const logger = require('../utils/logger');
const { AppError } = require('../utils/errors');

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry wrapper for Telegram API calls.
 * Handles 429 (retry_after) and transient network / 5xx errors.
 */
async function withRetry(fn, label = 'telegram') {
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const status = err.response?.status;
      const retryAfter = err.response?.data?.parameters?.retry_after;
      const isRetryable =
        status === 429 ||
        status >= 500 ||
        err.code === 'ECONNRESET' ||
        err.code === 'ETIMEDOUT' ||
        err.code === 'ECONNABORTED';

      if (!isRetryable || attempt === MAX_RETRIES) break;

      const delay =
        status === 429 && retryAfter
          ? (Number(retryAfter) + 1) * 1000
          : BASE_DELAY_MS * 2 ** (attempt - 1);

      logger.warn(`${label} retry ${attempt}/${MAX_RETRIES}`, {
        status,
        delay,
        message: err.message,
      });

      await sleep(delay);
    }
  }

  const details = lastError?.response?.data || null;
  logger.error(`${label} failed after retries`, {
    message: lastError?.message,
    details,
  });
  throw new AppError(`Telegram API error: ${lastError?.message || 'unknown'}`, {
    code: 'TELEGRAM_API_ERROR',
    details,
  });
}

async function apiPost(method, payload, config = {}) {
  return withRetry(async () => {
    const res = await axios.post(`${TELEGRAM_API}/${method}`, payload, {
      timeout: 60000,
      ...config,
    });
    if (res.data && res.data.ok === false) {
      throw Object.assign(new Error(res.data.description || 'Telegram API not ok'), {
        response: { status: 400, data: res.data },
      });
    }
    return res.data;
  }, method);
}

async function apiGet(method, params = {}) {
  return withRetry(async () => {
    const res = await axios.get(`${TELEGRAM_API}/${method}`, {
      params,
      timeout: 30000,
    });
    if (res.data && res.data.ok === false) {
      throw Object.assign(new Error(res.data.description || 'Telegram API not ok'), {
        response: { status: 400, data: res.data },
      });
    }
    return res.data;
  }, method);
}

// ─── Messaging ───────────────────────────────────────────────

async function sendMessage(chatId, text, extra = {}) {
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: extra.parse_mode || 'HTML',
    disable_web_page_preview: extra.disable_web_page_preview ?? true,
  };
  // Only include reply_markup when it is a real object — Telegram rejects null/undefined
  if (extra.reply_markup && typeof extra.reply_markup === 'object') {
    payload.reply_markup = extra.reply_markup;
  }
  return apiPost('sendMessage', payload);
}

async function sendPhotoByFileId(chatId, fileId, extra = {}) {
  const payload = {
    chat_id: chatId,
    photo: fileId,
    caption: extra.caption,
    parse_mode: extra.parse_mode || 'HTML',
  };
  if (extra.reply_markup && typeof extra.reply_markup === 'object') {
    payload.reply_markup = extra.reply_markup;
  }
  return apiPost('sendPhoto', payload);
}

async function sendDocumentByFileId(chatId, fileId, extra = {}) {
  return apiPost('sendDocument', {
    chat_id: chatId,
    document: fileId,
    caption: extra.caption,
    parse_mode: extra.parse_mode || 'HTML',
  });
}

/**
 * Upload a local photo once (seed script). Returns largest photo file_id.
 */
async function uploadPhotoFromPath(chatId, filePath, caption = '') {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('photo', fs.createReadStream(filePath));
  if (caption) {
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');
  }

  const data = await withRetry(async () => {
    const res = await axios.post(`${TELEGRAM_API}/sendPhoto`, form, {
      headers: form.getHeaders(),
      timeout: 120000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });
    if (res.data && res.data.ok === false) {
      throw Object.assign(new Error(res.data.description || 'upload failed'), {
        response: { status: 400, data: res.data },
      });
    }
    return res.data;
  }, 'uploadPhoto');

  const photos = data.result?.photo || [];
  return photos[photos.length - 1]?.file_id || null;
}

/**
 * Upload a local document once (seed script). Returns document file_id.
 */
async function uploadDocumentFromPath(chatId, filePath, caption = '') {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('document', fs.createReadStream(filePath));
  if (caption) {
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');
  }

  const data = await withRetry(async () => {
    const res = await axios.post(`${TELEGRAM_API}/sendDocument`, form, {
      headers: form.getHeaders(),
      timeout: 300000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });
    if (res.data && res.data.ok === false) {
      throw Object.assign(new Error(res.data.description || 'upload failed'), {
        response: { status: 400, data: res.data },
      });
    }
    return res.data;
  }, 'uploadDocument');

  return data.result?.document?.file_id || null;
}

// ─── Channel membership ──────────────────────────────────────

/**
 * Membership statuses that count as "joined".
 * left / kicked / restricted(if not member) do not count.
 */
const MEMBER_STATUSES = new Set(['creator', 'administrator', 'member', 'restricted']);

async function getChatMember(userId, chatId = CHANNEL_ID) {
  const data = await apiGet('getChatMember', {
    chat_id: chatId,
    user_id: userId,
  });
  return data.result;
}

async function isChannelMember(userId, chatId = CHANNEL_ID) {
  try {
    const member = await getChatMember(userId, chatId);
    const status = member?.status;
    // restricted users may still be in the channel
    if (status === 'restricted') {
      return member.is_member === true;
    }
    return MEMBER_STATUSES.has(status);
  } catch (err) {
    logger.warn('getChatMember failed', {
      userId,
      message: err.message,
      details: err.details,
    });
    return false;
  }
}

// ─── Webhook / bot setup ─────────────────────────────────────

async function setWebhook(url) {
  return apiGet('setWebhook', {
    url,
    drop_pending_updates: false,
    allowed_updates: JSON.stringify(['message', 'callback_query']),
  });
}

async function deleteWebhook() {
  return apiGet('deleteWebhook', { drop_pending_updates: false });
}

async function setMyCommands(commands) {
  return apiPost('setMyCommands', { commands });
}

async function answerCallbackQuery(callbackQueryId, text = '', showAlert = false) {
  return apiPost('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text,
    show_alert: showAlert,
  });
}

/**
 * Edit text of an existing bot message (used by admin panel to avoid spamming).
 * Gracefully ignores "message is not modified" errors.
 */
async function editMessageText(chatId, messageId, text, extra = {}) {
  const payload = {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: extra.parse_mode || 'HTML',
    disable_web_page_preview: extra.disable_web_page_preview ?? true,
  };
  // Only include reply_markup when it is a real object — Telegram rejects null/undefined
  if (extra.reply_markup && typeof extra.reply_markup === 'object') {
    payload.reply_markup = extra.reply_markup;
  }
  try {
    return await apiPost('editMessageText', payload);
  } catch (err) {
    if (err.message && err.message.includes('message is not modified')) return null;
    throw err;
  }
}

/**
 * Edit only the inline keyboard of an existing message.
 */
async function editMessageReplyMarkup(chatId, messageId, replyMarkup) {
  try {
    return await apiPost('editMessageReplyMarkup', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: replyMarkup,
    });
  } catch (err) {
    if (err.message && err.message.includes('message is not modified')) return null;
    throw err;
  }
}

/**
 * Delete a message silently (e.g. close admin panel).
 */
async function deleteMessage(chatId, messageId) {
  try {
    return await apiPost('deleteMessage', {
      chat_id: chatId,
      message_id: messageId,
    });
  } catch (err) {
    // Message may already be deleted — ignore
    logger.warn('deleteMessage failed (ignored)', { chatId, messageId, message: err.message });
    return null;
  }
}

module.exports = {
  sleep,
  withRetry,
  sendMessage,
  sendPhotoByFileId,
  sendDocumentByFileId,
  uploadPhotoFromPath,
  uploadDocumentFromPath,
  getChatMember,
  isChannelMember,
  setWebhook,
  deleteWebhook,
  setMyCommands,
  answerCallbackQuery,
  editMessageText,
  editMessageReplyMarkup,
  deleteMessage,
  apiPost,
  apiGet,
};
