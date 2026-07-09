-- =====================================================================
-- 孙氏族谱 · RLS 策略(邮箱+密码登录;editor 可写 / 任意登录可读)
-- 在 schema.sql 之后运行。幂等。
-- 角色来自 JWT 的 app_metadata.role(在 Supabase 控制台给每个用户设
--   app_metadata = {"role":"editor"} 或 {"role":"viewer"};未设=只读)。
-- 安全要点:未登录(仅 anon key)→ 所有查询被过滤为空 → anon key 公开无害,仓库可公开。
-- 切记:service_role 密钥永不进前端/仓库。
-- =====================================================================

-- ---------------------------------------------------------------------
-- 角色/权限助手(读 JWT;stable 因依赖每请求的令牌)。集中定义,避免各处复制 JWT 表达式漂移。
--   can_write()   = role ∈ {editor, admin}(admin 是 editor 超集,也能写数据/传照片)
--   can_minutes() = role=admin 或 app_metadata.perms 数组含 'minutes'(纪要访问)
-- perms 用 #>(取 jsonb)而非 #>>(取 text);coalesce 成 '[]' 保证 ? 不返 NULL(null-safe)。
-- ---------------------------------------------------------------------
create or replace function public.can_write() returns boolean
language sql stable as $$
  select (auth.jwt() #>> '{app_metadata,role}') in ('editor','admin')
$$;
create or replace function public.can_minutes() returns boolean
language sql stable as $$
  select ((auth.jwt() #>> '{app_metadata,role}') = 'admin')
      or coalesce(auth.jwt() #> '{app_metadata,perms}', '[]'::jsonb) ? 'minutes'
$$;

-- 8 张表:任意已登录可读;editor 或 admin 可增删改(can_write)
do $$
declare t text;
begin
  foreach t in array array['persons','marriages','media','narratives',
                           'verify','transcription','meta','history'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "read auth" on public.%I', t);
    execute format('drop policy if exists "write editor" on public.%I', t);
    execute format($p$create policy "read auth" on public.%I
                       for select to authenticated using (true)$p$, t);
    execute format($p$create policy "write editor" on public.%I
                       for all to authenticated
                       using (public.can_write())
                       with check (public.can_write())$p$, t);
  end loop;
end $$;

-- 说明:"read auth" 用 to authenticated → 未登录(anon)读不到任何行。
--      "write editor" 仅当 JWT app_metadata.role='editor' 才放行写。
--      若想让某些表所有登录者可写,可单独放宽;此处统一按 editor。

-- =====================================================================
-- Storage:照片桶 photos(公开读 + editor 可写删)
--   公开桶:图片 URL 可直接访问(对象 key 用 uuid 不可枚举);文字数据仍受上面 RLS 保护。
--   若要更严:把桶设私有 + 改用 createSignedUrl(前端 db.js 里 photoUrl 已留切换点)。
-- =====================================================================
insert into storage.buckets (id, name, public)
values ('photos','photos', true)
on conflict (id) do update set public = true;

drop policy if exists "photos editor write"  on storage.objects;
drop policy if exists "photos editor update" on storage.objects;
drop policy if exists "photos editor delete" on storage.objects;
create policy "photos editor write" on storage.objects for insert to authenticated
  with check (bucket_id='photos' and public.can_write());
create policy "photos editor update" on storage.objects for update to authenticated
  using (bucket_id='photos' and public.can_write());
create policy "photos editor delete" on storage.objects for delete to authenticated
  using (bucket_id='photos' and public.can_write());
-- 公开桶的 select 不需策略(公开可读)。

-- 纪要相关 RLS(minutes 表 + recordings 私有桶)见 minutes.sql(本文件之后运行)。

-- 自登记(迁移追踪;schema_migrations 未建时静默跳过)
insert into public.schema_migrations(version) select 'policies'
  where to_regclass('public.schema_migrations') is not null on conflict (version) do nothing;
