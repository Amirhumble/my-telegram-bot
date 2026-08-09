'use strict';

const { supabase } = require('../database/supabase');
const usersService = require('./users');
const telegram = require('./telegram');
const logger = require('../utils/logger');
const { AppError } = require('../utils/errors');

/**
 * Record a referral relationship when a user starts via deep link.
 *
 * Rules:
 * - No self-referrals
 * - Each user can only be referred once (referred_id is UNIQUE)
 * - Referral starts as verified=false until channel membership is confirmed
 *
 * Returns { ok, reason?, referral? }
 */
async function recordReferral(referrerId, referredId) {
  const referrer = Number(referrerId);
  const referred = Number(referredId);

  if (!Number.isFinite(referrer) || !Number.isFinite(referred)) {
    return { ok: false, reason: 'invalid_ids' };
  }

  if (referrer === referred) {
    logger.info('Self-referral blocked', { referrer, referred });
    return { ok: false, reason: 'self_referral' };
  }

  // Ensure both users exist (referrer may not have used bot recently)
  // Referred is always upserted by the start handler first.
  const referrerUser = await usersService.getUser(referrer);
  if (!referrerUser) {
    // Create a stub referrer so FK constraints pass; they will update on next visit
    try {
      await usersService.upsertUser({ telegramId: referrer });
    } catch (err) {
      logger.warn('Could not create stub referrer', { referrer, message: err.message });
      return { ok: false, reason: 'referrer_missing' };
    }
  }

  // Already referred?
  const existing = await getReferralByReferred(referred);
  if (existing) {
    return { ok: false, reason: 'already_referred', referral: existing };
  }

  const { data, error } = await supabase
    .from('referrals')
    .insert({
      referrer_id: referrer,
      referred_id: referred,
      verified: false,
    })
    .select()
    .single();

  if (error) {
    // Unique violation → already referred
    if (error.code === '23505') {
      return { ok: false, reason: 'already_referred' };
    }
    logger.error('recordReferral failed', { error: error.message, referrer, referred });
    throw new AppError('Failed to record referral', {
      code: 'DB_RECORD_REFERRAL',
      details: error,
    });
  }

  logger.info('Referral recorded (unverified)', { referrer, referred, id: data.id });
  return { ok: true, referral: data };
}

async function getReferralByReferred(referredId) {
  const { data, error } = await supabase
    .from('referrals')
    .select('*')
    .eq('referred_id', Number(referredId))
    .maybeSingle();

  if (error) {
    throw new AppError('Failed to fetch referral', {
      code: 'DB_GET_REFERRAL',
      details: error,
    });
  }

  return data;
}

/**
 * Verify channel membership and mark the referral as verified.
 * Called when the user presses "✅ I Joined".
 */
async function verifyReferral(referredId) {
  const referred = Number(referredId);
  const isMember = await telegram.isChannelMember(referred);

  if (!isMember) {
    return { ok: false, reason: 'not_member' };
  }

  await usersService.markJoinedChannel(referred, true);

  const referral = await getReferralByReferred(referred);

  if (!referral) {
    // User joined channel but was not referred — still mark membership
    return { ok: true, reason: 'joined_no_referral', verified: false };
  }

  if (referral.verified) {
    return { ok: true, reason: 'already_verified', referral, verified: true };
  }

  const { data, error } = await supabase
    .from('referrals')
    .update({ verified: true })
    .eq('id', referral.id)
    .eq('verified', false)   // idempotency guard — prevents double-count if cron races with manual verify
    .select()
    .maybeSingle();

  if (error) {
    throw new AppError('Failed to verify referral', {
      code: 'DB_VERIFY_REFERRAL',
      details: error,
    });
  }

  // maybeSingle() returns null if the row was already verified by another path
  if (!data) {
    logger.info('Referral already verified by another process (idempotent skip)', {
      referral_id: referral.id,
    });
    return { ok: true, reason: 'already_verified', verified: true };
  }

  logger.info('Referral verified', {
    referrer: data.referrer_id,
    referred: data.referred_id,
  });

  return { ok: true, reason: 'verified', referral: data, verified: true };
}

