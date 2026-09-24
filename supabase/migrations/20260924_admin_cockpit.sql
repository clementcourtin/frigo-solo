-- Frigo Solo — cockpit d'administration (24 septembre 2026)
-- À conserver dans le dépôt puis à appliquer une seule fois dans Supabase SQL.

begin;

-- Le premier administrateur devient le propriétaire technique. Les rôles ne
-- sont jamais stockés dans le JWT : chaque contrôle les relit en base.
alter table public.app_admins add column if not exists role text;
update public.app_admins set role = 'admin' where role is null;
alter table public.app_admins alter column role set default 'admin';
alter table public.app_admins alter column role set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'app_admins_role_check'
  ) then
    alter table public.app_admins
      add constraint app_admins_role_check check (role in ('owner', 'admin'));
  end if;
end $$;

update public.app_admins
set role = 'owner'
where user_id = (
  select id from auth.users where email = 'clementhealeaucrt@gmail.com'
);

alter table public.app_admins enable row level security;
revoke all on table public.app_admins from anon, authenticated;

-- Aucun journal ne référence auth.users : une trace de sécurité doit survivre
-- à la suppression d'un compte.
create table if not exists public.admin_audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid,
  target_user_id uuid,
  action text not null check (char_length(action) between 1 and 80),
  outcome text not null default 'succeeded'
    check (outcome in ('started', 'succeeded', 'failed')),
  metadata jsonb not null default '{}'::jsonb,
  error_code text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists admin_audit_logs_created_at_idx
  on public.admin_audit_logs (created_at desc);
create index if not exists admin_audit_logs_target_user_id_idx
  on public.admin_audit_logs (target_user_id, created_at desc);

alter table public.admin_audit_logs enable row level security;
revoke all on table public.admin_audit_logs from anon, authenticated;

create table if not exists public.admin_notes (
  id uuid primary key default gen_random_uuid(),
  target_user_id uuid not null,
  actor_id uuid not null,
  body text not null check (char_length(trim(body)) between 1 and 2000),
  created_at timestamptz not null default now()
);

create index if not exists admin_notes_target_user_id_created_at_idx
  on public.admin_notes (target_user_id, created_at desc);
alter table public.admin_notes enable row level security;
revoke all on table public.admin_notes from anon, authenticated;

-- Les réglages restent privés. Seule la vue minimale destinée à l'app est
-- exposée par app_public_settings() ci-dessous.
create table if not exists public.app_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
alter table public.app_settings enable row level security;
revoke all on table public.app_settings from anon, authenticated;

insert into public.app_settings (key, value)
values
  ('maintenance', '{"enabled": false, "message": ""}'::jsonb),
  ('banner', '{"enabled": false, "message": ""}'::jsonb)
on conflict (key) do nothing;

create or replace function public.app_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1 from public.app_admins where user_id = auth.uid()
  )
$$;

create or replace function public.app_is_owner()
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1 from public.app_admins where user_id = auth.uid() and role = 'owner'
  )
$$;

create or replace function public.app_writes_enabled()
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select
    public.app_is_admin()
    or not coalesce(
      (select (value ->> 'enabled')::boolean from public.app_settings where key = 'maintenance'),
      false
    )
$$;

revoke all on function public.app_is_admin() from public;
revoke all on function public.app_is_owner() from public;
revoke all on function public.app_writes_enabled() from public;
grant execute on function public.app_is_admin() to authenticated;
grant execute on function public.app_writes_enabled() to authenticated;

-- Une vraie maintenance bloque les écritures côté RLS, pas seulement dans
-- l'interface. Les admins restent opérationnels pour pouvoir la lever.
drop policy if exists "add own food" on public.food_items;
drop policy if exists "delete own food" on public.food_items;
drop policy if exists "update own food" on public.food_items;
create policy "add own food" on public.food_items for insert
  with check (auth.uid() = user_id and public.app_writes_enabled());
create policy "delete own food" on public.food_items for delete
  using (auth.uid() = user_id and public.app_writes_enabled());
