-- ============================================================
-- Migration 002 — Admin Panel enhancements
-- Run this in the Supabase SQL Editor
-- ============================================================

-- Add updated_at tracking to resources
alter table resources
  add column if not exists updated_at timestamp default now();

-- Add soft-delete / visibility flag to resources
alter table resources
  add column if not exists is_active boolean default true;

-- Automatically update updated_at on any resource row change
create or replace function update_resources_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_resources_updated_at on resources;
create trigger trg_resources_updated_at
  before update on resources
  for each row execute function update_resources_updated_at();

-- Index to only fetch active resources faster
create index if not exists idx_resources_is_active
  on resources (is_active)
  where is_active = true;
