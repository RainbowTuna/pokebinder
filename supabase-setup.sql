-- PokéBinder database setup.
-- Paste this whole file into Supabase → SQL Editor → New query, then press Run. Safe to run more than once.

create table if not exists public.binders (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  name       text not null,
  cover      jsonb not null default '{}'::jsonb,
  position   int  not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.binder_cards (
  binder_id  uuid not null references public.binders on delete cascade,
  card_id    text not null,
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  name       text,
  local_id   text,
  image      text,
  set_id     text,
  set_name   text,
  qty        int  not null default 1 check (qty > 0),
  added_at   timestamptz not null default now(),
  primary key (binder_id, card_id)
);

create index if not exists binder_cards_user_idx on public.binder_cards (user_id);
create index if not exists binders_user_idx on public.binders (user_id);

-- Row Level Security: every person can only see and change their own binders.
alter table public.binders      enable row level security;
alter table public.binder_cards enable row level security;

drop policy if exists "own binders" on public.binders;
create policy "own binders" on public.binders
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "own binder cards" on public.binder_cards;
create policy "own binder cards" on public.binder_cards
  for all to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and exists (select 1 from public.binders b where b.id = binder_id and b.user_id = auth.uid())
  );

grant select, insert, update, delete on public.binders, public.binder_cards to authenticated;
revoke all on public.binders, public.binder_cards from anon;

-- Live sync: tell open devices when something changes.
do $$
begin
  alter publication supabase_realtime add table public.binders;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.binder_cards;
exception when duplicate_object then null;
end $$;
