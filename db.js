// ============================================================
// db.js —— 数据访问层(前后端分离的"后端"= Supabase)
// 用 supabase-js 复刻原 server.py 的 REST 行为:
//   - 提供全局 api(method,path,body),让 app.js 的 ~30 处调用零改动
//   - 登录/角色(window.SBAUTH);照片 Storage(window.photoUrl)
//   - 写操作补写 history(撤销靠它);editor 可写、viewer 只读(RLS 兜底)
//   - 导出 CSV/GEDCOM/分享HTML/JSON 改为客户端生成(window.EXPORT)
// ============================================================
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const SB = window.SB || {};
if (!SB.url || !SB.anon) console.warn("config.js 未填 Supabase url/anon");
const sb = createClient(SB.url || "https://placeholder.supabase.co", SB.anon || "placeholder",
  { auth: { persistSession: true, autoRefreshToken: true } });
window.sb = sb;

const EDITABLE = ["gen","char_gen","name","alias","sex","birth","birth_lunar","birth_time","birth_place",
  "death","death_lunar","alive","rank","relation_type","kind","father_id","father_note","mother",
  "spouse","occupation","residence","burial","contact","address","deeds","source","status","note"];
const MARRIAGE_FIELDS = ["spouse","spouse_family","marriage_year","relation","note"];
const BUCKET = "photos";
const dec = decodeURIComponent;

// ---------- 登录/角色 ----------
async function currentUser(){ const { data } = await sb.auth.getUser(); return data.user; }
function roleOf(u){ return (u && u.app_metadata && u.app_metadata.role) || "viewer"; }
window.SBAUTH = {
  sb,
  getSession: async () => (await sb.auth.getSession()).data.session,
  signIn: (email, password) => sb.auth.signInWithPassword({ email, password }),
  signOut: () => sb.auth.signOut(),
  updatePassword: (password) => sb.auth.updateUser({ password }),   // 登录态下改自己密码
  user: currentUser,
  role: async () => roleOf(await currentUser()),
  onChange: (cb) => sb.auth.onAuthStateChange((_e, s) => cb(s)),
};

// ---------- 照片 URL(公开桶,直接公链) ----------
window.photoUrl = (key) => key ? sb.storage.from(BUCKET).getPublicUrl(key).data.publicUrl : "";

// ---------- 工具 ----------
function nowStr(){ const d=new Date(), p=n=>String(n).padStart(2,"0");
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; }
function must(res){ if(res.error) throw new Error(res.error.message||String(res.error)); return res.data; }
async function logHist(action, entity, entity_id, summary, before, after){
  try{ await sb.from("history").insert({ ts:nowStr(), action, entity, entity_id:String(entity_id),
    summary: summary||"", before: before!=null?JSON.stringify(before):"", after: after!=null?JSON.stringify(after):"", undone:0 }); }
  catch(e){ console.warn("history 写入失败", e); }
}
function dataUrlToBlob(dataUrl){
  const [meta, b64] = String(dataUrl).split(",");
  const mime = (meta.match(/data:([^;]+)/)||[])[1] || "image/jpeg";
  const bin = atob(b64||""); const arr = new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) arr[i]=bin.charCodeAt(i);
  return { blob: new Blob([arr], { type:mime }), mime };
}
const EXT = { "image/jpeg":"jpg","image/png":"png","image/webp":"webp","image/gif":"gif" };

