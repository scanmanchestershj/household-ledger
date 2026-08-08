-- =============================================================================
-- The Household Ledger — Supabase schema
-- Run this once in your Supabase project: Dashboard -> SQL Editor -> New query
-- =============================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- households: one row per family/household
-- ---------------------------------------------------------------------------
create table if not exists public.households (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  owner_id     uuid not null references auth.users(id) on delete cascade,
  invite_code  text not null unique,
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- profiles: maps each Supabase Auth user to a household + role
-- id = auth.users.id (one profile per login account)
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  household_id  uuid not null references public.households(id) on delete cascade,
  username      text,
  name          text,
  email         text,
  role          text not null default 'user' check (role in ('admin','user')),
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- household_data: the entire app state (settings, users, chores, budgets,
-- cards, requests, etc.) as one JSON blob per household — mirrors what used
-- to be saved to localStorage / window.storage in the original single-file app.
-- ---------------------------------------------------------------------------
create table if not exists public.household_data (
  household_id  uuid primary key references public.households(id) on delete cascade,
  data          jsonb not null default '{}'::jsonb,
  updated_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.households enable row level security;
alter table public.profiles enable row level security;
alter table public.household_data enable row level security;

-- households: a signed-in user can see/manage only their own household
drop policy if exists "households: select own" on public.households;
create policy "households: select own" on public.households
  for select using (
    id in (select household_id from public.profiles where id = auth.uid())
  );

drop policy if exists "households: insert own" on public.households;
create policy "households: insert own" on public.households
  for insert with check (owner_id = auth.uid());

drop policy if exists "households: update own" on public.households;
create policy "households: update own" on public.households
  for update using (owner_id = auth.uid());

-- profiles: a user can see every profile in their own household (so the app
-- can list household members), and can only edit their own row directly.
-- (Role/name changes made by an admin to *other* members go through the
-- update below, restricted to admins of the same household.)
drop policy if exists "profiles: select same household" on public.profiles;
create policy "profiles: select same household" on public.profiles
  for select using (
    household_id in (select household_id from public.profiles where id = auth.uid())
  );

drop policy if exists "profiles: insert own" on public.profiles;
create policy "profiles: insert own" on public.profiles
  for insert with check (id = auth.uid());

drop policy if exists "profiles: update own or admin of household" on public.profiles;
create policy "profiles: update own or admin of household" on public.profiles
  for update using (
    id = auth.uid()
    or household_id in (
      select household_id from public.profiles where id = auth.uid() and role = 'admin'
    )
  );

drop policy if exists "profiles: delete by admin of household" on public.profiles;
create policy "profiles: delete by admin of household" on public.profiles
  for delete using (
    household_id in (
      select household_id from public.profiles where id = auth.uid() and role = 'admin'
    )
  );

-- household_data: only members of the household can read/write its data blob
drop policy if exists "household_data: select own household" on public.household_data;
create policy "household_data: select own household" on public.household_data
  for select using (
    household_id in (select household_id from public.profiles where id = auth.uid())
  );

drop policy if exists "household_data: insert own household" on public.household_data;
create policy "household_data: insert own household" on public.household_data
  for insert with check (
    household_id in (select household_id from public.profiles where id = auth.uid())
  );

drop policy if exists "household_data: update own household" on public.household_data;
create policy "household_data: update own household" on public.household_data
  for update using (
    household_id in (select household_id from public.profiles where id = auth.uid())
  );

-- ---------------------------------------------------------------------------
-- join_household: lets a brand-new signed-up user join an existing household
-- by invite code, without being able to browse the households table directly
-- (SECURITY DEFINER runs with elevated privileges but only does this one thing).
-- ---------------------------------------------------------------------------
create or replace function public.join_household(
  p_invite_code text,
  p_username text,
  p_name text,
  p_email text
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_household_id uuid;
begin
  select id into v_household_id from public.households where invite_code = upper(p_invite_code);
  if v_household_id is null then
    raise exception 'Invalid invite code';
  end if;

  insert into public.profiles (id, household_id, username, name, email, role)
  values (auth.uid(), v_household_id, p_username, p_name, p_email, 'user')
  on conflict (id) do update set household_id = excluded.household_id;

  -- make sure a household_data row exists so the app has something to load
  insert into public.household_data (household_id, data)
  values (v_household_id, '{}'::jsonb)
  on conflict (household_id) do nothing;

  return true;
end;
$$;

grant execute on function public.join_household(text, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Seed a household_data row automatically whenever a household is created
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_household()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.household_data (household_id, data) values (new.id, '{}'::jsonb)
  on conflict (household_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_household_created on public.households;
create trigger on_household_created
  after insert on public.households
  for each row execute function public.handle_new_household();
