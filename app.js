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
// 照片放大预览(画廊):传图片数组+起始下标,可◀▶/方向键/滑动切换;点黑底或 Esc 关闭
let _lbImgs=[], _lbIdx=0, _lbX=0;
function openLightbox(imgs, idx){
  _lbImgs = Array.isArray(imgs) ? imgs.filter(Boolean) : (imgs?[imgs]:[]);
  if(!_lbImgs.length) return;
  _lbIdx = Math.max(0, Math.min(idx||0, _lbImgs.length-1));
  let m=document.getElementById("lightbox");
  if(!m){ m=el("div","lightbox"); m.id="lightbox"; document.body.appendChild(m);
    m.onclick=e=>{ if(e.target===m) m.classList.remove("open"); };           // 点黑底关;点图/按钮不关
    m.addEventListener("touchstart",e=>{ _lbX=e.touches[0].clientX; },{passive:true});
    m.addEventListener("touchend",e=>{ const dx=e.changedTouches[0].clientX-_lbX; if(Math.abs(dx)>40) _lbStep(dx<0?1:-1); },{passive:true});
  }
  _renderLightbox(); m.classList.add("open");
}
function _lbStep(d){ if(_lbImgs.length<2) return; _lbIdx=(_lbIdx+d+_lbImgs.length)%_lbImgs.length; _renderLightbox(); }
function _renderLightbox(){
  const m=document.getElementById("lightbox"); if(!m) return; const multi=_lbImgs.length>1;
  m.innerHTML=`${multi?'<button class="lb-nav lb-prev" title="上一张(←)">‹</button>':""}<img src="${esc(_lbImgs[_lbIdx])}" alt="">${multi?`<button class="lb-nav lb-next" title="下一张(→)">›</button><div class="lb-count">${_lbIdx+1} / ${_lbImgs.length}</div>`:""}`;
  if(multi){ m.querySelector(".lb-prev").onclick=e=>{e.stopPropagation();_lbStep(-1);}; m.querySelector(".lb-next").onclick=e=>{e.stopPropagation();_lbStep(1);}; }
}
// 软件版本(每次部署递增;显示在页头与登录页,便于确认浏览器已加载最新版)
const APP_NAME = "关系图谱";              // 产品名(品牌,固定);本质=人物关系图谱,非单一族谱;某本谱名是 meta.title(数据)
const APP_VERSION = "v0.40.0";
const APP_DATE = "2026-06-30";
[["#appVer",APP_VERSION],["#appVerLogin","版本 "+APP_VERSION+" · "+APP_DATE]].forEach(([s,t])=>{ const e=document.querySelector(s); if(e) e.textContent=t; });

// L1 节点=纯个人属性。世代(派生)/本族外部/行第/亲属关系/母/父系说明/配偶 已退出表单(关系→边层,世代→推算)。
const FORM_KEYS = ["id","name","char_gen","alias","sex","birth",
  "birth_lunar","birth_time","death","death_lunar","birth_place","burial","alive",
  "occupation","company","residence","contact","address","deeds","source","status","note"];
const DIRECT_LINE = new Set(["S001","S002","S004","S008","S010","S014","S019","S033","S046"]);
const ORIG_IMG = {p1:window.photoUrl("yuanpu/p1.jpg"),p2:window.photoUrl("yuanpu/p2.jpg"),p3:window.photoUrl("yuanpu/p3.jpg"),p4:window.photoUrl("yuanpu/p4.jpg")};
const UNDOABLE = new Set(["create:person","update:person","delete:person","purge:person","delete:marriage","delete:media","create:relationship"]);