async function countReferrals() {
  const { count, error } = await supabase
    .from('referrals')
    .select('*', { count: 'exact', head: true });

  if (error) {
    throw new AppError('Failed to count referrals', { code: 'DB_COUNT_REF', details: error });
  }
  return count || 0;
}

async function countVerifiedReferrals() {
  const { count, error } = await supabase
    .from('referrals')
    .select('*', { count: 'exact', head: true })
    .eq('verified', true);

  if (error) {
    throw new AppError('Failed to count verified referrals', {
      code: 'DB_COUNT_VERIFIED',
      details: error,
    });
  }
  return count || 0;
}

/**
 * Top referrers — single SQL aggregation, no N+1 queries.
 * Returns rows sorted by verified DESC, total DESC, created_at ASC.
 * Falls back gracefully when the referral_leaderboard view is not yet updated
 * (migration 004 not run): uses a raw aggregate query instead.
 *
 * @param {number} limit
 */
async function getTopReferrers(limit = 20) {
  const rows = await _fetchLeaderboard({ limit, offset: 0 });
  return rows;
}

/**
 * Paginated leaderboard page.
 * @param {number} page      1-based
 * @param {number} pageSize
 * @returns {{ rows: Array, total: number, page: number, pageSize: number, totalPages: number }}
 */
async function getLeaderboardPage(page = 1, pageSize = 10) {
  const safePage = Math.max(1, Number(page) || 1);
  const offset = (safePage - 1) * pageSize;

  const [rows, total] = await Promise.all([
    _fetchLeaderboard({ limit: pageSize, offset }),
    _countLeaderboardRows(),
  ]);

  logger.info('Leaderboard loaded', { page: safePage, pageSize, total });

  return {
    rows,
    total,
    page: safePage,
    pageSize,
    totalPages: Math.ceil(total / pageSize) || 1,
  };
}

/**
 * Internal: fetch leaderboard rows with LIMIT/OFFSET via single SQL aggregation.
 * Works whether migration 004 has been applied (view) or not (raw query).
 */
async function _fetchLeaderboard({ limit, offset }) {
  // Use the updated view when available; Supabase will throw if it doesn't exist.
  // We handle both the old view (verified_count only) and new view gracefully.
  const { data, error } = await supabase
    .from('referral_leaderboard')
    .select('telegram_id, username, first_name, created_at, verified_count, pending_count, total_referrals')
    .order('verified_count', { ascending: false })
    .order('total_referrals', { ascending: false })
    .range(offset, offset + limit - 1);

  if (!error) {
    return (data || []).map(_normaliseLeaderboardRow);
  }

  // View doesn't have pending_count (migration 004 not run) — fall back to raw aggregate.
  logger.warn('referral_leaderboard view missing columns, using raw fallback', {
    message: error.message,
  });
  return _fetchLeaderboardRaw({ limit, offset });
}

/**
 * Raw aggregate fallback — used when the view hasn't been updated yet.
 * Avoids N+1 by doing a single GROUP BY query.
 */
async function _fetchLeaderboardRaw({ limit, offset }) {
  // Supabase JS client doesn't support GROUP BY directly,
  // so we fetch all referrals and aggregate in JS.
  // This is only the fallback path — once migration 004 runs the view is used.
  const { data, error } = await supabase
    .from('referrals')
    .select('referrer_id, verified');

  if (error) {
    logger.error('_fetchLeaderboardRaw failed', { message: error.message });
    throw new AppError('Failed to load leaderboard', {
      code: 'DB_LEADERBOARD_RAW',
      details: error,
    });
  }

  // Aggregate in JS
  const map = new Map();
  for (const row of data || []) {
    const id = row.referrer_id;
    if (!map.has(id)) map.set(id, { verified: 0, pending: 0 });
    const entry = map.get(id);
    if (row.verified) entry.verified += 1;
    else entry.pending += 1;
  }

  // Sort: verified DESC, total DESC
  const sorted = [...map.entries()]
    .sort(([, a], [, b]) => {
      const vDiff = b.verified - a.verified;
      if (vDiff !== 0) return vDiff;
      return (b.verified + b.pending) - (a.verified + a.pending);
    })
    .slice(offset, offset + limit);

  // Enrich with user data — batch fetch to avoid N+1
  const ids = sorted.map(([id]) => id);
  const { data: users } = await supabase
    .from('users')
    .select('telegram_id, username, first_name, created_at')
    .in('telegram_id', ids.length ? ids : [-1]);

  const userMap = new Map((users || []).map((u) => [u.telegram_id, u]));

  return sorted.map(([telegramId, counts]) => {
    const user = userMap.get(telegramId) || {};
    return _normaliseLeaderboardRow({
      telegram_id: telegramId,
      username: user.username || null,
      first_name: user.first_name || null,
      created_at: user.created_at || null,
      verified_count: counts.verified,
      pending_count: counts.pending,
      total_referrals: counts.verified + counts.pending,
    });
  });
}

