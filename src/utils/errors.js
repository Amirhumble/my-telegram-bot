'use strict';

const logger = require('./logger');

class AppError extends Error {
  constructor(message, { code = 'APP_ERROR', status = 500, details = null } = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/**
 * Centralized async error wrapper for Express handlers and bot handlers.
 */
function asyncHandler(fn) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      logger.error('Unhandled handler error', {
        message: err.message,
        stack: err.stack,
        code: err.code,
      });
      throw err;
    }
  };
}

/**
 * Safe wrapper that logs and never rethrows — used for webhook processing
 * so one failed update does not crash the process.
 */
async function safeRun(label, fn) {
  try {
    return await fn();
  } catch (err) {
    logger.error(`${label} failed`, {
      message: err.message,
      stack: err.stack,
      code: err.code,
      details: err.response?.data || err.details || null,
    });
    return null;
  }
}

module.exports = {
  AppError,
  asyncHandler,
  safeRun,
};
