'use strict';

/**
 * Lightweight per-user, per-operation in-memory lock.
 *
 * Purpose: prevent duplicate concurrent requests from the same user.
 * For example, a user double-clicking "Soft Copies" should only trigger
 * one PDF delivery, not two simultaneous ones.
 *
 * Design:
 * - Pure in-memory Set — no DB, no network, no new dependencies.
 * - Lock key is "{userId}:{operation}" so locks are operation-specific.
 *   A user waiting on Soft Copies can still use other features.
 * - Locks are always released in a finally block by the caller, so they
 *   cannot get stuck even if the operation throws.
 * - No TTL needed: operations complete in seconds. If the process restarts,
 *   the Set is empty and all locks are implicitly cleared.
 *
 * Usage in handlers (see handlers below for real examples):
 *
 *   const { acquire, release, OPS } = require('../../utils/userOperationLock');
 *
 *   async function handleSoftCopies(message) {
 *     const userId = message.from?.id;
 *     if (!acquire(userId, OPS.SOFT_COPIES)) {
 *       await sendMessage(chatId, LOADING.ALREADY_PROCESSING);
 *       return;
 *     }
 *     try {
 *       await sendLoading(chatId, LOADING.SOFT_COPIES);
 *       // ... actual work ...
 *     } finally {
 *       release(userId, OPS.SOFT_COPIES);
 *     }
 *   }
 */

// The active lock set. Each entry is a string key "userId:operation".
const _locks = new Set();

/**
 * Named operation identifiers.
 * Using constants avoids typos and makes grep-able.
 */
const OPS = {
  SOFT_COPIES:  'soft_copies',
  DERS_PROGRAM: 'ders_program',
  COMPETITION:  'competition',
  FEEDBACK:     'feedback',
  MEMBERSHIP:   'membership',
};

/**
 * Compose the lock key.
 * @param {number|string} userId
 * @param {string}        operation  — one of OPS.*
 */
function _key(userId, operation) {
  return `${userId}:${operation}`;
}

/**
 * Try to acquire the lock for (userId, operation).
 *
 * @param {number|string} userId
 * @param {string}        operation
 * @returns {boolean}  true  → lock acquired, caller may proceed
 *                     false → already locked, caller should bail out
 */
function acquire(userId, operation) {
  if (!userId) return true; // unknown user — let it through (edge case)
  const key = _key(userId, operation);
  if (_locks.has(key)) return false;
  _locks.add(key);
  return true;
}

/**
 * Release the lock for (userId, operation).
 * Safe to call even if the lock was never acquired (no-op).
 *
 * @param {number|string} userId
 * @param {string}        operation
 */
function release(userId, operation) {
  if (!userId) return;
  _locks.delete(_key(userId, operation));
}

/**
 * Check whether a lock is currently held (read-only).
 * Useful for tests or debug logging.
 *
 * @param {number|string} userId
 * @param {string}        operation
 * @returns {boolean}
 */
function isLocked(userId, operation) {
  if (!userId) return false;
  return _locks.has(_key(userId, operation));
}

module.exports = { OPS, acquire, release, isLocked };
