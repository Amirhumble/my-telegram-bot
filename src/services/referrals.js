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
    .select()
    .single();

  if (error) {
    throw new AppError('Failed to verify referral', {
      code: 'DB_VERIFY_REFERRAL',
      details: error,
    });
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
 * Top referrers by verified count (admin only).
 */
async function getTopReferrers(limit = 20) {
  // Fetch verified referrals and aggregate in JS for portability
  // (view referral_leaderboard also exists in SQL)
  const { data, error } = await supabase
    .from('referrals')
    .select('referrer_id')
    .eq('verified', true);

  if (error) {
    throw new AppError('Failed to load top referrers', {
      code: 'DB_TOP_REFERRERS',
      details: error,
    });
  }

  const counts = new Map();
  for (const row of data || []) {
    const id = row.referrer_id;
    counts.set(id, (counts.get(id) || 0) + 1);
  }

  const sorted = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);

  // Enrich with user profiles
  const result = [];
  for (const [telegramId, verifiedCount] of sorted) {
    const user = await usersService.getUser(telegramId);
    result.push({
      telegram_id: telegramId,
      username: user?.username || null,
      first_name: user?.first_name || null,
      verified_count: verifiedCount,
    });
  }

  return result;
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
 * Updates last_checked_at and check_attempts regardless of outcome
 * (columns are optional — query is safe if migration 003 hasn't run yet).
 *
 * @param {object} referral  - row from the referrals table
 * @returns {{ verified: boolean, reason: string }}
 */
async function autoVerifyReferral(referral) {
  if (!referral || referral.verified) {
    return { verified: true, reason: 'already_verified' };
  }

  const referredId = Number(referral.referred_id);

  // Build the update payload, but only include tracking columns when present
  // in the row (safe for both pre- and post-migration 003 schemas).
  const trackingUpdate = {};
  if ('last_checked_at' in referral || referral.last_checked_at !== undefined) {
    trackingUpdate.last_checked_at = new Date().toISOString();
  }
  if ('check_attempts' in referral || referral.check_attempts !== undefined) {
    trackingUpdate.check_attempts = (Number(referral.check_attempts) || 0) + 1;
  }

  // Always record the attempt even if the tracking columns don't exist yet —
  // the update will simply ignore unknown fields in Supabase.
  const attemptPayload = {
    last_checked_at: new Date().toISOString(),
    check_attempts: (Number(referral.check_attempts) || 0) + 1,
  };

  let isMember = false;
  try {
    isMember = await telegram.isChannelMember(referredId);
  } catch (err) {
    logger.warn('autoVerifyReferral: membership check failed', {
      referred_id: referredId,
      referral_id: referral.id,
      message: err.message,
    });
    // Persist the attempt count even on Telegram error, best-effort
    await _updateAttempt(referral.id, attemptPayload).catch(() => {});
    return { verified: false, reason: 'telegram_error' };
  }

  if (!isMember) {
    await _updateAttempt(referral.id, attemptPayload).catch(() => {});
    return { verified: false, reason: 'not_member' };
  }

  // Member confirmed — mark joined_channel on the user record
  await usersService.markJoinedChannel(referredId, true).catch((err) => {
    logger.warn('autoVerifyReferral: markJoinedChannel failed', {
      referred_id: referredId,
      message: err.message,
    });
  });

  // Mark the referral verified
  const { data, error } = await supabase
    .from('referrals')
    .update({
      verified: true,
      last_checked_at: new Date().toISOString(),
      check_attempts: (Number(referral.check_attempts) || 0) + 1,
    })
    .eq('id', referral.id)
    .select()
    .single();

  if (error) {
    logger.error('autoVerifyReferral: update failed', {
      referral_id: referral.id,
      message: error.message,
    });
    throw new AppError('Failed to auto-verify referral', {
      code: 'DB_AUTO_VERIFY',
      details: error,
    });
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
  getUserReferralStats,
  buildInvitationLink,
  autoVerifyReferral,
  getPendingReferrals,
};
