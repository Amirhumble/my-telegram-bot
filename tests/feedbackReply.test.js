'use strict';

/**
 * Admin "Reply to Feedback" tests.
 *
 * Dummy env is set first so requiring services does not fail validation.
 * Telegram + feedback DB calls are mocked — no live API or database.
 */

process.env.TOKEN = 'test-token';
process.env.SERVER_URL = 'https://example.com';
process.env.ADMIN_CHAT_ID = '111';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
process.env.CHANNEL_ID = '-100';
process.env.BOT_USERNAME = 'testbot';
process.env.LOG_LEVEL = 'error';

const assert = require('assert');

const telegram = require('../src/services/telegram');
const feedbackService = require('../src/services/feedback');
const adminService = require('../src/services/admin');
const {
  FLOWS,
  STEPS,
  getAdminSession,
} = require('../src/utils/adminSession');
const { clearAllSessions } = require('../src/utils/session');
const {
  handleFeedbackReplyCallback,
  maybeHandlePendingAdminReply,
  parseFeedbackReplyCallback,
  replyCancelKeyboard,
  isReplyFlow,
  CANCEL_DATA,
} = require('../src/bot/handlers/feedbackReply');

const ADMIN_ID = 111;
const USER_ID = 222;
const FEEDBACK_ID = 42;

const sent = [];
const answered = [];
const editedMarkups = [];

function resetSpies() {
  sent.length = 0;
  answered.length = 0;
  editedMarkups.length = 0;
  clearAllSessions();
}

telegram.sendMessage = async (chatId, text, extra = {}) => {
  sent.push({ chatId, text, extra });
  return { ok: true, result: { message_id: 9000 + sent.length } };
};
telegram.answerCallbackQuery = async (id, text = '', showAlert = false) => {
  answered.push({ id, text, showAlert });
  return { ok: true };
};
telegram.editMessageReplyMarkup = async (chatId, messageId, replyMarkup) => {
  editedMarkups.push({ chatId, messageId, replyMarkup });
  return { ok: true };
};

const sampleFeedback = {
  id: FEEDBACK_ID,
  telegram_id: USER_ID,
  username: 'alice',
  message: 'The bot is great',
  created_at: '2026-08-12T00:00:00Z',
};

const realSendReplyToUser = feedbackService.sendReplyToUser;

let feedbackStore = { [FEEDBACK_ID]: { ...sampleFeedback } };
let sendReplyImpl = async (targetUserId, replyText) => {
  sent.push({
    chatId: targetUserId,
    text: feedbackService.formatUserReplyMessage(replyText),
    extra: { via: 'sendReplyToUser' },
  });
  return { ok: true };
};

feedbackService.getFeedbackById = async (id) => {
  const numericId = Number(id);
  return feedbackStore[numericId] || null;
};
feedbackService.sendReplyToUser = async (targetUserId, replyText) =>
  sendReplyImpl(targetUserId, replyText);

function adminCallback(data) {
  return {
    id: 'cb-1',
    data,
    from: { id: ADMIN_ID },
    message: { chat: { id: ADMIN_ID }, message_id: 50 },
  };
}

function adminMessage(text) {
  return {
    chat: { id: ADMIN_ID },
    from: { id: ADMIN_ID },
    text,
  };
}

function nonAdminCallback(data) {
  return {
    id: 'cb-2',
    data,
    from: { id: 999 },
    message: { chat: { id: 999 }, message_id: 51 },
  };
}

