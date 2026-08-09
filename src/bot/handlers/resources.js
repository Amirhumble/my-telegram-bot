'use strict';

const resourcesService = require('../../services/resources');
const usersService = require('../../services/users');
const { sendLoading, sendUserError, LOADING } = require('../../utils/userFeedback');
const { acquire, release, OPS } = require('../../utils/userOperationLock');
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
 *   1. Acquire per-user lock (bail if already running)
 *   2. Send immediate loading feedback
 *   3. Upsert user + fetch and send PDFs
 *   4. Release lock in finally
 */
async function handleSoftCopies(message) {
  const chatId = message.chat.id;
  const userId = message.from?.id;

  if (!acquire(userId, OPS.SOFT_COPIES)) {
    await sendLoading(chatId, LOADING.ALREADY_PROCESSING);
    return;
  }

  try {
    await sendLoading(chatId, LOADING.SOFT_COPIES);
    await ensureUser(message);
    await resourcesService.sendSoftCopies(chatId);
  } catch (err) {
    logger.error('handleSoftCopies failed', { chatId, message: err.message });
    await sendUserError(chatId, mainMenuKeyboard());
  } finally {
    release(userId, OPS.SOFT_COPIES);
  }
}

/**
 * Handle "📅 Ders Program" button and /ders_program command.
 *
 * UX flow:
 *   1. Acquire per-user lock (bail if already running)
 *   2. Send immediate loading feedback
 *   3. Upsert user + fetch and send image
 *   4. Release lock in finally
 */
async function handleDersProgram(message) {
  const chatId = message.chat.id;
  const userId = message.from?.id;

  if (!acquire(userId, OPS.DERS_PROGRAM)) {
    await sendLoading(chatId, LOADING.ALREADY_PROCESSING);
    return;
  }

  try {
    await sendLoading(chatId, LOADING.DERS_PROGRAM);
    await ensureUser(message);
    await resourcesService.sendDersProgram(chatId);
  } catch (err) {
    logger.error('handleDersProgram failed', { chatId, message: err.message });
    await sendUserError(chatId, mainMenuKeyboard());
  } finally {
    release(userId, OPS.DERS_PROGRAM);
  }
}

module.exports = {
  handleSoftCopies,
  handleDersProgram,
};
