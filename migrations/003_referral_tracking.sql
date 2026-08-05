-- ============================================================
-- Migration 003 — Hybrid Referral Verification Tracking
-- Run this in the Supabase SQL Editor
-- ============================================================

-- Track when a pending referral was last checked by the background job
alter table referrals
  add column if not exists last_checked_at timestamp;

-- Count how many times the background job has attempted to verify this referral
alter table referrals
  add column if not exists check_attempts integer default 0;

-- Index: background job only queries unverified rows, ordered by last check time
-- so it naturally prioritises rows that haven't been checked recently.
create index if not exists idx_referrals_pending
  on referrals (verified, last_checked_at)
  where verified = false;
