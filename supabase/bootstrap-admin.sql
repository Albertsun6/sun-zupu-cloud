-- =====================================================================
-- 引导第一个管理员(一次性)。在 Supabase 控制台 SQL Editor 里跑一次。
-- 之后即可在网页「👤 用户管理」里自助建号 / 改角色 / 开关纪要 / 改密 / 停用 / 删除。
-- 原理:网页与 RLS 读的是 JWT 里的 app_metadata,它来自 auth.users.raw_app_meta_data。
--       用 `||` 合并,保留 provider 等既有键;只覆盖 role / perms。
-- 注意:改完该用户【需重新登录】才会拿到带新 app_metadata 的 JWT(角色/权限才生效)。
-- 用时把下面的 admin@example.com 换成你自己的管理员邮箱后再跑。
-- =====================================================================
update auth.users
set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"role":"admin","perms":["minutes"]}'::jsonb
where email = 'admin@example.com';   -- ← 用时改成你自己的管理员邮箱

-- 核对(应看到 role=admin、perms 含 minutes):
-- select email, raw_app_meta_data->>'role' as role, raw_app_meta_data->'perms' as perms
--   from auth.users where email = 'admin@example.com';

-- 自登记(迁移追踪;schema_migrations 未建时静默跳过)
insert into public.schema_migrations(version) select 'bootstrap-admin'
  where to_regclass('public.schema_migrations') is not null on conflict (version) do nothing;
