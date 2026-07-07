-- =====================================================================
-- 孙氏族谱 · RPC 函数
-- 在 schema.sql / policies.sql 之后运行。
-- import_full:原子「导入/恢复」——清空全部表后从导出 JSON 重灌(对应本地版 import_full_json)。
--   可写角色(editor|admin,经 can_write())可调用;仅恢复数据图,不恢复 Storage 图片(图片需另行上传)。
--   历史坑(2026-07-07 健康度评审 P1):此处曾硬编码 <> 'editor',v0.41 引入 admin 超集角色后漂移——
--   admin 主账号点「上传JSON恢复」被拒。角色判定一律走 policies.sql 的 can_write()/can_minutes() 助手,禁止内联 role 字符串。
-- =====================================================================
create or replace function public.import_full(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare p jsonb; pid text;
begin
  if not public.can_write() then
    raise exception '需要可写权限(editor 或 admin)';
  end if;
  if not (payload ? 'persons') then
    raise exception '不是有效的族谱备份 JSON(缺 persons)';
  end if;

  -- 用 TRUNCATE 清空(不是 DELETE,绕过 pg_safeupdate 安全删除保护;一次清所有表+重置自增)
  truncate table public.media, public.marriages, public.persons,
                 public.narratives, public.verify, public.transcription, public.meta
                 restart identity cascade;

  insert into public.meta(key, value) values ('meta', coalesce(payload->'meta','{}'::jsonb));

  -- 列清单须与 db.js 的 EDITABLE/CSV_COLS 同步(2026-07-07 补 company——原漏,恢复会丢公司字段)
  insert into public.persons
    (id,gen,char_gen,name,alias,sex,birth,birth_lunar,birth_time,birth_place,death,death_lunar,alive,
     rank,relation_type,kind,father_id,father_note,mother,spouse,occupation,company,residence,burial,
     contact,address,deeds,source,status,note,photo,deleted,deleted_at,sort_order)
  select
     pj->>'id', coalesce(pj->>'gen',''), coalesce(pj->>'char_gen',''), coalesce(pj->>'name',''),
     coalesce(pj->>'alias',''), coalesce(pj->>'sex',''), coalesce(pj->>'birth',''),
     coalesce(pj->>'birth_lunar',''), coalesce(pj->>'birth_time',''), coalesce(pj->>'birth_place',''), coalesce(pj->>'death',''),
     coalesce(pj->>'death_lunar',''), coalesce(pj->>'alive',''), coalesce(pj->>'rank',''),
     coalesce(pj->>'relation_type',''), coalesce(pj->>'kind','本族'), coalesce(pj->>'father_id',''), coalesce(pj->>'father_note',''),
     coalesce(pj->>'mother',''), coalesce(pj->>'spouse',''), coalesce(pj->>'occupation',''), coalesce(pj->>'company',''),
     coalesce(pj->>'residence',''), coalesce(pj->>'burial',''), coalesce(pj->>'contact',''),
     coalesce(pj->>'address',''), coalesce(pj->>'deeds',''), coalesce(pj->>'source',''),
     coalesce(pj->>'status',''), coalesce(pj->>'note',''), coalesce(pj->>'photo',''),
     coalesce((pj->>'deleted')::int,0), coalesce(pj->>'deleted_at',''), coalesce((pj->>'sort_order')::int,0)
  from jsonb_array_elements(payload->'persons') pj;

  for p in select value from jsonb_array_elements(payload->'persons') loop
    pid := p->>'id';
    insert into public.marriages(person_id,spouse,spouse_family,marriage_year,relation,note,sort_order)
    select pid, coalesce(m->>'spouse',''), coalesce(m->>'spouse_family',''), coalesce(m->>'marriage_year',''),
           coalesce(m->>'relation',''), coalesce(m->>'note',''), coalesce((m->>'sort_order')::int,0)
    from jsonb_array_elements(coalesce(p->'marriages','[]'::jsonb)) m;
    insert into public.media(person_id,path,caption,is_primary,sort_order)
    select pid, coalesce(md->>'path',''), coalesce(md->>'caption',''),
           coalesce((md->>'is_primary')::int,0), coalesce((md->>'sort_order')::int,0)
    from jsonb_array_elements(coalesce(p->'media','[]'::jsonb)) md;
  end loop;

  insert into public.narratives(key,title,text,sort_order)
  select n->>'key', coalesce(n->>'title',''), coalesce(n->>'text',''), coalesce((n->>'sort_order')::int,0)
  from jsonb_array_elements(coalesce(payload->'narratives','[]'::jsonb)) n;

  insert into public.verify(category,topic,detail,status,resolution,date,sort_order)
  select coalesce(v->>'category',''), coalesce(v->>'topic',''), coalesce(v->>'detail',''),
         coalesce(v->>'status',''), coalesce(v->>'resolution',''), coalesce(v->>'date',''),
         coalesce((v->>'sort_order')::int,0)
  from jsonb_array_elements(coalesce(payload->'verify','[]'::jsonb)) v;

  insert into public.transcription(page,label,text,sort_order)
  select t->>'page', coalesce(t->>'label',''), coalesce(t->>'text',''), coalesce((t->>'sort_order')::int,0)
  from jsonb_array_elements(coalesce(payload->'transcription','[]'::jsonb)) t;

  -- 关系类型(备份若含则 upsert,保留自定义类型;不删现有,避免 relationships FK 失效)
  insert into public.relationship_types(type,label_zh,forward_label,inverse_label,is_symmetric,category,color,sort_order)
  select rt->>'type', coalesce(rt->>'label_zh',''), coalesce(rt->>'forward_label',''), coalesce(rt->>'inverse_label',''),
         coalesce((rt->>'is_symmetric')::boolean,false), coalesce(rt->>'category',''), coalesce(rt->>'color',''), coalesce((rt->>'sort_order')::int,0)
  from jsonb_array_elements(coalesce(payload->'relationship_types','[]'::jsonb)) rt
  on conflict (type) do update set label_zh=excluded.label_zh, forward_label=excluded.forward_label,
    inverse_label=excluded.inverse_label, is_symmetric=excluded.is_symmetric, category=excluded.category,
    color=excluded.color, sort_order=excluded.sort_order;

  -- 关系边(persons 重灌后再插;truncate persons 已 cascade 清空旧关系)。跳过端点/类型缺失的边,防 FK 报错。
  insert into public.relationships(from_id,to_id,type,directed,start_date,end_date,note)
  select r->>'from_id', r->>'to_id', r->>'type', coalesce((r->>'directed')::boolean,true),
         coalesce(r->>'start_date',''), coalesce(r->>'end_date',''), coalesce(r->>'note','')
  from jsonb_array_elements(coalesce(payload->'relationships','[]'::jsonb)) r
  where exists(select 1 from public.persons p where p.id=r->>'from_id')
    and exists(select 1 from public.persons p where p.id=r->>'to_id')
    and exists(select 1 from public.relationship_types t where t.type=r->>'type')
  on conflict (from_id,to_id,type) do nothing;

  insert into public.history(ts,action,entity,entity_id,summary)
  values (to_char(now(),'YYYY-MM-DD HH24:MI:SS'),'import','db','-',
          '导入JSON恢复,人物 ' || jsonb_array_length(payload->'persons'));

  return jsonb_build_object('ok', true, 'persons', jsonb_array_length(payload->'persons'));
end $$;

revoke all on function public.import_full(jsonb) from anon, public;
grant execute on function public.import_full(jsonb) to authenticated;
