-- ============================================================
-- Telegram Bot — Initial Schema (Supabase / PostgreSQL)
-- Run this in the Supabase SQL Editor (or via migration tooling)
-- ============================================================

-- Users who interact with the bot
create table if not exists users (
  telegram_id bigint primary key,
  username text,
  first_name text,
  joined_channel boolean default false,
  created_at timestamp default now()
);

-- Referral relationships (invisible to end users)
create table if not exists referrals (
  id bigint generated always as identity primary key,
  referrer_id bigint not null,
  referred_id bigint unique not null,
  verified boolean default false,
  created_at timestamp default now(),
  constraint referrals_no_self check (referrer_id <> referred_id),
  constraint referrals_referrer_fk foreign key (referrer_id)
    references users (telegram_id) on delete cascade,
  constraint referrals_referred_fk foreign key (referred_id)
    references users (telegram_id) on delete cascade
);

create index if not exists idx_referrals_referrer_id on referrals (referrer_id);
create index if not exists idx_referrals_verified on referrals (verified) where verified = true;

-- User feedback messages
create table if not exists feedbacks (
  id bigint generated always as identity primary key,
  telegram_id bigint not null,
  username text,
  message text not null,
  created_at timestamp default now(),
  constraint feedbacks_user_fk foreign key (telegram_id)
    references users (telegram_id) on delete cascade
);

create index if not exists idx_feedbacks_telegram_id on feedbacks (telegram_id);
create index if not exists idx_feedbacks_created_at on feedbacks (created_at desc);

-- Telegram file_id registry for images and PDFs
-- Runtime delivery NEVER reads local disk — only these file_ids
create table if not exists resources (
  id bigint generated always as identity primary key,
  name text not null,
  type text not null check (type in ('pdf', 'image')),
  telegram_file_id text not null,
  caption text,
  sort_order integer default 0,
  created_at timestamp default now(),
  constraint resources_name_unique unique (name)
);

create index if not exists idx_resources_type on resources (type);

-- Helpful admin view: verified referral counts per referrer
create or replace view referral_leaderboard as
select
  u.telegram_id,
  u.username,
  u.first_name,
  count(r.id) filter (where r.verified = true) as verified_count,
  count(r.id) as total_referrals
from users u
left join referrals r on r.referrer_id = u.telegram_id
group by u.telegram_id, u.username, u.first_name
order by verified_count desc, total_referrals desc;
