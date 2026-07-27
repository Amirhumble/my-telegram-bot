'use strict';

/**
 * Lightweight in-memory session store for multi-step flows
 * (e.g. waiting for feedback text after the Feedback button).
 *
 * Note: On multi-instance deployments, replace with Redis.
 * For a single Koyeb instance this is sufficient.
 */

const sessions = new Map();
const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes

function setSession(userId, data, ttlMs = DEFAULT_TTL_MS) {
  const key = String(userId);
  const existing = sessions.get(key);
  if (existing?.timeout) clearTimeout(existing.timeout);

  const timeout = setTimeout(() => {
    sessions.delete(key);
  }, ttlMs);

  // Allow process to exit even if sessions remain
  if (typeof timeout.unref === 'function') timeout.unref();

  sessions.set(key, { data, timeout, updatedAt: Date.now() });
}

function getSession(userId) {
  const entry = sessions.get(String(userId));
  return entry ? entry.data : null;
}

function clearSession(userId) {
  const key = String(userId);
  const entry = sessions.get(key);
  if (entry?.timeout) clearTimeout(entry.timeout);
  sessions.delete(key);
}

function clearAllSessions() {
  for (const [, entry] of sessions) {
    if (entry?.timeout) clearTimeout(entry.timeout);
  }
  sessions.clear();
}

module.exports = {
  setSession,
  getSession,
  clearSession,
  clearAllSessions,
};