const state = { persons:[], meta:{}, narratives:[], verify:[], transcription:[], relTypes:[], relCount:{}, q:"", share:false,
                editing:null, user:null, canEdit:false, lineage:"",
                graphCenter:"", graphHops:2, pathA:"", pathB:"",
                fatherOf:{}, motherOf:{}, childrenMap:{}, spouseOf:{}, _genCache:{}, _lineageCache:{}, lineages:null,
                filters:{charGen:"",status:"",alive:""}, customFilters:[],
                treeMode:null, classicLineage:null, classicZoom:null };   // classicZoom=null ⇒ 传统谱图默认"适应整页"

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
  renderHeader(); renderPeople(); renderHistory(); renderVerify(); renderSource();
}
function renderAuthBar(){       // 显示当前登录者 + 角色;viewer 隐藏所有 .edit-only 控件
  const who=$("#whoami"); if(who) who.textContent = state.user ? (state.user.email + (state.canEdit?" · 可编辑":" · 只读")) : "";
  document.body.classList.toggle("viewer", !state.canEdit);
}
function renderHeader(){
  $("#subtitle").textContent="";   // 谱名/地望副标题已按需去掉(产品是通用关系图谱)
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
// 三个模式(列表/卡片/孙氏)共用的过滤后列表:搜索(state.q)+ 自定义字段筛选(state.customFilters)+ 孙氏分页(state.lineage)
function peopleFiltered(){
  let list=state.persons.filter(p=>!p.deleted && matchQ(p) && (!state.lineage||familiesOf(p.id).includes(state.lineage)));
  (state.customFilters||[]).forEach(f=>{ const v=(f.val||"").trim().toLowerCase(); if(!v) return;   // 多条 AND
    list=list.filter(p=>{ const cell=String(cellVal(p,f.field)??"").toLowerCase(); return f.op==="eq"?cell===v:cell.includes(v); }); });
  return list;
}
// 共用的「搜索 + 字段筛选」条,渲染进 #filterBar(列表/卡片/孙氏 同一套);count=过滤后人数
function renderPeopleFilter(count){
  const fb=$("#filterBar"); if(!fb) return;
  const cfRows=(state.customFilters||[]).map((f,i)=>`<span class="cfrow" style="display:inline-flex;gap:.2rem;align-items:center"><select class="cf-field" data-i="${i}">${ROSTER_COLS.map(c=>`<option value="${c.k}"${c.k===f.field?" selected":""}>${esc(c.label)}</option>`).join("")}</select><select class="cf-op" data-i="${i}"><option value="contains"${f.op!=="eq"?" selected":""}>包含</option><option value="eq"${f.op==="eq"?" selected":""}>等于</option></select><input class="cf-val" data-i="${i}" value="${esc(f.val||"")}" placeholder="值" style="width:7em"><button class="btn btn-sm cf-del" data-i="${i}" title="删条件">✕</button></span>`).join("");
  const hasFilter=(state.q||"").trim()||(state.customFilters||[]).some(f=>(f.val||"").trim());
  const recent=recentSearches().filter(t=>t!==(state.q||"").trim());
  const recentRow=recent.length?`<div class="recentsearch" style="display:flex;gap:.3rem;flex-wrap:wrap;align-items:center;margin:.25rem 0 0"><span class="hint">最近搜索:</span>${recent.map(t=>`<button class="btn btn-sm rs-chip" data-q="${esc(t)}">${esc(t)}</button>`).join("")}<button class="btn btn-sm rs-clear" title="清空搜索历史">🗑 清空</button></div>`:"";
  fb.innerHTML=`<div class="rosterfilter" style="display:flex;gap:.4rem;flex-wrap:wrap;align-items:center">`
    +`<input id="peopleSearch" type="text" placeholder="🔍 搜索姓名/字号/备注…" value="${esc(state.q||"")}" style="min-width:11em;flex:0 1 18em">`
    +`${cfRows}<button class="btn btn-sm" id="cfAdd">+ 字段筛选</button>`
    +`<span class="hint">${count} 人</span>${hasFilter?`<button class="btn btn-sm" id="cfClear">清除</button>`:""}${state.canEdit&&hasFilter&&count>=1?`<button class="btn btn-sm" id="bulkRelBtn" title="把当前筛选出的这些人,批量加为某人的某种关系">🔗 批量加关系</button>`:""}</div>`+recentRow;
  const refocus=sel=>{ const e2=document.querySelector(sel); if(e2){ const v=e2.value; e2.focus(); try{e2.setSelectionRange(v.length,v.length);}catch(_){} } };
  { const rs=$("#peopleSearch"); if(rs){
      const apply=()=>{ state.q=rs.value; renderPeople(); refocus("#peopleSearch"); recordSearchDebounced(); };
      rs.oninput=e=>{ if(e.isComposing) return; apply(); };          // 拼音组合中不重渲染(否则销毁输入框打断输入法)
      rs.oncompositionend=apply;
      rs.onkeydown=e=>{ if(e.key==="Enter" && !e.isComposing){ state.q=rs.value; pushRecentSearch(rs.value); renderPeople(); refocus("#peopleSearch"); } }; } }   // 拼音用回车选词时 isComposing 仍为真→不当搜索提交;真回车先同步 state.q 防重渲染清空
  fb.querySelectorAll(".rs-chip").forEach(b=>b.onclick=()=>{ state.q=b.dataset.q; pushRecentSearch(state.q); renderPeople(); });
  { const rc=fb.querySelector(".rs-clear"); if(rc) rc.onclick=()=>{ clearRecentSearches(); renderPeople(); }; }
  fb.querySelectorAll(".cf-field").forEach(s=>s.onchange=()=>{ state.customFilters[+s.dataset.i].field=s.value; renderPeople(); });
  fb.querySelectorAll(".cf-op").forEach(s=>s.onchange=()=>{ state.customFilters[+s.dataset.i].op=s.value; renderPeople(); });
  fb.querySelectorAll(".cf-val").forEach(inp=>{ const apply=()=>{ const i=+inp.dataset.i; state.customFilters[i].val=inp.value; renderPeople(); refocus('.cf-val[data-i="'+i+'"]'); };
    inp.oninput=e=>{ if(e.isComposing) return; apply(); }; inp.oncompositionend=apply; });
  fb.querySelectorAll(".cf-del").forEach(b=>b.onclick=()=>{ state.customFilters.splice(+b.dataset.i,1); renderPeople(); });
  { const a=$("#cfAdd"); if(a) a.onclick=()=>{ (state.customFilters=state.customFilters||[]).push({field:ROSTER_COLS[0].k,op:"contains",val:""}); renderPeople(); }; }
  { const c=$("#cfClear"); if(c) c.onclick=()=>{ state.q=""; state.customFilters=[]; renderPeople(); }; }
  { const br=$("#bulkRelBtn"); if(br) br.onclick=()=>openBulkRel(peopleFiltered()); }
}
// 批量加关系:把当前筛选出的一组人,全部加为某目标人物的某种关系(对称类型,如 同事/朋友/合作)。已存在的跳过;经 REL+history,可逐条撤销。
function _personOptsBirth(sel,q){ q=(q||"").trim().toLowerCase();
  let list=state.persons.filter(p=>!p.deleted);
  if(q) list=list.filter(p=>((p.name||"")+" "+(p.alias||"")+" "+p.id).toLowerCase().includes(q));
  list=list.sort((a,b)=>(parseInt(a.gen)||0)-(parseInt(b.gen)||0)||(a.sort_order||0)-(b.sort_order||0)).slice(0,300);
  return list.map(p=>`<option value="${esc(p.id)}"${p.id===sel?" selected":""}>${esc(p.name||"(无名)")}${p.birth?(" · "+esc(p.birth)):""} — ${esc(p.id)}</option>`).join("");
}
function openBulkRel(list){
  list=(list||[]).filter(p=>p&&!p.deleted);
  const symTypes=(state.relTypes||[]).filter(t=>t.is_symmetric);
  if(!symTypes.length){ alert("没有可用的对称关系类型(同事/朋友等)"); return; }
  let mask=$("#bulkRelMask"); if(!mask){ mask=el("div","mask"); mask.id="bulkRelMask"; document.body.appendChild(mask); }
  const typeOpts=symTypes.map(t=>`<option value="${esc(t.type)}"${t.type==="colleague"?" selected":""}>${esc(t.label_zh)}</option>`).join("");
  // 中心人物的下拉【默认就是这组筛选出来的人】(中心通常在组内,如 孙德峰∈银河,一点即选);搜索框可搜全部人(中心不在组里时)
  const groupOpts=list.slice().sort((a,b)=>(parseInt(a.gen)||0)-(parseInt(b.gen)||0)||(a.sort_order||0)-(b.sort_order||0))
    .map(p=>`<option value="${esc(p.id)}">${esc(p.name||"(无名)")}${p.birth?(" · "+esc(p.birth)):""} — ${esc(p.id)}</option>`).join("");
  const groupPH=`<option value="">— 从这 ${list.length} 人里选中心(或右边搜全部)—</option>`;
  mask.innerHTML=`<div class="modal" style="width:min(560px,100%)"><h2>批量加关系</h2>
    <p class="hint">把<b>这 ${list.length} 人</b>全部连到<b>一个中心人物</b>(对称关系,如同事/朋友)。中心通常就在这组里——比如孙德峰就在银河,直接在下拉里选他。已存在的自动跳过;每条留痕、可在操作历史撤销。</p>
    <div class="field"><label>中心人物(这组人都连到 TA)</label><div class="inwrap"><input id="brSearch" placeholder="🔍 不在这组?搜全部" style="width:10em;margin-right:.3rem"><select id="brTarget">${groupPH}${groupOpts}</select></div></div>
    <div class="field"><label>关系类型</label><select id="brType">${typeOpts}</select> &nbsp; 备注 <input id="brNote" placeholder="可空,如 银河同事" style="width:11em"></div>
    <div class="err" id="brMsg"></div>
    <div class="modal-foot"><span class="spacer"></span><button class="btn" id="brCancel">取消</button><button class="btn btn-primary" id="brRun">确认创建</button></div></div>`;
  mask.classList.add("open");
  $("#brCancel").onclick=()=>mask.classList.remove("open");
  mask.onclick=e=>{ if(e.target===mask) mask.classList.remove("open"); };
  { const se=$("#brSearch"); if(se){ se.oninput=()=>{ const cur=$("#brTarget").value, q=se.value.trim();
      $("#brTarget").innerHTML = q ? (`<option value="">— 选中心人物 —</option>`+_personOptsBirth(cur, q)) : (groupPH+groupOpts); };   // 没输入=回到这组;输入=搜全部
      setTimeout(()=>{ try{ se.focus(); }catch(_){} }, 60); } }
  $("#brRun").onclick=async()=>{
    const target=$("#brTarget").value, type=$("#brType").value, note=$("#brNote").value.trim(), msg=$("#brMsg");
    if(!target){ msg.textContent="请先选目标人物"; return; }
    const targets=list.filter(p=>p.id!==target);
    if(!targets.length){ msg.textContent="没有可连接的人(筛选为空,或只有目标本人)"; return; }
    const tname=(byId(target)||{}).name||target, tl=(symTypes.find(t=>t.type===type)||{}).label_zh||type;
    if(!confirm(`把这 ${targets.length} 人 全部加为「${tname}」的「${tl}」?`)) return;
    const btn=$("#brRun"); btn.disabled=true; btn.textContent="创建中…";
    let edges=[]; try{ edges=await window.REL.all(); }catch(e){}
    const has=(a,b)=>edges.some(r=>r.type===type && ((r.from_id===a&&r.to_id===b)||(r.from_id===b&&r.to_id===a)));   // 对称:任一方向都算已存在
    let ok=0, skip=0; const fails=[];
    for(const p of targets){ if(has(target,p.id)){ skip++; continue; }
      try{ await window.REL.add({from_id:target,to_id:p.id,type,note}); ok++; }catch(e){ fails.push((p.name||p.id)+":"+(e.message||e)); } }
    btn.disabled=false; btn.textContent="确认创建";
    await reloadPersons(); await refreshRelCount(); renderPeople();
    mask.classList.remove("open");
    alert(`完成:新建 ${ok} 条「${tl}」${skip?(" · 跳过 "+skip+" 条已存在"):""}${fails.length?("\n失败 "+fails.length+":\n"+fails.slice(0,10).join("\n")):""}\n(可在「操作历史」逐条撤销)`);
  };
}
// 名册 = 列表 / 卡片 / 孙氏 三页。列表&卡片=全部人;孙氏=只显孙氏(卡片按世代)。计数显示在按钮上。
function renderPeople(){
  const mode = state.peopleMode || (state.peopleMode = (localStorage.getItem("people_view")||"list"));   // 默认列表
  const live = state.persons.filter(p=>!p.deleted);
  const total = live.length, sunCount = live.filter(p=>familiesOf(p.id).includes("孙氏")).length;   // 与孙氏页 renderCards 的过滤口径一致
  const sw=$("#peopleMode");
  if(sw){ sw.innerHTML=[["list","☰ 列表 "+total],["cards","🃏 卡片 "+total],["sun","孙氏 "+sunCount]].map(([m,l])=>`<button class="btn btn-sm${mode===m?" btn-primary":""}" data-mode="${m}">${l}</button>`).join("");
    sw.querySelectorAll("[data-mode]").forEach(b=>b.onclick=()=>{ state.peopleMode=b.dataset.mode; try{localStorage.setItem("people_view",b.dataset.mode);}catch(e){} renderPeople(); }); }
  const isList = mode==="list";
  state.lineage = mode==="sun" ? "孙氏" : "";       // 孙氏页只显孙氏;列表/卡片显全部
  const list = peopleFiltered();                    // 三模式共用同一套 搜索+筛选 结果
  renderPeopleFilter(list.length);                  // 共用筛选条(渲染进 #filterBar,始终显示)
  const fb=$("#filterBar"), ov=$("#overview"), rb=$("#rosterBox"), sn=$("#shareNote");
  if(fb) fb.style.display="";
  if(ov) ov.style.display=isList?"none":"";
  if(rb) rb.style.display=isList?"":"none";
  if(sn) sn.style.display=(!isList&&state.share)?"block":"none";
  if(isList) renderRoster(list); else renderCards(list);
}
function renderCards(list){
  const box=$("#overview"); box.innerHTML="";
  if(!list.length){ box.appendChild(el("p","note","无匹配人物。")); return; }
  const sorted=list.slice().sort((a,b)=>gk(genOf(a.id))-gk(genOf(b.id))||(a.sort_order||0)-(b.sort_order||0));
  if(!state.lineage){   // 「卡片」页=混合人群:平铺不分组(世代是同族概念,不适合混合);保持原样
    const cards=el("div","cards"); sorted.forEach(p=>cards.appendChild(personCard(p))); box.appendChild(cards); return;
  }
  // 「孙氏」页=同族:按世代分组,每组前加「第N世 · X字辈」头(同族适合按辈分组织)
  const groups=new Map();   // key=世代数字 或 "?";sorted 已按世代升序 → Map 保持插入序即升序
  sorted.forEach(p=>{ const g=genOf(p.id); const k=(g==null?"?":g); if(!groups.has(k)) groups.set(k,[]); groups.get(k).push(p); });
  groups.forEach((ppl,k)=>{
    const cnt={}; ppl.forEach(x=>{ const cg=(x.char_gen||"").trim(); if(cg&&cg!=="—") cnt[cg]=(cnt[cg]||0)+1; });   // 该世代主字辈
    let cg="",n=0; Object.keys(cnt).forEach(c=>{ if(cnt[c]>n){ n=cnt[c]; cg=c; } });
    const head=el("div","gen-head"); head.innerHTML=(k==="?"?"未定世代":("第"+k+"世"))+(cg?` <span class="gen-cg">${esc(cg)}字辈</span>`:"")+` <span class="gen-count">${ppl.length} 人</span>`;
    box.appendChild(head);
    const grid=el("div","cards"); ppl.forEach(p=>grid.appendChild(personCard(p))); box.appendChild(grid);
  });
}
function statusPill(s){const m={"确认":"pill-ok","存疑":"pill-warn","待考":"pill-muted","待补":"pill-info"};return s?`<span class="pill ${m[s]||"pill-muted"}">${esc(s)}</span>`:"";}
// 在世标:是=绿「在世」/否=不显/空或未知=黄「在世未知」(此前空值被当已故,误)
function aliveTag(p){ return p.alive==="是"?'<span class="tag">在世</span>':(p.alive==="否"?"":'<span class="pill pill-warn">在世未知</span>'); }
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
    +`<div class="nm">${esc(p.name||"(无名)")} ${aliveTag(p)} ${statusPill(p.status)}${state.relCount[p.id]?`<span class="relcount" title="关系数,点开看关系网">关系 ${state.relCount[p.id]}</span>`:""}</div>`
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
        try{ await api("PUT","/api/meta",meta); msg.textContent="已保存 ✓"; state._lineageCache={}; state.lineages=null; renderFamilies(); renderHeader(); renderPeople(); }catch(e){ msg.textContent="失败:"+e.message; } };
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
    rb.onclick=async()=>{await api("POST","/api/persons/"+encodeURIComponent(p.id)+"/restore");await reloadPersons();renderTrash();renderPeople();renderHeader();};
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
    try{ await api("POST","/api/history/"+b.dataset.id+"/undo"); await reloadPersons(); await refreshRelCount(); renderPeople(); renderHeader(); renderLog(); }  // refreshRelCount:撤销关系边后刷新 父/母/配偶 图,避免 UI 残留
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
  star.onclick=async()=>{await api("PUT","/api/media/"+md.id,{is_primary:1});await renderMedia(state.editing);await reloadPersons();renderPeople();};
  cap.onchange=async()=>{await api("PUT","/api/media/"+md.id,{caption:cap.value});};
  del.onclick=async()=>{if(!confirm("删除这张照片?"))return;await api("DELETE","/api/media/"+md.id);await renderMedia(state.editing);await reloadPersons();renderPeople();};
  it.innerHTML=`<img src="${esc(window.photoUrl(md.path))}" alt="" style="cursor:zoom-in"/>`;
  it.querySelector("img").onclick=()=>openLightbox(window.photoUrl(md.path));
  const ctl=el("div","gctl"); ctl.appendChild(cap); const row=el("div","subrow-line"); row.appendChild(star); row.appendChild(del); ctl.appendChild(row);
  it.appendChild(ctl); return it;
}

