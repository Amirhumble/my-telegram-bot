'use strict';

/**
 * Express HTTP server + Telegram webhook entrypoint.
 *
 * Responsibilities:
 * - Validate env (via config/env)
 * - Expose health check
 * - Receive Telegram updates and route them
 * - Register webhook on startup
 * - Graceful shutdown on SIGTERM/SIGINT
 */

const express = require('express');
const {
  PORT,
  WEBHOOK_PATH,
  WEBHOOK_URL,
  NODE_ENV,
} = require('./config/env');
const { checkDatabaseConnection } = require('./database/supabase');
const telegram = require('./services/telegram');
const { PUBLIC_COMMANDS } = require('./bot/commands');
const { handleUpdate } = require('./bot/handlers');
const logger = require('./utils/logger');
const { clearAllSessions } = require('./utils/session');

const app = express();
app.use(express.json({ limit: '1mb' }));

// ─── Health ──────────────────────────────────────────────────

app.get('/', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'telegram-bot',
    env: NODE_ENV,
  });
});

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'healthy' });
});

// ─── Telegram Webhook ────────────────────────────────────────

app.post(WEBHOOK_PATH, (req, res) => {
  // Acknowledge Telegram immediately (must respond within ~seconds)
  res.sendStatus(200);

  const update = req.body;
  if (!update || typeof update !== 'object') return;

  // Process asynchronously — errors are logged inside safeRun
  setImmediate(() => {
    handleUpdate(update).catch((err) => {
      logger.error('Unhandled update error', {
        message: err.message,
        stack: err.stack,
      });
    });
  });
});

// ─── 404 / error middleware ──────────────────────────────────

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, _req, res, _next) => {
  logger.error('Express error', { message: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Startup / Shutdown ──────────────────────────────────────

let server = null;
let isShuttingDown = false;

async function initBot() {
  logger.info('Registering Telegram webhook', { url: WEBHOOK_URL.replace(/\/[^/]+$/, '/***') });

  await telegram.setWebhook(WEBHOOK_URL);
  await telegram.setMyCommands(PUBLIC_COMMANDS);

  logger.info('Bot commands registered');
}

async function start() {
  logger.info('Starting Telegram bot service…', { env: NODE_ENV, port: PORT });

  // Database check (non-fatal if tables not yet created — logs a warning)
  try {
    await checkDatabaseConnection();
  } catch (err) {
    logger.warn('Database check threw', { message: err.message });
  }

  server = app.listen(PORT, async () => {
    logger.info(`HTTP server listening on port ${PORT}`);

    try {
      await initBot();
      logger.info('Bot is online');
    } catch (err) {
      logger.error('Bot init failed — check TOKEN, SERVER_URL, and network', {
        message: err.message,
        details: err.details,
      });
    }
  });

  server.on('error', (err) => {
    logger.error('HTTP server error', { message: err.message });
    process.exit(1);
  });
}

async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`Received ${signal} — graceful shutdown starting`);

  clearAllSessions();

  const forceTimer = setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
  if (typeof forceTimer.unref === 'function') forceTimer.unref();

  if (server) {
    await new Promise((resolve) => {
      server.close(() => {
        logger.info('HTTP server closed');
        resolve();
      });
    });
  }

  clearTimeout(forceTimer);
  logger.info('Shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', {
    message: reason?.message || String(reason),
    stack: reason?.stack,
  });
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { message: err.message, stack: err.stack });
  shutdown('uncaughtException');
});

start().catch((err) => {
  logger.error('Fatal startup error', { message: err.message, stack: err.stack });
  process.exit(1);
});

module.exports = { app, start, shutdown };
