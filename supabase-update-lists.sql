-- PokéBinder update: wishlist + checklists.
-- Paste into Supabase → SQL Editor → New query, then press Run. Safe to run more than once.

create table if not exists public.lists (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  kind       text not null check (kind in ('wishlist', 'checklist')),
  name       text not null,
  spec       jsonb not null default '{}'::jsonb,
  position   int  not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists lists_user_idx on public.lists (user_id);

alter table public.lists enable row level security;
drop policy if exists "own lists" on public.lists;
create policy "own lists" on public.lists
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant select, insert, update, delete on public.lists to authenticated;
revoke all on public.lists from anon;

do $$
begin
  alter publication supabase_realtime add table public.lists;
exception when duplicate_object then null;
end $$;