/* ---------- 数据体检(P0-4/5) ---------- */
function runHealth(){
  const ps=state.persons, ids=new Set(ps.map(p=>p.id));
  const F=state.fatherOf;
  const out={cycle:[],dangling:[],charBreak:[],yearConflict:[],genMismatch:[],noFather:[],marriedIn:[],dupName:[]};
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
  // 无父边但推算第>1代:区分「嫁入配偶」(本姓≠所嫁家族且配偶在本族有锚→无父正常)与「真缺父系」(应补父让世代连续)
  const marriedIn=p=>{ const mine=surnameOfSelf(p.id); if(!mine) return false;
    return (state.spouseOf[p.id]||[]).some(spId=>{ const s=surnameOfSelf(spId); if(!s||s===mine) return false;   // 同姓不算嫁入
      return state.fatherOf[spId]||!isNaN(parseInt((byId(spId)||{}).gen,10)); }); };                              // 配偶有父边或手填世代=在本族有锚,p 系嫁入
  ps.forEach(p=>{ if(!F[p.id]){ const g=genOf(p.id); if(g!=null&&g>1){
    if(marriedIn(p)) out.marriedIn.push({p,why:`随配偶第${g}代 · 嫁入(本姓${surnameOfSelf(p.id)||"?"},无父属正常)`});
    else out.noFather.push({p,why:`第${g}代但未连父亲`+(p.father_note?`(线索:${p.father_note})`:"")}); } } });
  const bn={}; ps.forEach(p=>{ if(p.name)(bn[p.name]=bn[p.name]||[]).push(p); });
  Object.keys(bn).forEach(n=>{ if(bn[n].length>1) out.dupName.push({name:n,list:bn[n]}); });
  return out;
}
function renderHealth(){
  const box=$("#health"); box.innerHTML=""; const h=runHealth();
  const total=h.cycle.length+h.dangling.length+h.charBreak.length+h.yearConflict.length+h.genMismatch.length+h.noFather.length;
  const miNote=h.marriedIn.length?` 另有 ${h.marriedIn.length} 位嫁入配偶(无父属正常)已单列、不计入。`:"";
  box.appendChild(el("p","note", (total? `共发现 ${total} 处需注意(重名 ${h.dupName.length} 组另列,多为已知待核实的同名)。点条目可直接打开修正。` : "✅ 未发现父子/世代/年代/字辈类问题。")+miNote));
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
  if(h.marriedIn.length) sec("· 嫁入配偶(无父属正常,不计为问题)", h.marriedIn, x=>plink(x.p,x.why), "pill-ok");
  sec("⑦ 重名(同名异人?需核实)", h.dupName, x=>{ const d=el("div","hitem"); d.innerHTML=`<b>${esc(x.name)}</b>: `+x.list.map(p=>`<a class="plink chip" data-pid="${esc(p.id)}">${esc(p.id)}·第${genStr(p.id)}代</a>`).join("")+(state.canEdit?` <button class="btn btn-sm mergebtn" data-name="${esc(x.name)}">合并…</button>`:""); return d; }, "pill-info");
  // ⑧ 配偶待整理(迁移任务,非错误):旧 spouse 自由文本 → 真实配偶人物 + 夫妻边
  const pend=state.persons.filter(p=>!p.deleted && (p.spouse||"").trim());
  sec("⑧ 配偶待整理(原始记载→关系)", pend, p=>{ const d=el("div","hitem");
    d.innerHTML=`<a class="plink" data-pid="${esc(p.id)}">${esc(p.name||p.id)}</a> <span class="hint">原文:${esc(p.spouse)}</span>`
      +(state.canEdit?` <button class="btn btn-sm spConvBtn" data-pid="${esc(p.id)}">整理为配偶</button>`:""); return d; }, "pill-info");
  // ⑨ 可回填另一方父母边(夫妻↔子女联动):孩子只连一方家长,而该家长恰好1个配偶 → 推定另一方父母
  const bf=backfillCoParentDrafts();
  sec("⑨ 可回填另一方父母边", bf, d=>{ const role=d.otherType==="mother"?"母":"父"; const div=el("div","hitem");
    div.innerHTML=`<a class="plink" data-pid="${esc(d.child.id)}">${esc(d.child.name||d.child.id)}</a> <span class="hint">缺${role}边,推定为「${esc(d.coParent.name||"")}」(${esc((byId(d.parentId)||{}).name||"")} 的唯一配偶)</span>`; return div; }, "pill-info");
  if(state.canEdit && bf.length){ const b=el("button","btn btn-sm btn-primary","一键回填预览…"); b.style.marginTop=".4rem"; b.onclick=openBackfillDialog; if(box.lastChild) box.lastChild.appendChild(b); }
  // ⑩ 在世状态空白:未填「在世」的人(图谱/卡片显黄「未知」)。可一键统一设为「是」(可逐条撤销)
  const aliveBlank=state.persons.filter(p=>!p.deleted && !(p.alive||"").trim());
  sec("⑩ 在世状态空白(未知)", aliveBlank, p=>plink(p,"未填在世,显示为「未知」"), "pill-info");
  if(state.canEdit && aliveBlank.length){ const b=el("button","btn btn-sm btn-primary",`把空白在世统一设为「是」(${aliveBlank.length})`); b.style.marginTop=".4rem";
    b.onclick=async()=>{ if(!confirm(`把 ${aliveBlank.length} 位「在世」为空的人统一标为「是」?可在操作历史逐条撤销。`)) return; b.disabled=true; b.textContent="处理中…";
      let ok=0; const fails=[]; for(const p of aliveBlank){ try{ await api("PUT","/api/persons/"+encodeURIComponent(p.id),{alive:"是"}); ok++; }catch(e){ fails.push((p.name||p.id)+":"+e.message); } }
      await reloadPersons(); await refreshRelCount(); renderHeader(); renderPeople(); renderHealth();
      if(fails.length) alert(`已改 ${ok} 条,失败 ${fails.length}:\n`+fails.join("\n")); };
    if(box.lastChild) box.lastChild.appendChild(b); }
  // 出生日期规范化工具(规则+AI)
  if(state.canEdit){ const pn=el("div","panel"); pn.innerHTML=`<h3>🤖 出生日期规范化</h3><div class="hint">把「出生日期」统一成 年 / 年-月 / 年-月-日(规则优先,农历/年号等用 AI 兜底),不识别的会标出供手动处理。</div>`;
    const b=el("button","btn btn-sm btn-primary","规范出生日期…"); b.style.marginTop=".4rem"; b.onclick=openDateNormalizer; pn.appendChild(b); box.appendChild(pn); }
  box.querySelectorAll(".plink").forEach(a=>a.onclick=()=>{ const t=byId(a.dataset.pid); if(t) openDetail(t); });   // 先看详情(含关系列表),编辑走详情里「编辑」
  box.querySelectorAll(".spConvBtn").forEach(b=>b.onclick=(e)=>{ e.stopPropagation(); openSpouseConverter(b.dataset.pid); });
  box.querySelectorAll(".mergebtn").forEach(b=>b.onclick=()=>{ const g=h.dupName.find(x=>x.name===b.dataset.name); if(g) openMergeDialog(g.list); });
  box.querySelectorAll(".useGenBtn").forEach(b=>b.onclick=async(e)=>{ e.stopPropagation(); const pid=b.dataset.pid;
    if(!confirm("清除该人手填世代,改由父系图自动推算?")) return;
    try{ await api("PUT","/api/persons/"+encodeURIComponent(pid),{gen:""}); await reloadPersons(); await refreshRelCount(); renderHeader(); renderPeople(); renderHealth(); }
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
      mask.classList.remove("open"); await reloadPersons(); renderHeader(); renderPeople(); renderHealth(); }
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
  // 照片:头像即主图;点头像打开画廊(全部照片,左右翻)。相册区不再单独显示。
  const media = share ? [] : (await api("GET","/api/persons/"+encodeURIComponent(p.id)+"/media").catch(()=>[]));
  const gallery = media.map(md=>window.photoUrl(md.path));
  const mainIdx = Math.max(0, media.findIndex(md=>md.path===p.photo));
  const photo=(p.photo&&!share)
    ? `<div class="dphoto-wrap"><img class="dphoto" loading="lazy" src="${esc(window.photoUrl(p.photo))}">${media.length>1?`<span class="dphoto-count">📷 ${media.length}</span>`:""}</div>`
    : `<div class="dphoto noimg">${esc((p.name||"?").slice(-1))}</div>`;
  let html=`<div class="dhead">${photo}<div class="dhead-main"><div class="dname">${esc(p.name||"(无名)")}</div>`
    +`<div class="dpills">${(p.char_gen&&p.char_gen!=="—")?`<span class="tag">${esc(p.char_gen)}字辈</span>`:""}<span class="tag">第${genStr(p.id)}代</span>${aliveTag(p)} ${statusPill(p.status)}</div></div></div>`;
  if(share){ box.innerHTML=html+`<p class="note">分享模式:在世亲属仅显示姓名/字辈/世代,其余隐藏。</p>`; $("#detailMask").classList.add("open"); return; }

  const chain=ancestorChain(p);
  if(chain.length){
    const seq=chain.slice().reverse().concat([p]);
    html+=`<div class="dchain"><span class="dk">直系</span> `+seq.map((x,i)=>
      (i?'<span class="arrow">→</span>':'')+(x.id===p.id?`<b>${esc(x.name)}</b>`:`<a class="plink" data-pid="${esc(x.id)}">${esc(x.name)}</a>`)).join("")+`</div>`;
  }

  const rows=[];
  const R=(k,v)=>{ if(v) rows.push(`<div class="drow"><span class="dk">${k}</span><span class="dv">${esc(v)}</span></div>`); };
  R("出生日期", [p.birth, p.birth_lunar&&("农历 "+p.birth_lunar), shengXiaoLabel(p), p.birth_time].filter(Boolean).join(" · "));
  R("出生地", p.birth_place);
  if(p.alive==="否"){ R("卒", [p.death, p.death_lunar&&("农历 "+p.death_lunar)].filter(Boolean).join(" · ")); R("葬地", p.burial); }   // 卒/葬仅在「已故」时显示
  R("字号", p.alias); R("性别", p.sex); R("学历/职业", p.occupation); R("公司", p.company); R("居地/迁徙", p.residence);
  if(rows.length) html+=`<div class="dgrid">${rows.join("")}</div>`;
  // 关系(父/母/配偶/子女/社交…)统一收到下方「关系网」列表;上方只留个人信息 + 直系链
  if(p.contact||p.address){
    html+=`<div class="dsec"><div class="dsec-h">联系(内部 🔒)</div>`
      +[p.contact&&`<div class="ditem">${esc(p.contact)}</div>`, p.address&&`<div class="ditem">${esc(p.address)}</div>`].filter(Boolean).join("")+`</div>`;
  }
  if(p.deeds) html+=`<div class="dsec"><div class="dsec-h">事迹</div><div class="ditem">${esc(p.deeds)}</div></div>`;
  const m3=[p.source&&("来源:"+p.source), p.note&&("备注:"+p.note)].filter(Boolean);
  if(m3.length) html+=`<div class="dsec hint" style="margin-top:.6rem">${m3.map(esc).join("<br>")}</div>`;
  // 照片不在详情页单列相册——全部照片点头像进画廊查看(上传/管理在「编辑」弹窗)
  // 关系网(详情页下方 = 关系管理中心:父/母/配偶/子女/社交 全在此整齐列表里增删改)
  const rtMap={}; (state.relTypes&&state.relTypes.length?state.relTypes:(await window.REL.types().catch(()=>[]))).forEach(t=>rtMap[t.type]=t);
  const rels=await window.REL.of(p.id).catch(()=>[]);
  const catRank=c=>{ const i=["亲属","社交","工作"].indexOf(c); return i<0?9:i; };
  const relPrio=(type,fromMe)=>((type==="father"||type==="mother")&&!fromMe)?1:(type==="spouse"?2:(((type==="father"||type==="mother")&&fromMe)?3:(type==="sibling"?4:5)));
  const mfRank=note=>{ const n=note||""; if(/原配|元配|嫡|发妻|结发/.test(n))return 0; if(/继|续|填房/.test(n))return 1; if(/侧|妾|偏房|庶/.test(n))return 2; return 3; };  // 名分先后:原配<续娶<侧室<未注
  const yrNum=s=>{ const m=(s||"").match(/\d{4}/); return m?+m[0]:99999; };
  let rh="";
  if(rels.length){
    const byCat={};
    rels.forEach(r=>{
      const t=rtMap[r.type]||{label_zh:r.type,category:"其他"};
      const fromMe=r.from_id===p.id, other=fromMe?r.to_id:r.from_id, op=byId(other); if(!op) return;
      const lab=r.directed?(fromMe?(t.forward_label||t.label_zh):(t.inverse_label||t.label_zh)):t.label_zh;
      (byCat[t.category||"其他"]=byCat[t.category||"其他"]||[]).push({r,op,lab,color:t.color,prio:relPrio(r.type,fromMe),isSpouse:r.type==="spouse"});
    });
    Object.keys(byCat).sort((a,b)=>catRank(a)-catRank(b)).forEach(cat=>{
      byCat[cat].sort((a,b)=>a.prio-b.prio
        || ((a.isSpouse&&b.isSpouse) ? (yrNum(a.r.start_date)-yrNum(b.r.start_date) || mfRank(a.r.note)-mfRank(b.r.note)) : 0)   // 配偶按婚年→名分排先后
        || (gk(genOf(a.op.id))-gk(genOf(b.op.id))) || (a.op.sort_order||0)-(b.op.sort_order||0));
      const spTotal=byCat[cat].filter(x=>x.isSpouse).length; let spIdx=0;                       // 多配偶才显示先后编号
      rh+=`<div class="rel-cat">${esc(cat)}</div>`;
      byCat[cat].forEach(it=>{
        let ord="";
        if(it.isSpouse && spTotal>1){ spIdx++; const o="①②③④⑤⑥⑦⑧⑨"[spIdx-1]||("("+spIdx+")"); ord=`<span style="color:#8e44ad;font-weight:700;margin-right:.15rem" title="配偶先后(按婚年/名分)">${o}</span>`; }
        const yr=(it.isSpouse&&it.r.start_date)?`<span class="hint" style="margin-left:.3rem">婚 ${esc(it.r.start_date)}</span>`:"";
        const note=it.r.note?esc(it.r.note):(it.isSpouse&&spTotal>1?'<span class="hint">未注原配/续娶</span>':"");
        rh+=`<div class="rel-row"><span class="reltag" style="border-color:${esc(it.color||'#cbd5e1')};color:${esc(it.color||'#475569')}">${esc(it.lab)}</span>${ord}<a class="plink rel-who" data-pid="${esc(it.op.id)}">${esc(it.op.name||'(无名)')}</a><span class="rel-note">${note}</span>${yr}${state.canEdit?`<span class="rel-act"><button class="btn btn-sm relnote" data-rid="${it.r.id}"${it.isSpouse?' data-spouse="1"':""} title="${it.isSpouse?'改名分/婚年':'改备注'}">改</button><button class="btn btn-sm reldel" data-rid="${it.r.id}" title="删除">✕</button></span>`:""}</div>`;
      });
    });
  } else rh=`<div class="hint">(暂无关系,点「+ 加关系」)</div>`;
  // 原始记载/待考 折叠进关系区(尚未转成边的旧文本)
  let pending="";
  if(!state.fatherOf[p.id] && p.father_note) pending+=`<div class="rel-pending">父系待考:${esc(p.father_note)} <span class="hint">线索,待补父子关系</span></div>`;
  if(p.mother) pending+=`<div class="rel-pending">母(原始记载):${esc(p.mother)} <span class="hint">待整理为母子关系</span></div>`;
  if(p.spouse) pending+=`<div class="rel-pending">配偶(原始记载):${esc(p.spouse)} ${state.canEdit?`<button class="btn btn-sm" id="spConvDetail">整理为配偶</button>`:`<span class="hint">待整理</span>`}</div>`;
  const addForm = state.canEdit ? `<div class="relquick" id="relAddForm" style="display:none"><input id="dq_search" placeholder="🔍 筛选姓名/字号/ID" style="width:8.5em;margin-right:.2rem"><select id="dq_to"></select><span id="dqNewWrap" style="display:none">姓名 <input id="dq_newname" placeholder="新人物姓名" style="width:7em"> <select id="dq_newsex"><option value="">性别</option><option>男</option><option>女</option></select></span> 是 <b>${esc(p.name||"本人")}</b> 的 <select id="dq_type"></select> <input id="dq_note" placeholder="备注(可空,如 原配/续娶)" style="width:9em"> <button class="btn btn-sm btn-primary" id="dq_add">加</button> <span class="hint" id="dq_msg"></span></div>` : "";
  html+=`<div class="dsec"><div class="dsec-h">关系网(${rels.length}) <button class="btn btn-sm" id="relEgoBtn">🎯 关系圈</button>${state.canEdit?` <button class="btn btn-sm" id="relAddToggle">+ 加关系</button>`:""}</div>${pending}${addForm}<div class="rel-list">${rh}</div></div>`;
  box.innerHTML=html;
  box.querySelectorAll(".plink").forEach(a=>a.onclick=()=>{ const t=byId(a.dataset.pid); if(t) openDetail(t); });
  { const open=()=>openLightbox(gallery, mainIdx);
    const av=box.querySelector("img.dphoto"); if(av && gallery.length){ av.style.cursor="zoom-in"; av.onclick=open; }
    const cc=box.querySelector(".dphoto-count"); if(cc) cc.onclick=open; }
  { const eb=$("#relEgoBtn"); if(eb) eb.onclick=()=>{ state.graphCenter=p.id; state.pathA=""; state.pathB=""; closeDetail(); switchView("graph"); }; }
  { const sb=$("#spConvDetail"); if(sb) sb.onclick=()=>{ closeDetail(); openSpouseConverter(p.id); }; }
  box.querySelectorAll(".reldel").forEach(b=>b.onclick=async()=>{ if(!confirm("删除这条关系?(直接删除,不可恢复;人物本身不受影响)"))return; try{ await window.REL.del(+b.dataset.rid); await reloadPersons(); await refreshRelCount(); openDetail(byId(p.id)); }catch(e){ alert("删除失败:"+e.message); } });
  box.querySelectorAll(".relnote").forEach(b=>b.onclick=async()=>{ const rid=+b.dataset.rid, r=rels.find(x=>String(x.id)===b.dataset.rid)||{};
    if(b.dataset.spouse==="1"){   // 配偶:同时改名分(原配/续娶/侧室)+婚配年,以记录先后
      const nv=prompt("名分(原配/续娶/侧室,可空):", r.note||""); if(nv===null)return;
      const yv=prompt("婚配年(如 1998,用于排先后,可空):", r.start_date||""); if(yv===null)return;
      try{ await window.REL.update(rid,{note:nv.trim(),start_date:yv.trim()}); openDetail(byId(p.id)); }catch(e){ alert("失败:"+e.message); }
    } else { const nv=prompt("关系备注:", r.note||""); if(nv===null)return; try{ await window.REL.update(rid,{note:nv.trim()}); openDetail(byId(p.id)); }catch(e){ alert("失败:"+e.message); } } });
  const tgl=$("#relAddToggle");
  const fillDqTo=q=>{ const dto=$("#dq_to"); if(dto) dto.innerHTML=`<option value="">— 选已有人物 —</option><option value="__new__">➕ 新建人物并连上…</option>`+personOptions("",q); };
  if(tgl) tgl.onclick=()=>{ const f=$("#relAddForm"); const show=f.style.display==="none"; f.style.display=show?"":"none";
    if(show){ const se=$("#dq_search"); if(se)se.value=""; fillDqTo(""); $("#dq_type").innerHTML=relOptionsHtml(); const dn=$("#dqNewWrap"); if(dn)dn.style.display="none"; if(se)se.focus(); } };
  { const se=$("#dq_search"); if(se) se.oninput=()=>fillDqTo(se.value); }   // 输入即筛选下拉(人多时用)
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
      let coRes={};
      if(type==="father"||type==="mother") coRes=(await maybeLinkCoParent(from,to,type))||{};  // 夫妻↔子女联动:补另一方父母
      else if(type==="spouse") await maybeSuggestSpouseCoParent(from,to);            // 加配偶→建议补录其已有子女
      const oname=((byId(other)||{}).name)||($("#dq_newname")&&$("#dq_newname").value.trim())||other;
      await reloadPersons(); await refreshRelCount(); await openDetail(byId(p.id));
      const t=$("#relAddToggle"); if(t) t.click();                                  // 重新展开,连续录入
      const m=$("#dq_msg"); if(m) m.textContent="已加:"+oname+" ✓"+(coRes.failMsg?(" ⚠ "+coRes.failMsg):"")+" 可继续添加下一条";
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

/* ---------- 自动联动:夫妻 ↔ 子女(另一方父母边)----------
   本谱多见原配/续娶/侧室,生母/继母不能瞎认。fail-closed 铁律:只有「唯一确定」才自动,稍有不确定一律转人审。规则:
   ① 加孩子→该家长只有 1 个【可见 + 已知对侧性别】配偶、且无已软删/性别未知的配偶把数目搅浑,才自动建另一方父母边;否则弹窗让人选,绝不静默乱挂。
   ② 加配偶→伴侣若已有子女,只「建议」补录(默认不勾,防继父母误挂;已有同角色父母的标「可能继子女」)。
   ③ 存量回填见数据体检 ⑨。机器建的边均 note 标注「据父母婚姻推定」、入操作历史可一键撤销。 */
const COPARENT_TAG = "据父母婚姻推定";
const isDup = e => /duplicate|unique/i.test((e&&e.message)||"");        // 唯一索引冲突=幂等,不算失败
// 某家长全部配偶对端 id(含已软删/悬空者——它们仍在 relationships 表,只是 byId 查不到)
function spouseEndpointIds(parentId, edges){
  const out=[]; edges.forEach(r=>{ if(r.type!=="spouse")return; if(r.from_id===parentId)out.push(r.to_id); else if(r.to_id===parentId)out.push(r.from_id); }); return out;
}
// fail-closed 决策:唯一「可能的另一方父母」必须【可见 + 已知对侧性别】、且无悬空(软删)/性别未知配偶搅浑,才判 auto。
//  悬空配偶 → 真实配偶数不确定 → 不 auto(防多妻塌缩成单妻误挂);性别未知 → 可能正是另一方父母 → 不 auto(与「性别未知不猜」一致)。
//  返回 { mode:'auto'|'prompt'|'skip', autoId, visibleIds, hasHidden }
function coParentDecision(spouseIds, otherType){
  const wantSex = otherType==="mother" ? "女" : "男";
  const oppKnown = otherType==="mother" ? "男" : "女";
  const links = spouseIds.map(id=>({ id, p:byId(id) }));
  const hasHidden = links.some(l=>!l.p);                                  // 悬空/软删
  const possible = links.filter(l=> !l.p || l.p.sex!==oppKnown );         // 可能的另一方父母(排除「已知相反性别」)
  const knownRight = possible.filter(l=> l.p && l.p.sex===wantSex );
  const visibleIds = possible.filter(l=>l.p).map(l=>l.id);
  if(!hasHidden && possible.length===1 && knownRight.length===1) return { mode:"auto", autoId:knownRight[0].id, visibleIds, hasHidden };
  return { mode: visibleIds.length ? "prompt" : "skip", visibleIds, hasHidden };
}
// 给孩子补「另一方父母」边。返回 {failMsg} 供调用方拼到提示(auto 成功无 failMsg;duplicate 视为成功)。
async function maybeLinkCoParent(parentId, childId, parentEdgeType){
  if(!state.canEdit) return {};
  let edges; try{ edges=await window.REL.all(); }catch(e){ return {}; }
  const otherType = parentEdgeType==="father" ? "mother" : "father";
  if(edges.some(r=>r.type===otherType && r.to_id===childId)) return {};        // 已有另一方父母,不覆盖
  const ids=spouseEndpointIds(parentId, edges); if(!ids.length) return {};
  const dec=coParentDecision(ids, otherType);
  if(dec.mode==="auto"){
    try{ await window.REL.add({ from_id:dec.autoId, to_id:childId, type:otherType, note:COPARENT_TAG }); return {}; }
    catch(e){ return isDup(e)?{}:{ failMsg:"另一方父母边建立失败:"+e.message+"(请在详情页手工补)" }; }
  }
  if(dec.mode==="prompt"){
    const cands=dec.visibleIds.map(id=>{ const p=byId(id)||{}; const e=edges.find(r=>r.type==="spouse"&&((r.from_id===id&&r.to_id===parentId)||(r.to_id===id&&r.from_id===parentId))); return { id, name:p.name, sex:p.sex, role:(e&&e.note)||"", year:(e&&e.start_date)||"" }; });
    await pickCoParent(cands, parentId, childId, otherType, dec.hasHidden);
  }
  return {};                                                                  // skip:无可见候选(只剩软删配偶)→ 静默不挂
}
// 多/不确定配偶裁决弹窗(Promise:用户选一位或「暂不」)。默认「暂不」——不替用户猜生母。真失败显示在弹窗内不静默吞。
function pickCoParent(cands, parentId, childId, otherType, hasHidden){
  return new Promise(resolve=>{
    let mask=$("#coparentMask"); if(!mask){ mask=el("div","mask"); mask.id="coparentMask"; document.body.appendChild(mask); }
    const child=byId(childId), parent=byId(parentId), role=otherType==="mother"?"生母":"生父";
    const rows=cands.map(c=>`<label class="mergerow"><input type="radio" name="cppick" value="${esc(c.id)}"> <b>${esc(c.name||"(无名)")}</b> <span class="hint">${esc(c.id)}${c.sex?" · "+esc(c.sex):""}${c.role?" · "+esc(c.role):""}${c.year?" · 婚 "+esc(c.year):""}</span></label>`).join("");
    mask.innerHTML=`<div class="modal" style="width:min(520px,100%)">
      <h2>选择「${esc((child&&child.name)||"")}」的${role}</h2>
      <p class="hint">${esc((parent&&parent.name)||"")} 有多位/不确定的配偶,系统不替你猜是谁。选一位(选错可在详情页删除该关系),或暂不指定、留待手工。</p>
      ${hasHidden?`<p class="hint" style="color:#c0392b">注意:该家长还有已移入回收站的配偶,真实配偶可能不止下列,请谨慎。</p>`:""}
      ${rows}
      <label class="mergerow"><input type="radio" name="cppick" value="" checked> 暂不指定(留待手工)</label>
      <div class="err" id="cpErr"></div>
      <div class="modal-foot"><span class="spacer"></span><button class="btn" id="cpCancel">跳过</button><button class="btn btn-primary" id="cpOk">确定</button></div>
    </div>`;
    mask.classList.add("open");
    const done=()=>{ mask.classList.remove("open"); resolve(); };
    $("#cpCancel").onclick=done; mask.onclick=e=>{ if(e.target===mask) done(); };
    $("#cpOk").onclick=async()=>{
      const v=((mask.querySelector("input[name=cppick]:checked"))||{}).value||"";
      if(v){ const c=cands.find(x=>x.id===v);
        try{ await window.REL.add({ from_id:v, to_id:childId, type:otherType, note:COPARENT_TAG+(c&&c.role?"·"+c.role:"") }); }
        catch(e){ if(!isDup(e)){ $("#cpErr").textContent="建立失败:"+e.message; return; } } }
      done();
    };
  });
}
// 新建夫妻边后:伴侣若已有子女且这位配偶尚未连上→建议补录(默认不勾,防继父母误挂)。性别未知不猜父/母。
async function maybeSuggestSpouseCoParent(aId, bId){
  if(!state.canEdit) return;
  let edges; try{ edges=await window.REL.all(); }catch(e){ return; }
  const rows=[];
  const gather=(parentId, spouseId)=>{
    const sp=byId(spouseId); const spType= sp&&sp.sex==="男"?"father":(sp&&sp.sex==="女"?"mother":null);
    if(!spType) return;
    const already=new Set(edges.filter(r=>r.type===spType && r.from_id===spouseId).map(r=>r.to_id));
    edges.filter(r=>(r.type==="father"||r.type==="mother") && r.from_id===parentId).forEach(r=>{
      if(already.has(r.to_id) || !byId(r.to_id)) return;
      const prior=edges.find(x=>x.type===spType && x.to_id===r.to_id && x.from_id!==spouseId);   // 已有同角色父母=可能继子女
      rows.push({ spouseId, spType, child:byId(r.to_id), priorName: prior?((byId(prior.from_id)||{}).name||"已有"):"" });
    });
  };
  gather(aId,bId); gather(bId,aId);
  if(!rows.length) return;
  await suggestSpouseChildren(rows);
}
function suggestSpouseChildren(rows){
  return new Promise(resolve=>{
    let mask=$("#spkidMask"); if(!mask){ mask=el("div","mask"); mask.id="spkidMask"; document.body.appendChild(mask); }
    const list=rows.map((r,i)=>{ const role=r.spType==="mother"?"生母":"生父"; const sp=byId(r.spouseId);
      const warn=r.priorName?` <span class="hint" style="color:#c0392b">已有${r.spType==="mother"?"母":"父"}:${esc(r.priorName)},可能是继子女</span>`:"";
      return `<label class="mergerow"><input type="checkbox" class="spk" data-i="${i}"> 把 <b>${esc((sp&&sp.name)||"")}</b> 设为 <b>${esc(r.child.name||"(无名)")}</b> 的${role} <span class="hint">第${genStr(r.child.id)}代</span>${warn}</label>`; }).join("");
    mask.innerHTML=`<div class="modal" style="width:min(560px,100%)">
      <h2>是否补录为子女的父母?</h2>
      <p class="hint">配偶的另一方已有子女。<b>仅当确为亲生父母才勾选</b>——续娶/再婚的继父母请留空。默认不勾。</p>
      <div style="max-height:50vh;overflow:auto">${list}</div>
      <div class="err" id="spkErr"></div>
      <div class="modal-foot"><span class="spacer"></span><button class="btn" id="spkCancel">跳过</button><button class="btn btn-primary" id="spkOk">建立所选关系</button></div>
    </div>`;
    mask.classList.add("open");
    const done=()=>{ mask.classList.remove("open"); resolve(); };
    $("#spkCancel").onclick=done; mask.onclick=e=>{ if(e.target===mask) done(); };
    $("#spkOk").onclick=async()=>{
      const picks=[...mask.querySelectorAll(".spk:checked")].map(c=>rows[+c.dataset.i]); const fails=[];
      for(const r of picks){ try{ await window.REL.add({ from_id:r.spouseId, to_id:r.child.id, type:r.spType, note:"据婚姻补录" }); }catch(e){ if(!isDup(e)) fails.push((r.child.name||r.child.id)+":"+e.message); } }
      if(fails.length){ $("#spkErr").textContent=fails.length+" 条失败:"+fails.join("; "); return; }
      done();
    };
  });
}
// 存量回填草稿:孩子有父无母(或有母无父)、且经 fail-closed 判定该家长唯一确定的另一方父母 → 草稿。多配偶/有软删配偶/性别未知不入列(需手工)。
function backfillCoParentDrafts(){
  const F=state.fatherOf, M=state.motherOf, S=state.spouseOf, out=[];
  state.persons.forEach(c=>{ if(c.deleted) return;
    const scan=(parentId, otherType)=>{ const dec=coParentDecision(S[parentId]||[], otherType);
      if(dec.mode==="auto"){ const cp=byId(dec.autoId); if(cp) out.push({ child:c, parentId, otherType, coParent:cp }); } };
    if(F[c.id] && !M[c.id]) scan(F[c.id], "mother");
    if(M[c.id] && !F[c.id]) scan(M[c.id], "father");
  });
  return out;
}
function openBackfillDialog(){
  const drafts=backfillCoParentDrafts();
  let mask=$("#backfillMask"); if(!mask){ mask=el("div","mask"); mask.id="backfillMask"; document.body.appendChild(mask); }
  if(!drafts.length){
    mask.innerHTML=`<div class="modal" style="width:min(520px,100%)"><h2>回填另一方父母边</h2><p class="hint">没有可回填项(无「家长唯一确定1个对侧配偶、孩子却缺另一方父母边」的情形)。</p><div class="modal-foot"><span class="spacer"></span><button class="btn btn-primary" id="bfClose">关闭</button></div></div>`;
    mask.classList.add("open"); $("#bfClose").onclick=()=>mask.classList.remove("open"); return;
  }
  const rows=drafts.map((d,i)=>{ const role=d.otherType==="mother"?"母":"父"; const parent=byId(d.parentId);
    return `<label class="mergerow"><input type="checkbox" class="bf" data-i="${i}" checked> <b>${esc(d.child.name||"(无名)")}</b> 的${role} ← <b>${esc(d.coParent.name||"(无名)")}</b> <span class="hint">(${esc((parent&&parent.name)||"")} 的唯一配偶)</span></label>`; }).join("");
  mask.innerHTML=`<div class="modal" style="width:min(620px,100%)">
    <h2>回填另一方父母边 <span class="pill pill-info">${drafts.length}</span></h2>
    <p class="hint">下列孩子只连了一方家长,而该家长<b>唯一确定只有 1 个对侧配偶</b>,据此推定另一方父母。逐条核对,取消勾选不对的,再建立。多配偶/有已删配偶/性别未知的孩子不在此列(需手工指定生母/生父)。建立后可在操作历史或详情页撤销。</p>
    <div style="max-height:50vh;overflow:auto">${rows}</div>
    <div class="err" id="bfErr"></div>
    <div class="modal-foot"><label class="hint"><input type="checkbox" id="bfAll" checked> 全选</label><span class="spacer"></span><button class="btn" id="bfCancel">取消</button><button class="btn btn-primary" id="bfOk">建立所选</button></div>
  </div>`;
  mask.classList.add("open");
  $("#bfCancel").onclick=()=>mask.classList.remove("open"); mask.onclick=e=>{ if(e.target===mask) mask.classList.remove("open"); };
  $("#bfAll").onclick=e=>{ mask.querySelectorAll(".bf").forEach(c=>c.checked=e.target.checked); };
  $("#bfOk").onclick=async()=>{
    const picks=[...mask.querySelectorAll(".bf:checked")].map(c=>drafts[+c.dataset.i]);
    if(!picks.length){ mask.classList.remove("open"); return; }
    $("#bfOk").disabled=true; $("#bfOk").textContent="建立中…";
    let ok=0; const fails=[];
    for(const d of picks){ try{ await window.REL.add({ from_id:d.coParent.id, to_id:d.child.id, type:d.otherType, note:COPARENT_TAG }); ok++; }catch(e){ if(isDup(e)) ok++; else fails.push((d.child.name||d.child.id)+":"+e.message); } }
    mask.classList.remove("open"); await reloadPersons(); await refreshRelCount(); renderHeader(); renderPeople(); renderHealth();
    if(fails.length) alert("已建立 "+ok+" 条,失败 "+fails.length+" 条:\n"+fails.join("\n"));
  };
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
  const v=p||Object.assign({status:"待考",alive:"是"},prefill||{});   // 新建默认在世=是(prefill 可覆盖)
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
  $("#charGenHint").textContent=""; const _bh=$("#birthHint"); if(_bh)_bh.textContent=""; charGenAuto(); initRelAuto(); toggleDeathFields();
  $("#mask").classList.add("open");
  if(!p) setTimeout(()=>{ const n=$("#f_name"); if(n) n.focus(); }, 60);
}
function closeModal(){ $("#mask").classList.remove("open"); state.editing=null; }
// 卒/葬字段仅在「在世=否」时显示(是/空=隐藏);随 f_alive 切换
function toggleDeathFields(){ const dead=$("#f_alive")&&$("#f_alive").value==="否"; document.querySelectorAll(".death-field").forEach(e=>{ e.style.display=dead?"":"none"; }); }

function collectForm(){ const d={}; FORM_KEYS.forEach(k=>{ const f=$("#f_"+k); if(f) d[k]=f.value.trim(); }); return d; }  // 父亲改走关系边,不再写 father_id 列
// 对账父亲:表单选的父 与 当前 father 边 不同则 删旧边+建新边(单一真源=关系图)
async function reconcileFatherEdge(childId, newFatherId){
  newFatherId=(newFatherId||"").trim();
  const cur=state.fatherOf[childId]||"";
  if(newFatherId===cur || newFatherId===childId) return;
  try{   // 不再静默吞错:删旧父边(已存 before 可撤销)+ 建新父边,任一失败都冒泡给 saveModal 显示,避免"删了旧的、新的没建上"静默丢父子关系
    if(cur){ const edges=await window.REL.of(childId); const old=edges.find(r=>r.type==="father"&&r.to_id===childId); if(old) await window.REL.del(old.id); }
    if(newFatherId){ await window.REL.add({from_id:newFatherId,to_id:childId,type:"father"}); }
  }catch(e){ throw new Error("父子关系更新失败("+(e.message||e)+");其余字段已保存,可重试或到详情页改父亲"); }
}
async function saveModal(){
  const d=collectForm(); const fsel=$("#f_father_id").value;
  if(!d.name){ $("#modalErr").textContent="请先填姓名(姓名必填)"; const n=$("#f_name"); if(n) n.focus(); return; }
  try{
    if(state.editing){
      await api("PUT","/api/persons/"+encodeURIComponent(state.editing),d);
      await reconcileFatherEdge(state.editing, fsel);
      closeModal(); await reloadPersons(); await refreshRelCount(); renderHeader(); renderPeople();
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
          try{ await window.REL.add({from_id:from,to_id:to,type});
            let coRes={};
            if(type==="father"||type==="mother") coRes=(await maybeLinkCoParent(from,to,type))||{};   // 夫妻↔子女联动
            else if(type==="spouse") await maybeSuggestSpouseCoParent(from,to);
            const tn=(state.relTypes.find(t=>t.type===type)||{}).label_zh||type; extra=" 已与「"+(((byId(rp)||{}).name)||rp)+"」建立「"+tn+"」关系。"+(coRes.failMsg?(" ⚠ "+coRes.failMsg):""); }
          catch(e){ extra=" (关系建立失败:"+(/duplicate|unique/i.test(e.message)?"该关系已存在":e.message)+")"; } }
      }
      $("#initRelWrap").style.display="none"; $("#idField").style.display="";
      await reloadPersons(); await refreshRelCount(); renderHeader(); renderPeople();
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
  try{ await api("DELETE","/api/persons/"+encodeURIComponent(state.editing)); closeModal(); await reloadPersons(); renderHeader(); renderPeople(); }
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
    await renderMedia(state.editing); await reloadPersons(); renderPeople();
  }catch(e){ $("#modalErr").textContent="上传失败:"+e.message; }
}

/* ---------- 关系(通用人际关系):列表 + 增改删 ---------- */
function personOptions(sel, q){
  q=(q||"").trim().toLowerCase();
  let list=state.persons.filter(p=>!p.deleted);
  if(q) list=list.filter(p=>((p.name||"")+" "+(p.alias||"")+" "+p.id).toLowerCase().includes(q));   // 按 姓名/字号/ID 筛
  list=list.sort((a,b)=>(parseInt(a.gen)||0)-(parseInt(b.gen)||0)||(a.sort_order||0)-(b.sort_order||0)).slice(0,300);
  return list.map(p=>`<option value="${esc(p.id)}"${p.id===sel?" selected":""}>${esc(p.name||"(无名)")}${p.alias?(" 字"+esc(p.alias)):""} — ${esc(p.id)}</option>`).join("");
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
  const gs=$("#gc_search"); if(gs) gs.value="";
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
  if(!state.graphTypesOff) state.graphTypesOff=new Set();   // 被点掉(隐藏)的关系类型
  const edges=rels.filter(r=>idset.has(r.from_id)&&idset.has(r.to_id)&&!state.graphTypesOff.has(r.type));   // 按图例勾选筛选:隐藏的类型不参与图/局部圈/关系链
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
      itemStyle:{ color:p.alive==="是"?"#10b981":(p.alive==="否"?"#64748b":"#f59e0b"), opacity:dimNode(p.id)?0.18:1, borderColor:isCenter?"#dc2626":(onPath?"#f59e0b":"transparent"), borderWidth:(isCenter||onPath)?3:0 },
      label:{ show: !pathSet || onPath } };
  });
  const nodeIds=new Set(nodes.map(n=>n.id));
  const links=edges.filter(r=>nodeIds.has(r.from_id)&&nodeIds.has(r.to_id)).map(r=>{ const t=tmap[r.type]||{}, onP=!!(pathEdge&&pathEdge.has(r.from_id+"|"+r.to_id));
    return { source:r.from_id, target:r.to_id, value:t.label_zh||r.type,
      lineStyle:{color:onP?"#f59e0b":(t.color||"#94a3b8"),width:onP?4:1.5,curveness:0.06,opacity:pathSet?(onP?1:0.1):0.72}, symbol:r.directed?["none","arrow"]:["none","none"], symbolSize:onP?10:7 }; });
  const legend=$("#graphLegend"); if(legend){
    legend.innerHTML=`<span class="leg"><i style="background:#10b981;width:10px;height:10px;border-radius:50%"></i>在世</span><span class="leg"><i style="background:#64748b;width:10px;height:10px;border-radius:50%"></i>已故</span><span class="leg"><i style="background:#f59e0b;width:10px;height:10px;border-radius:50%"></i>未知</span>`
      +(state.graphCenter?`<span class="leg" style="color:#dc2626">● 中心(${esc((byId(state.graphCenter)||{}).name||"")}/${state.graphHops}跳)</span>`:"")
      +`<span class="hint" style="margin-left:.4rem">关系(点击筛选):</span>`
      +types.map(t=>{ const off=state.graphTypesOff.has(t.type); return `<span class="leg legtype" data-rt="${esc(t.type)}" title="点击 显示/隐藏「${esc(t.label_zh)}」" style="cursor:pointer;user-select:none;${off?"opacity:.35;text-decoration:line-through":""}"><i style="background:${esc(t.color)}"></i>${esc(t.label_zh)}</span>`; }).join("")
      +(state.graphTypesOff.size?` <button class="btn btn-sm" id="legAllOn">全部显示</button>`:"");
    legend.querySelectorAll(".legtype").forEach(s=>s.onclick=()=>{ const rt=s.dataset.rt; if(state.graphTypesOff.has(rt)) state.graphTypesOff.delete(rt); else state.graphTypesOff.add(rt); renderGraph(); });
    { const a=legend.querySelector("#legAllOn"); if(a) a.onclick=()=>{ state.graphTypesOff.clear(); renderGraph(); }; }
  }
  box.innerHTML=""; box.style.height="66vh";
  if(_graphChart){ try{_graphChart.dispose();}catch(e){} }
  _graphChart=echarts.init(box);
  _graphChart.setOption({
    tooltip:{ formatter:pp=> pp.dataType==="edge" ? esc(pp.data.value) : "<b>"+esc(pp.data.name)+"</b><br>"+esc(pp.data.value) },
    series:[{ type:"graph", layout:"force", roam:true, draggable:true, force:{repulsion:260,edgeLength:110,gravity:0.08},
      label:{show:true,position:"right",fontSize:11,fontFamily:'"PingFang SC","Noto Sans SC",sans-serif',color:"#0f172a"},
      edgeLabel:{show:true, formatter:pp=>pp.data.value, fontSize:10, color:"#64748b", backgroundColor:"rgba(255,255,255,.7)", padding:[1,2], borderRadius:3},  // 连线上显示关系称谓
      emphasis:{focus:"adjacency",lineStyle:{width:4},edgeLabel:{fontSize:12,color:"#0f172a"}}, lineStyle:{color:"#94a3b8"}, data:nodes, links:links }]
  });
  _graphChart.on("click", pp=>{ if(pp.dataType==="node"){ const t=byId(pp.data.id); if(t) openDetail(t); } });
}
window.addEventListener("resize", ()=>{ const v=document.getElementById("view-graph"); if(_graphChart&&v&&v.classList.contains("active")) _graphChart.resize(); });