async function run(name, fn) {
  resetSpies();
  feedbackStore = { [FEEDBACK_ID]: { ...sampleFeedback } };
  sendReplyImpl = async (targetUserId, replyText) => {
    sent.push({
      chatId: targetUserId,
      text: feedbackService.formatUserReplyMessage(replyText),
      extra: { via: 'sendReplyToUser' },
    });
    return { ok: true };
  };
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err.message}`);
    throw err;
  }
}

async function main() {
  console.log('feedback reply tests\n');

  // ── Pure helpers ──────────────────────────────────────────
  await run('parseFeedbackReplyCallback: reply id', () => {
    assert.deepStrictEqual(parseFeedbackReplyCallback('feedback:reply:42'), {
      action: 'reply',
      feedbackId: '42',
    });
  });

  await run('parseFeedbackReplyCallback: cancel', () => {
    assert.deepStrictEqual(parseFeedbackReplyCallback('feedback:reply:cancel'), {
      action: 'cancel',
    });
  });

  await run('parseFeedbackReplyCallback: invalid / unrelated', () => {
    assert.strictEqual(parseFeedbackReplyCallback('ap:home'), null);
    assert.deepStrictEqual(parseFeedbackReplyCallback('feedback:reply:abc'), {
      action: 'invalid',
    });
    assert.strictEqual(parseFeedbackReplyCallback(null), null);
  });

  await run('reply button callback_data contains feedback id', () => {
    const kb = feedbackService.replyButtonKeyboard(77);
    assert.strictEqual(kb.inline_keyboard[0][0].callback_data, 'feedback:reply:77');
    assert.ok(kb.inline_keyboard[0][0].text.includes('Reply'));
  });

  await run('cancel keyboard uses feedback:reply:cancel', () => {
    const kb = replyCancelKeyboard();
    assert.strictEqual(kb.inline_keyboard[0][0].callback_data, CANCEL_DATA);
    assert.strictEqual(kb.inline_keyboard[0][0].text, '❌ Cancel');
  });

  await run('formatUserReplyMessage uses Amharic header and escapes HTML', () => {
    const msg = feedbackService.formatUserReplyMessage('hello <b>x</b> & y');
    assert.ok(msg.startsWith('<b>ለእርስዎ የተላከ ምላሽ</b>'));
    assert.ok(msg.includes('hello &lt;b&gt;x&lt;/b&gt; &amp; y'));
    assert.ok(!msg.includes('111'), 'must not expose admin id');
  });

  await run('isBlockedTelegramError detects 403 / blocked', () => {
    assert.strictEqual(
      feedbackService.isBlockedTelegramError({
        details: { error_code: 403, description: 'Forbidden: bot was blocked by the user' },
      }),
      true
    );
    assert.strictEqual(
      feedbackService.isBlockedTelegramError({ message: 'network timeout' }),
      false
    );
  });

  await run('sendReplyToUser rejects empty and too-long text', async () => {
    const original = telegram.sendMessage;
    let called = false;
    telegram.sendMessage = async () => {
      called = true;
    };
    try {
      const empty = await realSendReplyToUser(USER_ID, '   ');
      assert.deepStrictEqual(empty, { ok: false, reason: 'empty' });
      const long = await realSendReplyToUser(USER_ID, 'x'.repeat(4001));
      assert.deepStrictEqual(long, { ok: false, reason: 'too_long' });
      assert.strictEqual(called, false);
    } finally {
      telegram.sendMessage = original;
    }
  });

  await run('sendReplyToUser maps blocked Telegram errors', async () => {
    const original = telegram.sendMessage;
    telegram.sendMessage = async () => {
      const err = new Error('Telegram API error: Forbidden');
      err.details = { error_code: 403, description: 'Forbidden: bot was blocked by the user' };
      throw err;
    };
    try {
      const result = await realSendReplyToUser(USER_ID, 'hello');
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.reason, 'blocked');
    } finally {
      telegram.sendMessage = original;
    }
  });

  await run('isAdmin only accepts ADMIN_CHAT_ID', () => {
    assert.strictEqual(adminService.isAdmin(ADMIN_ID), true);
    assert.strictEqual(adminService.isAdmin(999), false);
    assert.strictEqual(adminService.isAdmin(USER_ID), false);
  });

  // ── Authorization ─────────────────────────────────────────
  await run('non-admin Reply click is rejected', async () => {
    await handleFeedbackReplyCallback(nonAdminCallback('feedback:reply:42'));
    assert.ok(answered.length >= 1, 'callback must be answered');
    assert.strictEqual(getAdminSession(999), null);
    const userSends = sent.filter((s) => s.extra?.via === 'sendReplyToUser');
    assert.strictEqual(userSends.length, 0);
  });

  // ── Reply button ──────────────────────────────────────────
  await run('admin Reply click starts flow and prompts', async () => {
    await handleFeedbackReplyCallback(adminCallback('feedback:reply:42'));
    assert.ok(answered.some((a) => a.id === 'cb-1'), 'callback answered immediately');
    const session = getAdminSession(ADMIN_ID);
    assert.ok(isReplyFlow(session));
    assert.strictEqual(session.data.feedbackId, FEEDBACK_ID);
    assert.strictEqual(session.data.targetUserId, USER_ID);
    const prompt = sent.find((s) => s.text === 'መልስዎን ይጻፉ፦');
    assert.ok(prompt, 'admin is prompted');
    assert.strictEqual(
      prompt.extra.reply_markup.inline_keyboard[0][0].callback_data,
      CANCEL_DATA
    );
  });

  await run('Reply on missing feedback does not start flow', async () => {
    await handleFeedbackReplyCallback(adminCallback('feedback:reply:9999'));
    assert.strictEqual(getAdminSession(ADMIN_ID), null);
    assert.ok(sent.some((s) => s.text.includes('አልተገኘም')));
  });

  await run('duplicate Reply click replaces previous state', async () => {
    feedbackStore[43] = {
      id: 43,
      telegram_id: 333,
      username: 'bob',
      message: 'second',
      created_at: '2026-08-12T00:00:00Z',
    };
    await handleFeedbackReplyCallback(adminCallback('feedback:reply:42'));
    await handleFeedbackReplyCallback(adminCallback('feedback:reply:43'));
    const session = getAdminSession(ADMIN_ID);
    assert.ok(isReplyFlow(session));
    assert.strictEqual(session.data.feedbackId, 43);
    assert.strictEqual(session.data.targetUserId, 333);
    const prompts = sent.filter((s) => s.text === 'መልስዎን ይጻፉ፦');
    assert.strictEqual(prompts.length, 2);
  });

  // ── Send reply ────────────────────────────────────────────
  await run('admin text is delivered to the user and state is cleared', async () => {
    await handleFeedbackReplyCallback(adminCallback('feedback:reply:42'));
    const handled = await maybeHandlePendingAdminReply(adminMessage('እናመሰግናለን፣ ተስተካክሏል።'));
    assert.strictEqual(handled, true);
    const toUser = sent.filter((s) => s.chatId === USER_ID);
    assert.strictEqual(toUser.length, 1);
    assert.ok(toUser[0].text.includes('ለእርስዎ የተላከ ምላሽ'));
    assert.ok(toUser[0].text.includes('እናመሰግናለን'));
    assert.ok(!toUser[0].text.includes(String(ADMIN_ID)));
    assert.ok(sent.some((s) => s.chatId === ADMIN_ID && s.text === '✅ መልሱ ተልኳል።'));
    assert.strictEqual(getAdminSession(ADMIN_ID), null);
  });

  await run('empty text keeps reply state', async () => {
    await handleFeedbackReplyCallback(adminCallback('feedback:reply:42'));
    const handled = await maybeHandlePendingAdminReply(adminMessage('   '));
    assert.strictEqual(handled, true);
    assert.ok(isReplyFlow(getAdminSession(ADMIN_ID)));
    assert.strictEqual(sent.filter((s) => s.chatId === USER_ID).length, 0);
    assert.ok(sent.some((s) => s.text.includes('ባዶ')));
  });

  await run('non-text message keeps reply state', async () => {
    await handleFeedbackReplyCallback(adminCallback('feedback:reply:42'));
    const handled = await maybeHandlePendingAdminReply({
      chat: { id: ADMIN_ID },
      from: { id: ADMIN_ID },
      photo: [{ file_id: 'abc' }],
    });
    assert.strictEqual(handled, true);
    assert.ok(isReplyFlow(getAdminSession(ADMIN_ID)));
    assert.strictEqual(sent.filter((s) => s.chatId === USER_ID).length, 0);
  });

  // ── Cancel ────────────────────────────────────────────────
  await run('Cancel button clears state without sending to user', async () => {
    await handleFeedbackReplyCallback(adminCallback('feedback:reply:42'));
    await handleFeedbackReplyCallback(adminCallback('feedback:reply:cancel'));
    assert.strictEqual(getAdminSession(ADMIN_ID), null);
    assert.strictEqual(sent.filter((s) => s.chatId === USER_ID).length, 0);
    assert.ok(sent.some((s) => s.text.includes('ተሰርዟል')));
  });

  await run('/cancel text clears reply state', async () => {
    await handleFeedbackReplyCallback(adminCallback('feedback:reply:42'));
    const handled = await maybeHandlePendingAdminReply(adminMessage('/cancel'));
    assert.strictEqual(handled, true);
    assert.strictEqual(getAdminSession(ADMIN_ID), null);
    assert.strictEqual(sent.filter((s) => s.chatId === USER_ID).length, 0);
  });

  // ── Telegram failure ──────────────────────────────────────
  await run('Telegram failure keeps reply state so admin can retry', async () => {
    sendReplyImpl = async () => ({ ok: false, reason: 'telegram_error' });
    await handleFeedbackReplyCallback(adminCallback('feedback:reply:42'));
    const handled = await maybeHandlePendingAdminReply(adminMessage('try again please'));
    assert.strictEqual(handled, true);
    assert.ok(isReplyFlow(getAdminSession(ADMIN_ID)), 'state must be kept');
    assert.ok(sent.some((s) => s.text.includes('መላክ አልተቻለም')));
  });

  await run('blocked user keeps reply state', async () => {
    sendReplyImpl = async () => ({ ok: false, reason: 'blocked' });
    await handleFeedbackReplyCallback(adminCallback('feedback:reply:42'));
    await maybeHandlePendingAdminReply(adminMessage('hello'));
    assert.ok(isReplyFlow(getAdminSession(ADMIN_ID)));
    assert.ok(sent.some((s) => s.text.includes('ታግዷል')));
  });

  // ── Feedback deleted after Reply click ────────────────────
  await run('feedback deleted before send clears stale state', async () => {
    await handleFeedbackReplyCallback(adminCallback('feedback:reply:42'));
    delete feedbackStore[FEEDBACK_ID];
    await maybeHandlePendingAdminReply(adminMessage('still here'));
    assert.strictEqual(getAdminSession(ADMIN_ID), null);
    assert.ok(sent.some((s) => s.text.includes('አልተገኘም')));
    assert.strictEqual(sent.filter((s) => s.chatId === USER_ID).length, 0);
  });

  // ── Pending interceptor ignores non-admins / idle admins ──
  await run('maybeHandlePendingAdminReply ignores users with no state', async () => {
    const handled = await maybeHandlePendingAdminReply({
      chat: { id: USER_ID },
      from: { id: USER_ID },
      text: 'hello',
    });
    assert.strictEqual(handled, false);
  });

  await run('admin session FLOWS/STEPS include reply_feedback', () => {
    assert.strictEqual(FLOWS.REPLY_FEEDBACK, 'reply_feedback');
    assert.strictEqual(STEPS.AWAITING_REPLY, 'awaiting_reply');
  });

  console.log('\nall tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