// ---------- persons ----------
async function listPersons(onlyDeleted){
  let q = sb.from("persons").select("*").order("sort_order").order("id");
  q = onlyDeleted ? q.eq("deleted",1) : q.eq("deleted",0);
  return must(await q);
}
async function nextId(){
  const rows = must(await sb.from("persons").select("id"));
  let mx=0; rows.forEach(r=>{ const m=/^[A-Za-z](\d+)/.exec(r.id||""); if(m) mx=Math.max(mx,+m[1]); });
  return "S"+String(mx+1).padStart(3,"0");
}
async function getPerson(pid){ return must(await sb.from("persons").select("*").eq("id",pid).maybeSingle()); }
async function createPerson(body){
  const pid = (body.id||"").trim() || await nextId();
  if(await getPerson(pid)) throw new Error("ID 已存在: "+pid);
  const rec = { id:pid }; EDITABLE.forEach(k=> rec[k]= body[k]!=null?body[k]:"");
  const row = must(await sb.from("persons").insert(rec).select().single());
  await logHist("create","person",pid,"新增人物: "+(body.name||pid), null, { id:pid, ...Object.fromEntries(EDITABLE.map(k=>[k,body[k]||""])) });
  return row;
}
async function updatePerson(pid, body){
  const before = await getPerson(pid); if(!before) throw new Error("人物不存在: "+pid);
  const patch={}; EDITABLE.forEach(k=>{ if(k in body) patch[k]=body[k]; }); patch.updated_at=nowStr();
  const row = must(await sb.from("persons").update(patch).eq("id",pid).select().single());
  const changed = EDITABLE.some(k=> (before[k]||"")!==(row[k]||""));
  if(changed) await logHist("update","person",pid,"修改人物: "+(row.name||pid), before, row);
  return row;
}
async function softDelete(pid){
  const before = await getPerson(pid); if(!before) throw new Error("人物不存在");
  must(await sb.from("persons").update({ deleted:1, deleted_at:nowStr() }).eq("id",pid));
  await logHist("delete","person",pid,"移入回收站: "+(before.name||pid), before, null);
  return { ok:true };
}
async function restorePerson(pid){
  must(await sb.from("persons").update({ deleted:0, deleted_at:"" }).eq("id",pid));
  await logHist("restore","person",pid,"从回收站恢复: "+pid);
  return { ok:true };
}
async function purgePerson(pid){
  const before = await getPerson(pid); if(!before) return { ok:true };
  must(await sb.from("persons").update({ father_id:"" }).eq("father_id",pid));   // 子女断父链
  const media = must(await sb.from("media").select("path").eq("person_id",pid));
  const keys = media.map(m=>m.path).filter(Boolean);
  if(keys.length){ try{ await sb.storage.from(BUCKET).remove(keys); }catch(e){} }
  must(await sb.from("media").delete().eq("person_id",pid));
  must(await sb.from("marriages").delete().eq("person_id",pid));
  must(await sb.from("persons").delete().eq("id",pid));
  await logHist("purge","person",pid,"彻底删除: "+(before.name||pid), before, null);
  return { ok:true };
}
async function reinsertPerson(row){
  const rec={}; ["id",...EDITABLE,"photo","deleted","deleted_at","sort_order"].forEach(k=>{ if(k in row) rec[k]=row[k]; });
  must(await sb.from("persons").upsert(rec));
}

// ---------- marriages ----------
async function listMarriages(pid){ return must(await sb.from("marriages").select("*").eq("person_id",pid).order("sort_order").order("id")); }
async function addMarriage(pid, body){
  const rec={ person_id:pid, sort_order:999 }; MARRIAGE_FIELDS.forEach(k=> rec[k]=body[k]||"");
  const row = must(await sb.from("marriages").insert(rec).select().single());
  await logHist("update","marriage",pid,"新增婚姻: "+(body.spouse||""));
  return row;
}
async function updateMarriage(mid, body){
  const patch={}; MARRIAGE_FIELDS.forEach(k=>{ if(k in body) patch[k]=body[k]; });
  const row = must(await sb.from("marriages").update(patch).eq("id",mid).select().single());
  await logHist("update","marriage",row.person_id,"修改婚姻");
  return row;
}
async function delMarriage(mid){
  const row = must(await sb.from("marriages").select("*").eq("id",mid).maybeSingle());
  if(!row) return { ok:true };
  must(await sb.from("marriages").delete().eq("id",mid));
  await logHist("delete","marriage",row.person_id,"删除婚姻: "+(row.spouse||""), row, null);
  return { ok:true };
}
async function reinsertMarriage(row){
  const rec={}; ["person_id","spouse","spouse_family","marriage_year","relation","note","sort_order"].forEach(k=>{ if(k in row) rec[k]=row[k]; });
  must(await sb.from("marriages").insert(rec));
}

