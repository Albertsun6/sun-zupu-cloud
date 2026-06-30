-- =====================================================================
-- 纪要(minutes)· RLS + 触发器 + recordings 私有桶
-- 运行顺序:schema.sql(建 minutes 表)→ policies.sql(定义 can_minutes 助手)→ 本文件。幂等,可重复跑。
-- 访问 = can_minutes()(role=admin 或 app_metadata.perms 含 'minutes');无权者读不到任何纪要、看不到录音。
-- 切记:service_role 永不进前端/仓库。
-- =====================================================================

-- ---------- 作者服务端强制(防前端伪造 created_by / created_by_email)----------
-- security definer 以便读 auth.users.email;search_path 固定(安全)。
create or replace function public.minutes_set_author() returns trigger
language plpgsql security definer set search_path = public, auth as $$
begin
  new.created_by := auth.uid();
  new.created_by_email := coalesce((select email from auth.users where id = auth.uid()), '');
  return new;
end $$;
drop trigger if exists minutes_author on public.minutes;
create trigger minutes_author before insert on public.minutes
  for each row execute function public.minutes_set_author();

-- ---------- updated_at 自动维护 ----------
create or replace function public.minutes_touch() returns trigger
language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists minutes_touch_trg on public.minutes;
create trigger minutes_touch_trg before update on public.minutes
  for each row execute function public.minutes_touch();

-- ---------- 受控列守卫(防客户端任意改列;跨模型评审 M1/M2/M3)----------
-- 普通登录用户(authenticated)经 PostgREST 只能改 title/meeting_at/note;
-- 状态机/转写/音频/作者/审计列只许 service_role(即 CF 函数 minutes.js 服务端)改。
-- 这样:① 客户端无法从控制台把 status 改回 uploaded 重复提交转写(双计费);
--       ② 无法把 audio_path 指向他人/任意对象骗签名URL;③ 无法伪造作者/创建时间。
create or replace function public.minutes_guard_cols() returns trigger
language plpgsql as $$
begin
  if current_user <> 'service_role' then
    if TG_OP = 'INSERT' then
      -- 普通客户端新建:受控列一律安全默认(防直接 insert 伪造 status/audio_path/transcript 等绕过 CF 管线)。
      -- 作者列由 minutes_set_author 触发器设;此处不动 created_by/created_by_email。
      new.status := 'draft';
      new.audio_path := ''; new.audio_mime := ''; new.audio_size := 0; new.duration_sec := 0;
      new.asr_task_id := ''; new.asr_error := '';
      new.transcript := ''; new.transcript_json := '[]'::jsonb;
      new.summary := ''; new.tasks := '[]'::jsonb; new.mindmap := '';
    else   -- UPDATE:受控列强制保持原值
      new.status          := old.status;
      new.asr_task_id     := old.asr_task_id;
      new.asr_error       := old.asr_error;
      new.transcript      := old.transcript;
      new.transcript_json := old.transcript_json;
      new.summary         := old.summary;
      new.tasks           := old.tasks;
      new.mindmap         := old.mindmap;
      new.audio_path      := old.audio_path;
      new.audio_mime      := old.audio_mime;
      new.audio_size      := old.audio_size;
      new.duration_sec    := old.duration_sec;
      new.created_by      := old.created_by;
      new.created_by_email:= old.created_by_email;
      new.created_at      := old.created_at;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists minutes_guard_cols_trg on public.minutes;
create trigger minutes_guard_cols_trg before insert or update on public.minutes
  for each row execute function public.minutes_guard_cols();

-- ---------- minutes 表 RLS:仅 can_minutes() 可读写(家族共享纪要,任一有权者可管理)----------
alter table public.minutes enable row level security;
drop policy if exists "minutes read"   on public.minutes;
drop policy if exists "minutes insert" on public.minutes;
drop policy if exists "minutes update" on public.minutes;
drop policy if exists "minutes delete" on public.minutes;
create policy "minutes read"   on public.minutes for select to authenticated
  using (public.can_minutes());
create policy "minutes insert" on public.minutes for insert to authenticated
  with check (public.can_minutes() and created_by = auth.uid());   -- 触发器已置 created_by=auth.uid(),此为双保险
create policy "minutes update" on public.minutes for update to authenticated
  using (public.can_minutes()) with check (public.can_minutes());
create policy "minutes delete" on public.minutes for delete to authenticated
  using (public.can_minutes());

-- ---------- recordings 私有桶(签名URL 访问;永不自动删)----------
-- 私有:public=false → 无签名链接拿不到音频;录音较敏感故不公开。
insert into storage.buckets (id, name, public)
values ('recordings','recordings', false)
on conflict (id) do update set public = false;

-- 写入(上传)只走 CF 函数 service_role 签发的【签名上传URL】(前端 uploadToSignedUrl,token 授权、不经 RLS),
-- 故【不给】客户端 insert/update/delete 策略 —— 否则有纪要权限者可经 storage-api 覆盖/删除他人录音(完整性破坏,跨模型评审 Medium)。
-- 仅保留 select(桶级 can_minutes;回放实际走 CF play-url 的 service_role 签名URL,此 select 仅为防御性保留)。
drop policy if exists "recordings minutes select" on storage.objects;
drop policy if exists "recordings minutes insert" on storage.objects;
drop policy if exists "recordings minutes update" on storage.objects;
drop policy if exists "recordings minutes delete" on storage.objects;
create policy "recordings minutes select" on storage.objects for select to authenticated
  using (bucket_id='recordings' and public.can_minutes());