/* ---------- 名册:全部人员表格 · 列可配置 · 可排序 · 点行编辑 ---------- */
const ROSTER_COLS = [
  {k:"name",label:"姓名"},{k:"gen",label:"世代"},{k:"char_gen",label:"字辈"},
  {k:"sex",label:"性别"},{k:"alive",label:"在世"},{k:"rel_count",label:"关系数"},{k:"lineage",label:"族谱"},
  {k:"birth",label:"出生日期"},{k:"birth_lunar",label:"农历生"},{k:"birth_time",label:"出生时间"},{k:"death",label:"卒年"},
  {k:"birth_place",label:"出生地"},{k:"occupation",label:"学历/职业"},{k:"company",label:"公司"},{k:"residence",label:"居地"},{k:"burial",label:"葬地"},
  {k:"spouse",label:"配偶(原始记载)"},{k:"contact",label:"联系方式"},{k:"address",label:"住址"},
  {k:"status",label:"状态"},{k:"note",label:"备注"},{k:"id",label:"ID"}
];
const ROSTER_DEFAULT = ["name","gen","char_gen","sex","alive","birth","death","occupation","company","lineage"];
function rosterCols(){ try{ const s=JSON.parse(localStorage.getItem("roster_cols")||"null"); if(Array.isArray(s)&&s.length) return s; }catch(e){} return ROSTER_DEFAULT.slice(); }
let _rosterSort={k:"gen",dir:1}, _colpickOpen=false;
/* ---------- 搜索历史(最近搜索词,存本地 localStorage)---------- */
function recentSearches(){ try{ const a=JSON.parse(localStorage.getItem("search_recent")||"[]"); return Array.isArray(a)?a.filter(x=>typeof x==="string"&&x.trim()).slice(0,12):[]; }catch(e){ return []; } }
function pushRecentSearch(term){ term=(term||"").trim(); if(term.length<1) return; try{ const a=recentSearches().filter(x=>x!==term); a.unshift(term); localStorage.setItem("search_recent", JSON.stringify(a.slice(0,12))); }catch(e){} }
function clearRecentSearches(){ try{ localStorage.removeItem("search_recent"); }catch(e){} }
let _searchRecTimer=null;
function recordSearchDebounced(){ clearTimeout(_searchRecTimer); _searchRecTimer=setTimeout(()=>{ pushRecentSearch(state.q); }, 1200); }   // 停止输入 1.2s 后记一条(避免记下半截词)
function cellVal(p,k){
  if(k==="birth_lunar"){ const bl=(p.birth_lunar||"").trim(), sx=shengXiaoLabel(p); return bl?(sx?bl+" "+sx:bl):(sx||""); }   // 农历列附属相(缺则按年补)
  return k==="rel_count"?(state.relCount[p.id]||0):(k==="gen"?(genOf(p.id)??""):(k==="lineage"?familiesOf(p.id).join(" / "):(p[k]==null?"":p[k]))); }
