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
// 照片点击放大预览(懒建覆盖层,点任意处或 Esc 关闭)
function openLightbox(src){ if(!src) return; let m=document.getElementById("lightbox");
  if(!m){ m=el("div","lightbox"); m.id="lightbox"; m.onclick=()=>m.classList.remove("open"); document.body.appendChild(m); }
  m.innerHTML=`<img src="${esc(src)}" alt="">`; m.classList.add("open"); }
// 软件版本(每次部署递增;显示在页头与登录页,便于确认浏览器已加载最新版)
const APP_NAME = "谱系";                 // 产品名(品牌,固定);某本谱的名字是 meta.title(数据)
const APP_VERSION = "v0.12.2";
const APP_DATE = "2026-06-28";
[["#appVer",APP_VERSION],["#appVerLogin","版本 "+APP_VERSION+" · "+APP_DATE]].forEach(([s,t])=>{ const e=document.querySelector(s); if(e) e.textContent=t; });

// L1 节点=纯个人属性。世代(派生)/本族外部/行第/亲属关系/母/父系说明/配偶 已退出表单(关系→边层,世代→推算)。
const FORM_KEYS = ["id","name","char_gen","alias","sex","birth",
  "birth_lunar","birth_time","death","death_lunar","birth_place","burial","alive",
  "occupation","residence","contact","address","deeds","source","status","note"];
const DIRECT_LINE = new Set(["S001","S002","S004","S008","S010","S014","S019","S033","S046"]);
const ORIG_IMG = {p1:window.photoUrl("yuanpu/p1.jpg"),p2:window.photoUrl("yuanpu/p2.jpg"),p3:window.photoUrl("yuanpu/p3.jpg"),p4:window.photoUrl("yuanpu/p4.jpg")};
const UNDOABLE = new Set(["create:person","update:person","delete:person","purge:person","delete:marriage","delete:media"]);

