'use strict';

const usersService = require('./users');
const referralsService = require('./referrals');
const feedbackService = require('./feedback');
const telegram = require('./telegram');
const { ADMIN_CHAT_ID } = require('../config/env');
const logger = require('../utils/logger');
const { escapeHtml } = require('./feedback');

function isAdmin(chatId) {
  return String(chatId) === String(ADMIN_CHAT_ID);
}

async function getStats() {
  const [totalUsers, totalReferrals, verifiedReferrals, feedbackCount] =
    await Promise.all([
      usersService.countUsers(),
      referralsService.countReferrals(),
      referralsService.countVerifiedReferrals(),
      feedbackService.countFeedbacks(),
    ]);

  return {
    totalUsers,
    totalReferrals,
    verifiedReferrals,
    feedbackCount,
  };
}

function formatStats(stats) {
  return (
    `📊 <b>Admin Stats</b>\n\n` +
    `👥 Total users: <b>${stats.totalUsers}</b>\n` +
    `🔗 Total referrals: <b>${stats.totalReferrals}</b>\n` +
    `✅ Verified referrals: <b>${stats.verifiedReferrals}</b>\n` +
    `📩 Feedback count: <b>${stats.feedbackCount}</b>`
  );
}

function formatTop(list) {
  if (!list.length) {
    return '🏆 <b>Top Referrers</b>\n\nNo verified referrals yet.';
  }

  const lines = list.map((row, i) => {
    const name = row.first_name || '—';
    const uname = row.username ? `@${row.username}` : 'no username';
    return (
      `${i + 1}. <b>${escapeHtml(name)}</b> (${escapeHtml(uname)})\n` +
      `    ID: <code>${row.telegram_id}</code> — ✅ ${row.verified_count}`
    );
  });

  return `🏆 <b>Top Referrers</b> (verified only)\n\n${lines.join('\n\n')}`;
}

async function getUserReport(telegramId) {
  const user = await usersService.getUser(telegramId);
  if (!user) {
    return null;
  }

  const refStats = await referralsService.getUserReferralStats(telegramId);

  return (
    `👤 <b>User Report</b>\n\n` +
    `<b>Name:</b> ${escapeHtml(user.first_name || '—')}\n` +
    `<b>Username:</b> ${user.username ? '@' + escapeHtml(user.username) : '—'}\n` +
    `<b>Telegram ID:</b> <code>${user.telegram_id}</code>\n` +
    `<b>Joined channel:</b> ${user.joined_channel ? 'Yes' : 'No'}\n` +
    `<b>Registered:</b> ${user.created_at || '—'}\n\n` +
    `<b>Referrals made:</b> ${refStats.total} (verified: ${refStats.verified})\n` +
    `<b>Referred by:</b> ${refStats.referred_by ? `<code>${refStats.referred_by}</code>` : '—'}\n` +
    `<b>Own referral verified:</b> ${refStats.own_referral_verified ? 'Yes' : 'No'}`
  );
}

/**
 * Broadcast a plain-text message to all known users.
 * Returns { sent, failed }.
 */
async function broadcast(message) {
  const ids = await usersService.getAllUserIds();
  let sent = 0;
  let failed = 0;

  for (const id of ids) {
    try {
      await telegram.sendMessage(id, message, { parse_mode: 'HTML' });
      sent += 1;
      // Gentle rate limit (~25 msg/sec safe under Telegram limits)
      await telegram.sleep(40);
    } catch (err) {
      failed += 1;
      logger.warn('Broadcast failed for user', { id, message: err.message });
    }
  }

  return { sent, failed, total: ids.length };
}

module.exports = {
  isAdmin,
  getStats,
  formatStats,
  formatTop,
  getUserReport,
  broadcast,
};
