'use strict';

const resourcesService = require('../../services/resources');
const usersService = require('../../services/users');
const { sendLoading, sendUserError, LOADING } = require('../../utils/userFeedback');
const { mainMenuKeyboard } = require('../keyboards/mainMenu');
const logger = require('../../utils/logger');

async function ensureUser(message) {
  const from = message.from || {};
  await usersService.upsertUser({
    telegramId: from.id,
    username: from.username,
    firstName: from.first_name,
  });
}

/**
 * Handle "📚 Soft Copies" button and /soft_copies command.
 *
 * UX flow:
 *   1. Send immediate loading feedback (before any DB/API work)
 *   2. Upsert user
 *   3. Fetch PDFs from Supabase and send each one
 */
async function handleSoftCopies(message) {
  const chatId = message.chat.id;

  // Step 1 — Immediate feedback (before any slow work)
  await sendLoading(chatId, LOADING.SOFT_COPIES);

  try {
    // Step 2 — Upsert user (fast, but after loading so user sees feedback first)
    await ensureUser(message);

    // Step 3 — Fetch and send PDFs
    await resourcesService.sendSoftCopies(chatId);
  } catch (err) {
    logger.error('handleSoftCopies failed', { chatId, message: err.message });
    await sendUserError(chatId, mainMenuKeyboard());
  }
}

/**
 * Handle "📅 Ders Program" button and /ders_program command.
 *
 * UX flow:
 *   1. Send immediate loading feedback
 *   2. Upsert user
 *   3. Fetch image file_id from Supabase and send photo
 */
async function handleDersProgram(message) {
  const chatId = message.chat.id;

  // Step 1 — Immediate feedback
  await sendLoading(chatId, LOADING.DERS_PROGRAM);

  try {
    // Step 2 — Upsert user
    await ensureUser(message);

    // Step 3 — Fetch and send Ders Program image
    await resourcesService.sendDersProgram(chatId);
  } catch (err) {
    logger.error('handleDersProgram failed', { chatId, message: err.message });
    await sendUserError(chatId, mainMenuKeyboard());
  }
}

module.exports = {
  handleSoftCopies,
  handleDersProgram,
};
