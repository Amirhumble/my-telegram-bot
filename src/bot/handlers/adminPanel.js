'use strict';

/**
 * Admin Panel Handler
 *
 * Handles all /admin command entry, inline keyboard callbacks (ap:*),
 * and multi-step wizard message inputs for the admin panel.
 *
 * Architecture:
 * - handleAdminEntry(message)     → /admin command
 * - handleAdminCallback(cbQuery)  → all ap:* callback_query events
 * - handleAdminMessage(message)   → wizard step inputs (PDF, text, image...)
 *
 * State machine lives in utils/adminSession.js.
 * Business logic lives in services/adminPanel.js.
 * This handler stays thin: route → delegate → respond.
 */

const adminService = require('../../services/admin');
const adminPanelService = require('../../services/adminPanel');
const referralsService = require('../../services/referrals');
const telegram = require('../../services/telegram');
const logger = require('../../utils/logger');
const { escapeHtml } = require('../../services/feedback');
const {
  FLOWS,
  STEPS,
  startFlow,
  getAdminSession,
  updateAdminSession,
  clearAdminSession,
} = require('../../utils/adminSession');
const {
  homeKeyboard,
  resourcesKeyboard,
  broadcastKeyboard,
  broadcastConfirmKeyboard,
  competitionKeyboard,
  leaderboardPagingKeyboard,
  resourceListKeyboard,
  confirmDeleteKeyboard,
  cancelKeyboard,
  backHomeKeyboard,
} = require('../keyboards/adminPanel');

// ─── Helpers ──────────────────────────────────────────────────

const HOME_TEXT = '🛠 <b>Admin Panel</b>\n\nChoose an option:';

/**
 * Send or edit the persistent panel message.
 * If panelMessageId exists in session we edit in place (no spam).
 * Returns the message_id of the panel message.
 */
async function showPanel(chatId, adminId, text, keyboard, existingMsgId = null) {
  if (existingMsgId) {
    try {
      await telegram.editMessageText(chatId, existingMsgId, text, {
        reply_markup: keyboard,
      });
      return existingMsgId;
    } catch (_) {
      // Fall through and send a new message if edit fails
    }
  }
  const res = await telegram.sendMessage(chatId, text, { reply_markup: keyboard });
  return res?.result?.message_id || null;
}

/**
 * Answer a callback query silently (required by Telegram to stop the spinner).
 */
async function ack(callbackId, text = '') {
  try {
    await telegram.answerCallbackQuery(callbackId, text);
  } catch (_) { /* ignore */ }
}

// ─── Entry: /admin command ────────────────────────────────────

/**
 * Called when a user sends /admin.
 * Returns true if handled (so the index router can skip further processing).
 */
async function handleAdminEntry(message) {
  const chatId = message.chat.id;

  if (!adminService.isAdmin(chatId)) {
    await telegram.sendMessage(chatId, 'You are not authorized.');
    return true;
  }

  // Clear any leftover wizard state
  clearAdminSession(chatId);

  const msgId = await showPanel(chatId, chatId, HOME_TEXT, homeKeyboard());
  // Store the panel message id so we can edit it later
  startFlow(chatId, FLOWS.IDLE, { panelMessageId: msgId });

  return true;
}

// ─── Callback router ──────────────────────────────────────────

/**
 * Main callback dispatcher for all ap:* data strings.
 * Returns true if the callback was an admin-panel callback (regardless of auth),
 * so the global callback router can stop processing.
 */
