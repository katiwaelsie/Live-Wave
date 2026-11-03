
-- All-features integration patch: idempotent ticket issuance and live notifications.
do $$ begin
  if to_regclass('public.tickets') is not null then
    create unique index if not exists tickets_payment_transaction_unique
      on public.tickets(payment_transaction_id);
  end if;
end $$;

create or replace function public.notify_followers_when_event_goes_live()
returns trigger language plpgsql security definer set search_path=public
as $$
begin
  if new.is_live is true and (tg_op='INSERT' or old.is_live is distinct from true) then
    insert into public.user_notifications(user_id,event_id,notification_type,title,body,action_url)
    select f.follower_id,new.id,'creator_live','A creator you follow is live',
      coalesce(new.title,'A livestream') || ' is live now',
      'watch.html?id=' || new.id::text
    from public.creator_follows f
    where f.creator_id=new.creator_id
    on conflict do nothing;
  end if;
  return new;
end;
$$;
drop trigger if exists notify_followers_when_event_goes_live on public.events;
create trigger notify_followers_when_event_goes_live
after insert or update of is_live on public.events
for each row execute function public.notify_followers_when_event_goes_live();


-- Admin read access for dashboard sections. Mutations still go through admin-action.
drop policy if exists "Admins read events" on public.events;
create policy "Admins read events" on public.events for select to authenticated
using (public.is_platform_admin());

do $$ begin
  if to_regclass('public.profiles') is not null then
    execute 'alter table public.profiles enable row level security';
    execute 'drop policy if exists "Admins read profiles" on public.profiles';
    execute 'create policy "Admins read profiles" on public.profiles for select to authenticated using (public.is_platform_admin())';
  end if;
end $$;

drop policy if exists "Admins read audit logs" on public.platform_audit_logs;
create policy "Admins read audit logs" on public.platform_audit_logs for select to authenticated
using (public.is_platform_admin());

create table if not exists public.event_reminder_sends (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  reminder_type text not null default '15_minute',
  sent_at timestamptz not null default now(),
  unique(event_id,user_id,reminder_type)
);
alter table public.event_reminder_sends enable row level security;


drop policy if exists "Users read own view sessions" on public.event_view_sessions;
create policy "Users read own view sessions" on public.event_view_sessions for select to authenticated
using (user_id=auth.uid() or public.is_platform_admin());


create table if not exists public.event_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
alter table public.event_categories enable row level security;
drop policy if exists "Anyone can read active categories" on public.event_categories;
create policy "Anyone can read active categories" on public.event_categories for select to anon, authenticated
using (active=true);
drop policy if exists "Admins manage categories" on public.event_categories;
create policy "Admins manage categories" on public.event_categories for all to authenticated
using (public.is_platform_admin()) with check (public.is_platform_admin());


-- Make replay storage private so paid/invitation-only replay URLs cannot be shared as permanent public links.
-- Existing replay_url values remain usable as storage-path references by the replay-url Edge Function.
update storage.buckets set public=false where id='replays';

drop policy if exists "Creators can upload their replay files" on storage.objects;
create policy "Creators can upload their replay files" on storage.objects for insert to authenticated
with check (
  bucket_id='replays' and exists (
    select 1 from public.events e
    where e.id::text=split_part(name,'/',1) and e.creator_id=auth.uid()
  )
);
drop policy if exists "Creators can update their replay files" on storage.objects;
create policy "Creators can update their replay files" on storage.objects for update to authenticated
using (
  bucket_id='replays' and exists (
    select 1 from public.events e
    where e.id::text=split_part(name,'/',1) and e.creator_id=auth.uid()
  )
)
with check (
  bucket_id='replays' and exists (
    select 1 from public.events e
    where e.id::text=split_part(name,'/',1) and e.creator_id=auth.uid()
  )
);


drop policy if exists "Creators can delete their replay files" on storage.objects;
create policy "Creators can delete their replay files" on storage.objects for delete to authenticated
using (
  bucket_id='replays' and exists (
    select 1 from public.events e
    where e.id::text=split_part(name,'/',1) and e.creator_id=auth.uid()
  )
);


drop policy if exists "Creators read payments for own events" on public.payment_transactions;
create policy "Creators read payments for own events" on public.payment_transactions for select to authenticated
using (exists (select 1 from public.events e where e.id=event_id and e.creator_id=auth.uid()));


create or replace function public.notify_replay_ready()
returns trigger language plpgsql security definer set search_path=public
as $$
begin
  if new.replay_url is not null and (tg_op='INSERT' or old.replay_url is distinct from new.replay_url) then
    insert into public.user_notifications(user_id,event_id,notification_type,title,body,action_url)
    values (new.creator_id,new.id,'replay_ready','Your replay is ready',
      coalesce(new.title,'Your event') || ' replay is ready to manage.',
      'creator.html');
    insert into public.user_notifications(user_id,event_id,notification_type,title,body,action_url)
    select t.user_id,new.id,'replay_ready','Replay available',
      coalesce(new.title,'An event you have access to') || ' replay is now available.',
      'watch.html?id=' || new.id::text
    from public.tickets t where t.event_id=new.id and t.paid=true
    on conflict do nothing;
  end if;
  return new;
end;
$$;
drop trigger if exists notify_replay_ready on public.events;
create trigger notify_replay_ready
after insert or update of replay_url on public.events
for each row execute function public.notify_replay_ready();


create or replace function public.protect_profile_admin_fields()
returns trigger language plpgsql security definer set search_path=public
as $$
begin
  if auth.uid() is not null and not public.is_platform_admin() then
    if new.account_status is distinct from old.account_status then
      raise exception 'Only platform administrators can change account status';
    end if;
    if new.creator_status is distinct from old.creator_status then
      raise exception 'Only platform administrators can change creator status';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists protect_profile_admin_fields on public.profiles;
create trigger protect_profile_admin_fields
before update on public.profiles
for each row execute function public.protect_profile_admin_fields();