function renderRoster(list){   // list 由 renderPeople 传入(已搜索+筛选);本函数只管 列设置 / 排序 / 表格
  const box=$("#rosterBox"); if(!box) return;
  const colset=new Set(rosterCols());
  const orderedCols=ROSTER_COLS.filter(c=>colset.has(c.k));
  const sk=_rosterSort.k, dir=_rosterSort.dir;
  list=(list||peopleFiltered()).slice().sort((a,b)=>{ let va,vb; if(sk==="gen"){va=gk(genOf(a.id));vb=gk(genOf(b.id));} else if(sk==="rel_count"){va=state.relCount[a.id]||0;vb=state.relCount[b.id]||0;} else if(sk==="lineage"){va=familiesOf(a.id).join("/");vb=familiesOf(b.id).join("/");} else {va=(a[sk]??"")+"";vb=(b[sk]??"")+"";}
    return va<vb?-dir:va>vb?dir:0; });
  const picker=`<details class="colpick"${_colpickOpen?" open":""}><summary>列设置(${colset.size} 列)</summary><div class="colgrid">`
    + ROSTER_COLS.map(c=>`<label><input type="checkbox" data-col="${c.k}"${colset.has(c.k)?" checked":""}> ${esc(c.label)}</label>`).join("") + `</div></details>`;
  const bar=`<div class="rosterbar">${picker}<span class="hint">点表头排序 · 点一行${state.canEdit?"看详情/编辑":"看详情"}</span></div>`;
  const thead="<tr>"+orderedCols.map(c=>`<th data-sk="${c.k}">${esc(c.label)}${sk===c.k?(dir>0?" ▲":" ▼"):""}</th>`).join("")+"</tr>";
  const rows=list.map(p=>`<tr data-pid="${esc(p.id)}">`+orderedCols.map(c=>`<td>${esc(String(cellVal(p,c.k)))}</td>`).join("")+`</tr>`).join("");
  box.innerHTML=bar+`<div class="rostertable"><table class="roster"><thead>${thead}</thead><tbody>${rows||""}</tbody></table></div>`;
  const dt=box.querySelector(".colpick"); if(dt) dt.ontoggle=e=>{ _colpickOpen=e.target.open; };
  box.querySelectorAll(".colpick input[type=checkbox]").forEach(cb=>cb.onchange=()=>{
    const cur=new Set(rosterCols()); cb.checked?cur.add(cb.dataset.col):cur.delete(cb.dataset.col);
    localStorage.setItem("roster_cols", JSON.stringify(ROSTER_COLS.filter(c=>cur.has(c.k)).map(c=>c.k))); renderRoster(peopleFiltered()); });
  box.querySelectorAll("th[data-sk]").forEach(th=>th.onclick=()=>{ const k=th.dataset.sk; _rosterSort=(sk===k)?{k,dir:-dir}:{k,dir:1}; renderRoster(peopleFiltered()); });
  box.querySelectorAll("tbody tr").forEach(tr=>tr.onclick=()=>{ const p=byId(tr.dataset.pid); if(p) openDetail(p); });   // 点行看详情(含关系列表),编辑走详情里「编辑」
}

