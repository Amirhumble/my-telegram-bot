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

module.exports = {
  recordReferral,
  getReferralByReferred,
  verifyReferral,
  countReferrals,
  countVerifiedReferrals,
  getTopReferrers,
  getUserReferralStats,
  buildInvitationLink,
};