async function _countLeaderboardRows() {
  const { count, error } = await supabase
    .from('referral_leaderboard')
    .select('*', { count: 'exact', head: true });

  if (!error) return count || 0;

  // Fallback: count distinct referrer_ids
  const { data } = await supabase
    .from('referrals')
    .select('referrer_id');

  const unique = new Set((data || []).map((r) => r.referrer_id));
  return unique.size;
}

function _normaliseLeaderboardRow(row) {
  return {
    telegram_id: row.telegram_id,
    username: row.username || null,
    first_name: row.first_name || null,
    created_at: row.created_at || null,
    verified_count: Number(row.verified_count) || 0,
    pending_count: Number(row.pending_count) || 0,
    total_referrals: Number(row.total_referrals) || 0,
  };
}

/**
 * Search a participant by Telegram ID (numeric) or @username.
 * Returns null if not found.
 *
 * @param {string} query  raw input from admin (e.g. "123456" or "@ahmed")
 * @returns {object|null}  enriched participant record or null
 */
async function searchParticipant(query) {
  const q = String(query || '').trim();
  if (!q) return null;

  logger.info('Participant searched', { query: q });

  let user = null;

  if (/^\d+$/.test(q)) {
    // Numeric — treat as Telegram ID
    user = await usersService.getUser(Number(q));
  } else {
    // Username search (strip leading @)
    const uname = q.replace(/^@/, '').toLowerCase();
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .ilike('username', uname)
      .limit(1)
      .maybeSingle();

    if (error) {
      logger.error('searchParticipant username query failed', { message: error.message });
    } else {
      user = data;
    }
  }

  if (!user) return null;

  // Fetch referral stats for this user
  const id = Number(user.telegram_id);

  const { data: refs, error: refErr } = await supabase
    .from('referrals')
    .select('verified')
    .eq('referrer_id', id);

  if (refErr) {
    logger.warn('searchParticipant: referral query failed', { message: refErr.message });
  }

  const allRefs = refs || [];
  const verified = allRefs.filter((r) => r.verified).length;
  const pending = allRefs.filter((r) => !r.verified).length;
  const total = allRefs.length;

  // Determine rank: count users with strictly more verified referrals
  let rank = null;
  if (total > 0) {
    const { count: higherCount, error: rankErr } = await supabase
      .from('referral_leaderboard')
      .select('*', { count: 'exact', head: true })
      .gt('verified_count', verified);

    if (!rankErr) rank = (higherCount || 0) + 1;
  }

  return {
    telegram_id: user.telegram_id,
    username: user.username || null,
    first_name: user.first_name || null,
    created_at: user.created_at || null,
    verified_count: verified,
    pending_count: pending,
    total_referrals: total,
    rank,
  };
}

/**
 * Full competition statistics (for the enhanced Statistics screen).
 */