create policy "update own food" on public.food_items for update
  using (auth.uid() = user_id and public.app_writes_enabled())
  with check (auth.uid() = user_id and public.app_writes_enabled());

drop policy if exists "create own shopping items" on public.shopping_items;
drop policy if exists "delete own shopping items" on public.shopping_items;
drop policy if exists "update own shopping items" on public.shopping_items;
create policy "create own shopping items" on public.shopping_items for insert
  with check (auth.uid() = user_id and public.app_writes_enabled());
create policy "delete own shopping items" on public.shopping_items for delete
  using (auth.uid() = user_id and public.app_writes_enabled());
create policy "update own shopping items" on public.shopping_items for update
  using (auth.uid() = user_id and public.app_writes_enabled())
  with check (auth.uid() = user_id and public.app_writes_enabled());

drop policy if exists "create own calendar feed" on public.calendar_feeds;
create policy "create own calendar feed" on public.calendar_feeds for insert
  with check (auth.uid() = user_id and public.app_writes_enabled());

create or replace function public.app_public_settings()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'maintenance', coalesce(
      (select value from public.app_settings where key = 'maintenance'),
      '{"enabled": false, "message": ""}'::jsonb
    ),
    'banner', coalesce(
      (select value from public.app_settings where key = 'banner'),
      '{"enabled": false, "message": ""}'::jsonb
    )
  )
$$;
revoke all on function public.app_public_settings() from public;
grant execute on function public.app_public_settings() to anon, authenticated;

create or replace function public.admin_dashboard()
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if not public.app_is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'stats', jsonb_build_object(
      'total_users', (select count(*) from auth.users),
      'active_30_days', (select count(*) from auth.users where last_sign_in_at >= now() - interval '30 days'),
      'food_items', (select count(*) from public.food_items),
      'shopping_items', (select count(*) from public.shopping_items),
      'calendar_feeds', (select count(*) from public.calendar_feeds),
      'due_soon', (select count(*) from public.food_items where expires_on <= current_date + 3),
      'admins', (select count(*) from public.app_admins),
      'suspended', (select count(*) from auth.users where banned_until > now())
    ),
    'settings', public.app_public_settings(),
    'users', coalesce((
      with foods as (
        select user_id, count(*)::int as total from public.food_items group by user_id
      ), shopping as (
        select user_id, count(*)::int as total from public.shopping_items group by user_id
      ), calendars as (
        select user_id, count(*)::int as total from public.calendar_feeds group by user_id
      )
      select jsonb_agg(jsonb_build_object(
        'id', u.id,
        'email', u.email,
        'created_at', u.created_at,
        'last_sign_in_at', u.last_sign_in_at,
        'banned_until', u.banned_until,
        'role', a.role,
        'foods', coalesce(f.total, 0),
        'shopping', coalesce(s.total, 0),
        'calendars', coalesce(c.total, 0)
      ) order by u.created_at desc)
      from auth.users u
      left join public.app_admins a on a.user_id = u.id
      left join foods f on f.user_id = u.id
      left join shopping s on s.user_id = u.id
      left join calendars c on c.user_id = u.id
    ), '[]'::jsonb),
    'audit', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', x.id,
        'action', x.action,
        'outcome', x.outcome,
        'created_at', x.created_at,
        'actor_email', coalesce(actor.email, 'Système'),
        'target_email', target.email,
        'metadata', x.metadata
      ) order by x.created_at desc)
      from (
        select * from public.admin_audit_logs order by created_at desc limit 30
      ) x
      left join auth.users actor on actor.id = x.actor_id
      left join auth.users target on target.id = x.target_user_id
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.admin_user_data(p_target_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if not public.app_is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  insert into public.admin_audit_logs (actor_id, target_user_id, action, metadata)
  values (auth.uid(), p_target_user_id, 'account_viewed', '{}'::jsonb);

  return jsonb_build_object(
    'foods', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', id, 'name', name, 'location', location, 'quantity', quantity,
        'unit', unit, 'expires_on', expires_on, 'created_at', created_at
      ) order by expires_on asc)
      from public.food_items where user_id = p_target_user_id
    ), '[]'::jsonb),
    'shopping', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', id, 'name', name, 'checked', checked, 'created_at', created_at
      ) order by created_at desc)
      from public.shopping_items where user_id = p_target_user_id
    ), '[]'::jsonb),
    'calendar_configured', exists(
      select 1 from public.calendar_feeds where user_id = p_target_user_id
    ),
    'notes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', n.id, 'body', n.body, 'created_at', n.created_at,
        'actor_email', coalesce(a.email, 'Administrateur')
      ) order by n.created_at desc)
      from public.admin_notes n
      left join auth.users a on a.id = n.actor_id
      where n.target_user_id = p_target_user_id
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.admin_add_note(p_target_user_id uuid, p_body text)
returns uuid
language plpgsql
security definer
set search_path = public, auth
as $$
declare note_id uuid;
begin
  if not public.app_is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if char_length(trim(coalesce(p_body, ''))) not between 1 and 2000 then
    raise exception 'note_invalid' using errcode = '22023';
  end if;

  insert into public.admin_notes (target_user_id, actor_id, body)
  values (p_target_user_id, auth.uid(), trim(p_body))
  returning id into note_id;
  insert into public.admin_audit_logs (actor_id, target_user_id, action, metadata)
  values (auth.uid(), p_target_user_id, 'note_added', '{}'::jsonb);
  return note_id;
