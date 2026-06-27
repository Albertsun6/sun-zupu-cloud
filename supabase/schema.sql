-- =====================================================================
-- 孙氏族谱 · Supabase Postgres schema
-- 在 Supabase 控制台 SQL Editor 里整段粘贴运行(幂等,可重复跑)。
-- 镜像本地 SQLite 结构;persons.id 保持 TEXT(S###);软删/历史/婚姻/相册齐全。
-- =====================================================================

create table if not exists public.persons (
  id            text primary key,
  gen           text default '',
  char_gen      text default '',
  name          text default '',
  alias         text default '',
  sex           text default '',
  birth         text default '',
  birth_lunar   text default '',
  birth_time    text default '',     -- 出生时间(时:分),时辰自动附在后
  birth_place   text default '',
  death         text default '',
  death_lunar   text default '',
  alive         text default '',
  rank          text default '',
  relation_type text default '',
  kind          text default '本族',   -- 本族 / 外部(非家族成员)
  father_id     text default '',     -- 故意不设外键(purge 会置空、体检要查悬空父)
  father_note   text default '',
  mother        text default '',
  spouse        text default '',
  occupation    text default '',
  residence     text default '',
  burial        text default '',
  contact       text default '',     -- 敏感
  address       text default '',     -- 敏感
  deeds         text default '',
  source        text default '',
  status        text default '',
  note          text default '',
  photo         text default '',     -- 主图 Storage object key(由 is_primary 镜像)
  deleted       integer default 0,
  deleted_at    text default '',
  sort_order    integer default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists persons_father_idx  on public.persons(father_id);
create index if not exists persons_deleted_idx on public.persons(deleted);

create table if not exists public.marriages (
  id            bigint generated always as identity primary key,
  person_id     text not null references public.persons(id) on delete cascade,
  spouse        text default '',
  spouse_family text default '',
  marriage_year text default '',
  relation      text default '',
  note          text default '',
  sort_order    integer default 0
);
create index if not exists marriages_person_idx on public.marriages(person_id);

create table if not exists public.media (
  id          bigint generated always as identity primary key,
  person_id   text not null references public.persons(id) on delete cascade,
  path        text default '',       -- Storage object key,如 people/S012/<uuid>.jpg
  caption     text default '',
  is_primary  integer default 0,
  sort_order  integer default 0
);
create index if not exists media_person_idx on public.media(person_id);

create table if not exists public.narratives (
  key        text primary key,
  title      text default '',
  text       text default '',
  sort_order integer default 0
);

create table if not exists public.verify (
  id         bigint generated always as identity primary key,
  category   text default '',
  topic      text default '',
  detail     text default '',
  status     text default '',
  resolution text default '',
  date       text default '',
  sort_order integer default 0
);

create table if not exists public.transcription (
  page       text primary key,       -- p1..p4
  label      text default '',
  text       text default '',
  sort_order integer default 0
);

create table if not exists public.meta (
  key   text primary key,            -- 'meta'
  value jsonb not null default '{}'::jsonb
);

create table if not exists public.history (
  id        bigint generated always as identity primary key,
  ts        text,                    -- 应用层字符串时间戳
  action    text,
  entity    text,
  entity_id text,
  summary   text,
  before    text,                    -- JSON 字符串(前端 diff 用 JSON.parse)
  after     text,
  undone    integer default 0,
  created_at timestamptz not null default now()
);
