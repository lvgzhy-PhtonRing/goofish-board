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

-- 纵深防御：anon 不直接持有表权限（读取一律走登录态）
revoke all on public.goofish_vitality, public.goofish_board_state from anon;

-- PATCH 时自动刷新 updated_at
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists gv_touch on public.goofish_vitality;
create trigger gv_touch before update on public.goofish_vitality
  for each row execute function public.touch_updated_at();

drop trigger if exists gb_touch on public.goofish_board_state;
create trigger gb_touch before update on public.goofish_board_state
  for each row execute function public.touch_updated_at();
