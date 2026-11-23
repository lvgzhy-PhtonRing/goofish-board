-- goofish-board 专用 Supabase 项目建表 + RLS
-- 项目 ref: efysjvbbaxwalhbbjxdc（东京区，与 ysp/Car/ETF 项目隔离）

create table if not exists public.goofish_vitality (
  id text primary key default 'main',
  payload jsonb not null,
  owner_id uuid references auth.users(id),
  revision bigint not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.goofish_board_state (
  id text primary key default 'main',
  payload jsonb not null,
  owner_id uuid references auth.users(id),
  revision bigint not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.goofish_vitality enable row level security;
alter table public.goofish_board_state enable row level security;

drop policy if exists gv_owner_all on public.goofish_vitality;
create policy gv_owner_all on public.goofish_vitality
  for all to authenticated
  using ((select auth.uid()) = owner_id)
  with check ((select auth.uid()) = owner_id);

drop policy if exists gb_owner_all on public.goofish_board_state;
create policy gb_owner_all on public.goofish_board_state
  for all to authenticated
  using ((select auth.uid()) = owner_id)
  with check ((select auth.uid()) = owner_id);

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.goofish_vitality, public.goofish_board_state to authenticated;
