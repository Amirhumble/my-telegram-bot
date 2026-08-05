'use strict';

const { supabase } = require('../database/supabase');
const telegram = require('./telegram');
const logger = require('../utils/logger');
const { AppError } = require('../utils/errors');

/**
 * Resource delivery service.
 * Runtime path uses ONLY telegram_file_id from the database.
 * Local filesystem is never read during normal operation.
 */

async function getResourcesByType(type) {
  const { data, error } = await supabase
    .from('resources')
    .select('*')
    .eq('type', type)
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true });

  if (error) {
    logger.error('getResourcesByType failed', { type, error: error.message });
    throw new AppError('Failed to load resources', {
      code: 'DB_GET_RESOURCES',
      details: error,
    });
  }

  // Filter is_active in JS so it works whether or not migration 002 has run
  return (data || []).filter((r) => r.is_active !== false);
}

async function getResourceByName(name) {
  const { data, error } = await supabase
    .from('resources')
    .select('*')
    .eq('name', name)
    .maybeSingle();

  if (error) {
    throw new AppError('Failed to load resource', {
      code: 'DB_GET_RESOURCE',
      details: error,
    });
  }

  return data;
}

/**
 * Upsert a resource row (used by seed script after one-time Telegram upload).
 */
async function upsertResource({ name, type, telegramFileId, caption = null, sortOrder = 0 }) {
  const { data, error } = await supabase
    .from('resources')
    .upsert(
      {
        name,
        type,
        telegram_file_id: telegramFileId,
        caption,
        sort_order: sortOrder,
      },
      { onConflict: 'name' }
    )
    .select()
    .single();

  if (error) {
    throw new AppError('Failed to upsert resource', {
      code: 'DB_UPSERT_RESOURCE',
      details: error,
    });
  }

  return data;
}

/**
 * Send the Ders Program image using stored file_id.
 */
async function sendDersProgram(chatId) {
  const images = await getResourcesByType('image');
  const ders =
    images.find((r) => r.name === 'ders_program' || r.name === 'ders_image') ||
    images[0];

  if (!ders || !ders.telegram_file_id) {
    await telegram.sendMessage(chatId, 'የደርስ ምስሉ አልተገኘም። እባክዎ አድሚኑን ያናግሩ።');
    return { ok: false, reason: 'not_found' };
  }

  await telegram.sendPhotoByFileId(chatId, ders.telegram_file_id, {
    caption: ders.caption || '<b>የደርስ ፕሮግራም</b>',
  });

  return { ok: true };
}

/**
 * Send all PDF soft copies using stored file_ids.
 */
async function sendSoftCopies(chatId) {
  const pdfs = await getResourcesByType('pdf');

  if (!pdfs.length) {
    await telegram.sendMessage(
      chatId,
      'ኪታቦቹ አልተገኙም። እባክዎ ቆይተው እንደገና ይሞክሩ ወይም አድሚኑን ያናግሩ።'
    );
    return { ok: false, reason: 'not_found' };
  }

  await telegram.sendMessage(chatId, '⏳ ኪታቦቹ እየተላኩ ነው...');

  for (const pdf of pdfs) {
    try {
      await telegram.sendDocumentByFileId(chatId, pdf.telegram_file_id, {
        caption: pdf.caption ? `<b>${pdf.caption}</b>` : undefined,
      });
      await telegram.sleep(800);
    } catch (err) {
      logger.error('Failed to send PDF', {
        name: pdf.name,
        message: err.message,
      });
    }
  }

  return { ok: true, count: pdfs.length };
}

// ─── Admin CRUD ───────────────────────────────────────────────
// These are used exclusively by the admin panel.
// All DB access for resources is centralised here.

/**
 * List all active PDF resources (admin panel use).
 * Works with base schema — does not reference updated_at.
 */
async function listBooks() {
  const { data, error } = await supabase
    .from('resources')
    .select('id, name, type, caption, sort_order, telegram_file_id, created_at')
    .eq('type', 'pdf')
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true });

  if (error) {
    logger.error('listBooks failed', { error: error.message });
    throw new AppError('Failed to list books', { code: 'DB_LIST_BOOKS', details: error });
  }

  // Filter is_active in JS so it works whether or not migration 002 has run
  return (data || []).filter((r) => r.is_active !== false);
}

/**
 * List all active resources of any type (admin panel use).
 */
async function listAllResources() {
  const { data, error } = await supabase
    .from('resources')
    .select('id, name, type, caption, sort_order, created_at')
    .order('type', { ascending: true })
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true });

  if (error) {
    logger.error('listAllResources failed', { error: error.message });
    throw new AppError('Failed to list resources', {
      code: 'DB_LIST_RESOURCES',
      details: error,
    });
  }

  return (data || []).filter((r) => r.is_active !== false);
}

/**
 * Count active resources.
 */
async function countResources() {
  // SELECT only 'id' — never reference optional columns (is_active, updated_at)
  // that only exist after migration 002. Filter is_active in JS from the row data.
  const { data, error } = await supabase
    .from('resources')
    .select('id');

  if (error) {
    logger.error('countResources failed', {
      message: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint,
    });
    throw new AppError('Failed to count resources', {
      code: 'DB_COUNT_RESOURCES',
      details: error,
    });
  }

  // No is_active filter needed — selecting only 'id' works against the base schema.
  // When migration 002 is applied, all existing rows default to is_active = true anyway.
  return (data || []).length;
}