async function handleAdminCallback(callbackQuery) {
  const data = callbackQuery.data || '';
  if (!data.startsWith('ap:')) return false;

  const chatId = callbackQuery.message?.chat?.id;
  const messageId = callbackQuery.message?.message_id;
  const callbackId = callbackQuery.id;
  const adminId = callbackQuery.from?.id;

  // ── Answer callback immediately — Telegram times out after ~10s ──
  // Must happen before any DB/network work, regardless of auth result.
  await ack(callbackId);

  // Auth guard (isAdmin is synchronous — no DB call)
  if (!adminService.isAdmin(adminId)) {
    // Send a short alert since we already ack'd silently above
    try {
      await telegram.answerCallbackQuery(callbackId, 'Not authorized.', true);
    } catch (_) { /* already answered */ }
    return true;
  }

  const session = getAdminSession(adminId);
  const panelMsgId = session?.panelMessageId || messageId;

  try {
    // ── Navigation ──────────────────────────────────────────
    if (data === 'ap:home' || data === 'ap:back') {
      clearAdminSession(adminId);
      startFlow(adminId, FLOWS.IDLE, { panelMessageId: panelMsgId });
      await showPanel(chatId, adminId, HOME_TEXT, homeKeyboard(), panelMsgId);
      return true;
    }

    if (data === 'ap:close') {
      clearAdminSession(adminId);
      await telegram.deleteMessage(chatId, panelMsgId);
      return true;
    }

    if (data === 'ap:cancel') {
      clearAdminSession(adminId);
      startFlow(adminId, FLOWS.IDLE, { panelMessageId: panelMsgId });
      await showPanel(chatId, adminId, HOME_TEXT, homeKeyboard(), panelMsgId);
      return true;
    }

    // ── Top-level sections ───────────────────────────────────
    if (data === 'ap:resources') {
      await showPanel(chatId, adminId, '📚 <b>Resource Management</b>', resourcesKeyboard(), panelMsgId);
      updateAdminSession(adminId, { panelMessageId: panelMsgId });
      return true;
    }

    if (data === 'ap:broadcast') {
      await showPanel(chatId, adminId, '📢 <b>Broadcast</b>\n\nChoose message type:', broadcastKeyboard(), panelMsgId);
      return true;
    }

    if (data === 'ap:competition') {
      await showPanel(chatId, adminId, '👥 <b>Competition</b>', competitionKeyboard(), panelMsgId);
      return true;
    }

    if (data === 'ap:stats') {
      return await handleStatsCallback(chatId, adminId, panelMsgId);
    }

    if (data === 'ap:settings') {
      await showPanel(chatId, adminId, '⚙ <b>Settings</b>\n\nSettings coming soon.', backHomeKeyboard('ap:home'), panelMsgId);
      return true;
    }

    // ── Resource sub-actions ─────────────────────────────────
    if (data === 'ap:res:add') return await startAddBook(chatId, adminId, panelMsgId);
    if (data === 'ap:res:remove') return await startRemoveBook(chatId, adminId, panelMsgId);
    if (data === 'ap:res:rename') return await startRenameBook(chatId, adminId, panelMsgId);
    if (data === 'ap:res:ders') return await startUpdateDers(chatId, adminId, panelMsgId);
    if (data === 'ap:res:list') return await handleListResources(chatId, adminId, panelMsgId);

    // ── Remove book selection / confirmation ─────────────────
    if (data.startsWith('ap:rm:id:')) {
      const resourceId = data.replace('ap:rm:id:', '');
      return await handleRemoveSelect(chatId, adminId, panelMsgId, resourceId);
    }
    if (data.startsWith('ap:rm:yes:')) {
      const resourceId = data.replace('ap:rm:yes:', '');
      return await handleRemoveConfirm(chatId, adminId, panelMsgId, resourceId);
    }
    if (data === 'ap:rm:no') {
      await showPanel(chatId, adminId, '📚 <b>Resource Management</b>', resourcesKeyboard(), panelMsgId);
      return true;
    }

    // ── Rename book selection ─────────────────────────────────
    if (data.startsWith('ap:rn:id:')) {
      const resourceId = data.replace('ap:rn:id:', '');
      return await handleRenameSelect(chatId, adminId, panelMsgId, resourceId);
    }

    // ── Broadcast types ──────────────────────────────────────
    if (data === 'ap:bc:text') return await startBroadcast(chatId, adminId, panelMsgId, 'text');
    if (data === 'ap:bc:photo') return await startBroadcast(chatId, adminId, panelMsgId, 'photo');
    if (data === 'ap:bc:doc') return await startBroadcast(chatId, adminId, panelMsgId, 'document');
    if (data === 'ap:bc:confirm') return await handleBroadcastConfirm(chatId, adminId, panelMsgId);
    if (data === 'ap:bc:cancel') {
      clearAdminSession(adminId);
      startFlow(adminId, FLOWS.IDLE, { panelMessageId: panelMsgId });
      await showPanel(chatId, adminId, HOME_TEXT, homeKeyboard(), panelMsgId);
      return true;
    }

    // ── Competition sub-actions ──────────────────────────────
    if (data === 'ap:comp:top') return await handleCompTop(chatId, adminId, panelMsgId, 1);
    if (data === 'ap:comp:search') return await startSearchParticipant(chatId, adminId, panelMsgId);
    if (data === 'ap:comp:stats') return await handleCompStats(chatId, adminId, panelMsgId);
    if (data === 'ap:comp:export') return await handleCompExport(chatId, adminId, panelMsgId);
    if (data.startsWith('ap:comp:page:')) {
      const page = parseInt(data.replace('ap:comp:page:', ''), 10) || 1;
      return await handleCompTop(chatId, adminId, panelMsgId, page);
    }

    // Unknown ap: callback — silently handled (ack already sent above)
    logger.warn('Unknown admin panel callback', { data });

  } catch (err) {
    logger.error('Admin panel callback error', {
      data,
      message: err.message,
      stack: err.stack,
    });
    await showPanel(chatId, adminId,
      `❌ <b>Error</b>\n\n${escapeHtml(err.message)}\n\nReturning to home…`,
      homeKeyboard(),
      panelMsgId
    );
    clearAdminSession(adminId);
    startFlow(adminId, FLOWS.IDLE, { panelMessageId: panelMsgId });
  }

  return true;
}