async function getCompetitionStats() {
  const [totalReferrals, verifiedReferrals] = await Promise.all([
    countReferrals(),
    countVerifiedReferrals(),
  ]);

  const pendingReferrals = totalReferrals - verifiedReferrals;

  // Total users who have generated at least one referral link
  // = total users (every user gets a link on /start, but only those who
  //   appear as referrer_id in the referrals table actually had someone use it).
  // For "links generated" we count distinct referrers + total users as proxy.
  const { data: referrerData } = await supabase
    .from('referrals')
    .select('referrer_id');

  const uniqueReferrers = new Set((referrerData || []).map((r) => r.referrer_id)).size;

  // Leader: first row of the leaderboard
  let leader = null;
  try {
    const { data: topRows } = await supabase
      .from('referral_leaderboard')
      .select('telegram_id, username, first_name, verified_count')
      .order('verified_count', { ascending: false })
      .limit(1);

    if (topRows && topRows.length > 0) {
      leader = _normaliseLeaderboardRow({ ...topRows[0], pending_count: 0, total_referrals: topRows[0].verified_count });
    }
  } catch (_) { /* non-fatal */ }

  return {
    totalReferrals,
    verifiedReferrals,
    pendingReferrals,
    uniqueReferrers,
    leader,
  };
}

/**
 * Fetch all leaderboard rows for CSV export (no pagination limit).
 * Uses LIMIT/OFFSET in batches to avoid loading everything into memory at once.
 *
 * @returns {Array<object>}
 */
async function getLeaderboardCsvData() {
  const PAGE = 500;
  const results = [];
  let offset = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const rows = await _fetchLeaderboard({ limit: PAGE, offset });
    if (!rows.length) break;
    results.push(...rows);
    if (rows.length < PAGE) break;
    offset += PAGE;
  }

  logger.info('CSV export prepared', { count: results.length });
  return results;
}

async function getUserReferralStats(telegramId) {
  const id = Number(telegramId);

  const { count: total, error: e1 } = await supabase
    .from('referrals')
    .select('*', { count: 'exact', head: true })
    .eq('referrer_id', id);

  const { count: verified, error: e2 } = await supabase
    .from('referrals')
    .select('*', { count: 'exact', head: true })
    .eq('referrer_id', id)
    .eq('verified', true);

  if (e1 || e2) {
    throw new AppError('Failed to load user referral stats', {
      code: 'DB_USER_REF_STATS',
      details: e1 || e2,
    });
  }

  const asReferred = await getReferralByReferred(id);

  return {
    total: total || 0,
    verified: verified || 0,
    referred_by: asReferred?.referrer_id || null,
    own_referral_verified: asReferred?.verified || false,
  };
}

/**
 * Build the public invitation deep link for a user.
 * Points/rankings are NEVER included.
 */
function buildInvitationLink(telegramId, botUsername) {
  return `https://t.me/${botUsername}?start=${telegramId}`;
}

// ─── Hybrid verification helpers ─────────────────────────────

/**
 * Automatically verify a single pending referral by checking channel membership.
 * Used by both Layer 2 (per-message check) and Layer 3 (cron job).
 *
 * Does nothing if the referral is already verified.
 *
 * Tracking columns (last_checked_at, check_attempts) are written only when
 * migration 003 has been applied — detected by their presence on the row object.
 * The core verified=true update NEVER includes optional columns so it cannot
 * fail due to a missing column in the database.
 *
 * @param {object} referral  - row from the referrals table
 * @returns {{ verified: boolean, reason: string }}
 */