/* ---------- 家族树:两种排版(传统谱图 / 自动树图)切换 ---------- */
function renderTreeView(){
  const mode = state.treeMode || (state.treeMode = (localStorage.getItem("tree_mode") || "classic"));
  const bar = $("#treeModeBar");
  if(bar){
    bar.innerHTML = [["classic","📜 传统谱图"],["mermaid","🌳 自动树图"]]
      .map(([v,l])=>`<button class="btn btn-sm${mode===v?" btn-primary":""}" data-tm="${v}">${l}</button>`).join("");
    bar.querySelectorAll("[data-tm]").forEach(b=>b.onclick=()=>{ state.treeMode=b.dataset.tm; try{localStorage.setItem("tree_mode",b.dataset.tm);}catch(e){} renderTreeView(); });
  }
  const note=$("#treeMermaidNote"); if(note) note.style.display=(mode==="mermaid")?"":"none";
  if(mode==="classic"){ if(window.renderClassicTree) window.renderClassicTree(); else { const b=$("#treeBox"); if(b) b.textContent="传统谱图模块加载中…(请稍候或刷新)"; } }
  else renderTree();
}

/* ---------- 标签切换 ---------- */
function switchView(name){
  if(name==="overview") name="roster";   // 世系总览已并入名册;旧链接/书签兼容
  document.querySelectorAll(".tab").forEach(t=>t.classList.toggle("active",t.dataset.view===name));
  document.querySelectorAll(".view").forEach(v=>v.classList.remove("active"));
  $("#view-"+name).classList.add("active");
  if(location.hash!=="#"+name) location.hash=name;
  if(name==="tree") renderTreeView();
  if(name==="graph") renderGraph();
  if(name==="roster") renderPeople();
  if(name==="families") renderFamilies();
  if(name==="trash") renderTrash();
  if(name==="health") renderHealth();
  if(name==="log"){ renderBackup(); renderLog(); }
}
document.querySelectorAll(".tab").forEach(t=>t.onclick=()=>switchView(t.dataset.view));
// 顶栏搜索已并入名册视图内的共用筛选条(renderPeopleFilter);此处不再绑定
$("#shareMode").onchange=e=>{ state.share=e.target.checked; renderPeople(); };
$("#addBtn").onclick=()=>openEdit(null);
$("#saveBtn").onclick=saveModal;
$("#delBtn").onclick=delModal;
$("#cancelBtn").onclick=closeModal;
$("#reTree").onclick=renderTree;
$("#gc_center")&&($("#gc_center").onchange=e=>{ state.graphCenter=e.target.value; renderGraph(); });
$("#gc_search")&&($("#gc_search").oninput=e=>{ const s=$("#gc_center"); if(s){ const cur=s.value; s.innerHTML=`<option value="">—</option>`+personOptions(cur, e.target.value); s.value=cur; } });   // 中心选择器可搜索(人多)
$("#gc_hops")&&($("#gc_hops").onchange=e=>{ state.graphHops=+e.target.value||2; renderGraph(); });
$("#gc_pathA")&&($("#gc_pathA").onchange=e=>{ state.pathA=e.target.value; renderGraph(); });
$("#gc_pathB")&&($("#gc_pathB").onchange=e=>{ state.pathB=e.target.value; renderGraph(); });
$("#gc_clear")&&($("#gc_clear").onclick=()=>{ state.graphCenter=""; state.pathA=""; state.pathB=""; renderGraph(); });
$("#f_father_id").onchange=charGenAuto;
$("#f_rel_person").onchange=initRelAuto;
$("#f_rel_type").onchange=initRelAuto;
$("#f_alive")&&($("#f_alive").onchange=toggleDeathFields);
$("#f_birth")&&($("#f_birth").onblur=e=>window.onBirthBlur&&window.onBirthBlur(e));   // 出生日期失焦即时规范;onBirthBlur 在 tools-dates-import-ai.js,运行时经 window 解析
$("#f_name").oninput=()=>{ const o=$("#initRelObj"); if(o) o.textContent=($("#f_name").value.trim())||"此人"; };
// Esc 关闭最上层弹窗(此前无键盘退出)
document.addEventListener("keydown", e=>{
  const lb=$("#lightbox");
  if(lb&&lb.classList.contains("open")){                                   // 预览中:方向键翻图,Esc 关
    if(e.key==="ArrowLeft"){ _lbStep(-1); return; }
    if(e.key==="ArrowRight"){ _lbStep(1); return; }
    if(e.key==="Escape"){ lb.classList.remove("open"); return; }
    return;
  }
  if(e.key!=="Escape") return;
  // 联动弹窗优先(可叠在编辑/详情弹窗之上;走各自 Cancel 以兑现 Promise,避免 await 永久挂起)
  if($("#coparentMask")&&$("#coparentMask").classList.contains("open")){ const b=$("#cpCancel"); if(b)b.click(); return; }
  if($("#spkidMask")&&$("#spkidMask").classList.contains("open")){ const b=$("#spkCancel"); if(b)b.click(); return; }
  if($("#backfillMask")&&$("#backfillMask").classList.contains("open")){ const b=$("#bfCancel")||$("#bfClose"); if(b)b.click(); return; }
  if($("#dateNormMask")&&$("#dateNormMask").classList.contains("open")){ const b=$("#dnCancel"); if(b)b.click(); return; }
  if($("#importMask")&&$("#importMask").classList.contains("open")){ $("#importMask").classList.remove("open"); return; }
  if($("#pwMask")&&$("#pwMask").classList.contains("open")) $("#pwMask").classList.remove("open");
  else if($("#mask").classList.contains("open")) closeModal();
  else if($("#detailMask").classList.contains("open")) closeDetail();
  else if($("#aiMask")&&$("#aiMask").classList.contains("open")) $("#aiMask").classList.remove("open");
  else if($("#spouseMask")&&$("#spouseMask").classList.contains("open")) $("#spouseMask").classList.remove("open"); });
