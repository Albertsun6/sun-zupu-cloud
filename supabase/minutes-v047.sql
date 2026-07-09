-- =====================================================================
-- 纪要 v0.47 · 说话人改名(speaker_id → 真名映射)
-- 运行顺序:在 minutes.sql / minutes-v042.sql 之后跑。幂等,可重复跑。
-- =====================================================================

-- speaker_names:{ "0":"孙德龙", "1":"李英娜" } —— 把转写的说话人编号映射成真名。
-- 用户可改的普通标注列(同 title/note),【不进】受控列守卫 minutes_guard_cols,故任何有纪要权限者
-- 经 PostgREST 直接 update 即可(RLS = can_minutes() 把门)。改一处、同编号全场同步(前端按此 map 渲染)。
alter table public.minutes add column if not exists speaker_names jsonb not null default '{}'::jsonb;

-- 约束(评审加固):必须是 jsonb 对象、且序列化后 ≤2000 字符(约 40 个说话人×40 字名,远超真实需要)。
-- 目的:客户端经 PostgREST 直写此列,若不限制,超长名会被逐段注入 AI prompt 撑爆正文(挤过 8 块上限丢后文),
-- 且 '"abc"' 这类非对象值会让前端把字符串当对象索引。CHECK 在 DB 侧 fail-closed,任何写入路径都挡。
alter table public.minutes drop constraint if exists minutes_speaker_names_ck;
alter table public.minutes add constraint minutes_speaker_names_ck
  check (jsonb_typeof(speaker_names) = 'object' and length(speaker_names::text) <= 2000);

-- 说明:无需改 minutes_guard_cols —— 该守卫只把它显式列出的受控列(status/asr_*/transcript*/audio_*/
-- diarized/segment_count 等)强制为安全值,不在清单里的列(title/meeting_at/note/speaker_names)客户端可写。
