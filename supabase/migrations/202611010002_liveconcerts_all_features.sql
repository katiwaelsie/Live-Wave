-- LiveConcerts all-features add-on migration.
-- BACK UP your database and review your existing schema before applying.
-- This migration is additive; it does not delete existing tables or records.

create extension if not exists pgcrypto;

-- Fields used by discovery, moderation, and ticketing.
alter table public.events add column if not exists thumbnail_url text;
alter table public.events add column if not exists description text;
alter table public.events add column if not exists category text;
alter table public.events add column if not exists ended_at timestamptz;
alter table public.events add column if not exists moderation_status text not null default 'active'
  check (moderation_status in ('active','reviewed','hidden','removed'));
alter table public.events add column if not exists replay_visibility text not null default 'public'
  check (replay_visibility in ('public','ticket_holders','creator_only'));
alter table public.events add column if not exists peak_viewers integer not null default 0 check (peak_viewers >= 0);

-- Ensure the legacy ticket model has a server-verifiable payment state.
do $$ begin
  if to_regclass('public.tickets') is not null then
    alter table public.tickets add column if not exists paid boolean not null default false;
    alter table public.tickets add column if not exists status text not null default 'active';
    alter table public.tickets add column if not exists issued_at timestamptz not null default now();
    alter table public.tickets add column if not exists payment_transaction_id uuid;
  end if;
end $$;

-- Viewer follow and saved-event features.
create table if not exists public.creator_follows (
  id uuid primary key default gen_random_uuid(),
  follower_id uuid not null references auth.users(id) on delete cascade,
  creator_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique(follower_id, creator_id),
  check (follower_id <> creator_id)
);
create table if not exists public.saved_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  event_id uuid not null references public.events(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique(user_id,event_id)
);

-- Reported content status and user account status. Existing profiles are not overwritten.
do $$ begin
  if to_regclass('public.profiles') is not null then
    alter table public.profiles add column if not exists account_status text not null default 'active';
    alter table public.profiles add column if not exists creator_status text not null default 'active';
  end if;
end $$;

-- Safe aggregate helper for creators. This counts view sessions, not people.
create or replace function public.creator_event_analytics(p_event_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare v_creator uuid; v_views bigint; v_peak integer; v_tickets bigint; v_revenue numeric;
begin
  select creator_id into v_creator from public.events where id = p_event_id;
  if v_creator is null or v_creator <> auth.uid() then
    raise exception 'Not authorized';
  end if;
  select count(*) into v_views from public.event_view_sessions where event_id=p_event_id;
  select coalesce(max(peak_viewers),0) into v_peak from public.events where id=p_event_id;
  select count(*) into v_tickets from public.tickets where event_id=p_event_id and paid=true;
  select coalesce(sum(amount_kes),0) into v_revenue
    from public.payment_transactions where event_id=p_event_id and status='succeeded';
  return jsonb_build_object('view_sessions',v_views,'peak_concurrent_viewers',v_peak,
    'paid_tickets',v_tickets,'gross_revenue_kes',v_revenue);
end;
$$;
revoke all on function public.creator_event_analytics(uuid) from public, anon;
grant execute on function public.creator_event_analytics(uuid) to authenticated;

-- RLS for viewer-owned data.
alter table public.creator_follows enable row level security;
alter table public.saved_events enable row level security;

drop policy if exists "Users manage own follows" on public.creator_follows;
create policy "Users manage own follows" on public.creator_follows for all to authenticated
using (follower_id=auth.uid()) with check (follower_id=auth.uid());

drop policy if exists "Users manage own saved events" on public.saved_events;
create policy "Users manage own saved events" on public.saved_events for all to authenticated
using (user_id=auth.uid()) with check (user_id=auth.uid());

-- User notifications are only readable/updatable by their recipient.
drop policy if exists "Users read own notifications" on public.user_notifications;
create policy "Users read own notifications" on public.user_notifications for select to authenticated
using (user_id=auth.uid() or public.is_platform_admin());

drop policy if exists "Users mark own notifications read" on public.user_notifications;
create policy "Users mark own notifications read" on public.user_notifications for update to authenticated
using (user_id=auth.uid()) with check (user_id=auth.uid());

-- Users may create reports about events; they cannot self-approve them.
drop policy if exists "Authenticated users can report events" on public.event_reports;
create policy "Authenticated users can report events" on public.event_reports for insert to authenticated
with check (reporter_id=auth.uid() and status='open');

drop policy if exists "Admins and moderators can review reports" on public.event_reports;
create policy "Admins and moderators can review reports" on public.event_reports for select to authenticated
using (public.is_platform_admin() or exists (
  select 1 from public.user_roles r where r.user_id=auth.uid() and r.role='moderator'
));

-- Payments must never be client-writable.
drop policy if exists "Users read own payment transactions" on public.payment_transactions;
create policy "Users read own payment transactions" on public.payment_transactions for select to authenticated
using (user_id=auth.uid() or public.is_platform_admin());

drop policy if exists "No client insert payment transactions" on public.payment_transactions;
create policy "No client insert payment transactions" on public.payment_transactions for insert to authenticated
with check (false);

-- Helpful indexes.
create index if not exists events_scheduled_at_idx on public.events(scheduled_at);
create index if not exists events_live_idx on public.events(is_live) where is_live=true;
create index if not exists tickets_event_paid_idx on public.tickets(event_id, paid);
