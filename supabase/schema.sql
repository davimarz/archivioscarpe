-- Eseguire una sola volta nel SQL Editor del proprio progetto Supabase.
-- La tabella e privata per ciascun utente autenticato.
create table if not exists public.shoe_archives (
  user_id uuid primary key references auth.users(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint payload_object check (jsonb_typeof(payload) = 'object')
);
alter table public.shoe_archives enable row level security;
revoke all on public.shoe_archives from anon;
grant select, insert, update on public.shoe_archives to authenticated;
drop policy if exists "read own archive" on public.shoe_archives;
drop policy if exists "insert own archive" on public.shoe_archives;
drop policy if exists "update own archive" on public.shoe_archives;
create policy "read own archive" on public.shoe_archives for select to authenticated using ((select auth.uid()) = user_id);
create policy "insert own archive" on public.shoe_archives for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "update own archive" on public.shoe_archives for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
