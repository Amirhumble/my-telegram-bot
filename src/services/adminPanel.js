'use strict';

/**
 * Admin Panel Service
 *
 * Thin orchestration layer for the admin panel.
 * ALL resource database logic is delegated to services/resources.js.
 * ALL user/referral/feedback logic is delegated to the respective services.
 * No direct Supabase queries live here.
 */

const resourcesService = require('./resources');
const adminService = require('./admin');
const usersService = require('./users');
const referralsService = require('./referrals');
const feedbackService = require('./feedback');
const telegram = require('./telegram');
const { supabase } = require('../database/supabase');
const logger = require('../utils/logger');
const { AppError } = require('../utils/errors');

// ─── Resource management (delegates to resources.js) ─────────

/** List all active PDF books. */
async function listBooks() {
  return resourcesService.listBooks();
}

/** List all active resources of any type. */
async function listAllResources() {
  return resourcesService.listAllResources();
}

/** Count all active resources. */
async function countResources() {
  return resourcesService.countResources();
}

/** Check whether a resource key is already in use. */
async function isKeyTaken(name) {
  return resourcesService.isKeyTaken(name);
}

/** Add a new PDF book. Returns { ok, resource } or { ok: false, reason }. */
async function addBook({ name, caption, telegramFileId, sortOrder = 0 }) {
  return resourcesService.addBook({ name, caption, telegramFileId, sortOrder });
}

/** Rename a book's display caption. */
async function renameBook(id, newCaption) {
  return resourcesService.renameBook(id, newCaption);
}

/** Soft-delete a book by ID. */
async function removeBook(id) {
  return resourcesService.removeBook(id);
}

/** Update (or create) the Ders Program image. */
async function updateDersProgram(telegramFileId) {
  return resourcesService.updateDersProgram(telegramFileId);
}

// ─── Broadcast ────────────────────────────────────────────────

/** Broadcast a plain-text message to all users. */
async function broadcastText(message) {
  return adminService.broadcast(message);
}

/** Broadcast a photo (file_id) with optional caption. */
async function broadcastPhoto(fileId, caption = '') {
  const ids = await usersService.getAllUserIds();
  let sent = 0;
  let failed = 0;

  for (const id of ids) {
    try {
      await telegram.sendPhotoByFileId(id, fileId, {
        caption: caption || undefined,
        parse_mode: 'HTML',
      });
      sent += 1;
      await telegram.sleep(40);
    } catch (err) {
      failed += 1;
      logger.warn('Photo broadcast failed for user', { id, message: err.message });
    }
  }

  return { sent, failed, total: ids.length };
}

/** Broadcast a document (file_id) with optional caption. */
async function broadcastDocument(fileId, caption = '') {
  const ids = await usersService.getAllUserIds();
  let sent = 0;
  let failed = 0;

  for (const id of ids) {
    try {
      await telegram.sendDocumentByFileId(id, fileId, {
        caption: caption || undefined,
        parse_mode: 'HTML',
      });
      sent += 1;
      await telegram.sleep(40);
    } catch (err) {
      failed += 1;
      logger.warn('Document broadcast failed for user', { id, message: err.message });
    }
  }

  return { sent, failed, total: ids.length };
}

// ─── Statistics ───────────────────────────────────────────────

/**
 * Aggregate statistics for the admin panel Statistics screen.
 * Counts joined_channel users directly since users.js has no dedicated helper.
 */
async function getPanelStats() {
  const [totalUsers, feedbackCount, totalResources, compStats] = await Promise.all([
    usersService.countUsers(),
    feedbackService.countFeedbacks(),
    countResources(),
    referralsService.getCompetitionStats(),
  ]);

  let joinedChannel = 0;
  try {
    const { count, error } = await supabase
      .from('users')
      .select('*', { count: 'exact', head: true })
      .eq('joined_channel', true);

    if (!error) joinedChannel = count || 0;
    else logger.warn('Failed to count joined_channel users', { error: error.message });
  } catch (err) {
    logger.warn('joinedChannel count threw', { message: err.message });
  }

  return {
    totalUsers,
    joinedChannel,
    feedbackCount,
    totalResources,
    // from compStats
    verifiedReferrals: compStats.verifiedReferrals,
    pendingReferrals: compStats.pendingReferrals,
    totalReferrals: compStats.totalReferrals,
    uniqueReferrers: compStats.uniqueReferrers,
    leader: compStats.leader,
  };
}

// ─── Leaderboard / competition (delegates to referrals.js) ───

/** Paginated leaderboard. */
async function getLeaderboardPage(page, pageSize) {
  return referralsService.getLeaderboardPage(page, pageSize);
}

/** Search a participant by ID or @username. */
async function searchParticipant(query) {
  return referralsService.searchParticipant(query);
}

/** Full leaderboard data for CSV export. */
async function getLeaderboardCsvData() {
  return referralsService.getLeaderboardCsvData();
}

module.exports = {
  // Resource CRUD
  listBooks,
  listAllResources,
  countResources,
  isKeyTaken,
  addBook,
  renameBook,
  removeBook,
  updateDersProgram,
  // Broadcast
  broadcastText,
  broadcastPhoto,
  broadcastDocument,
  // Stats
  getPanelStats,
  // Leaderboard / competition
  getLeaderboardPage,
  searchParticipant,
  getLeaderboardCsvData,
};