const state = { persons:[], meta:{}, narratives:[], verify:[], transcription:[], relTypes:[], relCount:{}, q:"", share:false,
                editing:null, user:null, canEdit:false, lineage:"",
                graphCenter:"", graphHops:2, pathA:"", pathB:"",
                fatherOf:{}, motherOf:{}, childrenMap:{}, spouseOf:{}, _genCache:{}, _lineageCache:{}, lineages:null,
                filters:{charGen:"",status:"",alive:""} };

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
// 本人血缘家族:有父边→父系顶祖姓;否则取本人姓(不借配偶,与 lineageOf 的"嫁入随夫"区分开)
function surnameOfSelf(id){
  const p=byId(id); if(!p) return null;
  const root=byId(rootOfPatriline(id)); const nm=((root&&root.name)||p.name||"").trim();
  return nm?nm[0]+"氏":null;
}
// 一人多家族(血缘 + 婚姻):自己血缘家族 ∪ 各配偶血缘家族。媳妇=娘家+夫家;两边都能筛到。
function familiesOf(id){
  const set=new Set(); const self=surnameOfSelf(id); if(self) set.add(self);
  (state.spouseOf[id]||[]).forEach(sp=>{ const s=surnameOfSelf(sp); if(s) set.add(s); });
  return set.size?[...set]:[lineageOf(id)];
}
function famCfg(fam){ return ((state.meta&&state.meta.families)||{})[fam]||{}; }
// 取某人所属(父系主家族)的字辈谱;无家族配置时回退旧全局 meta.charGen(平滑迁移)
function charGenFor(id){ const c=famCfg(lineageOf(id)).charGen; return (c&&c.length)?c:((state.meta&&state.meta.charGen)||[]); }
function lineagesList(){
  if(state.lineages) return state.lineages;
  const m={}; state.persons.filter(p=>!p.deleted).forEach(p=>{ familiesOf(p.id).forEach(l=>{ m[l]=(m[l]||0)+1; }); });
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
  // 品牌名固定=谱系;副标题=当前这本谱(meta.title)+ 地望,不让数据顶掉品牌名
  $("#subtitle").textContent=(m.title?("· "+m.title):"")+(m.lineage?("  "+m.lineage):"");
  const total=state.persons.length, alive=state.persons.filter(p=>p.alive==="是").length;
  const todo=state.verify.filter(v=>!/已?确认/.test(v.status||"")).length;
  $("#stats").textContent=`共 ${total} 人 · 在世 ${alive} · 待核实 ${todo} 项`;
  $("#title").firstChild.textContent=APP_NAME+" ";
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
  const lins=lineagesList();
  if(lins.length>1){ const ls=el("select"); const o0=el("option",null,"全部族谱"); o0.value=""; ls.appendChild(o0);
    lins.forEach(l=>{ const o=el("option",null,l.name+"("+l.count+")"); o.value=l.name; if(state.lineage===l.name)o.selected=true; ls.appendChild(o); });
    ls.onchange=()=>{ state.lineage=ls.value; renderFilters(); renderOverview(); if(document.getElementById("view-tree").classList.contains("active"))renderTree(); }; fb.appendChild(ls); }
  const fcEl=el("span","fcount"); fcEl.id="fcount"; fb.appendChild(fcEl);
  if(state.q||anyFilter()||state.lineage){ const clr=el("button","btn btn-sm","清除"); clr.onclick=()=>{ state.q=""; $("#search").value=""; state.lineage=""; state.filters={charGen:"",status:"",alive:""}; renderFilters(); renderOverview(); }; fb.appendChild(clr); }
}
function renderOverview(){
  const box=$("#overview"); box.innerHTML="";
  $("#shareNote").style.display=state.share?"block":"none";
  const list=state.persons.filter(p=>matchQ(p)&&matchFilter(p)&&(!state.lineage||familiesOf(p.id).includes(state.lineage)));
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
    +`<div class="nm">${esc(p.name||"(无名)")} ${living?'<span class="tag">在世</span>':""} ${statusPill(p.status)}${state.relCount[p.id]?`<span class="relcount" title="关系数,点开看关系网">关系 ${state.relCount[p.id]}</span>`:""}</div>`
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
  // 字辈谱已移到「家族管理」(各家族各自的派语);此处只放家史长文。
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

/* ---------- 家族管理(L3 配置:各家族字辈谱/显示名/堂号 + 谱头;成员由图谱动态推导)---------- */
function parseCharGen(s){ return (s||"").split(/[\s、,，·.。\/]+/).filter(Boolean); }
function renderFamilies(){
  const box=$("#families"); if(!box) return; box.innerHTML="";
  const meta=state.meta||(state.meta={}); meta.families=meta.families||{};
  const ro=!state.canEdit;
  const mkField=(parent,lab,val,ph)=>{ const w=el("div","ffield"); w.innerHTML=`<label>${esc(lab)}</label>`; const inp=el("input"); inp.type="text"; inp.value=val||""; if(ph)inp.placeholder=ph; if(ro)inp.disabled=true; w.appendChild(inp); parent.appendChild(w); return inp; };
  // 谱头
  const head=el("div","panel"); head.innerHTML=`<h3>谱头信息</h3>`;
  const hf={}; [["title","族谱名称"],["lineage","支系/地望"],["investigator","调查/编纂"],["compiler","整理者"]].forEach(([k,lab])=>{ hf[k]=mkField(head,lab,meta[k]); });
  if(!ro){ const foot=el("div","modal-foot"); const msg=el("span","hint"); const btn=el("button","btn btn-primary btn-sm","保存谱头");
    btn.onclick=async()=>{ Object.keys(hf).forEach(k=>meta[k]=hf[k].value.trim()); try{ await api("PUT","/api/meta",meta); msg.textContent="已保存 ✓"; renderHeader(); }catch(e){ msg.textContent="失败:"+e.message; } };
    foot.appendChild(el("span","spacer")); foot.appendChild(msg); foot.appendChild(btn); head.appendChild(foot); }
  box.appendChild(head);
  box.appendChild(el("p","note","家族由关系图谱<b>自动识别</b>(按父系姓氏),成员动态推导、无需手工指派。此处维护各家族的 字辈谱(派语)/显示名/堂号;字辈按父子相承顺取(父「景」则子「德」)。"));
  // 各家族
  lineagesList().forEach((l,idx)=>{
    const fam=l.name, cfg=meta.families[fam]||{};
    const defCG=(cfg.charGen&&cfg.charGen.length)?cfg.charGen:(idx===0?((meta.charGen)||[]):[]);
    const card=el("div","panel");
    card.innerHTML=`<h3>${esc(cfg.label||fam)} <span class="pill pill-info">${l.count} 人</span></h3>`;
    if(defCG.length) card.appendChild(el("div","cg-grid", defCG.map((c,i)=>`<span class="cg-cell"><b>${i+1}</b>　${esc(c)}</span>`).join("")));
    const labIn=mkField(card,"显示名",cfg.label||fam);
    const cgWrap=el("div","ffield"); cgWrap.innerHTML=`<label>字辈谱(派语顺序)</label>`; const cgTa=el("textarea"); cgTa.rows=2; cgTa.value=defCG.join(" "); cgTa.placeholder="派语顺序,空格分隔,如:胤 兆 鸿 耀 景 德 宝 维 树 中"; if(ro)cgTa.disabled=true; cgWrap.appendChild(cgTa); card.appendChild(cgWrap);
    const hallIn=mkField(card,"堂号",cfg.hall,"如 敦睦堂"); const noteIn=mkField(card,"备注/凡例",cfg.note);
    if(!ro){ const foot=el("div","modal-foot"); const msg=el("span","hint"); const btn=el("button","btn btn-primary btn-sm","保存");
      btn.onclick=async()=>{ meta.families[fam]={ label:labIn.value.trim()||fam, charGen:parseCharGen(cgTa.value), hall:hallIn.value.trim(), note:noteIn.value.trim() };
        try{ await api("PUT","/api/meta",meta); msg.textContent="已保存 ✓"; state._lineageCache={}; state.lineages=null; renderFamilies(); renderHeader(); renderOverview(); renderFilters(); }catch(e){ msg.textContent="失败:"+e.message; } };
      foot.appendChild(el("span","spacer")); foot.appendChild(msg); foot.appendChild(btn); card.appendChild(foot); }
    box.appendChild(card);
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

function expectedCharGen(fatherId){   // 按父子相承:父所属家族的派语里,父字辈的下一字(字辈仍父系顺承)
  const f=fatherId&&byId(fatherId); if(!f) return null; const cg=charGenFor(fatherId);
  if(f.char_gen&&f.char_gen!=="—"){ const i=cg.indexOf(f.char_gen); if(i>=0&&i+1<cg.length) return cg[i+1]; }
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
  it.innerHTML=`<img src="${esc(window.photoUrl(md.path))}" alt="" style="cursor:zoom-in"/>`;
  it.querySelector("img").onclick=()=>openLightbox(window.photoUrl(md.path));
  const ctl=el("div","gctl"); ctl.appendChild(cap); const row=el("div","subrow-line"); row.appendChild(star); row.appendChild(del); ctl.appendChild(row);
  it.appendChild(ctl); return it;
}

/* ---------- 数据体检(P0-4/5) ---------- */
function runHealth(){
  const ps=state.persons, ids=new Set(ps.map(p=>p.id));
  const F=state.fatherOf;
  const out={cycle:[],dangling:[],charBreak:[],yearConflict:[],genMismatch:[],noFather:[],dupName:[]};
  ps.forEach(p=>{ const f=F[p.id]; if(f && !ids.has(f)) out.dangling.push(p); });   // 悬空父(FK通常已挡)
  const inCycle=new Set();
  ps.forEach(p=>{ const seen=new Set(); let cur=p.id;
    while(cur && F[cur] && ids.has(F[cur])){ if(seen.has(cur)){ let x=cur; do{inCycle.add(x);x=F[x];}while(x&&x!==cur); break; } seen.add(cur); cur=F[cur]; } });
  out.cycle=ps.filter(p=>inCycle.has(p.id));
  ps.forEach(p=>{ const f=F[p.id]&&byId(F[p.id]);
    if(f&&f.char_gen&&f.char_gen!=="—"&&p.char_gen&&p.char_gen!=="—"){ const cg=charGenFor(f.id); const i=cg.indexOf(f.char_gen);
      if(i>=0&&i+1<cg.length&&p.char_gen!==cg[i+1]) out.charBreak.push({p,why:`父${f.name}「${f.char_gen}」→子应「${cg[i+1]}」,实为「${p.char_gen}」`}); } });
  const yr=s=>{ const m=(s||"").match(/\d{4}/); return m?+m[0]:null; };
  ps.forEach(p=>{ const b=yr(p.birth),d=yr(p.death);
    if(b&&d&&d<b) out.yearConflict.push({p,why:`卒(${d})早于生(${b})`});
    const f=F[p.id]&&byId(F[p.id]); if(f){ const fb=yr(f.birth); if(b&&fb&&b<=fb) out.yearConflict.push({p,why:`生(${b}) ≤ 父${f.name}生(${fb})`}); } });
  // 手填世代 ≠ 父+1(有父边且父能定位)
  ps.forEach(p=>{ const m=parseInt(p.gen,10), f=F[p.id]; if(!isNaN(m)&&f){ const fg=genOf(f); if(fg!=null&&m!==fg+1) out.genMismatch.push({p,why:`手填第${m}代,但父${(byId(f)||{}).name||f}第${fg}代(应第${fg+1}代)`}); } });
  // 无父边但推算第>1代(疑缺父系连接,应补父亲让世代连续;父系待考线索见 father_note)
  ps.forEach(p=>{ if(!F[p.id]){ const g=genOf(p.id); if(g!=null&&g>1) out.noFather.push({p,why:`第${g}代但未连父亲`+(p.father_note?`(线索:${p.father_note})`:"")}); } });
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
  sec("⑤ 残留手填世代与推算不符", h.genMismatch, x=>{ const d=el("div","hitem");
    d.innerHTML=`<a class="plink" data-pid="${esc(x.p.id)}">${esc(x.p.name||x.p.id)}</a> <span class="hint">${esc(x.why)}</span>`
      +(state.canEdit?` <button class="btn btn-sm useGenBtn" data-pid="${esc(x.p.id)}">采用推算(清手填)</button>`:""); return d; }, "pill-info");
  sec("⑥ 疑缺父系连接(世代断点)", h.noFather, x=>plink(x.p,x.why), "pill-info");
  sec("⑦ 重名(同名异人?需核实)", h.dupName, x=>{ const d=el("div","hitem"); d.innerHTML=`<b>${esc(x.name)}</b>: `+x.list.map(p=>`<a class="plink chip" data-pid="${esc(p.id)}">${esc(p.id)}·第${genStr(p.id)}代</a>`).join("")+(state.canEdit?` <button class="btn btn-sm mergebtn" data-name="${esc(x.name)}">合并…</button>`:""); return d; }, "pill-info");
  // ⑧ 配偶待整理(迁移任务,非错误):旧 spouse 自由文本 → 真实配偶人物 + 夫妻边
  const pend=state.persons.filter(p=>!p.deleted && (p.spouse||"").trim());
  sec("⑧ 配偶待整理(原始记载→关系)", pend, p=>{ const d=el("div","hitem");
    d.innerHTML=`<a class="plink" data-pid="${esc(p.id)}">${esc(p.name||p.id)}</a> <span class="hint">原文:${esc(p.spouse)}</span>`
      +(state.canEdit?` <button class="btn btn-sm spConvBtn" data-pid="${esc(p.id)}">整理为配偶</button>`:""); return d; }, "pill-info");
  box.querySelectorAll(".plink").forEach(a=>a.onclick=()=>{ const t=byId(a.dataset.pid); if(t) openDetail(t); });   // 先看详情(含关系列表),编辑走详情里「编辑」
  box.querySelectorAll(".spConvBtn").forEach(b=>b.onclick=(e)=>{ e.stopPropagation(); openSpouseConverter(b.dataset.pid); });
  box.querySelectorAll(".mergebtn").forEach(b=>b.onclick=()=>{ const g=h.dupName.find(x=>x.name===b.dataset.name); if(g) openMergeDialog(g.list); });
  box.querySelectorAll(".useGenBtn").forEach(b=>b.onclick=async(e)=>{ e.stopPropagation(); const pid=b.dataset.pid;
    if(!confirm("清除该人手填世代,改由父系图自动推算?")) return;
    try{ await api("PUT","/api/persons/"+encodeURIComponent(pid),{gen:""}); await reloadPersons(); await refreshRelCount(); renderHeader(); renderOverview(); renderHealth(); }
    catch(err){ alert("失败:"+err.message); } });
}
// 合并对话框:选保留谁,其余并入(子女/关系/婚姻/照片/空字段都迁过去,被并入者进回收站)
function openMergeDialog(list){
  let mask=$("#mergeMask");
  if(!mask){ mask=el("div","mask"); mask.id="mergeMask"; document.body.appendChild(mask); }
  const rows=list.map((p,i)=>{ const kids=(state.childrenMap[p.id]||[]).length;
    return `<label class="mergerow"><input type="radio" name="mergeSurv" value="${esc(p.id)}"${i===0?" checked":""}> 保留 <b>${esc(p.name||"(无名)")}</b> <span class="hint">${esc(p.id)} · 第${genStr(p.id)}代 · 现有 ${kids} 子女</span></label>`; }).join("");
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
  R("出生地", p.birth_place); R("葬地", p.burial);
  R("字号", p.alias); R("性别", p.sex); R("学历/职业", p.occupation); R("居地/迁徙", p.residence);
  if(rows.length) html+=`<div class="dgrid">${rows.join("")}</div>`;
  // 关系(父/母/配偶/子女/社交…)统一收到下方「关系网」列表;上方只留个人信息 + 直系链
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
  // 关系网(详情页下方 = 关系管理中心:父/母/配偶/子女/社交 全在此整齐列表里增删改)
  const rtMap={}; (state.relTypes&&state.relTypes.length?state.relTypes:(await window.REL.types().catch(()=>[]))).forEach(t=>rtMap[t.type]=t);
  const rels=await window.REL.of(p.id).catch(()=>[]);
  const catRank=c=>{ const i=["亲属","社交","工作"].indexOf(c); return i<0?9:i; };
  const relPrio=(type,fromMe)=>((type==="father"||type==="mother")&&!fromMe)?1:(type==="spouse"?2:(((type==="father"||type==="mother")&&fromMe)?3:(type==="sibling"?4:5)));
  let rh="";
  if(rels.length){
    const byCat={};
    rels.forEach(r=>{
      const t=rtMap[r.type]||{label_zh:r.type,category:"其他"};
      const fromMe=r.from_id===p.id, other=fromMe?r.to_id:r.from_id, op=byId(other); if(!op) return;
      const lab=r.directed?(fromMe?(t.forward_label||t.label_zh):(t.inverse_label||t.label_zh)):t.label_zh;
      (byCat[t.category||"其他"]=byCat[t.category||"其他"]||[]).push({r,op,lab,color:t.color,prio:relPrio(r.type,fromMe)});
    });
    Object.keys(byCat).sort((a,b)=>catRank(a)-catRank(b)).forEach(cat=>{
      byCat[cat].sort((a,b)=>a.prio-b.prio || (gk(genOf(a.op.id))-gk(genOf(b.op.id))) || (a.op.sort_order||0)-(b.op.sort_order||0));
      rh+=`<div class="rel-cat">${esc(cat)}</div>`;
      byCat[cat].forEach(it=>{ rh+=`<div class="rel-row"><span class="reltag" style="border-color:${esc(it.color||'#cbd5e1')};color:${esc(it.color||'#475569')}">${esc(it.lab)}</span><a class="plink rel-who" data-pid="${esc(it.op.id)}">${esc(it.op.name||'(无名)')}</a><span class="rel-note">${it.r.note?esc(it.r.note):""}</span>${state.canEdit?`<span class="rel-act"><button class="btn btn-sm relnote" data-rid="${it.r.id}" title="改备注">改</button><button class="btn btn-sm reldel" data-rid="${it.r.id}" title="删除">✕</button></span>`:""}</div>`; });
    });
  } else rh=`<div class="hint">(暂无关系,点「+ 加关系」)</div>`;
  // 原始记载/待考 折叠进关系区(尚未转成边的旧文本)
  let pending="";
  if(!state.fatherOf[p.id] && p.father_note) pending+=`<div class="rel-pending">父系待考:${esc(p.father_note)} <span class="hint">线索,待补父子关系</span></div>`;
  if(p.mother) pending+=`<div class="rel-pending">母(原始记载):${esc(p.mother)} <span class="hint">待整理为母子关系</span></div>`;
  if(p.spouse) pending+=`<div class="rel-pending">配偶(原始记载):${esc(p.spouse)} ${state.canEdit?`<button class="btn btn-sm" id="spConvDetail">整理为配偶</button>`:`<span class="hint">待整理</span>`}</div>`;
  const addForm = state.canEdit ? `<div class="relquick" id="relAddForm" style="display:none"><select id="dq_to"></select><span id="dqNewWrap" style="display:none">姓名 <input id="dq_newname" placeholder="新人物姓名" style="width:7em"> <select id="dq_newsex"><option value="">性别</option><option>男</option><option>女</option></select></span> 是 <b>${esc(p.name||"本人")}</b> 的 <select id="dq_type"></select> <input id="dq_note" placeholder="备注(可空,如 原配/续娶)" style="width:9em"> <button class="btn btn-sm btn-primary" id="dq_add">加</button> <span class="hint" id="dq_msg"></span></div>` : "";
  html+=`<div class="dsec"><div class="dsec-h">关系网(${rels.length}) <button class="btn btn-sm" id="relEgoBtn">🎯 关系圈</button>${state.canEdit?` <button class="btn btn-sm" id="relAddToggle">+ 加关系</button>`:""}</div>${pending}${addForm}<div class="rel-list">${rh}</div></div>`;
  box.innerHTML=html;
  box.querySelectorAll(".plink").forEach(a=>a.onclick=()=>{ const t=byId(a.dataset.pid); if(t) openDetail(t); });
  box.querySelectorAll(".dalbum img, img.dphoto").forEach(im=>{ im.style.cursor="zoom-in"; im.onclick=e=>{ e.stopPropagation(); openLightbox(im.src); }; });
  { const eb=$("#relEgoBtn"); if(eb) eb.onclick=()=>{ state.graphCenter=p.id; state.pathA=""; state.pathB=""; closeDetail(); switchView("graph"); }; }
  { const sb=$("#spConvDetail"); if(sb) sb.onclick=()=>{ closeDetail(); openSpouseConverter(p.id); }; }
  box.querySelectorAll(".reldel").forEach(b=>b.onclick=async()=>{ if(!confirm("删除这条关系?(直接删除,不可恢复;人物本身不受影响)"))return; try{ await window.REL.del(+b.dataset.rid); await reloadPersons(); await refreshRelCount(); openDetail(byId(p.id)); }catch(e){ alert("删除失败:"+e.message); } });
  box.querySelectorAll(".relnote").forEach(b=>b.onclick=async()=>{ const cur=(rels.find(r=>String(r.id)===b.dataset.rid)||{}).note||""; const nv=prompt("关系备注(如 原配/续娶/侧室):",cur); if(nv===null)return; try{ await window.REL.update(+b.dataset.rid,{note:nv.trim()}); openDetail(byId(p.id)); }catch(e){ alert("失败:"+e.message); } });
  const tgl=$("#relAddToggle");
  if(tgl) tgl.onclick=()=>{ const f=$("#relAddForm"); const show=f.style.display==="none"; f.style.display=show?"":"none";
    if(show){ $("#dq_to").innerHTML=`<option value="">— 选已有人物 —</option><option value="__new__">➕ 新建人物并连上…</option>`+personOptions(); $("#dq_type").innerHTML=relOptionsHtml(); const dn=$("#dqNewWrap"); if(dn)dn.style.display="none"; const t=$("#dq_to"); if(t)t.focus(); } };
  { const dto=$("#dq_to"); if(dto) dto.onchange=()=>{ const nw=$("#dqNewWrap"); if(nw) nw.style.display=(dto.value==="__new__")?"":"none"; }; }
  const dqAdd=$("#dq_add");
  if(dqAdd) dqAdd.onclick=async()=>{
    const sel=$("#dq_to").value, rt=$("#dq_type").value, note=$("#dq_note").value.trim(), msg=$("#dq_msg");
    if(!sel||!rt){ msg.textContent="请选人物和关系"; return; }
    const {type, fromIsX, need}=resolveRel(rt, p.sex);    // 先判定(尤其"孩子"需当前人性别),避免 __new__ 建了人却连不上
    if(!type){ msg.textContent="「孩子」需先知道"+(p.name||"本人")+"的性别——请在「编辑」里填好性别再加"; return; }
    try{
      let other=sel;
      if(sel==="__new__"){ const nm=($("#dq_newname").value||"").trim(); if(!nm){ msg.textContent="请填新人物姓名"; return; }
        const np=await api("POST","/api/persons",{name:nm, sex:$("#dq_newsex").value, status:"待考"}); other=np.id; }
      if(other===p.id){ msg.textContent="不能和自己建立关系"; return; }
      const from=fromIsX?other:p.id, to=fromIsX?p.id:other;
      await window.REL.add({from_id:from,to_id:to,type,note});
      const oname=((byId(other)||{}).name)||($("#dq_newname")&&$("#dq_newname").value.trim())||other;
      await reloadPersons(); await refreshRelCount(); await openDetail(byId(p.id));
      const t=$("#relAddToggle"); if(t) t.click();                                  // 重新展开,连续录入
      const m=$("#dq_msg"); if(m) m.textContent="已加:"+oname+" ✓ 可继续添加下一条";
    }catch(e){ const m=$("#dq_msg"); if(m) m.textContent=(/duplicate|unique/i.test(e.message)?"该关系已存在":("失败:"+e.message)); }
  };
  $("#detailMask").classList.add("open");
}

/* ---------- 加亲属(统一:新建人物 + 一条初始关系)---------- */
function openAddRelative(person){
  if(!person) return; closeDetail();
  openEdit(null, { status:"待考", alive:"是", _relTo:person.id });
}
// 关系下拉,句式「[X] 是 [当前人] 的 [label]」:有向给两向(X为长辈→父/母/老师/上级;X为晚辈→孩子/学生/下属),对称一项;按 category 分组
const _relNice = l => ({"子女":"孩子","父":"父亲","母":"母亲"}[l]||l);
function relOptions(){
  const opts=[];
  (state.relTypes||[]).forEach(t=>{ const cat=t.category||"其他";
    if(t.is_symmetric) opts.push({val:t.type+"|s", label:_relNice(t.forward_label||t.label_zh), cat});   // 配偶/兄弟姐妹/朋友/同事/合作
    else opts.push({val:t.type+"|f", label:_relNice(t.inverse_label||t.label_zh), cat});                 // X 是当前人的 父亲/母亲/老师/上级
  });
  (state.relTypes||[]).forEach(t=>{ const cat=t.category||"其他";                                        // 反向:X 是当前人的 孩子/学生/下属
    if(t.is_symmetric || t.type==="mother") return;                                                      // 父母的"孩子"合并成一项(边类型随当前人性别)
    if(t.type==="father") opts.push({val:"child|auto", label:"孩子", cat});
    else opts.push({val:t.type+"|i", label:_relNice(t.forward_label||t.label_zh), cat});
  });
  return opts;
}
function relOptionsHtml(selected){
  const order=["亲属","社交","工作","其他"], by={};
  relOptions().forEach(o=>(by[o.cat]=by[o.cat]||[]).push(o));
  let h=`<option value="">— 选关系 —</option>`;
  order.concat(Object.keys(by).filter(c=>!order.includes(c))).forEach(c=>{ if(!by[c])return;
    h+=`<optgroup label="${esc(c)}">`+by[c].map(o=>`<option value="${esc(o.val)}"${o.val===selected?" selected":""}>${esc(o.label)}</option>`).join("")+`</optgroup>`; });
  return h;
}
// 把下拉值解析成建边参数;current=当前人(详情)/此人(新建)。fromIsX=true 时边 from=X、to=当前人
function resolveRel(rt, curSex){
  let [type,side]=rt.split("|");
  if(type==="child"){                       // "X 是当前人的孩子":边类型(父子/母子)取决于当前人性别
    if(curSex!=="男"&&curSex!=="女") return { type:null, need:"sex" };  // 性别空时不静默默认 father
    type=(curSex==="女"?"mother":"father"); side="i";
  }
  return { type, fromIsX: side==="f" };
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
  const list=state.persons.filter(p=>p.id!==currentId&&!p.deleted).sort((a,b)=>gk(genOf(a.id))-gk(genOf(b.id)));
  const byGen={}; list.forEach(p=>{ const g=genOf(p.id); const k=(g==null?"未定世代":("第"+g+"代")); (byGen[k]=byGen[k]||[]).push(p); });
  const gnum=k=>k==="未定世代"?9999:(parseInt(k.replace(/\D/g,""))||9999);
  let h=`<option value="">(无 / 暂不连父亲)</option>`;
  Object.keys(byGen).sort((a,b)=>gnum(a)-gnum(b)).forEach(k=>{
    h+=`<optgroup label="${esc(k)}">`+byGen[k].map(p=>`<option value="${esc(p.id)}"${p.id===selected?" selected":""}>${esc(p.name||"(无名)")} — ${esc(p.id)}</option>`).join("")+`</optgroup>`;
  });
  $("#f_father_id").innerHTML=h;
}
function openEdit(p, prefill){
  state.editing=p?p.id:null;
  $("#modalTitle").textContent=p?("编辑:"+(p.name||p.id)):"添加人物";
  $("#delBtn").style.display=p?"inline-block":"none";
  $("#modalErr").textContent="";
  const v=p||prefill||{status:"待考"};
  FORM_KEYS.forEach(k=>{ const f=$("#f_"+k); if(f) f.value=v[k]!=null?v[k]:""; });
  $("#idField").style.display=p?"":"none";          // 新建时隐藏自动ID那格,保存后再显示
  fillFatherSelect(p?p.id:null, p?(state.fatherOf[p.id]||""):"");
  renderMedia(p?p.id:null);
  if(p){ $("#initRelWrap").style.display="none"; }   // 编辑已有人物:关系在详情页「关系网」管理
  else {
    $("#f_rel_person").innerHTML=`<option value="">— 选已有人物 —</option>`+personOptions();
    $("#f_rel_type").innerHTML=relOptionsHtml(prefill&&prefill._relType);
    $("#f_rel_person").value=(prefill&&prefill._relTo)||"";
    $("#initRelObj").textContent="此人";
    $("#initRelWrap").style.display="";
  }
  $("#charGenHint").textContent=""; charGenAuto(); initRelAuto();
  $("#mask").classList.add("open");
  if(!p) setTimeout(()=>{ const n=$("#f_name"); if(n) n.focus(); }, 60);
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
  if(!d.name){ $("#modalErr").textContent="请先填姓名(姓名必填)"; const n=$("#f_name"); if(n) n.focus(); return; }
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
      $("#modalTitle").textContent="编辑:"+(row.name||row.id);
      $("#delBtn").style.display="inline-block";
      await reconcileFatherEdge(row.id, fsel);
      let extra="";
      const rp=$("#f_rel_person").value, rt=$("#f_rel_type").value;
      if($("#initRelWrap").style.display!=="none" && rp && rt){
        const {type, fromIsX, need}=resolveRel(rt, d.sex||$("#f_sex").value);
        if(!type){ extra=" (「孩子」关系需先填本人性别,未建立——可到详情页补)"; }
        else { const from=fromIsX?rp:row.id, to=fromIsX?row.id:rp;
          try{ await window.REL.add({from_id:from,to_id:to,type}); const tn=(state.relTypes.find(t=>t.type===type)||{}).label_zh||type; extra=" 已与「"+(((byId(rp)||{}).name)||rp)+"」建立「"+tn+"」关系。"; }
          catch(e){ extra=" (关系建立失败:"+(/duplicate|unique/i.test(e.message)?"该关系已存在":e.message)+")"; } }
      }
      $("#initRelWrap").style.display="none"; $("#idField").style.display="";
      await reloadPersons(); await refreshRelCount(); renderHeader(); renderOverview();
      fillFatherSelect(row.id, state.fatherOf[row.id]||""); renderMedia(row.id);
      $("#modalErr").innerHTML=`<div class="callout ok"><span>✅ 已创建「${esc(row.name||row.id)}」。${esc(extra)}</span><span class="spacer"></span><button type="button" class="btn btn-sm" id="acPhoto">+ 上传照片</button><button type="button" class="btn btn-sm" id="acRel">+ 再加一位亲属</button><button type="button" class="btn btn-sm btn-primary" id="acDone">完成</button></div>`;
      const ph=$("#acPhoto"); if(ph) ph.onclick=()=>$("#mediaFile").click();
      const ar=$("#acRel"); if(ar) ar.onclick=()=>openAddRelative(byId(row.id));
      const ad=$("#acDone"); if(ad) ad.onclick=closeModal;
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
  {k:"name",label:"姓名"},{k:"gen",label:"世代"},{k:"char_gen",label:"字辈"},
  {k:"sex",label:"性别"},{k:"alive",label:"在世"},{k:"rel_count",label:"关系数"},{k:"lineage",label:"族谱"},
  {k:"birth",label:"生年"},{k:"birth_lunar",label:"农历生"},{k:"birth_time",label:"出生时间"},{k:"death",label:"卒年"},
  {k:"birth_place",label:"出生地"},{k:"occupation",label:"学历/职业"},{k:"residence",label:"居地"},{k:"burial",label:"葬地"},
  {k:"spouse",label:"配偶(原始记载)"},{k:"contact",label:"联系方式"},{k:"address",label:"住址"},
  {k:"status",label:"状态"},{k:"note",label:"备注"},{k:"id",label:"ID"}
];
const ROSTER_DEFAULT = ["name","gen","char_gen","sex","alive","lineage","birth","death","occupation"];
function rosterCols(){ try{ const s=JSON.parse(localStorage.getItem("roster_cols")||"null"); if(Array.isArray(s)&&s.length) return s; }catch(e){} return ROSTER_DEFAULT.slice(); }
let _rosterSort={k:"gen",dir:1}, _colpickOpen=false;
function renderRoster(){
  const box=$("#rosterBox"); if(!box) return;
  const colset=new Set(rosterCols());
  const orderedCols=ROSTER_COLS.filter(c=>colset.has(c.k));
  let list=state.persons.filter(p=>!p.deleted && matchQ(p));
  const lin=$("#rosterLineage") ? $("#rosterLineage").value : "";
  if(lin) list=list.filter(p=>familiesOf(p.id).includes(lin));
  const sk=_rosterSort.k, dir=_rosterSort.dir;
  list=list.slice().sort((a,b)=>{ let va,vb; if(sk==="gen"){va=gk(genOf(a.id));vb=gk(genOf(b.id));} else if(sk==="rel_count"){va=state.relCount[a.id]||0;vb=state.relCount[b.id]||0;} else if(sk==="lineage"){va=familiesOf(a.id).join("/");vb=familiesOf(b.id).join("/");} else {va=(a[sk]??"")+"";vb=(b[sk]??"")+"";}
    return va<vb?-dir:va>vb?dir:0; });
  const picker=`<details class="colpick"${_colpickOpen?" open":""}><summary>列设置(${colset.size} 列)</summary><div class="colgrid">`
    + ROSTER_COLS.map(c=>`<label><input type="checkbox" data-col="${c.k}"${colset.has(c.k)?" checked":""}> ${esc(c.label)}</label>`).join("") + `</div></details>`;
  const bar=`<div class="rosterbar">${picker}`
    + `<select id="rosterLineage"><option value="">全部族谱</option>`+lineagesList().map(l=>`<option value="${esc(l.name)}"${lin===l.name?" selected":""}>${esc(l.name)}(${l.count})</option>`).join("")+`</select>`
    + `<span class="hint">${list.length} 人 · 点一行${state.canEdit?"编辑":"看详情"}</span></div>`;
  const thead="<tr>"+orderedCols.map(c=>`<th data-sk="${c.k}">${esc(c.label)}${sk===c.k?(dir>0?" ▲":" ▼"):""}</th>`).join("")+"</tr>";
  const fmt=(p,k)=> k==="rel_count"?(state.relCount[p.id]||0):(k==="gen"?(genOf(p.id)??""):(k==="lineage"?familiesOf(p.id).join(" / "):(p[k]==null?"":p[k])));
  const rows=list.map(p=>`<tr data-pid="${esc(p.id)}">`+orderedCols.map(c=>`<td>${esc(String(fmt(p,c.k)))}</td>`).join("")+`</tr>`).join("");
  box.innerHTML=bar+`<div class="rostertable"><table class="roster"><thead>${thead}</thead><tbody>${rows||""}</tbody></table></div>`;
  const dt=box.querySelector(".colpick"); if(dt) dt.ontoggle=e=>{ _colpickOpen=e.target.open; };
  box.querySelectorAll(".colpick input[type=checkbox]").forEach(cb=>cb.onchange=()=>{
    const cur=new Set(rosterCols()); cb.checked?cur.add(cb.dataset.col):cur.delete(cb.dataset.col);
    localStorage.setItem("roster_cols", JSON.stringify(ROSTER_COLS.filter(c=>cur.has(c.k)).map(c=>c.k))); renderRoster(); });
  const rk=$("#rosterLineage"); if(rk) rk.onchange=renderRoster;
  box.querySelectorAll("th[data-sk]").forEach(th=>th.onclick=()=>{ const k=th.dataset.sk; _rosterSort=(sk===k)?{k,dir:-dir}:{k,dir:1}; renderRoster(); });
  box.querySelectorAll("tbody tr").forEach(tr=>tr.onclick=()=>{ const p=byId(tr.dataset.pid); if(p) openDetail(p); });   // 点行看详情(含关系列表),编辑走详情里「编辑」
}

/* ---------- AI 批量添加(粘贴文字 → DeepSeek 识别 → 草稿审核 → 创建)---------- */
let _aiDrafts=[];
// 世代(派生)/本族外部 已不在草稿;配偶/母/父(文字)暂留(写入退役列,供 v0.11 整理为关系)。
const AI_DRAFT_FIELDS=[
  {k:"name",label:"姓名"},{k:"sex",label:"性别",type:"sex"},
  {k:"char_gen",label:"字辈"},{k:"rank",label:"行第"},
  {k:"birth",label:"生年"},{k:"birth_lunar",label:"农历生"},{k:"death",label:"卒年"},
  {k:"birth_place",label:"出生地"},{k:"occupation",label:"职业"},{k:"residence",label:"居地"},
  {k:"spouse",label:"配偶(暂存)"},{k:"mother",label:"母(暂存)"},{k:"father_note",label:"父(文字)"},{k:"note",label:"备注"}
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
    _aiDrafts=(data.persons||[]).map(p=>{ const d={}; AI_DRAFT_FIELDS.forEach(f=>d[f.k]=p[f.k]!=null?String(p[f.k]):""); if(!d.father_note&&p.father) d.father_note="父:"+p.father; return d; });
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

/* ---------- 配偶 blob 转边工具(v0.12.0:旧 persons.spouse 自由文本 → 真实配偶人物 + 夫妻边)---------- */
// 启发式解析(纯 JS,无 AI;已对 13 条真实数据实测)。返回 [{name,sex,role,birth,death,marriageYear,note,confidence}]
function parseSpouseBlob(blob, personSex){
  if(blob==null) return [];
  const oppSex = personSex==="男"?"女":(personSex==="女"?"男":"");
  let s=String(blob).trim(); if(!s) return [];
  const paren=[];
  s=s.replace(/[（(]([^（）()]*)[）)]/g,(_m,inner)=>{ paren.push(inner); return "\x00"+(paren.length-1)+"\x00"; });
  const restore=str=>str.replace(/\x00(\d+)\x00/g,(_m,i)=>"（"+paren[+i]+"）");
  s=s.replace(/后娶|再娶|续娶|续弦/g,"\x02").replace(/[·•・/、;；,，]/g,"\x01");
  const tokens=[]; let buf="",pendingRole="";
  const flush=roleHint=>{ const seg=buf.trim(); buf=""; if(seg) tokens.push({seg,roleHint}); };
  for(const ch of s){ if(ch==="\x02"){ flush(pendingRole); pendingRole="续娶"; } else if(ch==="\x01"){ flush(pendingRole); pendingRole=""; } else buf+=ch; }
  flush(pendingRole);
  return tokens.map(t=>_parseOneSpouse(restore(t.seg), oppSex, t.roleHint));
}
function _parseOneSpouse(seg, oppSex, roleHint){
  let note=[], confidence=0.9, role=roleHint||"", birth="",death="",marriageYear="", text=seg.trim();
  if(/原配|元配/.test(text)){ role="原配"; text=text.replace(/原配|元配/g,"").trim(); }
  else if(/续娶|续弦/.test(text)){ role="续娶"; text=text.replace(/续娶|续弦/g,"").trim(); }
  else if(/侧室|妾室|^妾/.test(text)){ role="侧室"; text=text.replace(/侧室|妾室|妾/g,"").trim(); }
  const parens=[]; text=text.replace(/[（(]([^（）()]*)[）)]/g,(_m,inner)=>{ parens.push(inner); return ""; }).trim();
  for(const p of parens){ const info=_parseParen(p);
    if(info.birth&&!birth) birth=info.birth; if(info.death&&!death) death=info.death;
    if(info.marriageYear&&!marriageYear) marriageYear=info.marriageYear; if(info.note) note.push(info.note);
    if(info.ambiguous) confidence=Math.min(confidence,0.45); }
  let name=text, placeholder=false; const stripped=name.replace(/夫人/g,"").trim();
  if(/无名|不详|未详/.test(seg)&&stripped==="") placeholder=true;
  if(name==="夫人"||name==="") placeholder=placeholder||/夫人|无名|不详|未详/.test(seg);
  if(placeholder){ name=""; note=["原文为无名/泛称配偶,需人工决定是否建人"]; confidence=0.15; }
  else name=name.replace(/^夫人/,"").trim();
  if(/^[一-龥]氏$/.test(name)) confidence=Math.min(confidence,0.7);
  const mShi=name.match(/^([一-龥])氏([一-龥]{1,3})$/);
  if(mShi){ note.push("「"+name+"」疑为姓「"+mShi[1]+"」+名「"+mShi[2]+"」(即「"+mShi[1]+mShi[2]+"」?),「氏」是冠姓非名,待人工定名"); confidence=Math.min(confidence,0.5); }
  return { name, sex:oppSex||"", role, birth, death, marriageYear, note:note.join("; "), confidence:Math.round(confidence*100)/100 };
}
function _parseParen(p){
  p=String(p).trim(); const res={birth:"",death:"",marriageYear:"",note:"",ambiguous:false}; if(!p) return res;
  if(/^(早逝|早卒|夭折|无考|不详|未详|存疑)$/.test(p)){ res.note=p; return res; }
  let m=p.match(/^卒\s*(\d{4})$/); if(m){ res.death=m[1]; return res; }
  if(/^卒于|^卒\b/.test(p)){ res.note=p; return res; }
  if(/^\d+\??\s*岁$/.test(p)){ res.note=p; return res; }
  if(/农历/.test(p)){ res.note=p; return res; }
  m=p.match(/(\d{4})\s*[-–~至]\s*(\d{4})/);
  if(m){ res.birth=m[1]; res.death=m[2]; const leftover=p.replace(m[0],"").replace(/[·•、,，/\\\d?]/g,"").trim();
    if(leftover){ res.note="括号内含额外文字「"+p+"」(名/字/子女?待人工)"; res.ambiguous=true; } return res; }
  m=p.match(/^(\d{4})$/); if(m){ res.birth=m[1]; return res; }
  m=p.match(/(\d{4})/); if(m){ res.note="括号内「"+p+"」含年份但结构不清(待人工)"; res.ambiguous=true; return res; }
  res.note="括号内「"+p+"」(名/字/子女?待人工)"; res.ambiguous=true; return res;
}
let _spConv=null;   // {pid, rows:[{name,sex,role,birth,death,marriageYear,note,conf,dedup,useExisting,done,createdId}]}
function openSpouseConverter(pid){
  if(!state.canEdit) return; const p=byId(pid); if(!p){ return; }
  const parsed=parseSpouseBlob(p.spouse, p.sex);
  _spConv={ pid, rows: parsed.map(r=>({ name:r.name, sex:r.sex, role:r.role, birth:r.birth, death:r.death, marriageYear:r.marriageYear, note:r.note, conf:r.confidence, dedup:null, useExisting:"", done:false, createdId:"" })) };
  $("#spTitle").textContent=(p.name||pid)+(p.sex?("("+p.sex+")"):"");
  $("#spOrig").textContent=p.spouse||""; $("#spErr").textContent=""; $("#spParseMsg").textContent=parsed.length?("自动识别出 "+parsed.length+" 位,请核对"):"未自动识别,请手动加";
  renderSpouseRows(); $("#spouseMask").classList.add("open");
  refreshSpouseDedup();
}
async function refreshSpouseDedup(){
  if(!_spConv) return;
  for(const r of _spConv.rows){ const nm=(r.name||"").trim();
    if(nm && !r.done){ try{ r.dedup=await window.DEDUP.sameName(nm,null); }catch(e){ r.dedup=null; } } else r.dedup=null; }
  const ae=document.activeElement, box=$("#spRows");
  if(!(ae&&box&&box.contains(ae))) renderSpouseRows();   // 正在行内录入则不重绘,避免打断连续输入/IME
}
function renderSpouseRows(){
  const box=$("#spRows"); if(!box) return;
  if(!_spConv||!_spConv.rows.length){ box.innerHTML="<p class='hint'>未识别出配偶。点「+ 手动加一位」录入,或检查原文。</p>"; return; }
  box.innerHTML=_spConv.rows.map((r,i)=>{
    const conf = r.conf<0.5?`<span class="pill pill-warn">需核对</span>`:(r.conf<0.8?`<span class="pill pill-info">较可靠</span>`:`<span class="pill pill-ok">可靠</span>`);
    const dd = (r.dedup&&r.dedup.length&&!r.done) ? `<div class="aidup">⚠ 库中已有同名:`
        +`<label style="margin-left:.3rem"><input type="radio" name="spd${i}" data-i="${i}" data-use="new"${r.useExisting?"":" checked"}> 仍新建</label>`
        +r.dedup.slice(0,4).map(x=>`<label style="margin-left:.3rem"><input type="radio" name="spd${i}" data-i="${i}" data-use="${esc(x.id)}"${r.useExisting===x.id?" checked":""}> 用已有 ${esc(x.name)}(第${x.gen??"?"}代)</label>`).join("")+`</div>` : ``;
    return `<div class="aidraft${r.done?" skipped":""}"><div class="aidraft-h">配偶 #${i+1} ${conf}${r.done?' <span class="pill pill-ok">✓ 已连</span>':""}${r._err?` <span class="hint" style="color:#b91c1c">${esc(r._err)}</span>`:""}<span class="spacer" style="flex:1"></span>${r.done?"":`<button class="btn btn-sm sp-del" data-i="${i}">删除此行</button>`}</div>`
      +`<div class="aidraft-grid">`
      +`<label>姓名<input data-i="${i}" data-k="name" value="${esc(r.name)}"${r.done?" disabled":""}></label>`
      +`<label>性别<select data-i="${i}" data-k="sex"${r.done?" disabled":""}><option value=""${!r.sex?" selected":""}></option><option${r.sex==="男"?" selected":""}>男</option><option${r.sex==="女"?" selected":""}>女</option></select></label>`
      +`<label>名分<input data-i="${i}" data-k="role" value="${esc(r.role)}" placeholder="原配/续娶/侧室"${r.done?" disabled":""}></label>`
      +`<label>生年<input data-i="${i}" data-k="birth" value="${esc(r.birth)}"${r.done?" disabled":""}></label>`
      +`<label>卒年<input data-i="${i}" data-k="death" value="${esc(r.death)}"${r.done?" disabled":""}></label>`
      +`<label>婚年<input data-i="${i}" data-k="marriageYear" value="${esc(r.marriageYear)}"${r.done?" disabled":""}></label>`
      +`<label style="grid-column:1/-1">备注<input data-i="${i}" data-k="note" value="${esc(r.note)}"${r.done?" disabled":""}></label>`
      +`</div>${dd}</div>`;
  }).join("");
  box.querySelectorAll("[data-k]").forEach(e=>{ const r=_spConv.rows[+e.dataset.i];
    e.oninput=()=>{ r[e.dataset.k]=e.value; };
    if(e.dataset.k==="name") e.onchange=()=>{ r.useExisting=""; refreshSpouseDedup(); }; });
  box.querySelectorAll("[data-use]").forEach(rb=>rb.onchange=()=>{ _spConv.rows[+rb.dataset.i].useExisting=(rb.dataset.use==="new"?"":rb.dataset.use); });
  box.querySelectorAll(".sp-del").forEach(b=>b.onclick=()=>{ _spConv.rows.splice(+b.dataset.i,1); renderSpouseRows(); });
  const done=_spConv.rows.filter(r=>r.done).length;
  const pr=$("#spProgress"); if(pr) pr.textContent=`${done}/${_spConv.rows.length} 已连`;
}
async function confirmSpouseConvert(){
  if(!_spConv || state._spBusy || !state.canEdit) return;
  const p=byId(_spConv.pid); if(!p){ $("#spErr").textContent="人物不存在"; return; }
  const todo=_spConv.rows.filter(r=>!r.done && (r.name||"").trim());
  const noname=_spConv.rows.filter(r=>!r.done && !(r.name||"").trim());
  if(!todo.length){ $("#spErr").textContent=noname.length?"只剩无名配偶行;请补全姓名或删除该行":"没有可转换的配偶行"; return; }
  // 防重复(尤其重入):要"新建"但库中已有同名(可能是上次已转过的/族中已有)→ 让用户确认或改选「用已有」
  const dupNew=todo.filter(r=>!r.useExisting && state.persons.some(x=>!x.deleted && x.id!==p.id && (x.name||"")===r.name.trim()));
  if(dupNew.length && !confirm("以下配偶将【新建】,但库中已有同名:"+dupNew.map(r=>r.name.trim()).join("、")+"。\n若其中有人是上次已转过的或族中已有,请回去把该行改选「用已有」,否则会建出重复人物。\n仍要新建?")){ $("#spErr").textContent="已取消——请把同名行改选「用已有」再来"; return; }
  state._spBusy=true; $("#spConfirm").disabled=true; $("#spErr").textContent="转换中…";
  let ok=0, fail=0;
  for(const r of _spConv.rows){
    if(r.done || !(r.name||"").trim()) continue; r._err="";
    let spId=r.useExisting, createdNew=false;
    try{
      if(!spId){
        const np=await api("POST","/api/persons",{ name:r.name.trim(), sex:r.sex||"", birth:r.birth||"", death:r.death||"", alive:(r.death?"否":""), status:"待考", note:(r.note?r.note+" · ":"")+"由「"+(p.name||p.id)+"」配偶记载整理;原文:"+(p.spouse||"") });
        spId=np.id; createdNew=true; r.createdId=spId;
      }
      if(spId===p.id) throw new Error("配偶不能是本人");
      try{ await window.REL.add({ from_id:p.id, to_id:spId, type:"spouse", note:r.role||"", start_date:r.marriageYear||"" }); }
      catch(e){ if(/duplicate|unique/i.test(e.message)){ /* 已连过=幂等,视为成功 */ }
        else { if(createdNew){ try{ await api("DELETE","/api/persons/"+encodeURIComponent(spId)+"/purge"); }catch(_){} } throw e; } }  // 回滚:彻底删,不留回收站垃圾
      r.done=true; ok++;
    }catch(e){ fail++; r._err=e.message; }
  }
  await reloadPersons(); await refreshRelCount(); renderHeader(); renderOverview();
  const fresh=byId(p.id)||p;
  const allNamedDone=_spConv.rows.every(r=>r.done || !(r.name||"").trim());   // 无名行有意不建,不算"未完成"
  const unnamed=_spConv.rows.filter(r=>!r.done && !(r.name||"").trim()).length;
  if(fail===0 && allNamedDone){
    const un=unnamed?("\n注:有 "+unnamed+" 位无名/泛称配偶不会建人,清空后这部分原文也一并清掉(可在操作历史还原)。"):"";
    if(confirm("已整理 "+ok+" 位配偶。原文「"+(fresh.spouse||"")+"」里的配偶是否已全部处理?"+un+"\n清空后原文仅可在「操作历史」里撤销还原。")){
      try{ await api("PUT","/api/persons/"+encodeURIComponent(p.id),{spouse:""}); await reloadPersons();
        $("#spErr").innerHTML='<span style="color:#047857">✅ 已整理 '+ok+' 位配偶并清空原文(可在操作历史撤销还原)。</span>';
        setTimeout(()=>{ $("#spouseMask").classList.remove("open"); }, 1300);
      }catch(e){ $("#spErr").innerHTML='<span style="color:#b45309">配偶已连好,但清空原文失败:'+esc(e.message)+'(原文已保留,可稍后重试)</span>'; }
    } else $("#spErr").innerHTML='<span style="color:#047857">已整理 '+ok+' 位配偶(原文保留未清,可下次继续)。</span>';
  } else $("#spErr").innerHTML='<span style="color:#b91c1c">成功 '+ok+' 位'+(fail?(",失败 "+fail+" 位(看各行红字;原文保留未清)"):"")+'。</span>';
  renderSpouseRows();
  if(document.getElementById("view-health")&&document.getElementById("view-health").classList.contains("active")) renderHealth();
  if(state.detailing===p.id) openDetail(byId(p.id));
  state._spBusy=false; $("#spConfirm").disabled=false;
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
  if(name==="families") renderFamilies();
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
$("#f_rel_person").onchange=initRelAuto;
$("#f_rel_type").onchange=initRelAuto;
$("#f_name").oninput=()=>{ const o=$("#initRelObj"); if(o) o.textContent=($("#f_name").value.trim())||"此人"; };
// Esc 关闭最上层弹窗(此前无键盘退出)
document.addEventListener("keydown", e=>{ if(e.key!=="Escape") return;
  const lb=$("#lightbox"); if(lb&&lb.classList.contains("open")){ lb.classList.remove("open"); return; }   // 先关图片预览
  if($("#mask").classList.contains("open")) closeModal();
  else if($("#detailMask").classList.contains("open")) closeDetail();
  else if($("#aiMask")&&$("#aiMask").classList.contains("open")) $("#aiMask").classList.remove("open");
  else if($("#spouseMask")&&$("#spouseMask").classList.contains("open")) $("#spouseMask").classList.remove("open"); });
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
$("#spClose")     && ($("#spClose").onclick=()=>$("#spouseMask").classList.remove("open"));
$("#spouseMask")  && ($("#spouseMask").onclick=e=>{ if(e.target===$("#spouseMask")) $("#spouseMask").classList.remove("open"); });
$("#spConfirm")   && ($("#spConfirm").onclick=confirmSpouseConvert);
$("#spAddRow")    && ($("#spAddRow").onclick=()=>{ if(!_spConv)return; const ps=(byId(_spConv.pid)||{}).sex; _spConv.rows.push({name:"",sex:ps==="男"?"女":(ps==="女"?"男":""),role:"",birth:"",death:"",marriageYear:"",note:"",conf:1,dedup:null,useExisting:"",done:false,createdId:""}); renderSpouseRows(); });

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
