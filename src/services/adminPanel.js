'use strict';

/**
 * Admin Panel — Resource Management Service
 *
 * Wraps all database operations that the admin panel needs for CRUD on resources.
 * Business logic lives here; handlers stay thin.
 *
 * Reuses `resources` table schema (no schema changes required beyond migration 002).
 */

const { supabase } = require('../database/supabase');
const resourcesService = require('./resources');
const logger = require('../utils/logger');
const { AppError } = require('../utils/errors');

// ─── Read ─────────────────────────────────────────────────────

/**
 * Return all active PDF resources ordered by sort_order.
 */
async function listBooks() {
  const { data, error } = await supabase
    .from('resources')
    .select('id, name, caption, sort_order, telegram_file_id, created_at, updated_at')
    .eq('type', 'pdf')
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true });

  if (error) {
    logger.error('listBooks failed', { error: error.message });
    throw new AppError('Failed to list books', { code: 'DB_LIST_BOOKS', details: error });
  }
  return data || [];
}

/**
 * Return all active resources (all types) for display.
 */
async function listAllResources() {
  const { data, error } = await supabase
    .from('resources')
    .select('id, name, type, caption, sort_order, created_at, updated_at')
    .eq('is_active', true)
    .order('type', { ascending: true })
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true });

  if (error) {
    logger.error('listAllResources failed', { error: error.message });
    throw new AppError('Failed to list resources', { code: 'DB_LIST_RESOURCES', details: error });
  }
  return data || [];
}

/**
 * Count active resources by type.
 */
async function countResources() {
  const { count, error } = await supabase
    .from('resources')
    .select('*', { count: 'exact', head: true })
    .eq('is_active', true);

  if (error) {
    throw new AppError('Failed to count resources', { code: 'DB_COUNT_RESOURCES', details: error });
  }
  return count || 0;
}

// ─── Check key uniqueness ─────────────────────────────────────

/**
 * Returns true if the given name (key) is already in use by an active resource.
 */
async function isKeyTaken(name) {
  const { data, error } = await supabase
    .from('resources')
    .select('id')
    .eq('name', name)
    .eq('is_active', true)
    .maybeSingle();

  if (error) {
    throw new AppError('Failed to check key uniqueness', {
      code: 'DB_CHECK_KEY',
      details: error,
    });
  }
  return data !== null;
}

// ─── Create ───────────────────────────────────────────────────

/**
 * Add a new book (PDF resource).
 *
 * @param {object} opts
 * @param {string} opts.name          - unique key (e.g. "riyad")
 * @param {string} opts.caption       - display title (e.g. "رياض الصالحين")
 * @param {string} opts.telegramFileId
 * @param {number} [opts.sortOrder]
 * @returns {object} created row
 */
async function addBook({ name, caption, telegramFileId, sortOrder = 0 }) {
  // Guard against duplicate keys
  const taken = await isKeyTaken(name);
  if (taken) {
    return { ok: false, reason: 'duplicate_key' };
  }

  const { data, error } = await supabase
    .from('resources')
    .insert({
      name,
      type: 'pdf',
      telegram_file_id: telegramFileId,
      caption,
      sort_order: Number(sortOrder) || 0,
      is_active: true,
    })
    .select()
    .single();

  if (error) {
    // Unique constraint race condition
    if (error.code === '23505') {
      return { ok: false, reason: 'duplicate_key' };
    }
    logger.error('addBook failed', { error: error.message, name });
    throw new AppError('Failed to add book', { code: 'DB_ADD_BOOK', details: error });
  }

  logger.info('Book added', { id: data.id, name, caption });
  return { ok: true, resource: data };
}

// ─── Update ───────────────────────────────────────────────────

/**
 * Rename a resource (update its display caption only).
 *
 * @param {number} id         - DB row id
 * @param {string} newCaption - new display title
 */
async function renameBook(id, newCaption) {
  const { data, error } = await supabase
    .from('resources')
    .update({ caption: newCaption })
    .eq('id', Number(id))
    .eq('is_active', true)
    .select()
    .single();

  if (error) {
    logger.error('renameBook failed', { error: error.message, id });
    throw new AppError('Failed to rename book', { code: 'DB_RENAME_BOOK', details: error });
  }

  if (!data) {
    return { ok: false, reason: 'not_found' };
  }

  logger.info('Book renamed', { id, newCaption });
  return { ok: true, resource: data };
}

