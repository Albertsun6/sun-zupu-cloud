-- =====================================================================
-- 纪要 v0.42 · 长录音(分段录音 + 边录边传兜底)+ 说话人分离按时长开关
-- 运行顺序:在 schema.sql / policies.sql / minutes.sql 之后跑。幂等,可重复跑。
-- 依赖 policies.sql 的 can_minutes()。
-- =====================================================================

-- 1) minutes 加列:diarized(本次转写是否带说话人分离)、segment_count(边录边传的分段数,崩溃兜底用)
alter table public.minutes add column if not exists diarized      boolean default false;
alter table public.minutes add column if not exists segment_count integer default 0;

-- 2) 分段台账(边录边传:每个 timeslice 分片上传后由 CF 服务端登记一行,供崩溃后恢复重拼)
--    真正的整场文件仍是 minutes.audio_path(停止时前端把内存里的同源分片 new Blob 拼好单文件上传)。
--    段仅作【崩溃兜底】:录到一半页面崩了,可据这些段重拼出录音。
create table if not exists public.minute_segments (
  id          bigint generated always as identity primary key,
  minute_id   bigint not null references public.minutes(id) on delete cascade,
  seq         integer not null,                       -- 0,1,2… 分片顺序
  object_path text not null,                          -- recordings 桶 key,如 minutes/<id>/seg-000.webm
  size        bigint default 0,
  created_at  timestamptz not null default now(),
  unique (minute_id, seq)
);
create index if not exists minute_segments_minute_idx on public.minute_segments(minute_id, seq);

-- RLS:有纪要权限者可读(崩溃恢复要列段);写入只由 CF 服务端(service_role)做,不给客户端直写。
alter table public.minute_segments enable row level security;
drop policy if exists "mseg read" on public.minute_segments;
create policy "mseg read" on public.minute_segments for select to authenticated
  using (public.can_minutes());

-- 3) 受控列守卫补充:diarized/segment_count 也只许 service_role 改(普通客户端经 PostgREST 改不动)。
--    重定义 minutes_guard_cols(在 minutes.sql 基础上多护这两列;幂等 create or replace)。
create or replace function public.minutes_guard_cols() returns trigger
language plpgsql as $$
begin
  if current_user <> 'service_role' then
    if TG_OP = 'INSERT' then
      new.status := 'draft';
      new.audio_path := ''; new.audio_mime := ''; new.audio_size := 0; new.duration_sec := 0;
      new.asr_task_id := ''; new.asr_error := '';
      new.transcript := ''; new.transcript_json := '[]'::jsonb;
      new.summary := ''; new.tasks := '[]'::jsonb; new.mindmap := '';
      new.diarized := false; new.segment_count := 0;
    else   -- UPDATE:受控列强制保持原值
      new.status := old.status; new.asr_task_id := old.asr_task_id; new.asr_error := old.asr_error;
      new.transcript := old.transcript; new.transcript_json := old.transcript_json;
      new.summary := old.summary; new.tasks := old.tasks; new.mindmap := old.mindmap;
      new.audio_path := old.audio_path; new.audio_mime := old.audio_mime; new.audio_size := old.audio_size; new.duration_sec := old.duration_sec;
      new.created_by := old.created_by; new.created_by_email := old.created_by_email; new.created_at := old.created_at;
      new.diarized := old.diarized; new.segment_count := old.segment_count;
    end if;
  end if;
  return new;
end $$;
-- 触发器本身已在 minutes.sql 建好(before insert or update),此处只更新函数体。

-- 4) recordings 桶单文件上限提到 200MB(5h 低码率 opus ≈ 50-70MB,原默认 50MB 不够)。
update storage.buckets set file_size_limit = 209715200 where id = 'recordings';   -- 200 MiB

-- 自登记(迁移追踪;schema_migrations 未建时静默跳过)
insert into public.schema_migrations(version) select 'minutes-v042'
  where to_regclass('public.schema_migrations') is not null on conflict (version) do nothing;