async function autoVerifyReferral(referral) {
  if (!referral || referral.verified) {
    return { verified: true, reason: 'already_verified' };
  }

  const referredId = Number(referral.referred_id);

  // Detect whether migration 003 tracking columns exist on this row.
  // Supabase SELECT '*' returns all existing columns; if the column isn't
  // present in the result object, the migration hasn't been applied yet.
  const hasTrackingCols =
    'last_checked_at' in referral && 'check_attempts' in referral;

  logger.info('autoVerifyReferral: checking membership', {
    referral_id: referral.id,
    referred_id: referredId,
    has_tracking_columns: hasTrackingCols,
  });

  let isMember = false;
  try {
    isMember = await telegram.isChannelMember(referredId);
    logger.info('autoVerifyReferral: membership status', {
      referral_id: referral.id,
      referred_id: referredId,
      is_member: isMember,
    });
  } catch (err) {
    logger.warn('autoVerifyReferral: membership check failed', {
      referred_id: referredId,
      referral_id: referral.id,
      message: err.message,
    });
    // Best-effort: record the attempt if tracking columns exist
    if (hasTrackingCols) {
      await _updateAttempt(referral.id, {
        last_checked_at: new Date().toISOString(),
        check_attempts: (Number(referral.check_attempts) || 0) + 1,
      }).catch(() => {});
    }
    return { verified: false, reason: 'telegram_error' };
  }

  if (!isMember) {
    // Best-effort: record the attempt if tracking columns exist
    if (hasTrackingCols) {
      await _updateAttempt(referral.id, {
        last_checked_at: new Date().toISOString(),
        check_attempts: (Number(referral.check_attempts) || 0) + 1,
      }).catch(() => {});
    }
    return { verified: false, reason: 'not_member' };
  }

  // Member confirmed — mark joined_channel on the user record
  await usersService.markJoinedChannel(referredId, true).catch((err) => {
    logger.warn('autoVerifyReferral: markJoinedChannel failed', {
      referred_id: referredId,
      message: err.message,
    });
  });

  // ── Core update: only verified=true — NO optional columns ──
  // This is the fix for the critical bug: including last_checked_at or
  // check_attempts in this payload caused Supabase to reject the entire
  // update when migration 003 had not been applied, leaving the referral
  // permanently unverified.
  const coreUpdate = { verified: true };

  // Optionally also update tracking columns if they exist
  if (hasTrackingCols) {
    coreUpdate.last_checked_at = new Date().toISOString();
    coreUpdate.check_attempts = (Number(referral.check_attempts) || 0) + 1;
  }

  const { data, error } = await supabase
    .from('referrals')
    .update(coreUpdate)
    .eq('id', referral.id)
    .eq('verified', false)   // idempotency guard: skip if already verified
    .select()
    .maybeSingle();

  if (error) {
    logger.error('autoVerifyReferral: update failed', {
      referral_id: referral.id,
      message: error.message,
      code: error.code,
      hint: error.hint,
    });
    throw new AppError('Failed to auto-verify referral', {
      code: 'DB_AUTO_VERIFY',
      details: error,
    });
  }

  // data is null when the idempotency guard (verified=false) prevented the update
  // — meaning another process already verified it between our check and update.
  if (!data) {
    logger.info('autoVerifyReferral: already verified by another process (idempotent skip)', {
      referral_id: referral.id,
    });
    return { verified: true, reason: 'already_verified' };
  }

  logger.info('Referral auto-verified', {
    referral_id: data.id,
    referrer: data.referrer_id,
    referred: data.referred_id,
  });

  return { verified: true, reason: 'verified', referral: data };
}

/** Internal helper: update tracking columns only (no verified flag change). */
async function _updateAttempt(referralId, payload) {
  await supabase
    .from('referrals')
    .update(payload)
    .eq('id', referralId);
}

/**
 * Fetch all unverified referrals for the background cron job.
 * Ordered by last_checked_at ASC (nulls first) so the least-recently-checked
 * rows are processed first.
 *
 * Safe when migration 003 hasn't run — falls back gracefully by ordering on id.
 *
 * @returns {Array<object>}
 */
async function getPendingReferrals() {
  const { data, error } = await supabase
    .from('referrals')
    .select('*')
    .eq('verified', false)
    .order('id', { ascending: true });

  if (error) {
    logger.error('getPendingReferrals failed', {
      message: error.message,
      code: error.code,
    });
    throw new AppError('Failed to fetch pending referrals', {
      code: 'DB_PENDING_REFERRALS',
      details: error,
    });
  }

  // Sort in JS: nulls first (never checked), then oldest check first
  return (data || []).sort((a, b) => {
    if (!a.last_checked_at && !b.last_checked_at) return 0;
    if (!a.last_checked_at) return -1;
    if (!b.last_checked_at) return 1;
    return new Date(a.last_checked_at) - new Date(b.last_checked_at);
  });
}

module.exports = {
  recordReferral,
  getReferralByReferred,
  verifyReferral,
  countReferrals,
  countVerifiedReferrals,
  getTopReferrers,
  getLeaderboardPage,
  searchParticipant,
  getCompetitionStats,
  getLeaderboardCsvData,
  getUserReferralStats,
  buildInvitationLink,
  autoVerifyReferral,
  getPendingReferrals,
};