$("#logoutBtn").onclick=async()=>{ try{ await window.SBAUTH.signOut(); }catch(e){} location.reload(); };
$("#pwBtn") && ($("#pwBtn").onclick=()=>{ $("#pw_new").value=""; $("#pw_new2").value=""; $("#pwErr").textContent=""; $("#pwMask").classList.add("open"); setTimeout(()=>{const n=$("#pw_new"); if(n)n.focus();},50); });
$("#pwCancel") && ($("#pwCancel").onclick=()=>$("#pwMask").classList.remove("open"));
$("#pwMask") && ($("#pwMask").onclick=e=>{ if(e.target===$("#pwMask")) $("#pwMask").classList.remove("open"); });
$("#pwSave") && ($("#pwSave").onclick=async()=>{
  const a=$("#pw_new").value, b=$("#pw_new2").value, msg=$("#pwErr");
  if((a||"").length<6){ msg.style.color="#b91c1c"; msg.textContent="密码至少 6 位"; return; }
  if(a!==b){ msg.style.color="#b91c1c"; msg.textContent="两次输入不一致"; return; }
  $("#pwSave").disabled=true; msg.style.color="#64748b"; msg.textContent="保存中…";
  try{ const r=await window.SBAUTH.updatePassword(a); if(r&&r.error) throw r.error;
    msg.style.color="#047857"; msg.textContent="✅ 已修改,下次用新密码登录"; setTimeout(()=>$("#pwMask").classList.remove("open"),1300); }
  catch(e){ msg.style.color="#b91c1c"; msg.textContent="失败:"+(e.message||e); }
  $("#pwSave").disabled=false; });
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

