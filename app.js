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

const FORM_KEYS = ["id","name","gen","char_gen","rank","relation_type","alias","sex","birth",
  "birth_lunar","death","death_lunar","birth_place","burial","alive","mother","father_note",
  "spouse","occupation","residence","contact","address","deeds","source","status","note"];
const DIRECT_LINE = new Set(["S001","S002","S004","S008","S010","S014","S019","S033","S046"]);
const ORIG_IMG = {p1:window.photoUrl("yuanpu/p1.jpg"),p2:window.photoUrl("yuanpu/p2.jpg"),p3:window.photoUrl("yuanpu/p3.jpg"),p4:window.photoUrl("yuanpu/p4.jpg")};
const UNDOABLE = new Set(["create:person","update:person","delete:person","purge:person","delete:marriage","delete:media"]);

const state = { persons:[], meta:{}, narratives:[], verify:[], transcription:[], q:"", share:false,
                editing:null, user:null, canEdit:false,
                filters:{charGen:"",status:"",alive:""} };

// api(method,path,body) 由 db.js 提供(Supabase shim);此处不再定义。
async function reloadPersons(){ state.persons = await api("GET","/api/persons"); }
async function reloadEverything(){ await loadAll(); renderBackup(); renderLog(); }

async function loadAll(){
  [state.meta, state.persons, state.narratives, state.verify, state.transcription] = await Promise.all([
    api("GET","/api/meta"), api("GET","/api/persons"), api("GET","/api/narratives"),
    api("GET","/api/verify"), api("GET","/api/transcription")
  ]);
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
function anyFilter(){ return !!(state.filters.charGen||state.filters.status||state.filters.alive); }
function matchFilter(p){
  const f=state.filters;
  if(f.charGen && p.char_gen!==f.charGen) return false;
  if(f.status && p.status!==f.status) return false;
  if(f.alive && p.alive!==f.alive) return false;
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
  const fcEl=el("span","fcount"); fcEl.id="fcount"; fb.appendChild(fcEl);
  if(state.q||anyFilter()){ const clr=el("button","btn btn-sm","清除"); clr.onclick=()=>{ state.q=""; $("#search").value=""; state.filters={charGen:"",status:"",alive:""}; renderFilters(); renderOverview(); }; fb.appendChild(clr); }
}
function renderOverview(){
  const box=$("#overview"); box.innerHTML="";
  $("#shareNote").style.display=state.share?"block":"none";
  const list=state.persons.filter(p=>matchQ(p)&&matchFilter(p));
  const fc=$("#fcount"); if(fc) fc.textContent=(state.q||anyFilter())?`找到 ${list.length} 人`:`共 ${state.persons.length} 人`;
  const groups={};
  list.forEach(p=>{ (groups[p.gen||"—"]=groups[p.gen||"—"]||[]).push(p); });
  const keys=Object.keys(groups).sort((a,b)=>gk(a)-gk(b));
  if(!keys.length){ box.appendChild(el("p","note","无匹配人物。")); return; }
  keys.forEach(k=>{
    const blk=el("div","gen-block"); const cg=groups[k][0]?.char_gen;
    blk.appendChild(el("div","gen-head",`第 ${esc(k)} 代`+(cg&&cg!=="—"?` <span class="tag">${esc(cg)}字辈</span>`:"")));
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
  const isFather=new Set(state.persons.map(p=>p.father_id).filter(x=>x&&ids.has(x)));
  const nodes=state.persons.filter(p=>(p.father_id&&ids.has(p.father_id))||isFather.has(p.id));
  if(!nodes.length){ box.textContent="(暂无可绘制的父子关系)"; return; }
  let def="graph TD\n";
  nodes.forEach(p=>{
    const yrs=[p.birth,p.death].filter(x=>x&&x!=="无考").map(x=>x.replace(/[()（）]/g,"")).join("-");
    def+=`  ${p.id}["${((p.name||"(无名)")+(yrs?("·"+yrs):"")).replace(/"/g,"").replace(/[\[\]]/g,"")}"]\n`;
  });
  nodes.forEach(p=>{ if(p.father_id&&ids.has(p.father_id)) def+=`  ${p.father_id} --> ${p.id}\n`; });
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
    r.innerHTML=`<div class="vtop"><span class="vtopic">${esc(p.name||p.id)}</span><span class="tag">第${esc(p.gen)}代</span><span class="hint">删除于 ${esc(p.deleted_at||"")}</span></div>`;
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
async function renderMarriages(pid){
  const box=$("#marrList"); box.innerHTML="";
  if(!pid){ $("#marrHint").textContent="保存人物后可添加婚姻。"; $("#addMarr").disabled=true; return; }
  $("#marrHint").textContent=""; $("#addMarr").disabled=false;
  const list=await api("GET","/api/persons/"+encodeURIComponent(pid)+"/marriages");
  if(!list.length){ box.appendChild(el("div","hint","(暂无)")); return; }
  list.forEach(mr=>box.appendChild(marriageRow(mr)));
}
function marriageRow(mr){
  const r=el("div","subrow");
  const f=(ph,k,w)=>{const i=el("input");i.type="text";i.placeholder=ph;i.value=mr[k]||"";i.style.width=w||"";i.dataset.k=k;return i;};
  const sp=f("配偶","spouse"), fam=f("配偶父家/籍","spouse_family"), yr=f("婚配年","marriage_year","110px"),
        rel=f("关系(原配/续娶/侧室)","relation","150px"), note=f("备注","note");
  const save=el("button","btn btn-primary btn-sm","保存"); const del=el("button","btn btn-danger btn-sm","删");
  const msg=el("span","hint");
  save.onclick=async()=>{try{const d={};[sp,fam,yr,rel,note].forEach(i=>d[i.dataset.k]=i.value.trim());await api("PUT","/api/marriages/"+mr.id,d);msg.textContent="✓";}catch(e){msg.textContent=e.message;}};
  del.onclick=async()=>{if(!confirm("删除该婚姻记录?"))return;await api("DELETE","/api/marriages/"+mr.id);renderMarriages(state.editing);};
  const l1=el("div","subrow-line"); l1.appendChild(sp); l1.appendChild(fam); l1.appendChild(rel);
  const l2=el("div","subrow-line"); l2.appendChild(yr); l2.appendChild(note); l2.appendChild(save); l2.appendChild(del); l2.appendChild(msg);
  r.appendChild(l1); r.appendChild(l2); return r;
}

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
  const fmap={}; ps.forEach(p=>{ if(p.father_id) fmap[p.id]=p.father_id; });
  const out={selfFather:[],cycle:[],dangling:[],charBreak:[],yearConflict:[],dupName:[]};
  ps.forEach(p=>{ if(p.father_id){ if(p.father_id===p.id) out.selfFather.push(p); else if(!ids.has(p.father_id)) out.dangling.push(p); } });
  const inCycle=new Set();
  ps.forEach(p=>{ const seen=new Set(); let cur=p.id;
    while(cur && fmap[cur] && ids.has(fmap[cur])){ if(seen.has(cur)){ let x=cur; do{inCycle.add(x);x=fmap[x];}while(x&&x!==cur); break; } seen.add(cur); cur=fmap[cur]; } });
  out.cycle=ps.filter(p=>inCycle.has(p.id));
  ps.forEach(p=>{ const f=p.father_id&&byId(p.father_id);
    if(f&&f.char_gen&&f.char_gen!=="—"&&p.char_gen&&p.char_gen!=="—"){ const i=cg.indexOf(f.char_gen);
      if(i>=0&&i+1<cg.length&&p.char_gen!==cg[i+1]) out.charBreak.push({p,why:`父${f.name}「${f.char_gen}」→子应「${cg[i+1]}」,实为「${p.char_gen}」`}); } });
  const yr=s=>{ const m=(s||"").match(/\d{4}/); return m?+m[0]:null; };
  ps.forEach(p=>{ const b=yr(p.birth),d=yr(p.death);
    if(b&&d&&d<b) out.yearConflict.push({p,why:`卒(${d})早于生(${b})`});
    const f=p.father_id&&byId(p.father_id); if(f){ const fb=yr(f.birth); if(b&&fb&&b<=fb) out.yearConflict.push({p,why:`生(${b}) ≤ 父${f.name}生(${fb})`}); } });
  const bn={}; ps.forEach(p=>{ if(p.name)(bn[p.name]=bn[p.name]||[]).push(p); });
  Object.keys(bn).forEach(n=>{ if(bn[n].length>1) out.dupName.push({name:n,list:bn[n]}); });
  return out;
}
function renderHealth(){
  const box=$("#health"); box.innerHTML=""; const h=runHealth();
  const total=h.selfFather.length+h.cycle.length+h.dangling.length+h.charBreak.length+h.yearConflict.length;
  box.appendChild(el("p","note", total? `共发现 ${total} 处需注意(重名 ${h.dupName.length} 组另列,多为已知待核实的同名)。点条目可直接打开修正。` : "✅ 未发现父子/年代/字辈类结构问题。"));
  const plink=(p,extra)=>{ const d=el("div","hitem"); d.innerHTML=`<a class="plink" data-pid="${esc(p.id)}">${esc(p.name||p.id)}</a> <span class="hint">${esc(extra||"")}</span>`; return d; };
  const sec=(title,arr,render,pill)=>{ const pn=el("div","panel");
    pn.innerHTML=`<h3>${title} <span class="pill ${arr.length?(pill||'pill-warn'):'pill-ok'}">${arr.length}</span></h3>`;
    if(!arr.length) pn.appendChild(el("div","hint","无")); else arr.forEach(x=>pn.appendChild(render(x)));
    box.appendChild(pn); };
  sec("① 自己当自己父亲", h.selfFather, p=>plink(p,"father_id 指向自身"));
  sec("② 父子成环", h.cycle, p=>plink(p,"处于父子循环中"));
  sec("③ 父指向不存在/已删/回收站的人", h.dangling, p=>plink(p,"父ID="+p.father_id));
  sec("④ 字辈不顺(父子相承)", h.charBreak, x=>plink(x.p,x.why));
  sec("⑤ 年代矛盾", h.yearConflict, x=>plink(x.p,x.why));
  sec("⑥ 重名(同名异人?需核实)", h.dupName, x=>{ const d=el("div","hitem"); d.innerHTML=`<b>${esc(x.name)}</b>: `+x.list.map(p=>`<a class="plink chip" data-pid="${esc(p.id)}">${esc(p.id)}·第${esc(p.gen)}代</a>`).join(""); return d; }, "pill-info");
  box.querySelectorAll(".plink").forEach(a=>a.onclick=()=>{ const t=byId(a.dataset.pid); if(t){ state.canEdit?openEdit(t):openDetail(t); } });
}

/* ---------- 人物只读详情(P0-1/2/3) ---------- */
const byId = id => state.persons.find(x => x.id === id);
function childrenOf(id){ return state.persons.filter(p => p.father_id === id).sort((a,b)=>(a.sort_order||0)-(b.sort_order||0)); }
function ancestorChain(p){            // 返回 [父, 祖, …, 始迁祖],带防环
  const chain=[]; const seen=new Set([p.id]); let cur=p;
  while(cur && cur.father_id){ if(seen.has(cur.father_id)) break; const f=byId(cur.father_id); if(!f) break; chain.push(f); seen.add(f.id); cur=f; }
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
    +`<div class="dpills">${(p.char_gen&&p.char_gen!=="—")?`<span class="tag">${esc(p.char_gen)}字辈</span>`:""}<span class="tag">第${esc(p.gen)}代</span>${living?'<span class="tag">在世</span>':""} ${statusPill(p.status)}</div></div></div>`;
  if(share){ box.innerHTML=html+`<p class="note">分享模式:在世亲属仅显示姓名/字辈/世代,其余隐藏。</p>`; $("#detailMask").classList.add("open"); return; }

  const chain=ancestorChain(p);
  if(chain.length){
    const seq=chain.slice().reverse().concat([p]);
    html+=`<div class="dchain"><span class="dk">直系</span> `+seq.map((x,i)=>
      (i?'<span class="arrow">→</span>':'')+(x.id===p.id?`<b>${esc(x.name)}</b>`:`<a class="plink" data-pid="${esc(x.id)}">${esc(x.name)}</a>`)).join("")+`</div>`;
  }

  const rows=[];
  const R=(k,v)=>{ if(v) rows.push(`<div class="drow"><span class="dk">${k}</span><span class="dv">${esc(v)}</span></div>`); };
  R("生", [p.birth, p.birth_lunar&&("农历 "+p.birth_lunar)].filter(Boolean).join(" · "));
  R("卒", [p.death, p.death_lunar&&("农历 "+p.death_lunar)].filter(Boolean).join(" · "));
  R("出生地", p.birth_place); R("葬地", p.burial); R("行第", p.rank); R("亲属关系", p.relation_type);
  R("字号", p.alias); R("性别", p.sex); R("学历/职业", p.occupation); R("居地/迁徙", p.residence);
  let fa="";
  if(p.father_id && byId(p.father_id)) fa=`<a class="plink" data-pid="${esc(p.father_id)}">${esc(byId(p.father_id).name)}</a>`;
  else if(p.father_note) fa=esc(p.father_note);
  if(fa) rows.push(`<div class="drow"><span class="dk">父</span><span class="dv">${fa}</span></div>`);
  R("母", p.mother); R("配偶", p.spouse);
  if(rows.length) html+=`<div class="dgrid">${rows.join("")}</div>`;

  const marr=await api("GET","/api/persons/"+encodeURIComponent(p.id)+"/marriages").catch(()=>[]);
  if(marr.length){
    html+=`<div class="dsec"><div class="dsec-h">婚姻</div>`+marr.map(m=>{
      const ex=[m.relation, m.spouse_family&&("父家:"+m.spouse_family), m.marriage_year&&("婚配:"+m.marriage_year), m.note].filter(Boolean).join(" · ");
      return `<div class="ditem"><b>${esc(m.spouse||"(配偶)")}</b>${ex?" — "+esc(ex):""}</div>`; }).join("")+`</div>`;
  }
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
  box.innerHTML=html;
  box.querySelectorAll(".plink").forEach(a=>a.onclick=()=>{ const t=byId(a.dataset.pid); if(t) openDetail(t); });
  $("#detailMask").classList.add("open");
}

/* ---------- 加子女/加配偶快捷入口(P1-1) ---------- */
function openAddChild(parent){
  if(!parent) return;
  const g=parseInt(parent.gen,10);
  closeDetail();
  openEdit(null, { father_id:parent.id, gen:isNaN(g)?"":String(g+1),
    char_gen:expectedCharGen(parent.id)||"", status:"待考", alive:"是" });
}
function openAddSpouse(parent){    // 打开本人编辑,直达"婚姻"区(点"+添加婚姻"录入),不预创建空记录避免污染
  if(!parent) return;
  closeDetail(); openEdit(parent);
  $("#modalErr").innerHTML='<span style="color:#047857">在下方“婚姻”区点“+ 添加婚姻”录入配偶。</span>';
}

/* ---------- 人物详情/编辑弹窗 ---------- */
function fillFatherSelect(currentId, selected){
  const sel=$("#f_father_id"); sel.innerHTML="";
  const o0=el("option",null,"(无 / 见父系说明)"); o0.value=""; sel.appendChild(o0);
  state.persons.filter(p=>p.id!==currentId).sort((a,b)=>gk(a.gen)-gk(b.gen)).forEach(p=>{
    const o=el("option",null,`${esc(p.name)} — ${esc(p.id)}（第${esc(p.gen)}代）`); o.value=p.id; if(p.id===selected)o.selected=true; sel.appendChild(o);
  });
}
function openEdit(p, prefill){
  state.editing=p?p.id:null;
  const fa=prefill&&prefill.father_id&&byId(prefill.father_id);
  $("#modalTitle").textContent=p?("详情 / 编辑:"+(p.name||p.id)):(fa?("添加子女(父:"+(fa.name||"")+")"):"添加人物(保存后可加照片/婚姻)");
  $("#delBtn").style.display=p?"inline-block":"none";
  $("#modalErr").textContent="";
  const v=p||prefill||{status:"待考"};
  FORM_KEYS.forEach(k=>{ const f=$("#f_"+k); if(f) f.value=v[k]!=null?v[k]:""; });
  fillFatherSelect(p?p.id:null, v.father_id||"");
  renderMarriages(p?p.id:null); renderMedia(p?p.id:null);
  $("#charGenHint").textContent=""; charGenAuto();
  $("#mask").classList.add("open");
}
function closeModal(){ $("#mask").classList.remove("open"); state.editing=null; }
function collectForm(){ const d={}; FORM_KEYS.forEach(k=>{ const f=$("#f_"+k); if(f) d[k]=f.value.trim(); }); d.father_id=$("#f_father_id").value; return d; }
async function saveModal(){
  const d=collectForm();
  try{
    if(state.editing){ await api("PUT","/api/persons/"+encodeURIComponent(state.editing),d); closeModal(); await reloadPersons(); renderHeader(); renderOverview(); }
    else{
      const row=await api("POST","/api/persons",d);
      state.editing=row.id; $("#f_id").value=row.id;
      $("#modalTitle").textContent="详情 / 编辑:"+(row.name||row.id);
      $("#delBtn").style.display="inline-block";
      $("#modalErr").innerHTML='<span style="color:#047857">已创建,可继续上传照片 / 添加婚姻;或点关闭。</span>';
      await reloadPersons(); renderHeader(); renderOverview();
      fillFatherSelect(row.id, d.father_id); renderMarriages(row.id); renderMedia(row.id);
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

/* ---------- 标签切换 ---------- */
function switchView(name){
  document.querySelectorAll(".tab").forEach(t=>t.classList.toggle("active",t.dataset.view===name));
  document.querySelectorAll(".view").forEach(v=>v.classList.remove("active"));
  $("#view-"+name).classList.add("active");
  if(location.hash!=="#"+name) location.hash=name;
  if(name==="tree") renderTree();
  if(name==="trash") renderTrash();
  if(name==="health") renderHealth();
  if(name==="log"){ renderBackup(); renderLog(); }
}
document.querySelectorAll(".tab").forEach(t=>t.onclick=()=>switchView(t.dataset.view));
$("#search").oninput=e=>{ state.q=e.target.value; renderFilters(); renderOverview(); };
$("#shareMode").onchange=e=>{ state.share=e.target.checked; renderOverview(); };
$("#addBtn").onclick=()=>openEdit(null);
$("#saveBtn").onclick=saveModal;
$("#delBtn").onclick=delModal;
$("#cancelBtn").onclick=closeModal;
$("#reTree").onclick=renderTree;
$("#f_father_id").onchange=charGenAuto;
$("#logoutBtn").onclick=async()=>{ try{ await window.SBAUTH.signOut(); }catch(e){} location.reload(); };
$("#mask").onclick=e=>{ if(e.target===$("#mask")) closeModal(); };
$("#dCloseBtn").onclick=closeDetail;
$("#dEditBtn").onclick=()=>{ const p=byId(state.detailing); closeDetail(); if(p) openEdit(p); };
$("#dAddChild").onclick=()=>openAddChild(byId(state.detailing));
$("#dAddSpouse").onclick=()=>openAddSpouse(byId(state.detailing));
$("#detailMask").onclick=e=>{ if(e.target===$("#detailMask")) closeDetail(); };
$("#addMarr").onclick=async()=>{
  if(!state.editing){alert("请先保存人物");return;}
  if(!state.canEdit){ $("#marrHint").textContent="只读账号无权编辑"; return; }
  try{ await api("POST","/api/persons/"+encodeURIComponent(state.editing)+"/marriages",{spouse:"",relation:""}); renderMarriages(state.editing); }
  catch(e){ $("#marrHint").textContent="添加失败:"+e.message; }
};
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
