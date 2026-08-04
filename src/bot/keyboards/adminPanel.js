'use strict';

/**
 * All inline keyboards for the Admin Panel.
 *
 * Convention: callback_data strings use a short namespace prefix
 * so they are easy to route without clashing with existing callbacks.
 *
 *   ap:home        → admin panel home
 *   ap:resources   → resources submenu
 *   ap:broadcast   → broadcast submenu
 *   ap:competition → competition submenu
 *   ap:stats       → statistics
 *   ap:settings    → settings
 *   ap:close       → delete the panel message
 *
 *   ap:res:add         → add book
 *   ap:res:remove      → remove book
 *   ap:res:rename      → rename book
 *   ap:res:ders        → update ders program
 *   ap:res:list        → list resources
 *
 *   ap:bc:text         → broadcast text
 *   ap:bc:photo        → broadcast photo
 *   ap:bc:doc          → broadcast document
 *   ap:bc:confirm      → confirm broadcast
 *   ap:bc:cancel       → cancel broadcast
 *
 *   ap:comp:top        → top referrers
 *   ap:comp:stats      → competition stats
 *   ap:comp:export     → export CSV
 *
 *   ap:rm:id:<id>      → select resource for removal (id = DB id)
 *   ap:rm:yes:<id>     → confirm removal
 *   ap:rm:no           → cancel removal
 *
 *   ap:rn:id:<id>      → select resource for rename
 *
 *   ap:cancel          → cancel current wizard / go home
 */

// ─── Nav helpers ─────────────────────────────────────────────

const NAV = [
  [
    { text: '⬅ Back', callback_data: 'ap:back' },
    { text: '🏠 Home', callback_data: 'ap:home' },
    { text: '❌ Close', callback_data: 'ap:close' },
  ],
];

const NAV_HOME_CLOSE = [
  [
    { text: '🏠 Home', callback_data: 'ap:home' },
    { text: '❌ Close', callback_data: 'ap:close' },
  ],
];

// ─── Main panel ───────────────────────────────────────────────

function homeKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '📚 Resources', callback_data: 'ap:resources' }],
      [{ text: '📢 Broadcast', callback_data: 'ap:broadcast' }],
      [{ text: '👥 Competition', callback_data: 'ap:competition' }],
      [{ text: '📊 Statistics', callback_data: 'ap:stats' }],
      [{ text: '⚙ Settings', callback_data: 'ap:settings' }],
      [{ text: '❌ Close', callback_data: 'ap:close' }],
    ],
  };
}

// ─── Resources submenu ────────────────────────────────────────

function resourcesKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '➕ Add Book', callback_data: 'ap:res:add' }],
      [{ text: '🗑 Remove Book', callback_data: 'ap:res:remove' }],
      [{ text: '✏ Rename Book', callback_data: 'ap:res:rename' }],
      [{ text: '🖼 Update Ders Program', callback_data: 'ap:res:ders' }],
      [{ text: '📋 List Resources', callback_data: 'ap:res:list' }],
      ...NAV,
    ],
  };
}

// ─── Broadcast submenu ────────────────────────────────────────

function broadcastKeyboard() {
  return {
    inline_keyboard: [
      [{ text: 'Text', callback_data: 'ap:bc:text' }],
      [{ text: 'Photo', callback_data: 'ap:bc:photo' }],
      [{ text: 'Document', callback_data: 'ap:bc:doc' }],
      ...NAV,
    ],
  };
}

/** Confirm / cancel keyboard for broadcast preview. */
function broadcastConfirmKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '✅ Yes, send to all', callback_data: 'ap:bc:confirm' },
        { text: '❌ Cancel', callback_data: 'ap:bc:cancel' },
      ],
    ],
  };
}

// ─── Competition submenu ──────────────────────────────────────

function competitionKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🏆 Top Referrers', callback_data: 'ap:comp:top' }],
      [{ text: '📊 Statistics', callback_data: 'ap:comp:stats' }],
      [{ text: '📥 Export CSV', callback_data: 'ap:comp:export' }],
      ...NAV,
    ],
  };
}

// ─── Remove-book list ─────────────────────────────────────────

/**
 * Build an inline keyboard listing all books for selection.
 * @param {Array<{id: number, caption: string, name: string}>} resources
 * @param {string} actionPrefix  e.g. 'ap:rm:id' or 'ap:rn:id'
 */
function resourceListKeyboard(resources, actionPrefix) {
  const rows = resources.map((r) => [
    {
      text: r.caption || r.name,
      callback_data: `${actionPrefix}:${r.id}`,
    },
  ]);
  return {
    inline_keyboard: [
      ...rows,
      ...NAV,
    ],
  };
}

/** Confirm delete keyboard. */
function confirmDeleteKeyboard(resourceId) {
  return {
    inline_keyboard: [
      [
        { text: '✅ Yes, delete', callback_data: `ap:rm:yes:${resourceId}` },
        { text: '❌ No', callback_data: 'ap:rm:no' },
      ],
    ],
  };
}

// ─── Cancel wizard ────────────────────────────────────────────

function cancelKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🚫 Cancel', callback_data: 'ap:cancel' }],
    ],
  };
}

// ─── Back / home ──────────────────────────────────────────────

function backHomeKeyboard(backTarget = 'ap:home') {
  return {
    inline_keyboard: [
      [
        { text: '⬅ Back', callback_data: backTarget },
        { text: '🏠 Home', callback_data: 'ap:home' },
        { text: '❌ Close', callback_data: 'ap:close' },
      ],
    ],
  };
}

module.exports = {
  homeKeyboard,
  resourcesKeyboard,
  broadcastKeyboard,
  broadcastConfirmKeyboard,
  competitionKeyboard,
  resourceListKeyboard,
  confirmDeleteKeyboard,
  cancelKeyboard,
  backHomeKeyboard,
  NAV,
  NAV_HOME_CLOSE,
};