/**
 * Update the Ders Program image.
 * Finds the existing ders_program row and updates its telegram_file_id.
 * Does NOT create a duplicate row.
 *
 * @param {string} telegramFileId
 */
async function updateDersProgram(telegramFileId) {
  // First try to find existing ders_program resource (any active state)
  const { data: existing, error: findErr } = await supabase
    .from('resources')
    .select('id, name')
    .in('name', ['ders_program', 'ders_image'])
    .limit(1)
    .maybeSingle();

  if (findErr) {
    throw new AppError('Failed to find ders program', { code: 'DB_FIND_DERS', details: findErr });
  }

  if (existing) {
    // Update the existing row
    const { data, error } = await supabase
      .from('resources')
      .update({ telegram_file_id: telegramFileId, is_active: true })
      .eq('id', existing.id)
      .select()
      .single();

    if (error) {
      logger.error('updateDersProgram (update) failed', { error: error.message });
      throw new AppError('Failed to update ders program', {
        code: 'DB_UPDATE_DERS',
        details: error,
      });
    }

    logger.info('Ders Program updated', { id: data.id, telegramFileId });
    return { ok: true, resource: data };
  }

  // No existing row — create one
  const { data, error } = await supabase
    .from('resources')
    .insert({
      name: 'ders_program',
      type: 'image',
      telegram_file_id: telegramFileId,
      caption: '<b>የደርስ ፕሮግራም</b>',
      sort_order: 0,
      is_active: true,
    })
    .select()
    .single();

  if (error) {
    logger.error('updateDersProgram (insert) failed', { error: error.message });
    throw new AppError('Failed to create ders program', {
      code: 'DB_CREATE_DERS',
      details: error,
    });
  }

  logger.info('Ders Program created', { id: data.id, telegramFileId });
  return { ok: true, resource: data };
}

// ─── Delete (soft) ────────────────────────────────────────────

/**
 * Soft-delete a resource by ID (sets is_active = false).
 * Does NOT delete any Telegram data.
 *
 * @param {number} id
 */
async function removeBook(id) {
  const { data, error } = await supabase
    .from('resources')
    .update({ is_active: false })
    .eq('id', Number(id))
    .select()
    .single();

  if (error) {
    logger.error('removeBook failed', { error: error.message, id });
    throw new AppError('Failed to remove book', { code: 'DB_REMOVE_BOOK', details: error });
  }

  if (!data) {
    return { ok: false, reason: 'not_found' };
  }

  logger.info('Book removed (soft-deleted)', { id, name: data.name });
  return { ok: true, resource: data };
}

// ─── Broadcast helpers (re-exported for convenience) ──────────

const adminService = require('./admin');

/**
 * Broadcast a plain-text message to all users.
 * Delegates to existing adminService.broadcast().
 */
async function broadcastText(message) {
  return adminService.broadcast(message);
}

/**
 * Broadcast a photo (file_id) with optional caption.
 */
async function broadcastPhoto(fileId, caption = '') {
  const usersService = require('./users');
  const telegram = require('./telegram');

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

/**
 * Broadcast a document (file_id) with optional caption.
 */
async function broadcastDocument(fileId, caption = '') {
  const usersService = require('./users');
  const telegram = require('./telegram');

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

// ─── Stats ────────────────────────────────────────────────────

/**
 * Gather all statistics for the Statistics panel screen.
 */
async function getPanelStats() {
  const usersService = require('./users');
  const referralsService = require('./referrals');
  const feedbackService = require('./feedback');

  const [totalUsers, verifiedReferrals, feedbackCount, totalResources] = await Promise.all([
    usersService.countUsers(),
    referralsService.countVerifiedReferrals(),
    feedbackService.countFeedbacks(),
    countResources(),
  ]);

  // Count users that joined channel
  const { count: joinedChannel, error } = await supabase
    .from('users')
    .select('*', { count: 'exact', head: true })
    .eq('joined_channel', true);

  if (error) {
    logger.warn('Failed to count joined_channel users', { error: error.message });
  }

  return {
    totalUsers,
    joinedChannel: joinedChannel || 0,
    feedbackCount,
    totalResources,
    verifiedReferrals,
  };
}

module.exports = {
  listBooks,
  listAllResources,
  countResources,
  isKeyTaken,
  addBook,
  renameBook,
  updateDersProgram,
  removeBook,
  broadcastText,
  broadcastPhoto,
  broadcastDocument,
  getPanelStats,
};
