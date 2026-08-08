'use strict';

/**
 * Referral Verification Background Job (Layer 3)
 *
 * Runs every 20 minutes via node-cron.
 * Loads all unverified referrals and attempts to confirm each one
 * by calling getChatMember() against the Telegram API.
 *
 * Design rules:
 * - Never crashes the process — each failure is caught and logged individually.
 * - Never re-verifies already verified referrals (query filters verified = false).
 * - Adds a 150 ms delay between Telegram API calls to stay well under rate limits.
 * - Idempotent: safe to run multiple times or restart mid-run.
 */

const cron = require('node-cron');
const referralsService = require('./referrals');
const telegram = require('./telegram');
const logger = require('../utils/logger');

// Delay between individual Telegram getChatMember requests (ms)
const INTER_REQUEST_DELAY_MS = 150;

// Cron expression: every 20 minutes
const CRON_SCHEDULE = '*/20 * * * *';

let isRunning = false; // Guard: skip a tick if a previous run is still in progress
let cronTask = null;

/**
 * Process all pending referrals in one sweep.
 * Called by the cron job and can also be invoked manually in tests.
 *
 * @returns {{ processed: number, verified: number, skipped: number, failed: number }}
 */
async function runVerificationSweep() {
  if (isRunning) {
    logger.info('Referral cron: previous sweep still running — skipping this tick');
    return { processed: 0, verified: 0, skipped: 0, failed: 0 };
  }

  isRunning = true;
  const stats = { processed: 0, verified: 0, skipped: 0, failed: 0 };

  try {
    let pending;
    try {
      pending = await referralsService.getPendingReferrals();
    } catch (err) {
      logger.error('Referral cron: failed to load pending referrals', {
        message: err.message,
      });
      return stats;
    }

    if (!pending.length) {
      logger.info('Referral cron: no pending referrals to process');
      return stats;
    }

    logger.info('Referral cron: sweep started', { count: pending.length });

    for (const referral of pending) {
      stats.processed += 1;

      try {
        const result = await referralsService.autoVerifyReferral(referral);

        if (result.verified && result.reason !== 'already_verified') {
          stats.verified += 1;
          logger.info('Referral cron: verified', {
            referral_id: referral.id,
            referred_id: referral.referred_id,
            referrer_id: referral.referrer_id,
          });
        } else if (result.reason === 'not_member') {
          stats.skipped += 1;
          logger.info('Referral cron: not a member yet', {
            referral_id: referral.id,
            referred_id: referral.referred_id,
          });
        } else if (result.reason === 'telegram_error') {
          stats.failed += 1;
          // already logged inside autoVerifyReferral
        } else if (result.reason === 'already_verified') {
          // Race condition — another process verified it; treat as success
          stats.verified += 1;
        }
      } catch (err) {
        // One failure must not stop the remaining checks
        stats.failed += 1;
        logger.error('Referral cron: unexpected error processing referral', {
          referral_id: referral.id,
          referred_id: referral.referred_id,
          message: err.message,
        });
      }

      // Rate-limit guard: small pause between each Telegram request
      await telegram.sleep(INTER_REQUEST_DELAY_MS);
    }

    logger.info('Referral cron: sweep complete', stats);
  } finally {
    isRunning = false;
  }

  return stats;
}

/**
 * Start the background cron job.
 * Safe to call multiple times — will only register one task.
 */
function startCron() {
  if (cronTask) {
    logger.warn('Referral cron: already started — ignoring duplicate startCron() call');
    return;
  }

  if (!cron.validate(CRON_SCHEDULE)) {
    logger.error('Referral cron: invalid cron schedule', { schedule: CRON_SCHEDULE });
    return;
  }

  cronTask = cron.schedule(CRON_SCHEDULE, () => {
    logger.info('Referral cron: job triggered', { schedule: CRON_SCHEDULE });
    runVerificationSweep().catch((err) => {
      logger.error('Referral cron: unhandled sweep error', { message: err.message });
    });
  });

  logger.info('Referral verification scheduler started', { schedule: CRON_SCHEDULE });
}

/**
 * Stop the cron job (used during graceful shutdown).
 */
function stopCron() {
  if (cronTask) {
    cronTask.stop();
    cronTask = null;
    logger.info('Referral cron: background job stopped');
  }
}

module.exports = {
  startCron,
  stopCron,
  runVerificationSweep, // exported for manual triggering / tests
};