// ─── Competition: Statistics ───────────────────────────────────

async function handleStatsCallback(chatId, adminId, panelMsgId) {
  const stats = await adminPanelService.getPanelStats();

  let leaderLine = '—';
  if (stats.leader) {
    const name = escapeHtml(stats.leader.first_name || '—');
    const uname = stats.leader.username ? ` (@${escapeHtml(stats.leader.username)})` : '';
    leaderLine = `${name}${uname}\nVerified: <b>${stats.leader.verified_count}</b>`;
  }

  const text =
    `📊 <b>Competition Statistics</b>\n\n` +
    `👥 Users: <b>${stats.totalUsers}</b>\n` +
    `🔗 Referral Links: <b>${stats.uniqueReferrers ?? '—'}</b>\n` +
    `✅ Verified: <b>${stats.verifiedReferrals}</b>\n` +
    `⏳ Pending: <b>${stats.pendingReferrals ?? '—'}</b>\n` +
    `📚 Resources: <b>${stats.totalResources}</b>\n` +
    `💬 Feedback: <b>${stats.feedbackCount}</b>\n\n` +
    `🏆 Leader:\n${leaderLine}`;

  await showPanel(chatId, adminId, text, backHomeKeyboard('ap:competition'), panelMsgId);
  return true;
}

// ─── Competition: Top Referrers (paginated) ────────────────────

const PAGE_SIZE = 10;

// Medal emojis for top 3, numbered for the rest
const RANK_EMOJI = ['🥇', '🥈', '🥉'];

/**
 * Format a single leaderboard entry.
 * @param {object} row
 * @param {number} globalRank  1-based absolute rank
 */
function _formatEntry(row, globalRank) {
  const medal = RANK_EMOJI[globalRank - 1] || `#${globalRank}`;
  const name = escapeHtml(row.first_name || '—');
  const uname = row.username ? `📛 @${escapeHtml(row.username)}\n` : '';
  return (
    `${medal} <b>${medal.length > 2 ? '' : ' '}${name}</b>\n` +
    `${uname}` +
    `🆔 <code>${row.telegram_id}</code>\n` +
    `✅ Verified: <b>${row.verified_count}</b>\n` +
    `⏳ Pending: <b>${row.pending_count}</b>\n` +
    `📈 Total: <b>${row.total_referrals}</b>`
  );
}

async function handleCompTop(chatId, adminId, panelMsgId, page = 1) {
  const result = await adminPanelService.getLeaderboardPage(page, PAGE_SIZE);

  if (!result.rows.length) {
    await showPanel(chatId, adminId,
      '🏆 <b>Top Referrers</b>\n\nNo competition data yet.',
      backHomeKeyboard('ap:competition'),
      panelMsgId
    );
    return true;
  }

  const offset = (result.page - 1) * PAGE_SIZE;
  const entries = result.rows.map((row, i) => _formatEntry(row, offset + i + 1));

  const pageInfo = result.totalPages > 1
    ? `\nPage <b>${result.page}</b> of <b>${result.totalPages}</b>`
    : '';

  const text =
    `🏆 <b>Top Referrers</b>${pageInfo}\n\n` +
    entries.join('\n────────────────\n');

  await showPanel(chatId, adminId, text,
    leaderboardPagingKeyboard(result.page, result.totalPages),
    panelMsgId
  );

  logger.info('Leaderboard page displayed', { page: result.page, total: result.total });
  return true;
}

// ─── Competition: Search Participant ──────────────────────────

async function startSearchParticipant(chatId, adminId, panelMsgId) {
  startFlow(adminId, FLOWS.SEARCH_PARTICIPANT, {
    panelMessageId: panelMsgId,
    step: STEPS.AWAITING_SEARCH_QUERY,
  });
  await showPanel(chatId, adminId,
    '🔍 <b>Search Participant</b>\n\nSend a Telegram ID or @username.',
    cancelKeyboard(),
    panelMsgId
  );
  return true;
}

