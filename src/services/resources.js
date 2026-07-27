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

  return data || [];
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

module.exports = {
  getResourcesByType,
  getResourceByName,
  upsertResource,
  sendDersProgram,
  sendSoftCopies,
};
