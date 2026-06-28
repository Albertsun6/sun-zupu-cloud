// Mermaid 懒加载(画树时才取 CDN),离线时其余功能照常
let _mermaid = null;
async function getMermaid(){
  if(_mermaid) return _mermaid;
  const m = await import("https://cdn.jsdelivr.net/npm/mermaid@11.4.0/dist/mermaid.esm.min.mjs");
  _mermaid = m.default;
  _mermaid.initialize({ startOnLoad:false, theme:"base", themeVariables:{
    fontFamily:'"PingFang SC","Noto Sans SC",system-ui,sans-serif',
    primaryColor:"#f8fafc", primaryTextColor:"#0f172a", primaryBorderColor:"#94a3b8", lineColor:"#475569"
  }, flowchart:{ curve:"basis", padding:14 }});
  return _mermaid;
}
const $ = s => document.querySelector(s);
const el = (t,c,h) => { const e=document.createElement(t); if(c)e.className=c; if(h!=null)e.innerHTML=h; return e; };
const esc = s => (s==null?"":String(s)).replace(/[&<>"]/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[m]));
// 软件版本(每次部署递增;显示在页头与登录页,便于确认浏览器已加载最新版)
const APP_VERSION = "v0.9.1";
const APP_DATE = "2026-06-28";
[["#appVer",APP_VERSION],["#appVerLogin","版本 "+APP_VERSION+" · "+APP_DATE]].forEach(([s,t])=>{ const e=document.querySelector(s); if(e) e.textContent=t; });

const FORM_KEYS = ["id","name","gen","char_gen","rank","relation_type","kind","alias","sex","birth",
  "birth_lunar","birth_time","death","death_lunar","birth_place","burial","alive","mother","father_note",
  "spouse","occupation","residence","contact","address","deeds","source","status","note"];
const DIRECT_LINE = new Set(["S001","S002","S004","S008","S010","S014","S019","S033","S046"]);
const ORIG_IMG = {p1:window.photoUrl("yuanpu/p1.jpg"),p2:window.photoUrl("yuanpu/p2.jpg"),p3:window.photoUrl("yuanpu/p3.jpg"),p4:window.photoUrl("yuanpu/p4.jpg")};
const UNDOABLE = new Set(["create:person","update:person","delete:person","purge:person","delete:marriage","delete:media"]);

const state = { persons:[], meta:{}, narratives:[], verify:[], transcription:[], relTypes:[], relCount:{}, q:"", share:false,
                editing:null, user:null, canEdit:false, lineage:"",
                graphCenter:"", graphHops:2, pathA:"", pathB:"",
                fatherOf:{}, motherOf:{}, childrenMap:{}, spouseOf:{}, _genCache:{}, _lineageCache:{}, lineages:null,
                filters:{charGen:"",status:"",alive:"",kind:""} };

// api(method,path,body) 由 db.js 提供(Supabase shim);此处不再定义。
async function reloadPersons(){ state.persons = await api("GET","/api/persons"); }
// 一次取关系边,构出血缘图谱(父/母/子/配偶)+ 关系数;世代/家族树/族谱都基于它(单一真源)。
async function refreshRelCount(){
  let rels=[]; try{ rels=await window.REL.all(); }catch(e){}
  const cnt={}, fatherOf={}, motherOf={}, childrenMap={}, spouseOf={};
  rels.forEach(r=>{
    cnt[r.from_id]=(cnt[r.from_id]||0)+1; cnt[r.to_id]=(cnt[r.to_id]||0)+1;
    if(r.type==="father"){ fatherOf[r.to_id]=r.from_id; (childrenMap[r.from_id]=childrenMap[r.from_id]||[]).push(r.to_id); }
    else if(r.type==="mother"){ motherOf[r.to_id]=r.from_id; (childrenMap[r.from_id]=childrenMap[r.from_id]||[]).push(r.to_id); }
    else if(r.type==="spouse"){ (spouseOf[r.from_id]=spouseOf[r.from_id]||[]).push(r.to_id); (spouseOf[r.to_id]=spouseOf[r.to_id]||[]).push(r.from_id); }
  });
  state.relCount=cnt; state.fatherOf=fatherOf; state.motherOf=motherOf; state.childrenMap=childrenMap; state.spouseOf=spouseOf;
  state._genCache={}; state._lineageCache={}; state.lineages=null;
}
// 世代推算:沿父(无父则母)上溯到"最近一个有手填gen的锚点"或顶祖,效果=锚点gen+深度;顶祖无手填则=1;无父随配偶同代;带 memo+防环。
function genOf(id){ return _genWalk(id, new Set()); }
const genStr = id => { const g=genOf(id); return g==null?"?":g; };
function _genWalk(id, seen){
  if(state._genCache[id]!==undefined) return state._genCache[id];
  if(seen.has(id)) return null; seen.add(id);
  const p=byId(id); if(!p) return null;
  const manual=parseInt(p.gen,10);
  if(!isNaN(manual)){ state._genCache[id]=manual; return manual; }            // 手填=锚点(覆盖)
  const par=state.fatherOf[id]||state.motherOf[id];
  if(par){ const g=_genWalk(par,seen); const v=(g==null?null:g+1); state._genCache[id]=v; return v; }
  for(const sp of (state.spouseOf[id]||[])){ const g=_genWalk(sp,seen); if(g!=null){ state._genCache[id]=g; return g; } }  // 随配偶
  state._genCache[id]=null; return null;
}
// 族谱归属:父系顶祖的姓氏(单字姓近似);无父随配偶;= "X氏"。对缺边的同姓孤儿也能并入同族。
function rootOfPatriline(id, seen){ seen=seen||new Set(); if(seen.has(id))return id; seen.add(id); return state.fatherOf[id]?rootOfPatriline(state.fatherOf[id],seen):id; }
function lineageOf(id){
  if(state._lineageCache[id]) return state._lineageCache[id];
  const p=byId(id); if(!p) return (state._lineageCache[id]="(未知)");
  let baseId=id;
  if(!state.fatherOf[id]){ for(const sp of (state.spouseOf[id]||[])){ if(byId(sp)){ baseId=sp; break; } } }  // 嫁入随夫族
  const rootName=((byId(rootOfPatriline(baseId))||{}).name)||p.name||"";
  const sn=(rootName.trim()[0])||(p.name||"").trim()[0]||"其他";
  return (state._lineageCache[id]=sn+"氏");
}
function lineagesList(){
  if(state.lineages) return state.lineages;
  const m={}; state.persons.filter(p=>!p.deleted).forEach(p=>{ const l=lineageOf(p.id); m[l]=(m[l]||0)+1; });
  state.lineages=Object.entries(m).map(([name,count])=>({name,count})).sort((a,b)=>b.count-a.count);
  return state.lineages;
}
async function reloadEverything(){ await loadAll(); renderBackup(); renderLog(); }

async function loadAll(){
  [state.meta, state.persons, state.narratives, state.verify, state.transcription] = await Promise.all([
    api("GET","/api/meta"), api("GET","/api/persons"), api("GET","/api/narratives"),
    api("GET","/api/verify"), api("GET","/api/transcription")
  ]);
  state.relTypes = await window.REL.types().catch(()=>[]);
  await refreshRelCount();
  renderHeader(); renderFilters(); renderOverview(); renderHistory(); renderVerify(); renderSource();
}
function renderAuthBar(){       // 显示当前登录者 + 角色;viewer 隐藏所有 .edit-only 控件
  const who=$("#whoami"); if(who) who.textContent = state.user ? (state.user.email + (state.canEdit?" · 可编辑":" · 只读")) : "";
  document.body.classList.toggle("viewer", !state.canEdit);
}
function renderHeader(){
  const m=state.meta||{};
  $("#subtitle").textContent=(m.lineage?("· "+m.lineage):"")+(m.charGen?("  字辈:"+m.charGen.join("·")):"");
  const total=state.persons.length, alive=state.persons.filter(p=>p.alive==="是").length;
  const todo=state.verify.filter(v=>!/已?确认/.test(v.status||"")).length;
  $("#stats").textContent=`共 ${total} 人 · 在世 ${alive} · 待核实 ${todo} 项`;
  $("#title").firstChild.textContent=(m.title||"孙氏族谱")+" ";
}

/* ---------- 世系总览 ---------- */
const gk = g => { const n=parseInt(g,10); return isNaN(n)?9999:n; };
function matchQ(p){
  if(!state.q) return true;
  return [p.id,p.name,p.alias,p.note,p.deeds,p.residence,p.char_gen,p.occupation,p.birth_place,p.birth,p.death]
    .join(" ").toLowerCase().includes(state.q.toLowerCase());
}
function anyFilter(){ return !!(state.filters.charGen||state.filters.status||state.filters.alive||state.filters.kind); }
function matchFilter(p){
  const f=state.filters;
  if(f.charGen && p.char_gen!==f.charGen) return false;
  if(f.status && p.status!==f.status) return false;
  if(f.alive && p.alive!==f.alive) return false;
  if(f.kind && (p.kind||"本族")!==f.kind) return false;
  return true;
}
function renderFilters(){
  const fb=$("#filterBar"); if(!fb) return; fb.innerHTML="";
  const cg=(state.meta&&state.meta.charGen)||[];
  const mk=(label,key,opts)=>{ const s=el("select"); const o0=el("option",null,label); o0.value=""; s.appendChild(o0);
    opts.forEach(v=>{ const o=el("option",null,v); o.value=v; if(state.filters[key]===v)o.selected=true; s.appendChild(o); });
    s.onchange=()=>{ state.filters[key]=s.value; renderFilters(); renderOverview(); }; return s; };
  fb.appendChild(mk("全部字辈","charGen",cg));
  fb.appendChild(mk("全部状态","status",["确认","存疑","待考","待补"]));
  fb.appendChild(mk("在世/已故","alive",["是","否"]));
  fb.appendChild(mk("本族/外部","kind",["本族","外部"]));
  const lins=lineagesList();
  if(lins.length>1){ const ls=el("select"); const o0=el("option",null,"全部族谱"); o0.value=""; ls.appendChild(o0);
    lins.forEach(l=>{ const o=el("option",null,l.name+"("+l.count+")"); o.value=l.name; if(state.lineage===l.name)o.selected=true; ls.appendChild(o); });
    ls.onchange=()=>{ state.lineage=ls.value; renderFilters(); renderOverview(); if(document.getElementById("view-tree").classList.contains("active"))renderTree(); }; fb.appendChild(ls); }
  const fcEl=el("span","fcount"); fcEl.id="fcount"; fb.appendChild(fcEl);
  if(state.q||anyFilter()){ const clr=el("button","btn btn-sm","清除"); clr.onclick=()=>{ state.q=""; $("#search").value=""; state.filters={charGen:"",status:"",alive:"",kind:""}; renderFilters(); renderOverview(); }; fb.appendChild(clr); }
}
function renderOverview(){
  const box=$("#overview"); box.innerHTML="";
  $("#shareNote").style.display=state.share?"block":"none";
  const list=state.persons.filter(p=>matchQ(p)&&matchFilter(p)&&(!state.lineage||lineageOf(p.id)===state.lineage));
  const fc=$("#fcount"); if(fc) fc.textContent=(state.q||anyFilter()||state.lineage)?`找到 ${list.length} 人`:`共 ${state.persons.length} 人`;
  const groups={};
  list.forEach(p=>{ const g=genOf(p.id); const gkey=(g==null?"—":g); (groups[gkey]=groups[gkey]||[]).push(p); });
  const keys=Object.keys(groups).sort((a,b)=>gk(a)-gk(b));
  if(!keys.length){ box.appendChild(el("p","note","无匹配人物。")); return; }
  keys.forEach(k=>{
    const blk=el("div","gen-block"); const cg=groups[k][0]?.char_gen;
    const head = k==="—" ? "未入世系 · 外部人物" : `第 ${esc(k)} 代`;
    blk.appendChild(el("div","gen-head",head+(cg&&cg!=="—"?` <span class="tag">${esc(cg)}字辈</span>`:"")));
    const cards=el("div","cards");
    groups[k].sort((a,b)=>(a.sort_order||0)-(b.sort_order||0)).forEach(p=>cards.appendChild(personCard(p)));
    blk.appendChild(cards); box.appendChild(blk);
  });
}
function statusPill(s){const m={"确认":"pill-ok","存疑":"pill-warn","待考":"pill-muted","待补":"pill-info"};return s?`<span class="pill ${m[s]||"pill-muted"}">${esc(s)}</span>`:"";}
function personCard(p){
  const c=el("div","card"); c.onclick=()=>openDetail(p);
  const living=p.alive==="是", hide=state.share&&living;
  const thumb=p.photo&&!hide?`<img class="thumb" loading="lazy" src="${esc(window.photoUrl(p.photo))}" alt=""/>`:`<div class="thumb noimg">${esc((p.name||"?").slice(-1))}</div>`;
  let sub="",meta2="";
  if(!hide){
    const yrs=[p.birth,p.death].filter(x=>x&&x!=="无考").join("–");
    sub=[p.alias&&("字 "+p.alias),p.rank,yrs].filter(Boolean).join(" · ");
    meta2=[p.residence,p.occupation,p.father_note].filter(Boolean).join(" · ");
  }
  c.innerHTML=`<div class="card-row">${thumb}<div class="card-main">`
    +`<div class="nm">${esc(p.name||"(无名)")} ${living?'<span class="tag">在世</span>':""} ${statusPill(p.status)}</div>`
    +(sub?`<div class="sub">${esc(sub)}</div>`:"")+(meta2?`<div class="meta2">${esc(meta2)}</div>`:"")
    +`</div></div>`;
  return c;
}

/* ---------- 家族树 ---------- */
async function renderTree(){
  const box=$("#treeBox");
  const ids=new Set(state.persons.map(p=>p.id));
  const inLin = id => !state.lineage || lineageOf(id)===state.lineage;
  const isFather=new Set(); Object.values(state.fatherOf).forEach(f=>{ if(ids.has(f)) isFather.add(f); });
  const nodes=state.persons.filter(p=>((state.fatherOf[p.id]&&ids.has(state.fatherOf[p.id]))||isFather.has(p.id)) && inLin(p.id));
  if(!nodes.length){ box.textContent=state.lineage?"(该族谱暂无可绘制的父子关系)":"(暂无可绘制的父子关系)"; return; }
  let def="graph TD\n";
  const nodeIds=new Set(nodes.map(p=>p.id));
  nodes.forEach(p=>{
    const yrs=[p.birth,p.death].filter(x=>x&&x!=="无考").map(x=>x.replace(/[()（）]/g,"")).join("-");
    def+=`  ${p.id}["${((p.name||"(无名)")+(yrs?("·"+yrs):"")).replace(/"/g,"").replace(/[\[\]]/g,"")}"]\n`;
  });
  nodes.forEach(p=>{ const f=state.fatherOf[p.id]; if(f&&nodeIds.has(f)) def+=`  ${f} --> ${p.id}\n`; });
  const hi=nodes.filter(p=>DIRECT_LINE.has(p.id)).map(p=>p.id);
  if(hi.length){ def+="  classDef zhi fill:#ecfdf5,stroke:#10b981,stroke-width:2px,color:#064e3b;\n  class "+hi.join(",")+" zhi;\n"; }
  try{ const mermaid=await getMermaid(); const {svg}=await mermaid.render("famtree",def); box.innerHTML=svg; }
  catch(e){ box.innerHTML=`<p class="note">树图渲染失败(可能离线无法加载 Mermaid)。文字版见“世系总览”。</p><pre style="text-align:left;white-space:pre-wrap;font-size:.8rem">${esc(def)}</pre>`; }
}

/* ---------- 家史 ---------- */
function renderHistory(){
  const box=$("#historyNar"); box.innerHTML="";
  const cg=(state.meta&&state.meta.charGen)||[];
  if(cg.length){
    const card=el("div","panel");
    const cells=cg.map((c,i)=>`<span class="cg-cell"><b>${i+1}</b>　${esc(c)}</span>`).join("");
    card.innerHTML=`<h3>字辈谱(派语顺序)</h3><div class="cg-grid">${cells}</div><div class="hint">字辈按<b>父子相承</b>顺取(父“景”则子“德”);新增人物时系统据父辈自动顺推下一字。注:本谱的“第N代”编号与派语序号<b>不一定对齐</b>(早期有抵牾,见“派语说明”)。</div>`;
    box.appendChild(card);
  }
  state.narratives.forEach(n=>{
    const p=el("div","panel"); p.innerHTML=`<h3>${esc(n.title||n.key)}</h3>`;
    const ti=el("input"); ti.type="text"; ti.value=n.title||""; ti.style.marginBottom=".5rem";
    const ta=el("textarea"); ta.rows=Math.min(16,Math.max(4,Math.ceil((n.text||"").length/40))); ta.value=n.text||"";
    const foot=el("div","modal-foot"); const msg=el("span","hint"); const save=el("button","btn btn-primary btn-sm","保存");
    save.onclick=async()=>{try{await api("PUT","/api/narratives/"+encodeURIComponent(n.key),{title:ti.value,text:ta.value});n.title=ti.value;n.text=ta.value;msg.textContent="已保存 ✓";}catch(e){msg.textContent="失败:"+e.message;}};
    foot.appendChild(el("span","spacer")); foot.appendChild(msg); if(state.canEdit) foot.appendChild(save);
    if(!state.canEdit){ ti.disabled=true; ta.disabled=true; }
    p.appendChild(ti); p.appendChild(ta); p.appendChild(foot); box.appendChild(p);
  });
}

/* ---------- 待核实 ---------- */
function renderVerify(){
  const box=$("#verify"); box.innerHTML="";
  const cats={}; state.verify.forEach(v=>{(cats[v.category||"其他"]=cats[v.category||"其他"]||[]).push(v);});
  Object.keys(cats).forEach(cat=>{ box.appendChild(el("div","cat-head",esc(cat))); cats[cat].forEach(v=>box.appendChild(verifyRow(v))); });
}
function verifyRow(v){
  const r=el("div","vrow"); const top=el("div","vtop"); top.innerHTML=`<span class="vtopic">${esc(v.topic)}</span>`;
  const sel=el("select"); ["待考","存疑","待补","已确认"].forEach(s=>{const o=el("option",null,s);o.value=s;if(v.status===s)o.selected=true;sel.appendChild(o);}); sel.style.width="120px";
  const del=el("button","btn btn-danger btn-sm","删除"); top.appendChild(sel); if(state.canEdit) top.appendChild(del); r.appendChild(top);
  r.appendChild(el("div","vdetail",esc(v.detail)));
  const res=el("textarea"); res.rows=2; res.placeholder="核实结论 / 依据 / 来源"; res.value=v.resolution||"";
  const foot=el("div","modal-foot"); const date=el("input"); date.type="text"; date.placeholder="核实日期"; date.value=v.date||""; date.style.width="130px";
  const msg=el("span","hint"); const save=el("button","btn btn-primary btn-sm","保存");
  save.onclick=async()=>{try{const d={status:sel.value,resolution:res.value,date:date.value,category:v.category,topic:v.topic,detail:v.detail};await api("PUT","/api/verify/"+v.id,d);Object.assign(v,d);msg.textContent="已保存 ✓";renderHeader();}catch(e){msg.textContent="失败:"+e.message;}};
  del.onclick=async()=>{if(!confirm("删除该待核实项?"))return;await api("DELETE","/api/verify/"+v.id);state.verify=state.verify.filter(x=>x.id!==v.id);renderVerify();renderHeader();};
  foot.appendChild(date); foot.appendChild(el("span","spacer")); foot.appendChild(msg); if(state.canEdit) foot.appendChild(save);
  r.appendChild(res); r.appendChild(foot); return r;
}

/* ---------- 原谱影像与原文 ---------- */
function renderSource(){
  const box=$("#source"); box.innerHTML="";
  state.transcription.forEach(t=>{
    const wrap=el("div","panel"); const img=ORIG_IMG[t.page];
    wrap.innerHTML=`<h3>${esc(t.label||t.page)}</h3>`
      +(img?`<a href="${img}" target="_blank"><img class="origimg" loading="lazy" src="${img}" alt="${esc(t.page)}"/></a>`:"")
      +`<details class="tr"><summary>展开忠实誊录</summary><p>${esc(t.text)}</p></details>`;
    box.appendChild(wrap);
  });
}

/* ---------- 回收站 ---------- */
async function renderTrash(){
  const trash=await api("GET","/api/trash"); const box=$("#trash"); box.innerHTML="";
  if(!trash.length){ box.appendChild(el("p","note","回收站为空。")); return; }
  trash.forEach(p=>{
    const r=el("div","vrow");
    r.innerHTML=`<div class="vtop"><span class="vtopic">${esc(p.name||p.id)}</span><span class="tag">第${genStr(p.id)}代</span><span class="hint">删除于 ${esc(p.deleted_at||"")}</span></div>`;
    const foot=el("div","modal-foot");
    const rb=el("button","btn btn-primary btn-sm","恢复"); const pb=el("button","btn btn-danger btn-sm","彻底删除");
    rb.onclick=async()=>{await api("POST","/api/persons/"+encodeURIComponent(p.id)+"/restore");await reloadPersons();renderTrash();renderOverview();renderHeader();};
    pb.onclick=async()=>{if(!confirm("彻底删除「"+(p.name||p.id)+"」?(操作历史里仍可撤销重建)"))return;await api("DELETE","/api/persons/"+encodeURIComponent(p.id)+"/purge");renderTrash();};
    foot.appendChild(el("span","spacer")); if(state.canEdit){ foot.appendChild(rb); foot.appendChild(pb); } else foot.appendChild(el("span","hint","(只读)"));
    r.appendChild(foot); box.appendChild(r);
  });
}

/* ---------- 操作历史(可撤销) ---------- */
function diffHtml(h){
  try{
    const b=h.before?JSON.parse(h.before):null, a=h.after?JSON.parse(h.after):null;
    if(!b||!a) return "";
    const keys=new Set([...Object.keys(b),...Object.keys(a)]); const rows=[];
    keys.forEach(k=>{ if(k==="sort_order")return; let ov=b[k]==null?"":String(b[k]), nv=a[k]==null?"":String(a[k]);
      if(ov===nv) return;
      if(k==="contact"||k==="address"){ ov=ov?"(已隐藏)":"(空)"; nv=nv?"(已隐藏)":"(空)"; }
      rows.push(`<div class="dline"><b>${esc(k)}</b>: <span class="old">${esc(ov||"(空)")}</span> → <span class="new">${esc(nv||"(空)")}</span></div>`); });
    return rows.length?`<details class="diff"><summary>查看改动(${rows.length})</summary>${rows.join("")}</details>`:"";
  }catch(e){ return ""; }
}
async function renderLog(){
  const hist=await api("GET","/api/history"); const box=$("#log"); box.innerHTML="";
  if(!hist.length){ box.appendChild(el("p","note","暂无操作记录。")); return; }
  const amap={create:"新增",update:"修改",delete:"删除",restore:"恢复",purge:"彻底删除",photo:"照片",undo:"撤销",import:"导入","restore-backup":"回滚"};
  const tb=el("table"); tb.innerHTML="<thead><tr><th style='width:150px'>时间</th><th style='width:70px'>操作</th><th>说明</th><th style='width:84px'>撤销</th></tr></thead>";
  const body=el("tbody");
  hist.forEach(h=>{
    const tr=el("tr"); const undoable=state.canEdit&&UNDOABLE.has(h.action+":"+h.entity)&&!h.undone;
    let cell = h.undone?`<span class="hint">已撤销</span>` : (undoable?`<button class="btn btn-sm undo" data-id="${h.id}">撤销</button>`:"");
    tr.innerHTML=`<td>${esc(h.ts)}</td><td>${esc(amap[h.action]||h.action)}</td><td>${esc(h.summary)}${h.action==="update"?diffHtml(h):""}</td><td>${cell}</td>`;
    body.appendChild(tr);
  });
  tb.appendChild(body); box.appendChild(tb);
  box.querySelectorAll(".undo").forEach(b=>b.onclick=async()=>{
    if(!confirm("撤销该操作?")) return;
    try{ await api("POST","/api/history/"+b.dataset.id+"/undo"); await reloadPersons(); renderOverview(); renderHeader(); renderLog(); }
    catch(e){ alert("撤销失败:"+e.message); }
  });
}

async function renderBackup(){
  const box=$("#backupPanel"); if(!box) return; box.innerHTML="";
  const panel=el("div","panel");
  panel.innerHTML=`<h3>备份与恢复</h3><div class="hint">云端版:备份请点右上角「备份JSON」下载;恢复用下方「上传JSON恢复」(会先覆盖当前全部数据,操作不可逆,务必先备份)。Supabase 平台另有自动备份。</div>`;
  if(state.canEdit){
    const bar=el("div","modal-foot");
    const fi=el("input"); fi.type="file"; fi.accept=".json,application/json"; fi.style.display="none";
    const upBtn=el("button","btn btn-sm","↑ 上传JSON恢复"); upBtn.onclick=()=>fi.click();
    fi.onchange=async()=>{ const f=fi.files[0]; fi.value=""; if(!f)return;
      if(!confirm("用该 JSON 覆盖当前全部数据?(请先确保已备份当前数据)"))return;
      let data; try{ data=JSON.parse(await f.text()); }catch(e){ alert("JSON 解析失败"); return; }
      try{ const r=await api("POST","/api/import/json",data); alert("已恢复,人物 "+((r&&r.persons)||"?")+" 人。"); await reloadEverything(); }
      catch(e){ alert("恢复失败:"+e.message); } };
    bar.appendChild(el("span","spacer")); bar.appendChild(fi); bar.appendChild(upBtn);
    panel.appendChild(bar);
  } else { panel.appendChild(el("div","hint","(只读账号:仅可下载备份,不能恢复)")); }
  box.appendChild(panel);
}

function expectedCharGen(fatherId){   // 按父子相承:父的字辈在派语里的下一字
  const cg=(state.meta&&state.meta.charGen)||[]; const f=fatherId&&byId(fatherId);
  if(f&&f.char_gen&&f.char_gen!=="—"){ const i=cg.indexOf(f.char_gen); if(i>=0&&i+1<cg.length) return cg[i+1]; }
  return null;
}
function charGenAuto(){
  const hint=$("#charGenHint"); const cur=$("#f_char_gen").value.trim();
  const fid=$("#f_father_id").value; const expect=expectedCharGen(fid);
  if(expect){
    const fn=byId(fid).char_gen;
    if(!cur){ $("#f_char_gen").value=expect; hint.textContent="(已按父「"+fn+"」字辈顺推:"+expect+")"; hint.style.color="#047857"; }
    else if(cur!==expect){ hint.textContent="⚠ 父为"+fn+"字辈,子通常是「"+expect+"」"; hint.style.color="#b45309"; }
    else hint.textContent="";
  } else hint.textContent="";
}

/* ---------- 婚姻 ---------- */
// 婚姻文本编辑 UI 已移除(配偶改用「夫妻」关系 + 真实人物);marriages 数据层仍保留供导出/合并。

/* ---------- 相册 ---------- */
async function renderMedia(pid){
  const box=$("#mediaList"); box.innerHTML="";
  if(!pid){ $("#mediaHint").textContent="保存人物后可上传照片。"; $("#addPhoto").disabled=true; return; }
  $("#mediaHint").textContent=""; $("#addPhoto").disabled=false;
  const list=await api("GET","/api/persons/"+encodeURIComponent(pid)+"/media");
  if(!list.length){ box.appendChild(el("div","hint","(暂无照片)")); return; }
  list.forEach(md=>box.appendChild(mediaItem(md)));
}
function mediaItem(md){
  const it=el("div","gitem");
  const cap=el("input"); cap.type="text"; cap.placeholder="说明/年代"; cap.value=md.caption||"";
  const star=el("button","btn btn-sm"+(md.is_primary?" btn-primary":""), md.is_primary?"★ 主图":"设为主图");
  const del=el("button","btn btn-sm btn-danger","删除");
  star.onclick=async()=>{await api("PUT","/api/media/"+md.id,{is_primary:1});await renderMedia(state.editing);await reloadPersons();renderOverview();};
  cap.onchange=async()=>{await api("PUT","/api/media/"+md.id,{caption:cap.value});};
  del.onclick=async()=>{if(!confirm("删除这张照片?"))return;await api("DELETE","/api/media/"+md.id);await renderMedia(state.editing);await reloadPersons();renderOverview();};
  it.innerHTML=`<img src="${esc(window.photoUrl(md.path))}" alt=""/>`;
  const ctl=el("div","gctl"); ctl.appendChild(cap); const row=el("div","subrow-line"); row.appendChild(star); row.appendChild(del); ctl.appendChild(row);
  it.appendChild(ctl); return it;
}

/* ---------- 数据体检(P0-4/5) ---------- */
function runHealth(){
  const ps=state.persons, ids=new Set(ps.map(p=>p.id)), cg=(state.meta&&state.meta.charGen)||[];
  const F=state.fatherOf;
  const out={cycle:[],dangling:[],charBreak:[],yearConflict:[],genMismatch:[],noFather:[],dupName:[]};
  ps.forEach(p=>{ const f=F[p.id]; if(f && !ids.has(f)) out.dangling.push(p); });   // 悬空父(FK通常已挡)
  const inCycle=new Set();
  ps.forEach(p=>{ const seen=new Set(); let cur=p.id;
    while(cur && F[cur] && ids.has(F[cur])){ if(seen.has(cur)){ let x=cur; do{inCycle.add(x);x=F[x];}while(x&&x!==cur); break; } seen.add(cur); cur=F[cur]; } });
  out.cycle=ps.filter(p=>inCycle.has(p.id));
  ps.forEach(p=>{ const f=F[p.id]&&byId(F[p.id]);
    if(f&&f.char_gen&&f.char_gen!=="—"&&p.char_gen&&p.char_gen!=="—"){ const i=cg.indexOf(f.char_gen);
      if(i>=0&&i+1<cg.length&&p.char_gen!==cg[i+1]) out.charBreak.push({p,why:`父${f.name}「${f.char_gen}」→子应「${cg[i+1]}」,实为「${p.char_gen}」`}); } });
  const yr=s=>{ const m=(s||"").match(/\d{4}/); return m?+m[0]:null; };
  ps.forEach(p=>{ const b=yr(p.birth),d=yr(p.death);
    if(b&&d&&d<b) out.yearConflict.push({p,why:`卒(${d})早于生(${b})`});
    const f=F[p.id]&&byId(F[p.id]); if(f){ const fb=yr(f.birth); if(b&&fb&&b<=fb) out.yearConflict.push({p,why:`生(${b}) ≤ 父${f.name}生(${fb})`}); } });
  // 手填世代 ≠ 父+1(有父边且父能定位)
  ps.forEach(p=>{ const m=parseInt(p.gen,10), f=F[p.id]; if(!isNaN(m)&&f){ const fg=genOf(f); if(fg!=null&&m!==fg+1) out.genMismatch.push({p,why:`手填第${m}代,但父${(byId(f)||{}).name||f}第${fg}代(应第${fg+1}代)`}); } });
  // 本族但无父边且第>1代(疑缺父系连接,应补父亲让世代连续)
  ps.forEach(p=>{ if((p.kind||"本族")==="本族" && !F[p.id]){ const g=genOf(p.id); if(g!=null&&g>1) out.noFather.push({p,why:`第${g}代但未连父亲`}); } });
  const bn={}; ps.forEach(p=>{ if(p.name)(bn[p.name]=bn[p.name]||[]).push(p); });
  Object.keys(bn).forEach(n=>{ if(bn[n].length>1) out.dupName.push({name:n,list:bn[n]}); });
  return out;
}
function renderHealth(){
  const box=$("#health"); box.innerHTML=""; const h=runHealth();
  const total=h.cycle.length+h.dangling.length+h.charBreak.length+h.yearConflict.length+h.genMismatch.length+h.noFather.length;
  box.appendChild(el("p","note", total? `共发现 ${total} 处需注意(重名 ${h.dupName.length} 组另列,多为已知待核实的同名)。点条目可直接打开修正。` : "✅ 未发现父子/世代/年代/字辈类问题。"));
  const plink=(p,extra)=>{ const d=el("div","hitem"); d.innerHTML=`<a class="plink" data-pid="${esc(p.id)}">${esc(p.name||p.id)}</a> <span class="hint">${esc(extra||"")}</span>`; return d; };
  const sec=(title,arr,render,pill)=>{ const pn=el("div","panel");
    pn.innerHTML=`<h3>${title} <span class="pill ${arr.length?(pill||'pill-warn'):'pill-ok'}">${arr.length}</span></h3>`;
    if(!arr.length) pn.appendChild(el("div","hint","无")); else arr.forEach(x=>pn.appendChild(render(x)));
    box.appendChild(pn); };
  sec("① 父子成环", h.cycle, p=>plink(p,"处于父子循环中"));
  sec("② 父指向不存在/已删的人", h.dangling, p=>plink(p,"父边指向无效"));
  sec("③ 字辈不顺(父子相承)", h.charBreak, x=>plink(x.p,x.why));
  sec("④ 年代矛盾", h.yearConflict, x=>plink(x.p,x.why));
  sec("⑤ 手填世代与推算不符", h.genMismatch, x=>plink(x.p,x.why), "pill-info");
  sec("⑥ 疑缺父系连接(世代断点)", h.noFather, x=>plink(x.p,x.why), "pill-info");
  sec("⑦ 重名(同名异人?需核实)", h.dupName, x=>{ const d=el("div","hitem"); d.innerHTML=`<b>${esc(x.name)}</b>: `+x.list.map(p=>`<a class="plink chip" data-pid="${esc(p.id)}">${esc(p.id)}·第${genStr(p.id)}代</a>`).join("")+(state.canEdit?` <button class="btn btn-sm mergebtn" data-name="${esc(x.name)}">合并…</button>`:""); return d; }, "pill-info");
  box.querySelectorAll(".plink").forEach(a=>a.onclick=()=>{ const t=byId(a.dataset.pid); if(t){ state.canEdit?openEdit(t):openDetail(t); } });
  box.querySelectorAll(".mergebtn").forEach(b=>b.onclick=()=>{ const g=h.dupName.find(x=>x.name===b.dataset.name); if(g) openMergeDialog(g.list); });
}
// 合并对话框:选保留谁,其余并入(子女/关系/婚姻/照片/空字段都迁过去,被并入者进回收站)
function openMergeDialog(list){
  let mask=$("#mergeMask");
  if(!mask){ mask=el("div","mask"); mask.id="mergeMask"; document.body.appendChild(mask); }
  const rows=list.map((p,i)=>{ const kids=(state.childrenMap[p.id]||[]).length;
    return `<label class="mergerow"><input type="radio" name="mergeSurv" value="${esc(p.id)}"${i===0?" checked":""}> 保留 <b>${esc(p.name||"(无名)")}</b> <span class="hint">${esc(p.id)} · 第${genStr(p.id)}代 · ${esc(p.kind||"本族")} · 现有 ${kids} 子女</span></label>`; }).join("");
  mask.innerHTML=`<div class="modal" style="width:min(540px,100%)">
    <h2>合并重名:${esc(list[0].name||"")}</h2>
    <p class="hint">选一条<b>保留</b>,其余将并入它——子女/关系/婚姻/照片/空字段都迁到保留的那条,被并入者进回收站(可恢复)。<b>不可一键撤销,请确认是同一人</b>。同名跨代是合法的,不确定就别合。</p>
    ${rows}
    <div class="err" id="mergeErr"></div>
    <div class="modal-foot"><span class="spacer"></span><button class="btn" id="mergeCancel">取消</button><button class="btn btn-primary" id="mergeOk">确认合并</button></div>
  </div>`;
  mask.classList.add("open");
  $("#mergeCancel").onclick=()=>mask.classList.remove("open");
  mask.onclick=e=>{ if(e.target===mask) mask.classList.remove("open"); };
  $("#mergeOk").onclick=async()=>{
    const surv=mask.querySelector("input[name=mergeSurv]:checked").value;
    const dups=list.filter(p=>p.id!==surv);
    if(!dups.length){ $("#mergeErr").textContent="至少要有另一条并入"; return; }
    if(!confirm("确认把 "+dups.length+" 条并入「"+((byId(surv)||{}).name||surv)+"」?不可一键撤销。")) return;
    $("#mergeOk").disabled=true; $("#mergeErr").textContent="合并中…";
    try{ for(const d of dups){ await window.DEDUP.merge(surv, d.id); }
      mask.classList.remove("open"); await reloadPersons(); renderHeader(); renderOverview(); renderHealth(); }
    catch(e){ $("#mergeErr").textContent="失败:"+e.message; }
    $("#mergeOk").disabled=false;
  };
}

/* ---------- 人物只读详情(P0-1/2/3) ---------- */
const byId = id => state.persons.find(x => x.id === id);
function childrenOf(id){ return (state.childrenMap[id]||[]).map(byId).filter(Boolean).sort((a,b)=>(a.sort_order||0)-(b.sort_order||0)); }
function ancestorChain(p){            // 返回 [父, 祖, …, 始迁祖],带防环(走关系图 father 边)
  const chain=[]; const seen=new Set([p.id]); let cur=p.id;
  while(state.fatherOf[cur] && !seen.has(state.fatherOf[cur])){ const fid=state.fatherOf[cur]; const f=byId(fid); if(!f) break; chain.push(f); seen.add(fid); cur=fid; }
  return chain;
}
function closeDetail(){ $("#detailMask").classList.remove("open"); state.detailing=null; }
async function openDetail(p){
  if(!p) return;
  state.detailing=p.id;
  const box=$("#detailBody");
  const living=p.alive==="是", share=state.share&&living;
  const photo=(p.photo&&!share)?`<img class="dphoto" loading="lazy" src="${esc(window.photoUrl(p.photo))}">`:`<div class="dphoto noimg">${esc((p.name||"?").slice(-1))}</div>`;
  let html=`<div class="dhead">${photo}<div class="dhead-main"><div class="dname">${esc(p.name||"(无名)")}</div>`
    +`<div class="dpills">${(p.char_gen&&p.char_gen!=="—")?`<span class="tag">${esc(p.char_gen)}字辈</span>`:""}<span class="tag">第${genStr(p.id)}代</span>${living?'<span class="tag">在世</span>':""} ${statusPill(p.status)}</div></div></div>`;
  if(share){ box.innerHTML=html+`<p class="note">分享模式:在世亲属仅显示姓名/字辈/世代,其余隐藏。</p>`; $("#detailMask").classList.add("open"); return; }

  const chain=ancestorChain(p);
  if(chain.length){
    const seq=chain.slice().reverse().concat([p]);
    html+=`<div class="dchain"><span class="dk">直系</span> `+seq.map((x,i)=>
      (i?'<span class="arrow">→</span>':'')+(x.id===p.id?`<b>${esc(x.name)}</b>`:`<a class="plink" data-pid="${esc(x.id)}">${esc(x.name)}</a>`)).join("")+`</div>`;
  }

  const rows=[];
  const R=(k,v)=>{ if(v) rows.push(`<div class="drow"><span class="dk">${k}</span><span class="dv">${esc(v)}</span></div>`); };
  R("生", [p.birth, p.birth_lunar&&("农历 "+p.birth_lunar), p.birth_time].filter(Boolean).join(" · "));
  R("卒", [p.death, p.death_lunar&&("农历 "+p.death_lunar)].filter(Boolean).join(" · "));
  R("出生地", p.birth_place); R("葬地", p.burial); R("行第", p.rank); R("亲属关系", p.relation_type);
  R("字号", p.alias); R("性别", p.sex); R("学历/职业", p.occupation); R("居地/迁徙", p.residence);
  let fa=""; const _fid=state.fatherOf[p.id];
  if(_fid && byId(_fid)) fa=`<a class="plink" data-pid="${esc(_fid)}">${esc(byId(_fid).name)}</a>`;
  else if(p.father_note) fa=esc(p.father_note);
  if(fa) rows.push(`<div class="drow"><span class="dk">父</span><span class="dv">${fa}</span></div>`);
  R("母", p.mother); R("配偶", p.spouse);
  if(rows.length) html+=`<div class="dgrid">${rows.join("")}</div>`;

  const kids=childrenOf(p.id);
  if(kids.length){
    html+=`<div class="dsec"><div class="dsec-h">子女(${kids.length})</div><div class="dkids">`
      +kids.map(k=>`<a class="plink chip" data-pid="${esc(k.id)}">${esc(k.name||"(无名)")}</a>`).join("")+`</div></div>`;
  }
  if(p.contact||p.address){
    html+=`<div class="dsec"><div class="dsec-h">联系(内部 🔒)</div>`
      +[p.contact&&`<div class="ditem">${esc(p.contact)}</div>`, p.address&&`<div class="ditem">${esc(p.address)}</div>`].filter(Boolean).join("")+`</div>`;
  }
  if(p.deeds) html+=`<div class="dsec"><div class="dsec-h">事迹</div><div class="ditem">${esc(p.deeds)}</div></div>`;
  const m3=[p.source&&("来源:"+p.source), p.note&&("备注:"+p.note)].filter(Boolean);
  if(m3.length) html+=`<div class="dsec hint" style="margin-top:.6rem">${m3.map(esc).join("<br>")}</div>`;
  const media=await api("GET","/api/persons/"+encodeURIComponent(p.id)+"/media").catch(()=>[]);
  if(media.length){
    html+=`<div class="dsec"><div class="dsec-h">相册</div><div class="dalbum">`
      +media.map(md=>`<figure><img loading="lazy" src="${esc(window.photoUrl(md.path))}"><figcaption>${esc(md.caption||"")}</figcaption></figure>`).join("")+`</div></div>`;
  }
  // 关系网(详情页 = 关系管理中心:+加关系连已有 / 改备注 / 删;新建人物用底部 +加亲属)
  const rtMap={}; (state.relTypes&&state.relTypes.length?state.relTypes:(await window.REL.types().catch(()=>[]))).forEach(t=>rtMap[t.type]=t);
  const rels=await window.REL.of(p.id).catch(()=>[]);
  let rh="";
  if(rels.length){
    const byCat={};
    rels.forEach(r=>{
      const t=rtMap[r.type]||{label_zh:r.type,category:"其他"};
      const fromMe=r.from_id===p.id, other=fromMe?r.to_id:r.from_id, op=byId(other); if(!op) return;
      const lab=r.directed?(fromMe?(t.forward_label||t.label_zh):(t.inverse_label||t.label_zh)):t.label_zh;
      (byCat[t.category||"其他"]=byCat[t.category||"其他"]||[]).push({r,op,lab,color:t.color});
    });
    Object.keys(byCat).forEach(cat=>{
      rh+=`<div class="hint" style="margin:.4rem 0 .1rem">${esc(cat)}</div>`;
      byCat[cat].forEach(it=>{ rh+=`<div class="ditem"><span class="reltag" style="border-color:${esc(it.color||'#cbd5e1')};color:${esc(it.color||'#475569')}">${esc(it.lab)}</span> <a class="plink" data-pid="${esc(it.op.id)}">${esc(it.op.name||'(无名)')}</a>${it.r.note?`<span class="hint"> · ${esc(it.r.note)}</span>`:""}${state.canEdit?` <button class="btn btn-sm relnote" data-rid="${it.r.id}" title="改备注">改</button><button class="btn btn-sm reldel" data-rid="${it.r.id}" title="删除">✕</button>`:""}</div>`; });
    });
  } else rh=`<div class="hint">(暂无关系)</div>`;
  const addForm = state.canEdit ? `<div class="relquick" id="relAddForm" style="display:none">本人 是 <select id="dq_to"></select> 的 <select id="dq_type"></select> <input id="dq_note" placeholder="备注(可空,如原配/续娶)"> <button class="btn btn-sm btn-primary" id="dq_add">加</button> <span class="hint" id="dq_msg"></span></div>` : "";
  html+=`<div class="dsec"><div class="dsec-h">关系网(${rels.length}) <button class="btn btn-sm" id="relEgoBtn">🎯 关系圈</button>${state.canEdit?` <button class="btn btn-sm" id="relAddToggle">+ 加关系</button>`:""}</div>${addForm}${rh}</div>`;
  box.innerHTML=html;
  box.querySelectorAll(".plink").forEach(a=>a.onclick=()=>{ const t=byId(a.dataset.pid); if(t) openDetail(t); });
  { const eb=$("#relEgoBtn"); if(eb) eb.onclick=()=>{ state.graphCenter=p.id; state.pathA=""; state.pathB=""; closeDetail(); switchView("graph"); }; }
  box.querySelectorAll(".reldel").forEach(b=>b.onclick=async()=>{ if(!confirm("删除这条关系?"))return; try{ await window.REL.del(+b.dataset.rid); await refreshRelCount(); openDetail(byId(p.id)); }catch(e){ alert("删除失败:"+e.message); } });
  box.querySelectorAll(".relnote").forEach(b=>b.onclick=async()=>{ const cur=(rels.find(r=>String(r.id)===b.dataset.rid)||{}).note||""; const nv=prompt("关系备注(如 原配/续娶/侧室):",cur); if(nv===null)return; try{ await window.REL.update(+b.dataset.rid,{note:nv.trim()}); openDetail(byId(p.id)); }catch(e){ alert("失败:"+e.message); } });
  const tgl=$("#relAddToggle");
  if(tgl) tgl.onclick=()=>{ const f=$("#relAddForm"); const show=f.style.display==="none"; f.style.display=show?"":"none";
    if(show){ $("#dq_to").innerHTML=`<option value="">选人物</option>`+personOptions(); $("#dq_type").innerHTML=`<option value="">选关系</option>`+relOptions().map(o=>`<option value="${o.val}">${esc(o.label)}</option>`).join(""); } };
  const dqAdd=$("#dq_add");
  if(dqAdd) dqAdd.onclick=async()=>{
    const to=$("#dq_to").value, rt=$("#dq_type").value, note=$("#dq_note").value.trim(), msg=$("#dq_msg");
    if(!to||!rt){ msg.textContent="选人物和关系"; return; }
    if(to===p.id){ msg.textContent="不能和自己"; return; }
    const [type,side]=rt.split("|"); let from,toId; if(side==="f"){ from=to; toId=p.id; } else { from=p.id; toId=to; }
    try{ await window.REL.add({from_id:from,to_id:toId,type,note}); await refreshRelCount(); openDetail(byId(p.id)); }
    catch(e){ msg.textContent=(/duplicate|unique/i.test(e.message)?"该关系已存在":e.message); }
  };
  $("#detailMask").classList.add("open");
}

/* ---------- 加亲属(统一:新建人物 + 一条初始关系)---------- */
function openAddRelative(person){
  if(!person) return; closeDetail();
  openEdit(null, { kind:"本族", status:"待考", alive:"是", _relTo:person.id });
}
// 初始关系下拉:由关系字典生成(有向→2项:本人是X的「父/inverse」或「子女/forward」;对称→1项)
function relOptions(){
  const opts=[];
  (state.relTypes||[]).forEach(t=>{
    if(t.is_symmetric){ opts.push({val:t.type+"|s", label:(t.forward_label||t.label_zh)}); }
    else { opts.push({val:t.type+"|i", label:(t.inverse_label||t.label_zh)});
      let fl=t.forward_label||t.label_zh; if(fl==="子女") fl="子女("+(t.inverse_label||"父")+"系)";
      opts.push({val:t.type+"|f", label:fl}); }
  });
  return opts;
}
// 选了初始关系时智能预填 世代/字辈/性别(复刻原 加子女/加配偶 便利)
function initRelAuto(){
  const wrap=$("#initRelWrap"); if(!wrap||wrap.style.display==="none") return;
  const pid=$("#f_rel_person").value, rt=$("#f_rel_type").value, X=pid&&byId(pid), hint=$("#initRelHint");
  if(hint) hint.textContent="";
  if(!X||!rt) return;
  if(rt==="father|f"&&!$("#f_char_gen").value){ const cg=expectedCharGen(pid); if(cg)$("#f_char_gen").value=cg; }  // 子(父系)字辈顺推
  else if(rt==="spouse|s"&&!$("#f_sex").value){ $("#f_sex").value=X.sex==="男"?"女":(X.sex==="女"?"男":""); }       // 配偶性别取反
  const tn=(state.relTypes.find(t=>t.type===rt.split("|")[0])||{}).label_zh||"";
  if(hint&&tn) hint.textContent="保存后将与「"+(X.name||pid)+"」建立关系;世代自动推算";
}

/* ---------- 人物详情/编辑弹窗 ---------- */
function fillFatherSelect(currentId, selected){
  const sel=$("#f_father_id"); sel.innerHTML="";
  const o0=el("option",null,"(无 / 见父系说明)"); o0.value=""; sel.appendChild(o0);
  state.persons.filter(p=>p.id!==currentId).sort((a,b)=>gk(genOf(a.id))-gk(genOf(b.id))).forEach(p=>{
    const g=genOf(p.id); const o=el("option",null,`${esc(p.name)} — ${esc(p.id)}(第${g==null?"?":g}代)`); o.value=p.id; if(p.id===selected)o.selected=true; sel.appendChild(o);
  });
}
function openEdit(p, prefill){
  state.editing=p?p.id:null;
  $("#modalTitle").textContent=p?("详情 / 编辑:"+(p.name||p.id)):"添加人物";
  $("#delBtn").style.display=p?"inline-block":"none";
  $("#modalErr").textContent="";
  const v=p||prefill||{status:"待考"};
  FORM_KEYS.forEach(k=>{ const f=$("#f_"+k); if(f) f.value=v[k]!=null?v[k]:""; });
  fillFatherSelect(p?p.id:null, p?(state.fatherOf[p.id]||""):"");
  renderMedia(p?p.id:null);
  if(p){ $("#initRelWrap").style.display="none"; }   // 编辑已有人物:关系在「关系」标签/详情管理
  else {
    $("#f_rel_person").innerHTML=`<option value="">— 不连任何人 —</option>`+personOptions();
    $("#f_rel_type").innerHTML=`<option value="">— 选关系 —</option>`+relOptions().map(o=>`<option value="${o.val}">${esc(o.label)}</option>`).join("");
    $("#f_rel_person").value=(prefill&&prefill._relTo)||"";
    $("#f_rel_type").value=(prefill&&prefill._relType)||"";
    $("#initRelWrap").style.display="";
  }
  $("#charGenHint").textContent=""; charGenAuto(); applyKindUI(); initRelAuto();
  $("#mask").classList.add("open");
}
// 本族/外部 切换:外部隐藏族谱专属字段;已填内容默认保留(非破坏),并提供「清空」入口
const FAM_FIELDS=["gen","char_gen","rank","relation_type","father_id","father_note"];
function applyKindUI(){
  const ext = $("#f_kind") && $("#f_kind").value==="外部";
  $("#mask").classList.toggle("ext", !!ext);
  const wrap=$("#kindNoteWrap"); if(!wrap) return;
  if(ext){
    const has = FAM_FIELDS.some(k=>{ const e=$("#f_"+k); return e && (e.value||"").trim(); });
    if(has){
      $("#kindNote").innerHTML='已隐藏族谱专属字段(世代/字辈/行第/亲属关系/父亲),已填内容<b>仍保留</b>。确为外部人士可 <button type="button" class="btn btn-sm" id="kindClear">清空这些字段</button>';
      wrap.style.display="";
      $("#kindClear").onclick=()=>{ if(!confirm("清空 世代/字辈/行第/亲属关系/父亲/父系说明?(保存后生效)"))return; FAM_FIELDS.forEach(k=>{ const e=$("#f_"+k); if(e) e.value=""; }); applyKindUI(); };
    } else wrap.style.display="none";
  } else wrap.style.display="none";
}
function closeModal(){ $("#mask").classList.remove("open"); state.editing=null; }
function collectForm(){ const d={}; FORM_KEYS.forEach(k=>{ const f=$("#f_"+k); if(f) d[k]=f.value.trim(); }); return d; }  // 父亲改走关系边,不再写 father_id 列
// 对账父亲:表单选的父 与 当前 father 边 不同则 删旧边+建新边(单一真源=关系图)
async function reconcileFatherEdge(childId, newFatherId){
  newFatherId=(newFatherId||"").trim();
  const cur=state.fatherOf[childId]||"";
  if(newFatherId===cur || newFatherId===childId) return;
  if(cur){ try{ const edges=await window.REL.of(childId); const old=edges.find(r=>r.type==="father"&&r.to_id===childId); if(old) await window.REL.del(old.id); }catch(e){} }
  if(newFatherId){ try{ await window.REL.add({from_id:newFatherId,to_id:childId,type:"father"}); }catch(e){} }
}
async function saveModal(){
  const d=collectForm(); const fsel=$("#f_father_id").value;
  try{
    if(state.editing){
      await api("PUT","/api/persons/"+encodeURIComponent(state.editing),d);
      await reconcileFatherEdge(state.editing, fsel);
      closeModal(); await reloadPersons(); await refreshRelCount(); renderHeader(); renderOverview();
    } else {
      if(d.name){ const same=await window.DEDUP.sameName(d.name,null);
        if(same.length && !confirm("已有 "+same.length+" 个同名:"+same.map(s=>(s.name)+"(第"+(s.gen||"?")+"代)").join("、")+"。\n同名可能是不同人。仍要创建?")) return; }
      const row=await api("POST","/api/persons",d);
      state.editing=row.id; $("#f_id").value=row.id;
      $("#modalTitle").textContent="详情 / 编辑:"+(row.name||row.id);
      $("#delBtn").style.display="inline-block";
      await reconcileFatherEdge(row.id, fsel);
      let extra="";
      const rp=$("#f_rel_person").value, rt=$("#f_rel_type").value;
      if($("#initRelWrap").style.display!=="none" && rp && rt){
        const [type,side]=rt.split("|"); let from,to;
        if(side==="f"){ from=rp; to=row.id; } else { from=row.id; to=rp; }
        try{ await window.REL.add({from_id:from,to_id:to,type}); const tn=(state.relTypes.find(t=>t.type===type)||{}).label_zh||type; extra=" 已与「"+(((byId(rp)||{}).name)||rp)+"」建立「"+tn+"」关系。"; }
        catch(e){ extra=" (关系建立失败:"+(/duplicate|unique/i.test(e.message)?"该关系已存在":e.message)+")"; }
      }
      $("#initRelWrap").style.display="none";
      $("#modalErr").innerHTML='<span style="color:#047857">已创建,可继续上传照片;或点关闭。'+esc(extra)+'</span>';
      await reloadPersons(); await refreshRelCount(); renderHeader(); renderOverview();
      fillFatherSelect(row.id, state.fatherOf[row.id]||""); renderMedia(row.id);
    }
  }catch(e){ $("#modalErr").textContent="保存失败:"+e.message; }
}
async function delModal(){
  if(!state.editing) return;
  if(!confirm("将该人物移入回收站(可恢复)?")) return;
  try{ await api("DELETE","/api/persons/"+encodeURIComponent(state.editing)); closeModal(); await reloadPersons(); renderHeader(); renderOverview(); }
  catch(e){ $("#modalErr").textContent="删除失败:"+e.message; }
}
function compressImage(file){   // 上传前缩放压缩(>1600px 缩到 1600,转 JPEG q0.85),失败则原样
  return new Promise(resolve=>{
    const reader=new FileReader();
    reader.onload=()=>{
      const img=new Image();
      img.onload=()=>{
        const max=1600; let w=img.width, h=img.height;
        if(w<=max && h<=max){ resolve(reader.result); return; }
        const s=Math.min(max/w, max/h); w=Math.round(w*s); h=Math.round(h*s);
        try{ const cv=document.createElement("canvas"); cv.width=w; cv.height=h;
          cv.getContext("2d").drawImage(img,0,0,w,h); resolve(cv.toDataURL("image/jpeg",0.85)); }
        catch(e){ resolve(reader.result); }
      };
      img.onerror=()=>resolve(reader.result); img.src=reader.result;
    };
    reader.readAsDataURL(file);
  });
}
async function uploadMedia(file){
  if(!state.editing){ alert("请先保存人物"); return; }
  try{
    const dataUrl=await compressImage(file);
    await api("POST","/api/persons/"+encodeURIComponent(state.editing)+"/media",{filename:file.name,dataUrl});
    await renderMedia(state.editing); await reloadPersons(); renderOverview();
  }catch(e){ $("#modalErr").textContent="上传失败:"+e.message; }
}

/* ---------- 关系(通用人际关系):列表 + 增改删 ---------- */
function personOptions(sel){
  return state.persons.filter(p=>!p.deleted)
    .sort((a,b)=>(parseInt(a.gen)||0)-(parseInt(b.gen)||0)||(a.sort_order||0)-(b.sort_order||0))
    .map(p=>`<option value="${esc(p.id)}"${p.id===sel?" selected":""}>${esc(p.name||"(无名)")} — ${esc(p.id)}</option>`).join("");
}
// 「关系」标签已移除;关系的增/删/改收归到人物详情页(见 openDetail)。personOptions/relOptions 仍复用。

/* ---------- 关系图谱(ECharts,懒加载 CDN)---------- */
let _echarts=null, _graphChart=null;
async function getECharts(){ if(!_echarts) _echarts=await import("https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.esm.min.mjs"); return _echarts; }
// 无向 BFS 最短路径(连通性,用于"两人怎么连")
function bfsPath(adj,a,b){
  const prev={}; prev[a]=null; const q=[a];
  while(q.length){ const cur=q.shift(); if(cur===b){ const path=[]; let x=b; while(x!=null){ path.unshift(x); x=prev[x]; } return path; }
    (adj[cur]||[]).forEach(n=>{ if(!(n in prev)){ prev[n]=cur; q.push(n); } }); }
  return null;
}
function fillGraphControls(){
  const opts=`<option value="">—</option>`+personOptions();
  [["gc_center",state.graphCenter],["gc_pathA",state.pathA],["gc_pathB",state.pathB]].forEach(([id,val])=>{ const s=$("#"+id); if(s){ s.innerHTML=opts; s.value=val||""; } });
  const hs=$("#gc_hops"); if(hs) hs.value=String(state.graphHops||2);
}
async function renderGraph(){
  const box=$("#graphBox"); if(!box) return;
  box.innerHTML="<p class='note' style='padding:1rem'>加载关系图谱…</p>";
  let echarts,rels,types;
  try{ echarts=await getECharts(); rels=await window.REL.all(); types=await window.REL.types(); }
  catch(e){ box.innerHTML="<p style='padding:1rem;color:#b91c1c'>图谱加载失败:"+esc(e.message)+"</p>"; return; }
  const tmap={}; types.forEach(t=>tmap[t.type]=t);
  const persons=state.persons.filter(p=>!p.deleted); const idset=new Set(persons.map(p=>p.id));
  const edges=rels.filter(r=>idset.has(r.from_id)&&idset.has(r.to_id));
  const adj={}, edgeOf={};
  edges.forEach(r=>{ (adj[r.from_id]=adj[r.from_id]||[]).push(r.to_id); (adj[r.to_id]=adj[r.to_id]||[]).push(r.from_id); edgeOf[r.from_id+"|"+r.to_id]=r; edgeOf[r.to_id+"|"+r.from_id]=r; });
  fillGraphControls();
  // 局部圈(以中心人物 N 跳)
  let visible=null;
  if(state.graphCenter && idset.has(state.graphCenter)){
    visible=new Set([state.graphCenter]); let fr=[state.graphCenter];
    for(let h=0;h<(state.graphHops||2);h++){ const nx=[]; fr.forEach(id=>(adj[id]||[]).forEach(n=>{ if(!visible.has(n)){visible.add(n);nx.push(n);} })); fr=nx; }
  }
  // 最短关系链
  let pathSet=null, pathEdge=null, pathText="";
  if(state.pathA && state.pathB && state.pathA!==state.pathB && idset.has(state.pathA) && idset.has(state.pathB)){
    const path=bfsPath(adj,state.pathA,state.pathB);
    if(path){ pathSet=new Set(path); pathEdge=new Set(); const segs=[];
      for(let i=0;i<path.length-1;i++){ pathEdge.add(path[i]+"|"+path[i+1]); pathEdge.add(path[i+1]+"|"+path[i]);
        const r=edgeOf[path[i]+"|"+path[i+1]]||{}, t=tmap[r.type]||{};
        segs.push(esc((byId(path[i])||{}).name||path[i])+' <span style="color:#f59e0b">—'+esc(t.label_zh||r.type||"")+'→</span>'); }
      segs.push(esc((byId(path[path.length-1])||{}).name||""));
      pathText="最短关系链("+(path.length-1)+"步):"+segs.join(" ");
      if(visible) path.forEach(id=>visible.add(id));
    } else pathText="「"+esc((byId(state.pathA)||{}).name||"")+"」与「"+esc((byId(state.pathB)||{}).name||"")+"」之间无可达关系路径。";
  }
  const pt=$("#graphPathText"); if(pt) pt.innerHTML=pathText;
  const show = visible || idset;
  const deg={}; edges.forEach(r=>{ deg[r.from_id]=(deg[r.from_id]||0)+1; deg[r.to_id]=(deg[r.to_id]||0)+1; });
  const dimNode = id => pathSet && !pathSet.has(id);
  const nodes=persons.filter(p=>show===idset||show.has(p.id)).map(p=>{
    const onPath=!!(pathSet&&pathSet.has(p.id)), isCenter=p.id===state.graphCenter;
    return { id:p.id, name:p.name||"(无名)", symbolSize:(onPath||isCenter?12:0)+Math.min(44,16+(deg[p.id]||0)*4),
      value:(p.char_gen&&p.char_gen!=="—"?p.char_gen+"字辈·":"")+"第"+genStr(p.id)+"代",
      itemStyle:{ color:p.alive==="是"?"#10b981":"#64748b", opacity:dimNode(p.id)?0.18:1, borderColor:isCenter?"#dc2626":(onPath?"#f59e0b":"transparent"), borderWidth:(isCenter||onPath)?3:0 },
      label:{ show: !pathSet || onPath } };
  });
  const nodeIds=new Set(nodes.map(n=>n.id));
  const links=edges.filter(r=>nodeIds.has(r.from_id)&&nodeIds.has(r.to_id)).map(r=>{ const t=tmap[r.type]||{}, onP=!!(pathEdge&&pathEdge.has(r.from_id+"|"+r.to_id));
    return { source:r.from_id, target:r.to_id, value:t.label_zh||r.type,
      lineStyle:{color:onP?"#f59e0b":(t.color||"#94a3b8"),width:onP?4:1.5,curveness:0.06,opacity:pathSet?(onP?1:0.1):0.72}, symbol:r.directed?["none","arrow"]:["none","none"], symbolSize:onP?10:7 }; });
  const legend=$("#graphLegend"); if(legend) legend.innerHTML=`<span class="leg"><i style="background:#10b981;width:10px;height:10px;border-radius:50%"></i>在世</span><span class="leg"><i style="background:#64748b;width:10px;height:10px;border-radius:50%"></i>已故</span>`+(state.graphCenter?`<span class="leg" style="color:#dc2626">● 中心(${esc((byId(state.graphCenter)||{}).name||"")}/${state.graphHops}跳)</span>`:"")+types.map(t=>`<span class="leg"><i style="background:${esc(t.color)}"></i>${esc(t.label_zh)}</span>`).join("");
  box.innerHTML=""; box.style.height="66vh";
  if(_graphChart){ try{_graphChart.dispose();}catch(e){} }
  _graphChart=echarts.init(box);
  _graphChart.setOption({
    tooltip:{ formatter:pp=> pp.dataType==="edge" ? esc(pp.data.value) : "<b>"+esc(pp.data.name)+"</b><br>"+esc(pp.data.value) },
    series:[{ type:"graph", layout:"force", roam:true, draggable:true, force:{repulsion:230,edgeLength:95,gravity:0.08},
      label:{show:true,position:"right",fontSize:11,fontFamily:'"PingFang SC","Noto Sans SC",sans-serif',color:"#0f172a"},
      emphasis:{focus:"adjacency",lineStyle:{width:4}}, lineStyle:{color:"#94a3b8"}, data:nodes, links:links }]
  });
  _graphChart.on("click", pp=>{ if(pp.dataType==="node"){ const t=byId(pp.data.id); if(t) openDetail(t); } });
}
window.addEventListener("resize", ()=>{ const v=document.getElementById("view-graph"); if(_graphChart&&v&&v.classList.contains("active")) _graphChart.resize(); });

/* ---------- 名册:全部人员表格 · 列可配置 · 可排序 · 点行编辑 ---------- */
const ROSTER_COLS = [
  {k:"name",label:"姓名"},{k:"kind",label:"本族/外部"},{k:"gen",label:"世代"},{k:"char_gen",label:"字辈"},
  {k:"sex",label:"性别"},{k:"alive",label:"在世"},{k:"rel_count",label:"关系数"},{k:"lineage",label:"族谱"},{k:"rank",label:"行第"},{k:"relation_type",label:"亲属关系"},
  {k:"birth",label:"生年"},{k:"birth_lunar",label:"农历生"},{k:"birth_time",label:"出生时间"},{k:"death",label:"卒年"},
  {k:"birth_place",label:"出生地"},{k:"occupation",label:"学历/职业"},{k:"residence",label:"居地"},{k:"burial",label:"葬地"},
  {k:"mother",label:"母"},{k:"spouse",label:"配偶"},{k:"contact",label:"联系方式"},{k:"address",label:"住址"},
  {k:"status",label:"状态"},{k:"note",label:"备注"},{k:"id",label:"ID"}
];
const ROSTER_DEFAULT = ["name","kind","gen","char_gen","sex","alive","birth","death","occupation"];
function rosterCols(){ try{ const s=JSON.parse(localStorage.getItem("roster_cols")||"null"); if(Array.isArray(s)&&s.length) return s; }catch(e){} return ROSTER_DEFAULT.slice(); }
let _rosterSort={k:"gen",dir:1}, _colpickOpen=false;
function renderRoster(){
  const box=$("#rosterBox"); if(!box) return;
  const colset=new Set(rosterCols());
  const orderedCols=ROSTER_COLS.filter(c=>colset.has(c.k));
  let list=state.persons.filter(p=>!p.deleted && matchQ(p));
  const kind=$("#rosterKind") ? $("#rosterKind").value : "";
  if(kind) list=list.filter(p=>(p.kind||"本族")===kind);
  const sk=_rosterSort.k, dir=_rosterSort.dir;
  list=list.slice().sort((a,b)=>{ let va,vb; if(sk==="gen"){va=gk(genOf(a.id));vb=gk(genOf(b.id));} else if(sk==="rel_count"){va=state.relCount[a.id]||0;vb=state.relCount[b.id]||0;} else if(sk==="lineage"){va=lineageOf(a.id);vb=lineageOf(b.id);} else {va=(a[sk]??"")+"";vb=(b[sk]??"")+"";}
    return va<vb?-dir:va>vb?dir:0; });
  const picker=`<details class="colpick"${_colpickOpen?" open":""}><summary>列设置(${colset.size} 列)</summary><div class="colgrid">`
    + ROSTER_COLS.map(c=>`<label><input type="checkbox" data-col="${c.k}"${colset.has(c.k)?" checked":""}> ${esc(c.label)}</label>`).join("") + `</div></details>`;
  const bar=`<div class="rosterbar">${picker}`
    + `<select id="rosterKind"><option value="">全部</option><option value="本族"${kind==="本族"?" selected":""}>本族</option><option value="外部"${kind==="外部"?" selected":""}>外部</option></select>`
    + `<span class="hint">${list.length} 人 · 点一行${state.canEdit?"编辑":"看详情"}</span></div>`;
  const thead="<tr>"+orderedCols.map(c=>`<th data-sk="${c.k}">${esc(c.label)}${sk===c.k?(dir>0?" ▲":" ▼"):""}</th>`).join("")+"</tr>";
  const fmt=(p,k)=> k==="kind"?(p.kind||"本族"):(k==="rel_count"?(state.relCount[p.id]||0):(k==="gen"?(genOf(p.id)??""):(k==="lineage"?lineageOf(p.id):(p[k]==null?"":p[k]))));
  const rows=list.map(p=>`<tr data-pid="${esc(p.id)}">`+orderedCols.map(c=>`<td>${esc(String(fmt(p,c.k)))}</td>`).join("")+`</tr>`).join("");
  box.innerHTML=bar+`<div class="rostertable"><table class="roster"><thead>${thead}</thead><tbody>${rows||""}</tbody></table></div>`;
  const dt=box.querySelector(".colpick"); if(dt) dt.ontoggle=e=>{ _colpickOpen=e.target.open; };
  box.querySelectorAll(".colpick input[type=checkbox]").forEach(cb=>cb.onchange=()=>{
    const cur=new Set(rosterCols()); cb.checked?cur.add(cb.dataset.col):cur.delete(cb.dataset.col);
    localStorage.setItem("roster_cols", JSON.stringify(ROSTER_COLS.filter(c=>cur.has(c.k)).map(c=>c.k))); renderRoster(); });
  const rk=$("#rosterKind"); if(rk) rk.onchange=renderRoster;
  box.querySelectorAll("th[data-sk]").forEach(th=>th.onclick=()=>{ const k=th.dataset.sk; _rosterSort=(sk===k)?{k,dir:-dir}:{k,dir:1}; renderRoster(); });
  box.querySelectorAll("tbody tr").forEach(tr=>tr.onclick=()=>{ const p=byId(tr.dataset.pid); if(p){ state.canEdit?openEdit(p):openDetail(p); } });
}

/* ---------- AI 批量添加(粘贴文字 → DeepSeek 识别 → 草稿审核 → 创建)---------- */
let _aiDrafts=[];
const AI_DRAFT_FIELDS=[
  {k:"name",label:"姓名"},{k:"kind",label:"类型",type:"kind"},{k:"sex",label:"性别",type:"sex"},
  {k:"gen",label:"世代"},{k:"char_gen",label:"字辈"},{k:"rank",label:"行第"},
  {k:"birth",label:"生年"},{k:"birth_lunar",label:"农历生"},{k:"death",label:"卒年"},
  {k:"birth_place",label:"出生地"},{k:"occupation",label:"职业"},{k:"residence",label:"居地"},
  {k:"spouse",label:"配偶"},{k:"mother",label:"母"},{k:"father_note",label:"父(文字)"},{k:"note",label:"备注"}
];
function openAI(){ $("#aiText").value=""; $("#aiMsg").textContent=""; $("#aiDrafts").innerHTML=""; $("#aiCreateBar").style.display="none"; _aiDrafts=[]; $("#aiMask").classList.add("open"); }
async function aiParse(){
  const text=$("#aiText").value.trim(), msg=$("#aiMsg");
  if(!text){ msg.textContent="请先粘贴文字"; return; }
  msg.textContent="识别中…(首次可能十几秒)"; $("#aiParse").disabled=true;
  try{
    const session=await window.SBAUTH.getSession(); const token=session&&session.access_token;
    const r=await fetch("/api/ai-parse",{ method:"POST", headers:{ "content-type":"application/json", authorization:"Bearer "+(token||"") }, body:JSON.stringify({text}) });
    const data=await r.json().catch(()=>({error:"返回非JSON(可能AI代理未部署)"}));
    if(!r.ok){ msg.textContent="失败:"+(data.error||r.status); return; }
    _aiDrafts=(data.persons||[]).map(p=>{ const d={}; AI_DRAFT_FIELDS.forEach(f=>d[f.k]=p[f.k]!=null?String(p[f.k]):""); if(!d.father_note&&p.father) d.father_note="父:"+p.father; if(!d.kind) d.kind="本族"; return d; });
    msg.textContent=`识别到 ${_aiDrafts.length} 人,请核对补齐后创建`;
    renderAIDrafts();
  }catch(e){ msg.textContent="网络/服务错误:"+e.message; }
  finally{ $("#aiParse").disabled=false; }
}
function renderAIDrafts(){
  const box=$("#aiDrafts");
  if(!_aiDrafts.length){ box.innerHTML="<p class='hint'>没识别到人物。换段文字或手动添加。</p>"; $("#aiCreateBar").style.display="none"; return; }
  const existing={}; state.persons.filter(p=>!p.deleted).forEach(p=>{ if(p.name)(existing[p.name]=existing[p.name]||[]).push(p); });
  const seen={};
  box.innerHTML=_aiDrafts.map((d,i)=>{
    const nm=(d.name||"").trim(); const ex=nm?(existing[nm]||[]):[]; const batchDup=!!(nm&&seen[nm]); if(nm) seen[nm]=(seen[nm]||0)+1;
    const warn=(ex.length||batchDup)
      ? `<span class="aidup">⚠ ${ex.length?("库中已有同名:"+ex.slice(0,3).map(p=>esc(p.name)+"(第"+genStr(p.id)+"代)").join("、")):"本批内重复"}</span><label class="aidraft-skip"><input type="checkbox" data-i="${i}" data-skip${d._skip?" checked":""}> 跳过不建</label>` : "";
    return `<div class="aidraft${d._skip?" skipped":""}"><div class="aidraft-h">#${i+1} ${esc(d.name||"(未命名)")} ${warn} <button class="btn btn-sm aidraft-del" data-i="${i}">删除此条</button></div><div class="aidraft-grid">`
    + AI_DRAFT_FIELDS.map(f=>{
        if(f.type==="kind") return `<label>${f.label}<select data-i="${i}" data-k="kind"><option${d.kind!=="外部"?" selected":""}>本族</option><option${d.kind==="外部"?" selected":""}>外部</option></select></label>`;
        if(f.type==="sex") return `<label>${f.label}<select data-i="${i}" data-k="sex"><option value=""${!d.sex?" selected":""}></option><option${d.sex==="男"?" selected":""}>男</option><option${d.sex==="女"?" selected":""}>女</option></select></label>`;
        return `<label>${f.label}<input data-i="${i}" data-k="${f.k}" value="${esc(d[f.k]||"")}"></label>`;
      }).join("") + `</div></div>`; }).join("");
  $("#aiCreateBar").style.display="flex";
  box.querySelectorAll("[data-k]").forEach(e2=>{ e2.oninput=e2.onchange=()=>{ _aiDrafts[+e2.dataset.i][e2.dataset.k]=e2.value; }; });
  box.querySelectorAll("[data-skip]").forEach(cb=>cb.onchange=()=>{ _aiDrafts[+cb.dataset.i]._skip=cb.checked; renderAIDrafts(); });
  box.querySelectorAll(".aidraft-del").forEach(b=>b.onclick=()=>{ _aiDrafts.splice(+b.dataset.i,1); renderAIDrafts(); });
}
async function aiCreateAll(){
  const valid=_aiDrafts.filter(d=>(d.name||"").trim() && !d._skip);
  const skipped=_aiDrafts.filter(d=>(d.name||"").trim() && d._skip).length;
  if(!valid.length){ alert("没有可创建的人物(需姓名,且未勾「跳过」)"); return; }
  if(!confirm("将创建 "+valid.length+" 个人物(状态=待考)"+(skipped?(",跳过 "+skipped+" 条疑似重复"):"")+"?")) return;
  const btn=$("#aiCreateAll"); btn.disabled=true; let ok=0, fail=0;
  for(const d of valid){ try{ await api("POST","/api/persons",{ ...d, status:"待考" }); ok++; }catch(e){ fail++; } }
  btn.disabled=false;
  await reloadPersons(); renderOverview(); renderHeader();
  $("#aiMsg").textContent=`已创建 ${ok} 人${fail?(",失败 "+fail):""}`;
  _aiDrafts=[]; renderAIDrafts();
  if(!fail) setTimeout(()=>$("#aiMask").classList.remove("open"), 1200);
}

/* ---------- 标签切换 ---------- */
function switchView(name){
  document.querySelectorAll(".tab").forEach(t=>t.classList.toggle("active",t.dataset.view===name));
  document.querySelectorAll(".view").forEach(v=>v.classList.remove("active"));
  $("#view-"+name).classList.add("active");
  if(location.hash!=="#"+name) location.hash=name;
  if(name==="tree") renderTree();
  if(name==="graph") renderGraph();
  if(name==="roster") renderRoster();
  if(name==="trash") renderTrash();
  if(name==="health") renderHealth();
  if(name==="log"){ renderBackup(); renderLog(); }
}
document.querySelectorAll(".tab").forEach(t=>t.onclick=()=>switchView(t.dataset.view));
$("#search").oninput=e=>{ state.q=e.target.value; renderFilters(); renderOverview(); if(document.getElementById("view-roster").classList.contains("active")) renderRoster(); };
$("#shareMode").onchange=e=>{ state.share=e.target.checked; renderOverview(); };
$("#addBtn").onclick=()=>openEdit(null);
$("#saveBtn").onclick=saveModal;
$("#delBtn").onclick=delModal;
$("#cancelBtn").onclick=closeModal;
$("#reTree").onclick=renderTree;
$("#gc_center")&&($("#gc_center").onchange=e=>{ state.graphCenter=e.target.value; renderGraph(); });
$("#gc_hops")&&($("#gc_hops").onchange=e=>{ state.graphHops=+e.target.value||2; renderGraph(); });
$("#gc_pathA")&&($("#gc_pathA").onchange=e=>{ state.pathA=e.target.value; renderGraph(); });
$("#gc_pathB")&&($("#gc_pathB").onchange=e=>{ state.pathB=e.target.value; renderGraph(); });
$("#gc_clear")&&($("#gc_clear").onclick=()=>{ state.graphCenter=""; state.pathA=""; state.pathB=""; renderGraph(); });
$("#f_father_id").onchange=charGenAuto;
$("#f_kind").onchange=applyKindUI;
$("#f_rel_person").onchange=initRelAuto;
$("#f_rel_type").onchange=initRelAuto;
$("#logoutBtn").onclick=async()=>{ try{ await window.SBAUTH.signOut(); }catch(e){} location.reload(); };
$("#mask").onclick=e=>{ if(e.target===$("#mask")) closeModal(); };
$("#dCloseBtn").onclick=closeDetail;
$("#dEditBtn").onclick=()=>{ const p=byId(state.detailing); closeDetail(); if(p) openEdit(p); };
$("#dAddRelative").onclick=()=>openAddRelative(byId(state.detailing));
$("#detailMask").onclick=e=>{ if(e.target===$("#detailMask")) closeDetail(); };
$("#addPhoto").onclick=()=>{ if(!state.editing){alert("请先保存人物");return;} $("#mediaFile").click(); };
$("#mediaFile").onchange=e=>{ if(e.target.files[0]) uploadMedia(e.target.files[0]); e.target.value=""; };
$("#addVerify").onclick=async()=>{
  if(!state.canEdit){ alert("只读账号无权编辑"); return; }
  try{ const v=await api("POST","/api/verify",{category:"其他",topic:"(新待核实项)",detail:"",status:"待考"}); state.verify.push(v); renderVerify(); renderHeader(); }
  catch(e){ alert("新增失败:"+e.message); }
};

/* ---------- 导出(客户端生成下载;分享模式=脱敏) ---------- */
$("#exShareHtml") && ($("#exShareHtml").onclick=()=>window.EXPORT.shareHtml());
$("#exCsv")       && ($("#exCsv").onclick=()=>window.EXPORT.csv(state.share));
$("#exGedcom")    && ($("#exGedcom").onclick=()=>window.EXPORT.gedcom());
$("#exJson")      && ($("#exJson").onclick=()=>window.EXPORT.json(state.share));
$("#aiBtn")       && ($("#aiBtn").onclick=openAI);
$("#aiParse")     && ($("#aiParse").onclick=aiParse);
$("#aiCreateAll") && ($("#aiCreateAll").onclick=aiCreateAll);
$("#aiClose")     && ($("#aiClose").onclick=()=>$("#aiMask").classList.remove("open"));
$("#aiMask")      && ($("#aiMask").onclick=e=>{ if(e.target===$("#aiMask")) $("#aiMask").classList.remove("open"); });

/* ---------- 登录门 ---------- */
function showLogin(){ $("#loginMask").classList.add("open"); $("#loginPw").value=""; $("#loginErr").textContent=""; }
async function boot(){
  const session = await window.SBAUTH.getSession();
  if(!session){ showLogin(); return; }
  $("#loginMask").classList.remove("open");
  state.user = session.user;
  state.canEdit = ((state.user&&state.user.app_metadata&&state.user.app_metadata.role)||"viewer")==="editor";
  renderAuthBar();
  try{ await loadAll(); const h=(location.hash||"").replace("#",""); if(h&&document.getElementById("view-"+h)) switchView(h); }
  catch(e){ $("#overview").innerHTML="<p style='padding:1rem;color:#b91c1c'>加载失败:"+esc(e.message)+"</p>"; }
}
$("#loginBtn").onclick=async()=>{
  const email=$("#loginEmail").value.trim(), pw=$("#loginPw").value;
  if(!email||!pw){ $("#loginErr").textContent="请输入邮箱和密码"; return; }
  $("#loginErr").textContent="登录中…";
  const { error }=await window.SBAUTH.signIn(email,pw);
  if(error){ $("#loginErr").textContent="登录失败:"+(error.message||error); return; }
  $("#loginErr").textContent=""; boot();
};
$("#loginPw").addEventListener("keydown",e=>{ if(e.key==="Enter") $("#loginBtn").click(); });
window.SBAUTH.onChange(s=>{ if(!s) showLogin(); });
boot();
