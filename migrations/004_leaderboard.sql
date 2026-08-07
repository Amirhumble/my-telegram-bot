-- ============================================================
-- Migration 004 — Enhanced Competition Leaderboard
-- Run this in the Supabase SQL Editor
-- ============================================================

-- Replace the referral_leaderboard view with a richer version.
-- Returns verified, pending, and total counts per referrer,
-- sorted by: verified DESC, total DESC, user.created_at ASC.
-- Uses a single aggregation — no N+1 queries.
create or replace view referral_leaderboard as
select
  u.telegram_id,
  u.username,
  u.first_name,
  u.created_at,
  count(r.id) filter (where r.verified = true)  as verified_count,
  count(r.id) filter (where r.verified = false) as pending_count,
  count(r.id)                                    as total_referrals
from users u
inner join referrals r on r.referrer_id = u.telegram_id
group by u.telegram_id, u.username, u.first_name, u.created_at
order by
  verified_count  desc,
  total_referrals desc,
  u.created_at    asc;

-- Index to make the leaderboard query fast even at 10 000+ users.
-- Covers the GROUP BY and the verified filter.
create index if not exists idx_referrals_referrer_verified
  on referrals (referrer_id, verified);
