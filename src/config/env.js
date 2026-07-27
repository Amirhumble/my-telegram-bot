'use strict';

require('dotenv').config();

/**
 * Validates and exports environment configuration.
 * Fails fast on missing required variables so the bot never starts half-configured.
 */

const REQUIRED = [
  'TOKEN',
  'SERVER_URL',
  'ADMIN_CHAT_ID',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'CHANNEL_ID',
  'BOT_USERNAME',
];

function validateEnv() {
  const missing = REQUIRED.filter((key) => {
    const value = process.env[key];
    return value === undefined || value === null || String(value).trim() === '';
  });

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}\n` +
        'Copy .env.example to .env and fill in all values.'
    );
  }
}

validateEnv();

const TOKEN = process.env.TOKEN.trim();
const SERVER_URL = process.env.SERVER_URL.trim().replace(/\/$/, '');
const ADMIN_CHAT_ID = String(process.env.ADMIN_CHAT_ID).trim();
const PORT = Number(process.env.PORT) || 5000;
const SUPABASE_URL = process.env.SUPABASE_URL.trim();
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY.trim();
const CHANNEL_ID = process.env.CHANNEL_ID.trim();
const BOT_USERNAME = process.env.BOT_USERNAME.trim().replace(/^@/, '');
const CHANNEL_INVITE_LINK = (process.env.CHANNEL_INVITE_LINK || '').trim();
const NODE_ENV = process.env.NODE_ENV || 'production';

const TELEGRAM_API = `https://api.telegram.org/bot${TOKEN}`;
const WEBHOOK_PATH = `/webhook/${TOKEN}`;
const WEBHOOK_URL = `${SERVER_URL}${WEBHOOK_PATH}`;

module.exports = {
  TOKEN,
  SERVER_URL,
  ADMIN_CHAT_ID,
  PORT,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  CHANNEL_ID,
  BOT_USERNAME,
  CHANNEL_INVITE_LINK,
  NODE_ENV,
  TELEGRAM_API,
  WEBHOOK_PATH,
  WEBHOOK_URL,
};
