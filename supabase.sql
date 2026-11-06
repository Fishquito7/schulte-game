-- 舒尔特方格 · 全球排行榜表结构（Supabase / Postgres）
-- 用法：Supabase 控制台 → SQL Editor → New query → 整段粘贴 → Run
-- 跑完后到 Project Settings → API 复制 URL 和 anon public key，填进 index.html 的 NET。

create table if not exists public.scores (
  id         bigint generated always as identity primary key,
  name       text         not null default '匿名',
  mode       text         not null,           -- square / radial / star
  size       int          not null,           -- 4 / 5 / 6
  rev        boolean      not null default false,
  t          numeric(6,2) not null,           -- 用时（秒）
  s          int          not null,           -- 评分 0-120
  created_at timestamptz  not null default now(),
  constraint name_len check (char_length(name) between 1 and 12),
  constraint mode_ok  check (mode in ('square','radial','star')),
  constraint size_ok  check (size between 3 and 8),
  constraint time_ok  check (t > 2 and t < 900),
  constraint score_ok check (s between 0 and 120)
);

-- 榜单查询走这个索引：先按模式/尺寸/正倒序过滤，再按用时升序
create index if not exists scores_rank_idx on public.scores (mode, size, rev, t);

-- 行级安全：必须开，否则 anon key 等于裸奔
alter table public.scores enable row level security;

-- 任何人可读
drop policy if exists "scores read" on public.scores;
create policy "scores read" on public.scores for select using (true);

-- 任何人可写，但只能插入“合法”的一行
-- 注意：故意不建 update / delete 策略 —— 匿名用户改不了也删不掉别人的成绩
drop policy if exists "scores insert" on public.scores;
create policy "scores insert" on public.scores for insert with check (
  char_length(name) between 1 and 12
  and mode in ('square', 'radial', 'star')
  and size between 3 and 8
  and t > 2 and t < 900
  and s between 0 and 120
);

-- 可选：只保留每项前 200 名的定时清理（Supabase 支持 pg_cron）
-- select cron.schedule('trim-scores', '0 4 * * *', $$
--   delete from public.scores where id in (
--     select id from (
--       select id, row_number() over (partition by mode, size, rev order by t) rn
--       from public.scores
--     ) x where rn > 200
--   );
-- $$);