async function handleSearchParticipantStep(chatId, message, session) {
  const { panelMessageId } = session;
  const query = (message.text || '').trim();

  if (!query) {
    await showPanel(chatId, chatId,
      '🔍 <b>Search Participant</b>\n\n⚠ Please send a Telegram ID or @username.',
      cancelKeyboard(),
      panelMessageId
    );
    return true;
  }

  const participant = await adminPanelService.searchParticipant(query);

  clearAdminSession(chatId);
  startFlow(chatId, FLOWS.IDLE, { panelMessageId });

  if (!participant) {
    await showPanel(chatId, chatId,
      `❌ <b>User not found.</b>\n\nQuery: <code>${escapeHtml(query)}</code>`,
      backHomeKeyboard('ap:competition'),
      panelMessageId
    );
    return true;
  }

  const name = escapeHtml(participant.first_name || '—');
  const uname = participant.username
    ? `📛 @${escapeHtml(participant.username)}\n`
    : '';
  const rankLine = participant.rank !== null && participant.rank !== undefined
    ? `🏆 Rank: <b>#${participant.rank}</b>\n`
    : '';
  const regDate = participant.created_at
    ? `📅 Registered: <b>${String(participant.created_at).slice(0, 10)}</b>\n`
    : '';

  const text =
    `🔍 <b>Participant Found</b>\n\n` +
    `👤 ${name}\n` +
    `${uname}` +
    `🆔 <code>${participant.telegram_id}</code>\n` +
    `${rankLine}` +
    `✅ Verified Referrals: <b>${participant.verified_count}</b>\n` +
    `⏳ Pending Referrals: <b>${participant.pending_count}</b>\n` +
    `📈 Total Referrals: <b>${participant.total_referrals}</b>\n` +
    `${regDate}`;

  await showPanel(chatId, chatId, text, backHomeKeyboard('ap:competition'), panelMessageId);
  return true;
}

// ─── Competition: Stats (Competition submenu stats) ────────────

async function handleCompStats(chatId, adminId, panelMsgId) {
  // Reuse the main stats handler — same data, same screen
  return handleStatsCallback(chatId, adminId, panelMsgId);
}

// ─── Competition: Export CSV ───────────────────────────────────

