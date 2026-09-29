-- =====================================================================
-- 迁移登记表 v0.48 · 记录"线上库跑过哪些 SQL",防再发生"漏跑 minutes-v042/047 → 400"那类事故
-- 运行顺序:新库排第一个跑(先有登记表,之后每份 SQL 的自登记行才落得下);现网库随时可跑,幂等。
-- 跑完 probes/check-migrations.mjs 就能核对线上缺哪份 SQL。
-- =====================================================================

create table if not exists public.schema_migrations (
  version    text primary key,          -- = SQL 文件基名(不含 .sql),如 'minutes-v047'
  applied_at timestamptz not null default now()
);

-- 版本串非敏感,连 anon(未登录)也放行读——探针无凭证即可核对,CI 也能跑。
-- 这是全库唯一 anon 可读的表,已在 CLAUDE.md 安全模型记为例外;写没有任何策略=只有手动跑 SQL(owner/service_role)能写。
alter table public.schema_migrations enable row level security;
drop policy if exists "mig read" on public.schema_migrations;
create policy "mig read" on public.schema_migrations for select to anon, authenticated using (true);

-- 追溯登记:下列文件在现网库确实都跑过,补记事实。
-- 重建新库时本段也无害——重建流程本来就是按序跑完全部文件,登记与事实最终一致;
-- 但若只跑了本文件就中途停手,登记会先于事实,check-migrations 此时的"全绿"不可信。
insert into public.schema_migrations(version) values
  ('schema'), ('policies'), ('functions'), ('relationships'),
  ('minutes'), ('minutes-v042'), ('minutes-v047'),
  ('bootstrap-admin'), ('migrations-registry')
on conflict (version) do nothing;

-- 【约定,ship-checks 有门禁】每个 supabase/*.sql 文件末尾都带一行自登记(登记表还没建时静默跳过):
--   insert into public.schema_migrations(version) select '<文件基名>'
--     where to_regclass('public.schema_migrations') is not null on conflict (version) do nothing;