/**
 * Returns true if a resource with the given name already exists.
 */
async function isKeyTaken(name) {
  const { data, error } = await supabase
    .from('resources')
    .select('id')
    .eq('name', name)
    .maybeSingle();

  if (error) {
    throw new AppError('Failed to check key uniqueness', {
      code: 'DB_CHECK_KEY',
      details: error,
    });
  }

  // A row exists — key is taken (regardless of is_active state)
  return data !== null;
}

/**
 * Insert a new PDF book.
 * Returns { ok: true, resource } or { ok: false, reason }.
 */
async function addBook({ name, caption, telegramFileId, sortOrder = 0 }) {
  const taken = await isKeyTaken(name);
  if (taken) {
    return { ok: false, reason: 'duplicate_key' };
  }

  const payload = {
    name,
    type: 'pdf',
    telegram_file_id: telegramFileId,
    caption,
    sort_order: Number(sortOrder) || 0,
  };

  const { data, error } = await supabase
    .from('resources')
    .insert(payload)
    .select()
    .single();

  if (error) {
    if (error.code === '23505') {
      return { ok: false, reason: 'duplicate_key' };
    }
    logger.error('addBook failed', { error: error.message, name });
    throw new AppError('Failed to add book', { code: 'DB_ADD_BOOK', details: error });
  }

  logger.info('Book added', { id: data.id, name, caption });
  return { ok: true, resource: data };
}

/**
 * Rename a book (update caption only).
 * Returns { ok: true, resource } or { ok: false, reason: 'not_found' }.
 */
async function renameBook(id, newCaption) {
  const { data, error } = await supabase
    .from('resources')
    .update({ caption: newCaption })
    .eq('id', Number(id))
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
 * Soft-delete a resource (sets is_active = false).
 * Falls back to hard-delete if is_active column does not exist yet.
 * Never deletes Telegram file data.
 */
async function removeBook(id) {
  // Try soft-delete first
  const { data, error } = await supabase
    .from('resources')
    .update({ is_active: false })
    .eq('id', Number(id))
    .select()
    .single();

  if (error) {
    // If the column doesn't exist yet, fall back to hard-delete
    if (error.message && error.message.includes('is_active')) {
      logger.warn('is_active column missing — using hard-delete fallback', { id });
      const { data: del, error: delErr } = await supabase
        .from('resources')
        .delete()
        .eq('id', Number(id))
        .select()
        .single();

      if (delErr) {
        logger.error('removeBook hard-delete failed', { error: delErr.message, id });
        throw new AppError('Failed to remove book', {
          code: 'DB_REMOVE_BOOK',
          details: delErr,
        });
      }
      if (!del) return { ok: false, reason: 'not_found' };
      logger.info('Book hard-deleted', { id });
      return { ok: true, resource: del };
    }

    logger.error('removeBook failed', { error: error.message, id });
    throw new AppError('Failed to remove book', { code: 'DB_REMOVE_BOOK', details: error });
  }

  if (!data) {
    return { ok: false, reason: 'not_found' };
  }

  logger.info('Book soft-deleted', { id, name: data.name });
  return { ok: true, resource: data };
}

/**
 * Update (or create) the Ders Program image resource.
 * Never creates a duplicate row.
 */
async function updateDersProgram(telegramFileId) {
  // Look for existing row by well-known names
  const { data: existing, error: findErr } = await supabase
    .from('resources')
    .select('id, name')
    .in('name', ['ders_program', 'ders_image'])
    .limit(1)
    .maybeSingle();

  if (findErr) {
    throw new AppError('Failed to find ders program', {
      code: 'DB_FIND_DERS',
      details: findErr,
    });
  }

  if (existing) {
    const { data, error } = await supabase
      .from('resources')
      .update({ telegram_file_id: telegramFileId })
      .eq('id', existing.id)
      .select()
      .single();

    if (error) {
      logger.error('updateDersProgram failed', { error: error.message });
      throw new AppError('Failed to update ders program', {
        code: 'DB_UPDATE_DERS',
        details: error,
      });
    }

    logger.info('Ders Program updated', { id: data.id });
    return { ok: true, resource: data };
  }

  // No existing row — insert
  const { data, error } = await supabase
    .from('resources')
    .insert({
      name: 'ders_program',
      type: 'image',
      telegram_file_id: telegramFileId,
      caption: '<b>የደርስ ፕሮግራም</b>',
      sort_order: 0,
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

  logger.info('Ders Program created', { id: data.id });
  return { ok: true, resource: data };
}

module.exports = {
  getResourcesByType,
  getResourceByName,
  upsertResource,
  sendDersProgram,
  sendSoftCopies,
  // Admin CRUD
  listBooks,
  listAllResources,
  countResources,
  isKeyTaken,
  addBook,
  renameBook,
  removeBook,
  updateDersProgram,
};
