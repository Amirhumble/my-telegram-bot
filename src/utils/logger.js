'use strict';

const LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const currentLevel =
  LEVELS[process.env.LOG_LEVEL] !== undefined
    ? LEVELS[process.env.LOG_LEVEL]
    : LEVELS.info;

function formatMeta(meta) {
  if (!meta || Object.keys(meta).length === 0) return '';
  try {
    return ` ${JSON.stringify(meta)}`;
  } catch {
    return ' [unserializable meta]';
  }
}

function log(level, message, meta = {}) {
  if (LEVELS[level] > currentLevel) return;

  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${level.toUpperCase()} ${message}${formatMeta(meta)}`;

  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

module.exports = {
  error: (message, meta) => log('error', message, meta),
  warn: (message, meta) => log('warn', message, meta),
  info: (message, meta) => log('info', message, meta),
  debug: (message, meta) => log('debug', message, meta),
};
