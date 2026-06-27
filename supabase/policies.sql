-- =====================================================================
-- 孙氏族谱 · RLS 策略(邮箱+密码登录;editor 可写 / 任意登录可读)
-- 在 schema.sql 之后运行。幂等。
-- 角色来自 JWT 的 app_metadata.role(在 Supabase 控制台给每个用户设
--   app_metadata = {"role":"editor"} 或 {"role":"viewer"};未设=只读)。
-- 安全要点:未登录(仅 anon key)→ 所有查询被过滤为空 → anon key 公开无害,仓库可公开。
-- 切记:service_role 密钥永不进前端/仓库。
-- =====================================================================

-- 8 张表:任意已登录可读;仅 editor 可增删改
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
                       using ((auth.jwt() #>> '{app_metadata,role}') = 'editor')
                       with check ((auth.jwt() #>> '{app_metadata,role}') = 'editor')$p$, t);
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
  with check (bucket_id='photos' and (auth.jwt() #>> '{app_metadata,role}') = 'editor');
create policy "photos editor update" on storage.objects for update to authenticated
  using (bucket_id='photos' and (auth.jwt() #>> '{app_metadata,role}') = 'editor');
create policy "photos editor delete" on storage.objects for delete to authenticated
  using (bucket_id='photos' and (auth.jwt() #>> '{app_metadata,role}') = 'editor');
-- 公开桶的 select 不需策略(公开可读)。