// ---------- media / 相册 ----------
async function listMedia(pid){ return must(await sb.from("media").select("*").eq("person_id",pid).order("is_primary",{ascending:false}).order("sort_order").order("id")); }
async function refreshPrimary(pid){
  const rows = must(await sb.from("media").select("id,path,is_primary,sort_order").eq("person_id",pid).order("sort_order").order("id"));
  const prim = rows.find(r=>r.is_primary);
  if(prim){ must(await sb.from("persons").update({photo:prim.path}).eq("id",pid)); }
  else if(rows.length){ must(await sb.from("media").update({is_primary:1}).eq("id",rows[0].id));
    must(await sb.from("persons").update({photo:rows[0].path}).eq("id",pid)); }
  else { must(await sb.from("persons").update({photo:""}).eq("id",pid)); }
}
async function addMedia(pid, body){
  if(!(await getPerson(pid))) throw new Error("人物不存在");
  const { blob, mime } = dataUrlToBlob(body.dataUrl);
  if(blob.size > 12*1024*1024) throw new Error("图片过大(>12MB)");
  const ext = EXT[mime] || (body.filename||"").split(".").pop() || "jpg";
  const key = `people/${pid}/${crypto.randomUUID()}.${ext}`;
  const up = await sb.storage.from(BUCKET).upload(key, blob, { contentType:mime, upsert:false });
  if(up.error) throw new Error("上传失败: "+up.error.message);
  const row = must(await sb.from("media").insert({ person_id:pid, path:key, caption:body.caption||"", is_primary:0, sort_order:999 }).select().single());
  await refreshPrimary(pid);
  await logHist("photo","person",pid,"上传照片");
  return row;
}
async function updateMedia(mid, body){
  const cur = must(await sb.from("media").select("person_id").eq("id",mid).maybeSingle());
  if(!cur) throw new Error("照片不存在");
  const pid = cur.person_id;
  if("caption" in body) must(await sb.from("media").update({caption:body.caption}).eq("id",mid));
  if(body.is_primary){ must(await sb.from("media").update({is_primary:0}).eq("person_id",pid));
    must(await sb.from("media").update({is_primary:1}).eq("id",mid)); }
  await refreshPrimary(pid);
  return must(await sb.from("media").select("*").eq("id",mid).single());
}
async function delMedia(mid){
  const row = must(await sb.from("media").select("*").eq("id",mid).maybeSingle());
  if(!row) return { ok:true };
  must(await sb.from("media").delete().eq("id",mid));   // 保留 Storage 文件以便撤销
  await refreshPrimary(row.person_id);
  await logHist("delete","media",row.person_id,"删除照片", row, null);
  return { ok:true };
}
async function reinsertMedia(row){
  const rec={}; ["person_id","path","caption","is_primary","sort_order"].forEach(k=>{ if(k in row) rec[k]=row[k]; });
  must(await sb.from("media").insert(rec)); await refreshPrimary(row.person_id);
}

// ---------- meta / narratives / verify / transcription ----------
async function getMeta(){ const r = must(await sb.from("meta").select("value").eq("key","meta").maybeSingle()); return r ? r.value : {}; }
async function putMeta(body){ must(await sb.from("meta").upsert({ key:"meta", value:body })); await logHist("update","meta","meta","修改谱头信息"); return body; }
async function listNarratives(){ return must(await sb.from("narratives").select("*").order("sort_order")); }
async function putNarrative(key, body){ must(await sb.from("narratives").upsert({ key, title:body.title||"", text:body.text||"" })); await logHist("update","narrative",key,"修改家史: "+(body.title||key)); return { key, ...body }; }
async function listVerify(){ return must(await sb.from("verify").select("*").order("sort_order").order("id")); }
async function createVerify(body){ const rec={ sort_order:999 }; ["category","topic","detail","status","resolution","date"].forEach(k=> rec[k]=body[k]!=null?body[k]:(k==="status"?"待考":"")); const row=must(await sb.from("verify").insert(rec).select().single()); await logHist("create","verify",row.id,"新增待核实项"); return row; }
async function updateVerify(vid, body){ const patch={}; ["category","topic","detail","status","resolution","date"].forEach(k=>{ if(k in body) patch[k]=body[k]; }); const row=must(await sb.from("verify").update(patch).eq("id",vid).select().single()); await logHist("update","verify",vid,"更新待核实: "+(body.topic||vid)); return row; }
async function delVerify(vid){ must(await sb.from("verify").delete().eq("id",vid)); await logHist("delete","verify",vid,"删除待核实项"); return { ok:true }; }
async function listTranscription(){ return must(await sb.from("transcription").select("*").order("sort_order")); }
async function listHistory(){ return must(await sb.from("history").select("*").order("id",{ascending:false}).limit(300)); }

