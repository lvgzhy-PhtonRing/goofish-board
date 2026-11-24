
-- ===== 2026-11-24 全店数据（卖家数据总览）=====
create table if not exists public.goofish_shop_metrics (
  id uuid primary key default gen_random_uuid(),
  captured_at text not null,
  complete boolean not null default false,
  reason text,
  payload jsonb not null,
  owner_id uuid references auth.users(id),
  created_at timestamptz not null default now()
);
alter table public.goofish_shop_metrics enable row level security;
drop policy if exists gm_owner_all on public.goofish_shop_metrics;
create policy gm_owner_all on public.goofish_shop_metrics for all to authenticated
  using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
revoke all on public.goofish_shop_metrics from anon;
grant select, insert, update, delete on public.goofish_shop_metrics to authenticated;
create index if not exists gm_created_idx on public.goofish_shop_metrics (created_at desc);