async function handleCompExport(chatId, adminId, panelMsgId) {
  const rows = await adminPanelService.getLeaderboardCsvData();

  if (!rows.length) {
    await showPanel(chatId, adminId,
      '📤 No competition data to export.',
      backHomeKeyboard('ap:competition'),
      panelMsgId
    );
    return true;
  }

  // Build CSV
  const today = new Date().toISOString().slice(0, 10);
  const filename = `competition_results_${today}.csv`;
  const header = 'rank,telegram_id,username,first_name,verified,pending,total,registered_at';
  const csvRows = rows.map((r, i) => {
    const esc = (v) => String(v || '').replace(/"/g, '""');
    return [
      i + 1,
      r.telegram_id,
      `"${esc(r.username)}"`,
      `"${esc(r.first_name)}"`,
      r.verified_count,
      r.pending_count,
      r.total_referrals,
      `"${esc(String(r.created_at || '').slice(0, 10))}"`,
    ].join(',');
  });
  const csv = [header, ...csvRows].join('\n');

  // Send as document (no disk I/O)
  const { Readable } = require('stream');
  const FormData = require('form-data');
  const axios = require('axios');
  const { TELEGRAM_API } = require('../../config/env');

  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('document', Readable.from([csv]), {
    filename,
    contentType: 'text/csv',
  });
  form.append('caption', `📤 Competition results — ${today}\nTotal participants: ${rows.length}`);

  try {
    await axios.post(`${TELEGRAM_API}/sendDocument`, form, {
      headers: form.getHeaders(),
      timeout: 60000,
    });
    logger.info('CSV exported', { filename, rows: rows.length });
  } catch (err) {
    logger.error('CSV export send failed', { message: err.message });
    await showPanel(chatId, adminId,
      `❌ Export failed: ${escapeHtml(err.message)}`,
      backHomeKeyboard('ap:competition'),
      panelMsgId
    );
    return true;
  }

  await showPanel(chatId, adminId,
    `✅ <b>Export complete.</b>\n\n${rows.length} participants exported to <code>${filename}</code>`,
    backHomeKeyboard('ap:competition'),
    panelMsgId
  );
  return true;
}

async function handleListResources(chatId, adminId, panelMsgId) {
  const resources = await adminPanelService.listAllResources();
  if (!resources.length) {
    await showPanel(chatId, adminId,
      '📋 <b>Resources</b>\n\nNo resources found.',
      backHomeKeyboard('ap:resources'),
      panelMsgId
    );
    return true;
  }

  const lines = resources.map((r, i) => {
    const title = escapeHtml(r.caption || r.name);
    const type = r.type === 'pdf' ? '📄' : '🖼';
    return `${i + 1}. ${type} <b>${title}</b> <code>[${escapeHtml(r.name)}]</code>`;
  });

  const text = `📋 <b>Resources</b>\n\n${lines.join('\n')}\n\nTotal: <b>${resources.length}</b>`;
  await showPanel(chatId, adminId, text, backHomeKeyboard('ap:resources'), panelMsgId);
  return true;
}

// ─── Resource: Add Book wizard ────────────────────────────────

async function startAddBook(chatId, adminId, panelMsgId) {
  startFlow(adminId, FLOWS.ADD_BOOK, {
    panelMessageId: panelMsgId,
    step: STEPS.AWAITING_PDF,
  });
  await showPanel(chatId, adminId,
    '➕ <b>Add Book</b>\n\nStep 1/4 — Send the PDF file.',
    cancelKeyboard(),
    panelMsgId
  );
  return true;
}

// ─── Resource: Remove Book wizard ─────────────────────────────

async function startRemoveBook(chatId, adminId, panelMsgId) {
  const books = await adminPanelService.listBooks();
  if (!books.length) {
    await showPanel(chatId, adminId,
      '🗑 <b>Remove Book</b>\n\nNo books found.',
      backHomeKeyboard('ap:resources'),
      panelMsgId
    );
    return true;
  }

  startFlow(adminId, FLOWS.REMOVE_BOOK, {
    panelMessageId: panelMsgId,
    step: STEPS.AWAITING_SELECTION,
  });

  await showPanel(chatId, adminId,
    '🗑 <b>Remove Book</b>\n\nSelect a book to remove:',
    resourceListKeyboard(books, 'ap:rm:id'),
    panelMsgId
  );
  return true;
}

async function handleRemoveSelect(chatId, adminId, panelMsgId, resourceId) {
  updateAdminSession(adminId, { step: STEPS.AWAITING_CONFIRM, data: { resourceId } });
  await showPanel(chatId, adminId,
    `🗑 <b>Remove Book</b>\n\nAre you sure you want to delete this resource?\n\n⚠ This action cannot be undone.`,
    confirmDeleteKeyboard(resourceId),
    panelMsgId
  );
  return true;
}

async function handleRemoveConfirm(chatId, adminId, panelMsgId, resourceId) {
  const result = await adminPanelService.removeBook(resourceId);
  clearAdminSession(adminId);
  startFlow(adminId, FLOWS.IDLE, { panelMessageId: panelMsgId });

  if (!result.ok) {
    await showPanel(chatId, adminId,
      '❌ Resource not found or already removed.',
      backHomeKeyboard('ap:resources'),
      panelMsgId
    );
    return true;
  }

  await showPanel(chatId, adminId,
    '✅ <b>Book removed successfully.</b>',
    backHomeKeyboard('ap:resources'),
    panelMsgId
  );
  return true;
}

// ─── Resource: Rename Book wizard ─────────────────────────────

async function startRenameBook(chatId, adminId, panelMsgId) {
  const books = await adminPanelService.listBooks();
  if (!books.length) {
    await showPanel(chatId, adminId,
      '✏ <b>Rename Book</b>\n\nNo books found.',
      backHomeKeyboard('ap:resources'),
      panelMsgId
    );
    return true;
  }

  startFlow(adminId, FLOWS.RENAME_BOOK, {
    panelMessageId: panelMsgId,
    step: STEPS.AWAITING_SELECTION,
  });

  await showPanel(chatId, adminId,
    '✏ <b>Rename Book</b>\n\nSelect a book to rename:',
    resourceListKeyboard(books, 'ap:rn:id'),
    panelMsgId
  );
  return true;
}

async function handleRenameSelect(chatId, adminId, panelMsgId, resourceId) {
  updateAdminSession(adminId, {
    step: STEPS.AWAITING_NEW_TITLE,
    data: { resourceId },
  });
  await showPanel(chatId, adminId,
    '✏ <b>Rename Book</b>\n\nEnter the new display title:',
    cancelKeyboard(),
    panelMsgId
  );
  return true;
}

// ─── Resource: Update Ders Program wizard ─────────────────────

async function startUpdateDers(chatId, adminId, panelMsgId) {
  startFlow(adminId, FLOWS.UPDATE_DERS, {
    panelMessageId: panelMsgId,
    step: STEPS.AWAITING_IMAGE,
  });
  await showPanel(chatId, adminId,
    '🖼 <b>Update Ders Program</b>\n\nSend the new image.',
    cancelKeyboard(),
    panelMsgId
  );
  return true;
}

// ─── Broadcast wizard ─────────────────────────────────────────

async function startBroadcast(chatId, adminId, panelMsgId, type) {
  const prompts = {
    text: 'Send the text message to broadcast:',
    photo: 'Send the photo to broadcast (with optional caption):',
    document: 'Send the document to broadcast (with optional caption):',
  };
  startFlow(adminId, FLOWS.BROADCAST, {
    panelMessageId: panelMsgId,
    step: STEPS.AWAITING_CONTENT,
    data: { broadcastType: type },
  });
  await showPanel(chatId, adminId,
    `📢 <b>Broadcast — ${type.charAt(0).toUpperCase() + type.slice(1)}</b>\n\n${prompts[type]}`,
    cancelKeyboard(),
    panelMsgId
  );
  return true;
}

async function handleBroadcastConfirm(chatId, adminId, panelMsgId) {
  const session = getAdminSession(adminId);
  if (!session || session.flow !== FLOWS.BROADCAST) {
    await showPanel(chatId, adminId, HOME_TEXT, homeKeyboard(), panelMsgId);
    return true;
  }

  const { broadcastType, broadcastContent, broadcastFileId } = session.data;

  await showPanel(chatId, adminId,
    '📣 <b>Broadcasting…</b>\n\nThis may take a moment. Please wait.',
    backHomeKeyboard('ap:home'),
    panelMsgId
  );

  let result;
  try {
    if (broadcastType === 'text') {
      result = await adminPanelService.broadcastText(broadcastContent);
    } else if (broadcastType === 'photo') {
      result = await adminPanelService.broadcastPhoto(broadcastFileId, broadcastContent);
    } else {
      result = await adminPanelService.broadcastDocument(broadcastFileId, broadcastContent);
    }
  } catch (err) {
    logger.error('Broadcast failed', { message: err.message });
    clearAdminSession(adminId);
    startFlow(adminId, FLOWS.IDLE, { panelMessageId: panelMsgId });
    await showPanel(chatId, adminId,
      `❌ Broadcast failed: ${escapeHtml(err.message)}`,
      backHomeKeyboard('ap:broadcast'),
      panelMsgId
    );
    return true;
  }

  clearAdminSession(adminId);
  startFlow(adminId, FLOWS.IDLE, { panelMessageId: panelMsgId });

  await showPanel(chatId, adminId,
    `✅ <b>Broadcast complete.</b>\n\n` +
    `📤 Sent: <b>${result.sent}</b>\n` +
    `❌ Failed: <b>${result.failed}</b>\n` +
    `👥 Total: <b>${result.total}</b>`,
    backHomeKeyboard('ap:home'),
    panelMsgId
  );
  return true;
}

// ─── Admin message wizard interceptor ────────────────────────

/**
 * Called from the global message handler BEFORE normal routing.
 * If the admin has an active wizard step, this handles the incoming
 * message and returns true so the router skips everything else.
 *
 * Handles all message types: text, document, photo.
 */
async function handleAdminMessage(message) {
  const from = message.from || {};
  const chatId = message.chat.id;

  if (!adminService.isAdmin(chatId)) return false;

  const session = getAdminSession(chatId);
  if (!session || !session.flow || session.flow === FLOWS.IDLE) return false;

  const { flow, step, panelMessageId, data } = session;

  // /cancel anywhere inside a wizard aborts it
  if (message.text && message.text.trim() === '/cancel') {
    clearAdminSession(chatId);
    startFlow(chatId, FLOWS.IDLE, { panelMessageId });
    await showPanel(chatId, chatId,
      '🚫 <b>Cancelled.</b>\n\nReturning to home…',
      homeKeyboard(),
      panelMessageId
    );
    return true;
  }

  try {
    // ── Add Book wizard ──────────────────────────────────────
    if (flow === FLOWS.ADD_BOOK) return await handleAddBookStep(chatId, message, session);

    // ── Rename Book wizard ───────────────────────────────────
    if (flow === FLOWS.RENAME_BOOK && step === STEPS.AWAITING_NEW_TITLE) {
      return await handleRenameStep(chatId, message, session);
    }

    // ── Update Ders Program wizard ───────────────────────────
    if (flow === FLOWS.UPDATE_DERS && step === STEPS.AWAITING_IMAGE) {
      return await handleDersStep(chatId, message, session);
    }

    // ── Broadcast wizard ─────────────────────────────────────
    if (flow === FLOWS.BROADCAST && step === STEPS.AWAITING_CONTENT) {
      return await handleBroadcastStep(chatId, message, session);
    }

    // ── Search Participant wizard ─────────────────────────────
    if (flow === FLOWS.SEARCH_PARTICIPANT && step === STEPS.AWAITING_SEARCH_QUERY) {
      return await handleSearchParticipantStep(chatId, message, session);
    }

  } catch (err) {
    logger.error('Admin wizard step error', {
      flow, step, message: err.message, stack: err.stack,
    });
    clearAdminSession(chatId);
    startFlow(chatId, FLOWS.IDLE, { panelMessageId });
    await showPanel(chatId, chatId,
      `❌ <b>Error:</b> ${escapeHtml(err.message)}\n\nReturning to home.`,
      homeKeyboard(),
      panelMessageId
    );
    return true;
  }

  return false;
}

// ─── Add Book wizard steps ────────────────────────────────────

async function handleAddBookStep(chatId, message, session) {
  const { step, panelMessageId, data } = session;

  // Step 1: Receive PDF
  if (step === STEPS.AWAITING_PDF) {
    const doc = message.document;
    if (!doc) {
      await showPanel(chatId, chatId,
        '➕ <b>Add Book</b>\n\n⚠ Please send a PDF file (not text or image).',
        cancelKeyboard(),
        panelMessageId
      );
      return true;
    }
    const mimeType = (doc.mime_type || '').toLowerCase();
    if (mimeType !== 'application/pdf' && !doc.file_name?.toLowerCase().endsWith('.pdf')) {
      await showPanel(chatId, chatId,
        '➕ <b>Add Book</b>\n\n⚠ That doesn\'t look like a PDF. Please send a PDF file.',
        cancelKeyboard(),
        panelMessageId
      );
      return true;
    }

    updateAdminSession(chatId, {
      step: STEPS.AWAITING_TITLE,
      data: { fileId: doc.file_id },
    });
    await showPanel(chatId, chatId,
      '➕ <b>Add Book</b>\n\nStep 2/4 — Enter the display title.\n\nExample: <code>رياض الصالحين</code>',
      cancelKeyboard(),
      panelMessageId
    );
    return true;
  }

  // Step 2: Receive title
  if (step === STEPS.AWAITING_TITLE) {
    const title = (message.text || '').trim();
    if (!title) {
      await showPanel(chatId, chatId,
        '➕ <b>Add Book</b>\n\n⚠ Title cannot be empty. Enter a display title:',
        cancelKeyboard(),
        panelMessageId
      );
      return true;
    }

    updateAdminSession(chatId, {
      step: STEPS.AWAITING_KEY,
      data: { title },
    });
    await showPanel(chatId, chatId,
      `➕ <b>Add Book</b>\n\nStep 3/4 — Enter a unique key (lowercase, no spaces).\n\nExample: <code>riyad</code>`,
      cancelKeyboard(),
      panelMessageId
    );
    return true;
  }

  // Step 3: Receive key
  if (step === STEPS.AWAITING_KEY) {
    const key = (message.text || '').trim().toLowerCase().replace(/\s+/g, '_');
    if (!key || !/^[a-z0-9_]+$/.test(key)) {
      await showPanel(chatId, chatId,
        '➕ <b>Add Book</b>\n\n⚠ Key must be lowercase letters, numbers, or underscores.\n\nExample: <code>riyad</code>',
        cancelKeyboard(),
        panelMessageId
      );
      return true;
    }

    const taken = await adminPanelService.isKeyTaken(key);
    if (taken) {
      await showPanel(chatId, chatId,
        `➕ <b>Add Book</b>\n\n⚠ Key <code>${escapeHtml(key)}</code> is already in use. Choose a different key:`,
        cancelKeyboard(),
        panelMessageId
      );
      return true;
    }

    updateAdminSession(chatId, {
      step: STEPS.AWAITING_ORDER,
      data: { key },
    });
    await showPanel(chatId, chatId,
      '➕ <b>Add Book</b>\n\nStep 4/4 — Enter display order (number, e.g. <code>1</code>).\n\nSend <code>0</code> to skip.',
      cancelKeyboard(),
      panelMessageId
    );
    return true;
  }

  // Step 4: Receive sort order → save
  if (step === STEPS.AWAITING_ORDER) {
    const raw = (message.text || '').trim();
    const sortOrder = raw === '' || raw === '0' ? 0 : parseInt(raw, 10);
    const order = isNaN(sortOrder) ? 0 : sortOrder;

    // Re-read session for complete data
    const freshSession = getAdminSession(chatId);
    const d = { ...freshSession.data, sortOrder: order };

    const result = await adminPanelService.addBook({
      name: d.key,
      caption: d.title,
      telegramFileId: d.fileId,
      sortOrder: d.sortOrder,
    });

    clearAdminSession(chatId);
    startFlow(chatId, FLOWS.IDLE, { panelMessageId });

    if (!result.ok) {
      await showPanel(chatId, chatId,
        `❌ Failed to add book: ${result.reason === 'duplicate_key' ? 'Key already exists.' : 'Database error.'}`,
        backHomeKeyboard('ap:resources'),
        panelMessageId
      );
      return true;
    }

    await showPanel(chatId, chatId,
      `✅ <b>Book added successfully.</b>\n\n` +
      `📖 Title: <b>${escapeHtml(d.title)}</b>\n` +
      `🔑 Key: <code>${escapeHtml(d.key)}</code>\n` +
      `📊 Order: <b>${order}</b>`,
      backHomeKeyboard('ap:resources'),
      panelMessageId
    );
    return true;
  }

  return false;
}

// ─── Rename Book wizard step ──────────────────────────────────

async function handleRenameStep(chatId, message, session) {
  const { panelMessageId, data } = session;
  const newTitle = (message.text || '').trim();

  if (!newTitle) {
    await showPanel(chatId, chatId,
      '✏ <b>Rename Book</b>\n\n⚠ Title cannot be empty. Enter new title:',
      cancelKeyboard(),
      panelMessageId
    );
    return true;
  }

  const result = await adminPanelService.renameBook(data.resourceId, newTitle);
  clearAdminSession(chatId);
  startFlow(chatId, FLOWS.IDLE, { panelMessageId });

  if (!result.ok) {
    await showPanel(chatId, chatId,
      '❌ Resource not found.',
      backHomeKeyboard('ap:resources'),
      panelMessageId
    );
    return true;
  }

  await showPanel(chatId, chatId,
    `✅ <b>Book renamed successfully.</b>\n\nNew title: <b>${escapeHtml(newTitle)}</b>`,
    backHomeKeyboard('ap:resources'),
    panelMessageId
  );
  return true;
}

// ─── Update Ders Program wizard step ─────────────────────────

async function handleDersStep(chatId, message, session) {
  const { panelMessageId } = session;

  // Accept either a photo array (compressed) or a document (uncompressed)
  let fileId = null;

  if (message.photo && message.photo.length > 0) {
    // Telegram sends an array of sizes; last = largest
    fileId = message.photo[message.photo.length - 1].file_id;
  } else if (message.document) {
    const mime = (message.document.mime_type || '').toLowerCase();
    if (mime.startsWith('image/')) {
      fileId = message.document.file_id;
    }
  }

  if (!fileId) {
    await showPanel(chatId, chatId,
      '🖼 <b>Update Ders Program</b>\n\n⚠ Please send an image (photo or image document).',
      cancelKeyboard(),
      panelMessageId
    );
    return true;
  }

  const result = await adminPanelService.updateDersProgram(fileId);
  clearAdminSession(chatId);
  startFlow(chatId, FLOWS.IDLE, { panelMessageId });

  if (!result.ok) {
    await showPanel(chatId, chatId,
      '❌ Failed to update Ders Program.',
      backHomeKeyboard('ap:resources'),
      panelMessageId
    );
    return true;
  }

  await showPanel(chatId, chatId,
    '✅ <b>Ders Program updated successfully.</b>',
    backHomeKeyboard('ap:resources'),
    panelMessageId
  );
  return true;
}

// ─── Broadcast wizard step ────────────────────────────────────

async function handleBroadcastStep(chatId, message, session) {
  const { panelMessageId, data } = session;
  const { broadcastType } = data;

  let content = '';
  let fileId = null;
  let previewText = '';

  if (broadcastType === 'text') {
    content = (message.text || '').trim();
    if (!content) {
      await showPanel(chatId, chatId,
        '📢 <b>Broadcast</b>\n\n⚠ Message cannot be empty. Send the text:',
        cancelKeyboard(),
        panelMessageId
      );
      return true;
    }
    previewText = `📢 <b>Broadcast Preview</b>\n\n${escapeHtml(content)}`;

  } else if (broadcastType === 'photo') {
    if (!message.photo || !message.photo.length) {
      await showPanel(chatId, chatId,
        '📢 <b>Broadcast</b>\n\n⚠ Please send a photo.',
        cancelKeyboard(),
        panelMessageId
      );
      return true;
    }
    fileId = message.photo[message.photo.length - 1].file_id;
    content = (message.caption || '').trim();
    previewText = `📢 <b>Broadcast Preview — Photo</b>\n\nCaption: ${escapeHtml(content) || '(none)'}`;

  } else if (broadcastType === 'document') {
    if (!message.document) {
      await showPanel(chatId, chatId,
        '📢 <b>Broadcast</b>\n\n⚠ Please send a document.',
        cancelKeyboard(),
        panelMessageId
      );
      return true;
    }
    fileId = message.document.file_id;
    content = (message.caption || '').trim();
    previewText = `📢 <b>Broadcast Preview — Document</b>\n\nCaption: ${escapeHtml(content) || '(none)'}`;
  }

  updateAdminSession(chatId, {
    step: STEPS.AWAITING_BROADCAST_CONFIRM,
    data: { broadcastContent: content, broadcastFileId: fileId },
  });

  await showPanel(chatId, chatId,
    `${previewText}\n\n---\n<b>Send to all users?</b>`,
    broadcastConfirmKeyboard(),
    panelMessageId
  );
  return true;
}

// ─── Exports ──────────────────────────────────────────────────

module.exports = {
  handleAdminEntry,
  handleAdminCallback,
  handleAdminMessage,
};