// ---------- 撤销 ----------
const UNDOABLE = new Set(["create:person","update:person","delete:person","purge:person","delete:marriage","delete:media"]);
async function undo(hid){
  const h = must(await sb.from("history").select("*").eq("id",hid).maybeSingle());
  if(!h) throw new Error("记录不存在");
  if(h.undone) throw new Error("该操作已撤销过");
  const key = h.action+":"+h.entity;
  if(!UNDOABLE.has(key)) throw new Error("该操作不支持撤销");
  const before = h.before ? JSON.parse(h.before) : null;
  let summ="已撤销";
  if(key==="create:person"){ await softDelete(h.entity_id); summ="撤销新增 → 移入回收站: "+h.entity_id; }
  else if(key==="update:person"){ const patch={}; EDITABLE.forEach(k=> patch[k]=before? (before[k]||""):""); await updatePerson(h.entity_id, patch); summ="撤销修改 → 还原: "+h.entity_id; }
  else if(key==="delete:person"){ await restorePerson(h.entity_id); summ="撤销删除 → 恢复: "+h.entity_id; }
  else if(key==="purge:person"){ if(before) await reinsertPerson(before); summ="撤销彻底删除 → 重建: "+h.entity_id; }
  else if(key==="delete:marriage"){ if(before) await reinsertMarriage(before); summ="撤销删除婚姻"; }
  else if(key==="delete:media"){ if(before) await reinsertMedia(before); summ="撤销删除照片"; }
  must(await sb.from("history").update({ undone:1 }).eq("id",hid));
  await logHist("undo",h.entity,h.entity_id,summ);
  return { ok:true, summary:summ };
}

// ---------- 关系(通用人际关系:有类型有方向的边)----------
let _relTypesCache = null;
async function listRelTypes(){
  if(_relTypesCache) return _relTypesCache;
  _relTypesCache = must(await sb.from("relationship_types").select("*").order("sort_order").order("type"));
  return _relTypesCache;
}
async function listRelationships(){ return must(await sb.from("relationships").select("*").order("id")); }
async function relationsOf(pid){ return must(await sb.from("relationships").select("*").or("from_id.eq."+pid+",to_id.eq."+pid)); }
async function addRelationship(body){
  let from_id=body.from_id, to_id=body.to_id;
  if(!from_id||!to_id) throw new Error("请选择两个人");
  if(from_id===to_id) throw new Error("不能和自己建立关系");
  const t=(await listRelTypes()).find(x=>x.type===body.type);
  const directed = t ? !t.is_symmetric : true;
  if(!directed && from_id>to_id){ const x=from_id; from_id=to_id; to_id=x; }   // 对称边规范序
  const rec={ from_id, to_id, type:body.type, directed, start_date:body.start_date||"", end_date:body.end_date||"", note:body.note||"" };
  const row=must(await sb.from("relationships").insert(rec).select().single());
  await logHist("create","relationship",row.id,"新增关系: "+((t&&t.label_zh)||body.type)+" "+from_id+"→"+to_id);
  return row;
}
async function updateRelationship(id, body){
  const patch={}; ["type","start_date","end_date","note"].forEach(k=>{ if(k in body) patch[k]=body[k]; });
  const row=must(await sb.from("relationships").update(patch).eq("id",id).select().single());
  await logHist("update","relationship",id,"修改关系"); return row;
}
async function delRelationship(id){
  must(await sb.from("relationships").delete().eq("id",id));
  await logHist("delete","relationship",id,"删除关系"); return { ok:true };
}
window.REL = { types:listRelTypes, all:listRelationships, of:relationsOf, add:addRelationship, update:updateRelationship, del:delRelationship };

