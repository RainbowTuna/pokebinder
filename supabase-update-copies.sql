-- PokéBinder update: grade + price for each copy of a card.
-- Paste into Supabase → SQL Editor → New query, then press Run. Safe to run more than once.

alter table public.binder_cards add column if not exists copies jsonb not null default '[]'::jsonb;
