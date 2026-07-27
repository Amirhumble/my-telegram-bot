'use strict';

const { supabase } = require('../database/supabase');
const logger = require('../utils/logger');
const { AppError } = require('../utils/errors');

/**
 * Upsert a Telegram user into the users table.
 * Safe to call on every interaction.
 */
async function upsertUser({ telegramId, username = null, firstName = null }) {
  const payload = {
    telegram_id: Number(telegramId),
    username: username || null,
    first_name: firstName || null,
  };

  const { data, error } = await supabase
    .from('users')
    .upsert(payload, { onConflict: 'telegram_id' })
    .select()
    .single();

  if (error) {
    logger.error('upsertUser failed', { error: error.message, telegramId });
    throw new AppError('Failed to upsert user', {
      code: 'DB_UPSERT_USER',
      details: error,
    });
  }

  return data;
}

async function getUser(telegramId) {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('telegram_id', Number(telegramId))
    .maybeSingle();

  if (error) {
    logger.error('getUser failed', { error: error.message, telegramId });
    throw new AppError('Failed to get user', {
      code: 'DB_GET_USER',
      details: error,
    });
  }

  return data;
}

async function markJoinedChannel(telegramId, joined = true) {
  const { data, error } = await supabase
    .from('users')
    .update({ joined_channel: joined })
    .eq('telegram_id', Number(telegramId))
    .select()
    .single();

  if (error) {
    logger.error('markJoinedChannel failed', { error: error.message, telegramId });
    throw new AppError('Failed to update channel membership', {
      code: 'DB_MARK_JOINED',
      details: error,
    });
  }

  return data;
}

async function countUsers() {
  const { count, error } = await supabase
    .from('users')
    .select('*', { count: 'exact', head: true });

  if (error) {
    throw new AppError('Failed to count users', {
      code: 'DB_COUNT_USERS',
      details: error,
    });
  }

  return count || 0;
}

/**
 * Return all user telegram IDs for broadcast (paginated under the hood).
 */
async function getAllUserIds() {
  const pageSize = 1000;
  let from = 0;
  const ids = [];

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data, error } = await supabase
      .from('users')
      .select('telegram_id')
      .range(from, from + pageSize - 1);

    if (error) {
      throw new AppError('Failed to list users', {
        code: 'DB_LIST_USERS',
        details: error,
      });
    }

    if (!data || data.length === 0) break;
    ids.push(...data.map((row) => row.telegram_id));
    if (data.length < pageSize) break;
    from += pageSize;
  }

  return ids;
}

module.exports = {
  upsertUser,
  getUser,
  markJoinedChannel,
  countUsers,
  getAllUserIds,
};
