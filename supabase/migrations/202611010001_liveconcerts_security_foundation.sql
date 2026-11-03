-- LiveConcerts Phase 1 security and feature foundation.
-- Additive migration: review against your live schema before applying to production.

create table if not exists public.user_roles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('admin','moderator')),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null
);

create or replace function public.is_platform_admin()
returns boolean
language sql stable security definer
set search_path = public, auth
as $$
  select exists (
    select 1 from public.user_roles r
    where r.user_id = auth.uid() and r.role = 'admin'
  );
$$;

revoke all on function public.is_platform_admin() from public;
grant execute on function public.is_platform_admin() to authenticated;


-- Access policy for events; existing events remain public unless explicitly changed.
do $$ begin
  if to_regclass('public.events') is not null then
    execute 'alter table public.events add column if not exists access_mode text not null default ''public''';
    execute 'alter table public.events add column if not exists access_code_required boolean not null default false';
  end if;
end $$;

-- Access codes store hashes only; code validation/issuance must happen in a trusted Edge Function.
create table if not exists public.event_access_codes (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete cascade,
  code_hash text not null unique,
  label text,
  max_uses integer check (max_uses is null or max_uses > 0),
  uses_count integer not null default 0 check (uses_count >= 0),
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists event_access_codes_event_idx on public.event_access_codes(event_id);

create table if not exists public.event_access_grants (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  access_code_id uuid references public.event_access_codes(id) on delete set null,
  granted_at timestamptz not null default now(),
  expires_at timestamptz,
  unique(event_id, user_id)
);
create index if not exists event_access_grants_user_idx on public.event_access_grants(user_id, event_id);

create table if not exists public.user_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  event_id uuid references public.events(id) on delete cascade,
  notification_type text not null,
  title text not null,
  body text not null default '',
  action_url text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists user_notifications_user_created_idx on public.user_notifications(user_id, created_at desc);

create table if not exists public.event_view_sessions (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  session_key_hash text not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  duration_seconds integer check (duration_seconds is null or duration_seconds >= 0),
  is_replay boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists event_view_sessions_event_idx on public.event_view_sessions(event_id, started_at desc);

create table if not exists public.event_reports (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  reporter_id uuid references auth.users(id) on delete set null,
  reason text not null,
  details text,
  status text not null default 'open' check (status in ('open','reviewing','resolved','dismissed')),
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists event_reports_status_idx on public.event_reports(status, created_at desc);

create table if not exists public.platform_audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references auth.users(id) on delete set null,
  action text not null,
  target_type text,
  target_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists platform_audit_logs_created_idx on public.platform_audit_logs(created_at desc);

-- Payment records are written only by trusted payment Edge Functions using service role.
create table if not exists public.payment_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete restrict,
  event_id uuid not null references public.events(id) on delete restrict,
  provider text not null default 'mpesa',
  merchant_request_id text,
  checkout_request_id text unique,
  provider_receipt text unique,
  phone_number text,
  amount_kes numeric(12,2) not null check (amount_kes > 0),
  currency text not null default 'KES' check (currency = 'KES'),
  status text not null default 'pending' check (status in ('pending','succeeded','failed','cancelled','reversed')),
  raw_callback jsonb,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists payment_transactions_user_idx on public.payment_transactions(user_id, created_at desc);
create index if not exists payment_transactions_event_idx on public.payment_transactions(event_id, status);

-- Preserve the existing tickets table while adding optional links/status where it exists.
do $$ begin
  if to_regclass('public.tickets') is not null then
    execute 'alter table public.tickets add column if not exists payment_transaction_id uuid references public.payment_transactions(id) on delete set null';
    execute 'alter table public.tickets add column if not exists status text not null default ''active''';
    execute 'alter table public.tickets add column if not exists issued_at timestamptz not null default now()';
  end if;
end $$;


-- Atomic, race-safe code redemption. Only service_role should call this RPC.
create or replace function public.redeem_event_access_code(p_event_id uuid, p_user_id uuid, p_code_hash text)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare c public.event_access_codes%rowtype;
begin
  select * into c from public.event_access_codes
  where event_id = p_event_id and code_hash = p_code_hash
  for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
  if c.revoked_at is not null then return jsonb_build_object('ok', false, 'reason', 'revoked'); end if;
  if c.expires_at is not null and c.expires_at <= now() then return jsonb_build_object('ok', false, 'reason', 'expired'); end if;
  if c.max_uses is not null and c.uses_count >= c.max_uses then return jsonb_build_object('ok', false, 'reason', 'limit'); end if;
  update public.event_access_codes set uses_count = uses_count + 1 where id = c.id;
  insert into public.event_access_grants(event_id, user_id, access_code_id, expires_at)
  values (p_event_id, p_user_id, c.id, c.expires_at)
  on conflict (event_id, user_id) do update set access_code_id = excluded.access_code_id, granted_at = now(), expires_at = excluded.expires_at;
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.redeem_event_access_code(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.redeem_event_access_code(uuid, uuid, text) to service_role;

alter table public.user_roles enable row level security;
alter table public.event_access_codes enable row level security;
alter table public.event_access_grants enable row level security;
alter table public.user_notifications enable row level security;
alter table public.event_view_sessions enable row level security;
alter table public.event_reports enable row level security;
alter table public.platform_audit_logs enable row level security;
alter table public.payment_transactions enable row level security;

-- Only existing admins may read roles or administer roles. Provision the first admin manually in SQL.
create policy "Admins can read user roles" on public.user_roles for select to authenticated using (public.is_platform_admin());
create policy "Admins can manage user roles" on public.user_roles for all to authenticated using (public.is_platform_admin()) with check (public.is_platform_admin());

-- Access codes themselves are not readable from browser clients. Trusted Edge Functions use service role.
create policy "Event owners can list access grants" on public.event_access_grants for select to authenticated
using (user_id = auth.uid() or exists (select 1 from public.events e where e.id = event_id and e.creator_id = auth.uid()) or public.is_platform_admin());

create policy "Users can read own notifications" on public.user_notifications for select to authenticated using (user_id = auth.uid() or public.is_platform_admin());
create policy "Users can mark own notifications read" on public.user_notifications for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "Users can read own view sessions" on public.event_view_sessions for select to authenticated using (user_id = auth.uid() or exists (select 1 from public.events e where e.id = event_id and e.creator_id = auth.uid()) or public.is_platform_admin());
-- Writes should be made by trusted functions to prevent fabricated analytics.

create policy "Users can create event reports" on public.event_reports for insert to authenticated with check (reporter_id = auth.uid());
create policy "Admins can review event reports" on public.event_reports for select to authenticated using (public.is_platform_admin());
create policy "Admins can update event reports" on public.event_reports for update to authenticated using (public.is_platform_admin()) with check (public.is_platform_admin());

create policy "Admins can read audit logs" on public.platform_audit_logs for select to authenticated using (public.is_platform_admin());
create policy "Admins can read payment transactions" on public.payment_transactions for select to authenticated using (public.is_platform_admin());
create policy "Users can read own payment transactions" on public.payment_transactions for select to authenticated using (user_id = auth.uid());

-- Do not create a default admin in client code. Replace the UUID with the trusted owner's auth.users.id.
-- Example (run manually only after verifying the account):
-- insert into public.user_roles(user_id, role) values ('YOUR-AUTH-USER-UUID', 'admin')
-- on conflict (user_id) do update set role = 'admin';