/* ---------- 跨模块共享:把核心符号挂到 window,供抽出的工具模块(tools-*.js,模块内裸引用经全局对象解析)使用 ---------- */
Object.assign(window, { state, $, el, esc, byId, FORM_KEYS, ROSTER_COLS, DIRECT_LINE, UNDOABLE, ORIG_IMG, APP_NAME, APP_VERSION, getMermaid, openLightbox, _lbStep, _renderLightbox, reloadPersons, refreshRelCount, genOf, _genWalk, rootOfPatriline, lineageOf, surnameOfSelf, familiesOf, famCfg, charGenFor, lineagesList, reloadEverything, loadAll, renderAuthBar, renderHeader, matchQ, peopleFiltered, renderPeopleFilter, _personOptsBirth, openBulkRel, renderPeople, renderCards, statusPill, aliveTag, personCard, renderTree, renderTreeView, renderHistory, parseCharGen, renderFamilies, renderVerify, verifyRow, renderSource, renderTrash, diffHtml, renderLog, renderBackup, expectedCharGen, charGenAuto, renderMedia, mediaItem, runHealth, renderHealth, openMergeDialog, childrenOf, ancestorChain, closeDetail, openDetail, openAddRelative, relOptions, relOptionsHtml, resolveRel, initRelAuto, spouseEndpointIds, coParentDecision, maybeLinkCoParent, pickCoParent, maybeSuggestSpouseCoParent, suggestSpouseChildren, backfillCoParentDrafts, openBackfillDialog, fillFatherSelect, openEdit, closeModal, toggleDeathFields, collectForm, reconcileFatherEdge, saveModal, delModal, compressImage, uploadMedia, personOptions, getECharts, bfsPath, fillGraphControls, renderGraph, rosterCols, recentSearches, pushRecentSearch, clearRecentSearches, recordSearchDebounced, cellVal, renderRoster, switchView, showLogin, boot });

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