// ---------- 去重:同名检测 + 人工确认的合并 ----------
async function findSameName(name, excludeId){
  name=(name||"").trim(); if(!name) return [];
  const rows = must(await sb.from("persons").select("id,name,gen,kind").eq("name",name).eq("deleted",0));
  return rows.filter(r=>r.id!==excludeId);
}
// 把 dup 并入 survivor:迁移 子女/关系/婚姻/照片,survivor 补空,dup 进回收站,留痕。不自动撤销。
async function mergePersons(survivorId, dupId){
  if(survivorId===dupId) throw new Error("不能合并到自己");
  const sur=await getPerson(survivorId), dup=await getPerson(dupId);
  if(!sur||!dup) throw new Error("人物不存在");
  const c={children:0,relations:0,marriages:0,media:0};
  // 1) 子女改父
  const kids=must(await sb.from("persons").select("id").eq("father_id",dupId)); c.children=kids.length;
  if(kids.length) must(await sb.from("persons").update({father_id:survivorId}).eq("father_id",dupId));
  // 2) 关系迁移(处理自环/撞重复/对称规范序)
  const rels=must(await sb.from("relationships").select("*").or("from_id.eq."+dupId+",to_id.eq."+dupId));
  const existing=must(await sb.from("relationships").select("from_id,to_id,type").or("from_id.eq."+survivorId+",to_id.eq."+survivorId));
  const keyOf=(f,t,ty)=>f+"|"+t+"|"+ty;
  const surSet=new Set(existing.map(r=>keyOf(r.from_id,r.to_id,r.type)));
  for(const r of rels){
    let f=r.from_id===dupId?survivorId:r.from_id, t=r.to_id===dupId?survivorId:r.to_id;
    if(f===t){ must(await sb.from("relationships").delete().eq("id",r.id)); continue; }      // 自环
    if(!r.directed && f>t){ const x=f; f=t; t=x; }                                            // 对称规范序
    if(surSet.has(keyOf(f,t,r.type))){ must(await sb.from("relationships").delete().eq("id",r.id)); continue; } // 撞重复
    must(await sb.from("relationships").update({from_id:f,to_id:t}).eq("id",r.id));
    surSet.add(keyOf(f,t,r.type)); c.relations++;
  }
  // 3) 婚姻
  const marr=must(await sb.from("marriages").select("id").eq("person_id",dupId)); c.marriages=marr.length;
  if(marr.length) must(await sb.from("marriages").update({person_id:survivorId}).eq("person_id",dupId));
  // 4) 照片
  const med=must(await sb.from("media").select("id").eq("person_id",dupId)); c.media=med.length;
  if(med.length){ must(await sb.from("media").update({person_id:survivorId}).eq("person_id",dupId)); await refreshPrimary(survivorId); }
  // 5) survivor 补空(不覆盖已填)
  const patch={};
  EDITABLE.forEach(k=>{ if((!sur[k]||(""+sur[k]).trim()==="") && dup[k] && (""+dup[k]).trim()!=="") patch[k]=dup[k]; });
  if(Object.keys(patch).length){ patch.updated_at=nowStr(); must(await sb.from("persons").update(patch).eq("id",survivorId)); }
  // 6) dup 进回收站(此时已无引用)
  must(await sb.from("persons").update({ deleted:1, deleted_at:nowStr() }).eq("id",dupId));
  // 7) 留痕(history 原 entity_id 不动,保留各自审计)
  await logHist("merge","person",survivorId,"合并: "+(dup.name||dupId)+"("+dupId+")→"+(sur.name||survivorId)+"("+survivorId+");迁移 子女"+c.children+"/关系"+c.relations+"/婚姻"+c.marriages+"/照片"+c.media, dup, null);
  return { ok:true, ...c };
}
window.DEDUP = { sameName:findSameName, merge:mergePersons };

// ---------- REST 兼容 shim:让 app.js 的 api() 调用零改动 ----------
async function api(method, path, body){
  const u = new URL(path, location.origin); const p = u.pathname; method = method.toUpperCase();
  let m;
  if(method==="GET"){
    if(p==="/api/meta") return await getMeta();
    if(p==="/api/persons") return await listPersons(false);
    if(p==="/api/trash") return await listPersons(true);
    if(p==="/api/narratives") return await listNarratives();
    if(p==="/api/verify") return await listVerify();
    if(p==="/api/transcription") return await listTranscription();
    if(p==="/api/history") return await listHistory();
    if(p==="/api/backups") return [];                       // 云端无 .db 快照
    if(p==="/api/auth") return { needsToken:false, ok:true }; // 兼容旧调用
    if(m=p.match(/^\/api\/persons\/(.+)\/marriages$/)) return await listMarriages(dec(m[1]));
    if(m=p.match(/^\/api\/persons\/(.+)\/media$/)) return await listMedia(dec(m[1]));
    throw new Error("未知接口 "+p);
  }
  if(method==="POST"){
    if(p==="/api/persons") return await createPerson(body);
    if(p==="/api/verify") return await createVerify(body);
    if(p==="/api/import/json"){ const r=await sb.rpc("import_full",{ payload:body }); if(r.error) throw new Error(r.error.message); return r.data; }
    if(p==="/api/backups/restore") throw new Error("云端不支持 .db 快照恢复,请用『上传JSON恢复』");
    if(m=p.match(/^\/api\/persons\/(.+)\/marriages$/)) return await addMarriage(dec(m[1]), body);
    if(m=p.match(/^\/api\/persons\/(.+)\/media$/)) return await addMedia(dec(m[1]), body);
    if(m=p.match(/^\/api\/persons\/(.+)\/restore$/)) return await restorePerson(dec(m[1]));
    if(m=p.match(/^\/api\/history\/(\d+)\/undo$/)) return await undo(+m[1]);
    throw new Error("未知接口 "+p);
  }
  if(method==="PUT"){
    if(m=p.match(/^\/api\/marriages\/(\d+)$/)) return await updateMarriage(+m[1], body);
    if(m=p.match(/^\/api\/media\/(\d+)$/)) return await updateMedia(+m[1], body);
    if(p==="/api/meta") return await putMeta(body);
    if(m=p.match(/^\/api\/narratives\/(.+)$/)) return await putNarrative(dec(m[1]), body);
    if(m=p.match(/^\/api\/verify\/(\d+)$/)) return await updateVerify(+m[1], body);
    if(m=p.match(/^\/api\/persons\/(.+)$/)) return await updatePerson(dec(m[1]), body);
    throw new Error("未知接口 "+p);
  }
  if(method==="DELETE"){
    if(m=p.match(/^\/api\/persons\/(.+)\/purge$/)) return await purgePerson(dec(m[1]));
    if(m=p.match(/^\/api\/marriages\/(\d+)$/)) return await delMarriage(+m[1]);
    if(m=p.match(/^\/api\/media\/(\d+)$/)) return await delMedia(+m[1]);
    if(m=p.match(/^\/api\/verify\/(\d+)$/)) return await delVerify(+m[1]);
    if(m=p.match(/^\/api\/persons\/(.+)$/)) return await softDelete(dec(m[1]));
    throw new Error("未知接口 "+p);
  }
  throw new Error("不支持 "+method);
}
window.api = api;

