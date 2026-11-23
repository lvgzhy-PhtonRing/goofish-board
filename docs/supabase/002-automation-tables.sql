
-- ===== 2026-11-24 Excel 自动化：快照 / 事件 / 待确认 =====
create table if not exists public.goofish_snapshots (
  id bigserial primary key,
  fetched_at text not null,
  item_count integer not null default 0,
  payload jsonb not null,
  owner_id uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.goofish_events (
  id bigserial primary key,
  item_id text,
  lineage_id text,
  type text not null,
  occurred_at text not null,
  data jsonb not null default '{}'::jsonb,
  owner_id uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.goofish_pending (
  id uuid primary key default gen_random_uuid(),
  item_id text,
  kind text not null,
  question text not null,
  options jsonb not null,
  suggestion text,
  status text not null default 'pending',
  resolution text,
  owner_id uuid references auth.users(id),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

alter table public.goofish_snapshots enable row level security;
alter table public.goofish_events enable row level security;
alter table public.goofish_pending enable row level security;

drop policy if exists gs_owner_all on public.goofish_snapshots;
create policy gs_owner_all on public.goofish_snapshots for all to authenticated
  using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
drop policy if exists ge_owner_all on public.goofish_events;
create policy ge_owner_all on public.goofish_events for all to authenticated
  using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
drop policy if exists gp_owner_all on public.goofish_pending;
create policy gp_owner_all on public.goofish_pending for all to authenticated
  using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);

revoke all on public.goofish_snapshots, public.goofish_events, public.goofish_pending from anon;
grant select, insert, update, delete on public.goofish_snapshots, public.goofish_events, public.goofish_pending to authenticated;
grant usage, select on all sequences in schema public to authenticated;

create index if not exists ge_item_idx on public.goofish_events (item_id);
create index if not exists ge_type_idx on public.goofish_events (type);
create index if not exists gp_status_idx on public.goofish_pending (status);
create index if not exists gs_fetched_idx on public.goofish_snapshots (fetched_at desc);
