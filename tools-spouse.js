// ============================================================
// tools-spouse.js —— 配偶 blob 转边工具(从 app.js 抽出,v0.32.0 模块化)
// 模块内裸引用 state/$/byId/esc/api/reloadPersons/... 经全局对象解析(app.js 已 window 暴露);
// window.DEDUP / window.REL / window.api 由 db.js 暴露。本模块在 app.js 之后加载。
// 公开函数 + 自己的事件绑定挂回 window,供 app.js(renderHealth/openDetail)裸调用。
// ============================================================
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
  await reloadPersons(); await refreshRelCount(); renderHeader(); renderPeople();
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

/* 事件绑定(从 app.js 迁来) */
$("#spClose")     && ($("#spClose").onclick=()=>$("#spouseMask").classList.remove("open"));
$("#spouseMask")  && ($("#spouseMask").onclick=e=>{ if(e.target===$("#spouseMask")) $("#spouseMask").classList.remove("open"); });
$("#spConfirm")   && ($("#spConfirm").onclick=confirmSpouseConvert);
$("#spAddRow")    && ($("#spAddRow").onclick=()=>{ if(!_spConv)return; const ps=(byId(_spConv.pid)||{}).sex; _spConv.rows.push({name:"",sex:ps==="男"?"女":(ps==="女"?"男":""),role:"",birth:"",death:"",marriageYear:"",note:"",conf:1,dedup:null,useExisting:"",done:false,createdId:""}); renderSpouseRows(); });

/* 暴露给 app.js 裸调用 */
Object.assign(window, { openSpouseConverter, confirmSpouseConvert, renderSpouseRows, parseSpouseBlob });