// ============================================================
// 导出(客户端生成 + 下载)—— 复刻 server.py 的 export_*。redact=隐去联系方式/住址。
// ============================================================
function download(filename, content, mime){
  const blob = content instanceof Blob ? content : new Blob([content], { type:mime||"text/plain;charset=utf-8" });
  const a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download=filename;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(a.href),2000);
}
function csvCell(s){ s=(s==null?"":String(s)); return /[",\n]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s; }
const CSV_COLS=["id","gen","char_gen","name","alias","sex","birth","birth_lunar","birth_time","birth_place","death","death_lunar","alive","rank","relation_type","kind","father_id","father_note","mother","spouse","occupation","residence","burial","contact","address","deeds","source","status","note","photo"];
const CSV_HEAD=["ID","世代","字辈","姓名","字号","性别","生年","农历生","出生时辰","出生地","卒年/享年","农历卒","在世","行第","亲属关系","本族/外部","父ID","父系说明","母","配偶","学历/职业/功名","居地/迁徙","葬地","联系方式","现住址","事迹","资料来源","状态","备注","主照片"];
function marrSummary(list){ return (list||[]).map(m=>{ let s=m.spouse||""; const ex=[m.relation, m.spouse_family&&("父家:"+m.spouse_family), m.marriage_year&&("婚配:"+m.marriage_year)].filter(Boolean); if(ex.length)s+="("+ex.join("·")+")"; return s; }).filter(Boolean).join("; "); }
const esc = s => (s==null?"":String(s)).replace(/[&<>"]/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[m]));

async function fullData(redact){
  const [persons, narratives, verify, transcription, meta] = await Promise.all([
    listPersons(true), listNarratives(), listVerify(), listTranscription(), getMeta()]);
  const allMarr = must(await sb.from("marriages").select("*").order("sort_order").order("id"));
  const allMedia = must(await sb.from("media").select("*").order("is_primary",{ascending:false}).order("sort_order").order("id"));
  const mByP={}, mdByP={};
  allMarr.forEach(m=>(mByP[m.person_id]=mByP[m.person_id]||[]).push(m));
  allMedia.forEach(m=>(mdByP[m.person_id]=mdByP[m.person_id]||[]).push(m));
  persons.forEach(p=>{ if(redact){p.contact="";p.address="";} p.marriages=mByP[p.id]||[]; p.media=mdByP[p.id]||[]; });
  const relationships = must(await sb.from("relationships").select("*").order("id"));
  const relationship_types = must(await sb.from("relationship_types").select("*").order("sort_order"));
  return { meta, persons, narratives, verify, transcription, relationships, relationship_types, _redacted:!!redact };
}
// 推算世代(复刻 app.js genOf):沿父/母上溯到最近手填gen锚点或顶祖+深度;无父随配偶;带 memo+防环
function buildGenOf(persons, relationships){
  const byId={}; (persons||[]).forEach(p=>byId[p.id]=p);
  const fatherOf={}, motherOf={}, spouseOf={};
  (relationships||[]).forEach(r=>{
    if(r.type==="father") fatherOf[r.to_id]=r.from_id;
    else if(r.type==="mother") motherOf[r.to_id]=r.from_id;
    else if(r.type==="spouse"){ (spouseOf[r.from_id]=spouseOf[r.from_id]||[]).push(r.to_id); (spouseOf[r.to_id]=spouseOf[r.to_id]||[]).push(r.from_id); }
  });
  const memo={};
  const walk=(id,seen)=>{ if(id in memo) return memo[id]; if(seen.has(id)) return null; seen.add(id);
    const p=byId[id]; if(!p) return null; const m=parseInt(p.gen,10); if(!isNaN(m)){ memo[id]=m; return m; }
    const par=fatherOf[id]||motherOf[id]; if(par){ const g=walk(par,seen); memo[id]=(g==null?null:g+1); return memo[id]; }
    for(const sp of (spouseOf[id]||[])){ const g=walk(sp,seen); if(g!=null){ memo[id]=g; return g; } }
    memo[id]=null; return null; };
  return id=>walk(id,new Set());
}
async function exportJson(redact){ const d=await fullData(redact); download(redact?"zupu-share.json":"zupu-backup.json", JSON.stringify(d,null,2), "application/json"); }
async function exportCsv(redact){
  const d=await fullData(redact); const genOf=buildGenOf(d.persons, d.relationships);
  const lines=[CSV_HEAD.concat("婚姻详情").map(csvCell).join(",")];
  d.persons.filter(p=>!p.deleted).forEach(p=>{ const row=CSV_COLS.map(c=>csvCell(c==="gen"?(genOf(p.id)??""):p[c])); row.push(csvCell(marrSummary(p.marriages))); lines.push(row.join(",")); });
  download(redact?"persons-redacted.csv":"persons.csv", "﻿"+lines.join("\n"), "text/csv;charset=utf-8");
}
async function exportGedcom(){
  const d=await fullData(false); const rows=d.persons.filter(p=>!p.deleted); const by={}; rows.forEach(r=>by[r.id]=r);
  const xref={}; rows.forEach((r,i)=>xref[r.id]="@I"+(i+1)+"@");
  const fams={}; rows.forEach(r=>{ const f=r.father_id; if(f&&by[f]) (fams[f]=fams[f]||[]).push(r.id); });
  const fx={}; Object.keys(fams).forEach((f,i)=>fx[f]="@F"+(i+1)+"@"); const foc={}; Object.entries(fams).forEach(([f,ks])=>ks.forEach(k=>foc[k]=f));
  const L=["0 HEAD","1 SOUR 谱系(人物关系图谱)","1 GEDC","2 VERS 5.5.1","2 FORM LINEAGE-LINKED","1 CHAR UTF-8"];
  rows.forEach(r=>{ const pid=r.id; L.push("0 "+xref[pid]+" INDI");
    const nm=r.name||"", sur=nm.startsWith("孙")?"孙":"", giv=sur?nm.slice(sur.length):nm;
    L.push("1 NAME "+giv+" /"+sur+"/"); L.push("1 SEX "+(r.sex==="男"?"M":r.sex==="女"?"F":"U"));
    if(r.birth){ L.push("1 BIRT"); L.push("2 DATE "+r.birth); if(r.birth_place) L.push("2 PLAC "+r.birth_place); }
    if(r.death&&r.death!=="无考"){ L.push("1 DEAT"); L.push("2 DATE "+r.death); if(r.burial) L.push("2 PLAC "+r.burial); }
    if(r.occupation) L.push("1 OCCU "+r.occupation);
    const ms=marrSummary(r.marriages);
    const nb=[r.alias&&"字号:"+r.alias, ms&&"婚:"+ms, r.mother&&"母:"+r.mother, r.birth_lunar&&"农历生:"+r.birth_lunar, r.deeds, r.note, r.status&&"状态:"+r.status].filter(Boolean);
    if(nb.length) L.push("1 NOTE "+nb.join(" | "));
    if(foc[pid]) L.push("1 FAMC "+fx[foc[pid]]); if(fams[pid]) L.push("1 FAMS "+fx[pid]);
  });
  Object.entries(fams).forEach(([f,ks])=>{ L.push("0 "+fx[f]+" FAM"); L.push("1 HUSB "+xref[f]); ks.forEach(k=>L.push("1 CHIL "+xref[k])); });
  L.push("0 TRLR"); download("zupu.ged", L.join("\n")+"\n", "text/plain;charset=utf-8");
}
async function exportShareHtml(){
  const d=await fullData(false); const meta=d.meta||{}; const persons=d.persons.filter(p=>!p.deleted); const nar=d.narratives;
  const living=p=>p.alive==="是";
  const yrs=p=>{ let y=[p.birth,p.death].filter(x=>x&&x!=="无考").join("–"); if(p.birth_lunar||p.death_lunar) y+="(农历 "+[p.birth_lunar,p.death_lunar].filter(Boolean).join("–")+")"; return y; };
  const gk=g=>{ const n=parseInt(g,10); return isNaN(n)?9999:n; };
  const genOf=buildGenOf(d.persons, d.relationships);
  const groups={}; persons.forEach(p=>{ const g=genOf(p.id); (groups[g==null?"—":g]=groups[g==null?"—":g]||[]).push(p); });
  let gen=""; Object.keys(groups).sort((a,b)=>gk(a)-gk(b)).forEach(g=>{ const cg=groups[g][0].char_gen;
    gen+='<div class="gen"><h3>第 '+esc(g)+' 代'+(cg&&cg!=="—"?" · "+esc(cg)+"字辈":"")+'</h3>';
    groups[g].forEach(p=>{ if(living(p)) gen+='<p><b>'+esc(p.name||"(无名)")+'</b> <span class="tag">在世</span></p>';
      else { const bits=[p.alias&&"字 "+p.alias, yrs(p), p.residence, p.occupation, marrSummary(p.marriages)&&"婚: "+marrSummary(p.marriages), p.deeds].filter(Boolean); gen+='<p><b>'+esc(p.name||"(无名)")+'</b> '+esc(bits.join(" · "))+'</p>'; } });
    gen+='</div>'; });
  const ids=new Set(persons.map(p=>p.id)); const isF=new Set(persons.map(p=>p.father_id).filter(x=>ids.has(x)));
  const nodes=persons.filter(p=>ids.has(p.father_id)||isF.has(p.id));
  let tdef="graph TD\n"; nodes.forEach(p=>{ let lab=p.name||"(无名)"; if(!living(p)){ const y=[p.birth,p.death].filter(x=>x&&x!=="无考").join("-"); if(y)lab+="·"+y; } tdef+="  "+p.id+'["'+lab.replace(/["\[\]]/g,"")+'"]\n'; });
  nodes.forEach(p=>{ if(ids.has(p.father_id)) tdef+="  "+p.father_id+" --> "+p.id+"\n"; });
  const narHtml=nar.map(n=>'<div class="card"><h3>'+esc(n.title||n.key)+'</h3><p>'+esc(n.text)+'</p></div>').join("");
  const cg=(meta.charGen||[]).join(" · "); const today=nowStr().slice(0,10);
  const htmlDoc='<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+esc(meta.title||"族谱")+' · 分享版</title>'
    +'<script type="module">import m from "https://cdn.jsdelivr.net/npm/mermaid@11.4.0/dist/mermaid.esm.min.mjs";m.initialize({startOnLoad:true,theme:"base",themeVariables:{fontFamily:\'"PingFang SC","Noto Sans SC",sans-serif\',primaryColor:"#ecfdf5",primaryBorderColor:"#10b981",primaryTextColor:"#064e3b",lineColor:"#475569"}});<\/script>'
    +'<style>body{font-family:"PingFang SC","Noto Sans SC","Microsoft YaHei",system-ui,sans-serif;line-height:1.75;color:#0f172a;background:#fafaf9;max-width:920px;margin:0 auto;padding:1.5rem}h1{font-size:1.6rem}h3{color:#047857}.card{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:1rem 1.3rem;margin:1rem 0}.gen{border-left:3px solid #047857;padding:.2rem 0 .2rem 1rem;margin:1rem 0}.gen p{margin:.2rem 0;color:#334155;font-size:.95rem}.tag{font-size:.7rem;border:1px solid #e2e8f0;border-radius:5px;padding:.02rem .4rem;color:#64748b}.mermaid{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:1rem;overflow:auto;text-align:center}blockquote{border-left:3px solid #047857;background:#ecfdf5;padding:.6rem 1rem;border-radius:0 6px 6px 0;color:#334155}.muted{color:#94a3b8;font-size:.8rem}</style></head><body>'
    +'<h1>'+esc(meta.title||"族谱")+'</h1><div class="muted">'+esc(meta.lineage||"")+' · 字辈:'+esc(cg)+' · 考察:'+esc(meta.investigator||"")+' · 整理:'+esc(meta.compiler||"")+' · '+esc(meta.compiledYear||"")+'</div>'
    +'<blockquote>'+esc(meta.migration||"")+'</blockquote><div class="card"><h3>家史</h3>'+narHtml+'</div><h3>家族树</h3><div class="mermaid">'+tdef+'</div><h3>世系(按代)</h3>'+gen
    +'<p class="muted">本页为家族分享版,在世亲属仅显示姓名,联系方式/住址等隐私信息已隐藏。生成于 '+today+'。</p></body></html>';
  download("zupu-share.html", htmlDoc, "text/html;charset=utf-8");
}
window.EXPORT = { json:exportJson, csv:exportCsv, gedcom:exportGedcom, shareHtml:exportShareHtml };
