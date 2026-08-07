'use strict';

/**
 * Admin wizard session store.
 *
 * Each admin user gets a single mutable session object that acts as
 * a state machine for multi-step flows (add-book wizard, broadcast, etc.).
 *
 * State shape example:
 * {
 *   flow: 'add_book',           // which wizard is running
 *   step: 'awaiting_pdf',       // current wizard step
 *   panelMessageId: 12345,      // message ID of the persistent panel message
 *   data: {                     // accumulator for wizard inputs
 *     fileId: null,
 *     title: null,
 *     key: null,
 *     sortOrder: null,
 *   }
 * }
 */

const { setSession, getSession, clearSession } = require('./session');

// TTL for admin sessions: 60 minutes (admins get more time)
const ADMIN_SESSION_TTL = 60 * 60 * 1000;

/** Flows recognised by the admin panel. */
const FLOWS = {
  IDLE: null,
  ADD_BOOK: 'add_book',
  REMOVE_BOOK: 'remove_book',
  RENAME_BOOK: 'rename_book',
  UPDATE_DERS: 'update_ders',
  BROADCAST: 'broadcast',
  SEARCH_PARTICIPANT: 'search_participant',
};

/** Steps within each flow. */
const STEPS = {
  // add_book
  AWAITING_PDF: 'awaiting_pdf',
  AWAITING_TITLE: 'awaiting_title',
  AWAITING_KEY: 'awaiting_key',
  AWAITING_ORDER: 'awaiting_order',
  AWAITING_CONFIRM: 'awaiting_confirm',

  // remove_book / rename_book
  AWAITING_SELECTION: 'awaiting_selection',

  // rename_book
  AWAITING_NEW_TITLE: 'awaiting_new_title',

  // update_ders
  AWAITING_IMAGE: 'awaiting_image',

  // broadcast
  AWAITING_CONTENT: 'awaiting_content',
  AWAITING_BROADCAST_CONFIRM: 'awaiting_broadcast_confirm',

  // search_participant
  AWAITING_SEARCH_QUERY: 'awaiting_search_query',
};

// Internal namespace to keep admin sessions separate from user sessions
function _key(adminId) {
  return `admin_${adminId}`;
}

/**
 * Start a new admin wizard flow, resetting any previous state.
 * @param {number|string} adminId
 * @param {string} flow  - one of FLOWS.*
 * @param {object} [initial] - optional extra data to seed
 */
function startFlow(adminId, flow, initial = {}) {
  setSession(
    _key(adminId),
    {
      flow,
      step: null,
      panelMessageId: null,
      data: {},
      ...initial,
    },
    ADMIN_SESSION_TTL
  );
}

/**
 * Read the current admin session (returns null if none/expired).
 * @param {number|string} adminId
 * @returns {object|null}
 */
function getAdminSession(adminId) {
  return getSession(_key(adminId));
}

/**
 * Merge partial updates into the current session.
 * If no session exists a no-op is performed (caller should check first).
 * @param {number|string} adminId
 * @param {object} patch
 */
function updateAdminSession(adminId, patch) {
  const existing = getAdminSession(adminId);
  if (!existing) return;
  setSession(
    _key(adminId),
    { ...existing, ...patch, data: { ...existing.data, ...(patch.data || {}) } },
    ADMIN_SESSION_TTL
  );
}

/**
 * Advance the wizard to the next step.
 */
function setStep(adminId, step) {
  updateAdminSession(adminId, { step });
}

/**
 * Clear the admin session entirely (flow completed or cancelled).
 */
function clearAdminSession(adminId) {
  clearSession(_key(adminId));
}

module.exports = {
  FLOWS,
  STEPS,
  startFlow,
  getAdminSession,
  updateAdminSession,
  setStep,
  clearAdminSession,
};
