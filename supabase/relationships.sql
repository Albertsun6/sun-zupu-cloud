-- =====================================================================
-- 孙氏族谱 → 通用「人 + 关系图谱」· 关系数据层
-- 在 schema.sql / policies.sql / functions.sql 之后运行(幂等,可重复跑)。
-- 设计:persons 仍是唯一人源;relationships 为有类型有方向的边表;
--       relationship_types 为可扩展字典(加类型只 insert 一行,不改 schema)。
--       现有 father_id 迁成 type='father' 的有向边,且 father_id 列保留对照、不删。
-- =====================================================================

-- 1) 关系类型字典:中文名 / 正反称谓 / 是否对称 / 分组 / 颜色
create table if not exists public.relationship_types (
  type          text primary key,        -- father|mother|spouse|sibling|friend|colleague|teacher|boss|partner...
  label_zh      text not null,           -- 显示名:父子/母子/夫妻/同事...
  forward_label text default '',         -- 有向时 from→to 一侧称谓(father 的 to 侧='子女')
  inverse_label text default '',         -- 反向一侧称谓(father 的 from 侧='父')
  is_symmetric  boolean not null default false,  -- 对称(夫妻/朋友/同事)=true(symmetric 是保留字)
  category      text default '',         -- 亲属|工作|社交
  color         text default '',         -- 图谱边/图例颜色
  sort_order    integer default 0
);
insert into public.relationship_types(type,label_zh,forward_label,inverse_label,is_symmetric,category,color,sort_order) values
  ('father','父子','子女','父',      false,'亲属','#c0392b',10),
  ('mother','母子','子女','母',      false,'亲属','#e67e22',20),
  ('spouse','夫妻','配偶','配偶',    true ,'亲属','#8e44ad',30),
  ('sibling','兄弟姐妹','','',        true ,'亲属','#16a085',40),
  ('friend','朋友','',  '',          true ,'社交','#2980b9',50),
  ('colleague','同事','','',         true ,'工作','#27ae60',60),
  ('teacher','师生','学生','老师',   false,'工作','#d35400',70),
  ('boss','上下级','下属','上级',    false,'工作','#7f8c8d',80),
  ('partner','合作','', '',          true ,'工作','#2c3e50',90)
on conflict (type) do nothing;

-- 2) 关系(边)表:from/to/类型/方向/起止/备注
create table if not exists public.relationships (
  id         bigint generated always as identity primary key,
  from_id    text not null references public.persons(id) on delete cascade,
  to_id      text not null references public.persons(id) on delete cascade,
  type       text not null references public.relationship_types(type),
  directed   boolean not null default true,   -- 有向(父子/师生/上下级)=true;对称(夫妻/朋友/同事)=false
  start_date text default '',                 -- 关系起(婚配年/入职年…),沿用 TEXT 日期风格
  end_date   text default '',
  note       text default '',
  created_at timestamptz not null default now(),
  constraint rel_no_self check (from_id <> to_id)
);
create index if not exists rel_from_idx on public.relationships(from_id);
create index if not exists rel_to_idx   on public.relationships(to_id);
create index if not exists rel_type_idx on public.relationships(type);
create unique index if not exists rel_uniq on public.relationships(from_id,to_id,type); -- 同对人+同类型防重

-- 3) 双向视图:对称边展开成两向,前端/查询统一从 from 出发
--    security_invoker=true:视图按【查询者】权限跑、尊重 relationships 的 RLS。
--    否则视图以创建者(postgres)权限跑 = 绕过 RLS,anon 仅凭 anon key 即可经视图读到全部关系边
--    (Supabase linter「Security Definer View」CRITICAL;2026-07-01 实测确为真泄露,本视图前端未用)。
create or replace view public.relationships_bidir
  with (security_invoker = true) as
  select id, from_id, to_id, type, directed, start_date, end_date, note from public.relationships
  union all
  select id, to_id as from_id, from_id as to_id, type, directed, start_date, end_date, note
  from public.relationships where directed = false;

-- 4) RLS(对齐 policies.sql:authenticated 读、can_write()=role∈{editor,admin} 写)
--    历史坑:此处曾硬编码 ='editor',v0.41 引入 admin 超级角色后漂移——admin 能写 persons 却写不了
--    relationships,「新建人物并连上」建了孤儿人物却连不上边(2026-07-01 修)。改用 policies.sql 的 can_write()。
alter table public.relationships      enable row level security;
alter table public.relationship_types enable row level security;
drop policy if exists "rel read"  on public.relationships;
drop policy if exists "rel write" on public.relationships;
drop policy if exists "rt read"   on public.relationship_types;
drop policy if exists "rt write"  on public.relationship_types;
create policy "rel read"  on public.relationships      for select to authenticated using (true);
create policy "rel write" on public.relationships      for all to authenticated
  using (public.can_write())
  with check (public.can_write());
create policy "rt read"   on public.relationship_types for select to authenticated using (true);
create policy "rt write"  on public.relationship_types for all to authenticated
  using (public.can_write())
  with check (public.can_write());

-- 5) 迁移:每条非空且非悬空的 father_id → 一条有向 father 边(from=父, to=子)
--    跳过悬空父(=数据体检查的那种);father_id 列保留对照,不删。
insert into public.relationships(from_id, to_id, type, directed, note)
  select p.father_id, p.id, 'father', true, coalesce(p.father_note,'')
  from public.persons p
  where coalesce(p.deleted,0)=0
    and coalesce(p.father_id,'') <> ''
    and exists (select 1 from public.persons f where f.id = p.father_id)
  on conflict (from_id,to_id,type) do nothing;

-- 自登记(迁移追踪;schema_migrations 未建时静默跳过)
insert into public.schema_migrations(version) select 'relationships'
  where to_regclass('public.schema_migrations') is not null on conflict (version) do nothing;
