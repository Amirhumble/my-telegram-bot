'use strict';

const adminService = require('../../services/admin');
const referralsService = require('../../services/referrals');
const telegram = require('../../services/telegram');
const logger = require('../../utils/logger');

/**
 * Admin-only commands. Silently ignore non-admins.
 */
async function handleAdminCommand(message) {
  const chatId = message.chat.id;
  const text = (message.text || '').trim();

  if (!adminService.isAdmin(chatId)) {
    // Do not reveal that admin commands exist
    return false;
  }

  if (text === '/admin_stats' || text.startsWith('/admin_stats@')) {
    const stats = await adminService.getStats();
    await telegram.sendMessage(chatId, adminService.formatStats(stats));
    return true;
  }

  if (text === '/admin_top' || text.startsWith('/admin_top@')) {
    const top = await referralsService.getTopReferrers(20);
    await telegram.sendMessage(chatId, adminService.formatTop(top));
    return true;
  }

  if (text.startsWith('/admin_user')) {
    const parts = text.split(/\s+/);
    const targetId = parts[1];

    if (!targetId || !/^\d+$/.test(targetId)) {
      await telegram.sendMessage(
        chatId,
        'Usage: <code>/admin_user &lt;telegram_id&gt;</code>'
      );
      return true;
    }

    const report = await adminService.getUserReport(targetId);
    if (!report) {
      await telegram.sendMessage(chatId, `User <code>${targetId}</code> not found.`);
      return true;
    }

    await telegram.sendMessage(chatId, report);
    return true;
  }

  if (text.startsWith('/admin_broadcast')) {
    const body = text.replace(/^\/admin_broadcast(@\w+)?\s*/i, '').trim();

    if (!body) {
      await telegram.sendMessage(
        chatId,
        'Usage: <code>/admin_broadcast Your message here</code>'
      );
      return true;
    }

    await telegram.sendMessage(chatId, '📣 Broadcasting… this may take a moment.');
    const result = await adminService.broadcast(body);
    logger.info('Broadcast complete', result);
    await telegram.sendMessage(
      chatId,
      `📣 Broadcast done.\nSent: <b>${result.sent}</b>\nFailed: <b>${result.failed}</b>\nTotal: <b>${result.total}</b>`
    );
    return true;
  }

  return false;
}

module.exports = {
  handleAdminCommand,
};
