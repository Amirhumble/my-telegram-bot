'use strict';

const { createClient } = require('@supabase/supabase-js');
const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
} = require('../config/env');
const logger = require('../utils/logger');


logger.info('Supabase configuration', {
  url: SUPABASE_URL,
});
/**
 * Supabase client using the service role key.
 * This key is server-side only — never expose it to clients.
 */
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

/**
 * Lightweight connectivity check used during graceful startup.
 */
async function checkDatabaseConnection() {
  const { error } = await supabase.from('users').select('telegram_id').limit(1);

  if (error) {
    // Table may not exist yet on first deploy — still useful signal
    logger.warn('Database connectivity check warning', {
      message: error.message,
      code: error.code,
    });
    return { ok: false, error };
  }

  logger.info('Database connection OK');
  return { ok: true };
}

module.exports = {
  supabase,
  checkDatabaseConnection,
};