end;
$$;

create or replace function public.admin_update_settings(
  p_maintenance_enabled boolean,
  p_maintenance_message text,
  p_banner_enabled boolean,
  p_banner_message text
)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if not public.app_is_owner() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if char_length(coalesce(p_maintenance_message, '')) > 280
     or char_length(coalesce(p_banner_message, '')) > 280 then
    raise exception 'message_too_long' using errcode = '22023';
  end if;

  insert into public.app_settings (key, value, updated_at, updated_by)
  values
    ('maintenance', jsonb_build_object('enabled', p_maintenance_enabled, 'message', trim(coalesce(p_maintenance_message, ''))), now(), auth.uid()),
    ('banner', jsonb_build_object('enabled', p_banner_enabled, 'message', trim(coalesce(p_banner_message, ''))), now(), auth.uid())
  on conflict (key) do update
    set value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by;

  insert into public.admin_audit_logs (actor_id, action, metadata)
  values (auth.uid(), 'settings_updated', jsonb_build_object('maintenance', p_maintenance_enabled, 'banner', p_banner_enabled));
end;
$$;

create or replace function public.admin_set_role(p_target_user_id uuid, p_role text)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare current_role text;
begin
  if not public.app_is_owner() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_target_user_id = auth.uid() then
    raise exception 'self_role_change_forbidden' using errcode = '42501';
  end if;
  if p_role not in ('admin', 'none') then
    raise exception 'role_invalid' using errcode = '22023';
  end if;
  select role into current_role from public.app_admins where user_id = p_target_user_id;
  if current_role = 'owner' then
    raise exception 'owner_role_change_forbidden' using errcode = '42501';
  end if;

  if p_role = 'none' then
    delete from public.app_admins where user_id = p_target_user_id;
  else
    insert into public.app_admins (user_id, role)
    values (p_target_user_id, 'admin')
    on conflict (user_id) do update set role = 'admin';
  end if;
  insert into public.admin_audit_logs (actor_id, target_user_id, action, metadata)
  values (auth.uid(), p_target_user_id, 'role_updated', jsonb_build_object('role', p_role));
end;
$$;

revoke all on function public.admin_dashboard() from public;
revoke all on function public.admin_user_data(uuid) from public;
revoke all on function public.admin_add_note(uuid, text) from public;
revoke all on function public.admin_update_settings(boolean, text, boolean, text) from public;
revoke all on function public.admin_set_role(uuid, text) from public;
grant execute on function public.admin_dashboard() to authenticated;
grant execute on function public.admin_user_data(uuid) to authenticated;
grant execute on function public.admin_add_note(uuid, text) to authenticated;
grant execute on function public.admin_update_settings(boolean, text, boolean, text) to authenticated;
grant execute on function public.admin_set_role(uuid, text) to authenticated;

commit;
