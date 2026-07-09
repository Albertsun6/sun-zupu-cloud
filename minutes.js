// ============================================================
// minutes.js —— 纪要(录音 → 转写 → 摘要/任务/脑图)。type=module,在 app.js 之后加载,裸引用其全局。
// 数据:window.MINUTES(db.js)。元数据 CRUD 走 PostgREST(RLS);录音/转写/AI 走 CF 函数 /api/minutes。
// ============================================================
const { $, el, esc, state } = window;

let _minutes = [];
let currentDetail = null;
let rec = null;                 // 当前录音控制器
const pollTimers = {};          // 转写轮询(按 minute id)
let _wakeLock = null;           // 录音期间持屏幕唤醒锁,防手机息屏后系统掐掉录音(不支持的浏览器静默跳过)
async function _acquireWakeLock(){
  try{ if(navigator.wakeLock && !_wakeLock){ _wakeLock = await navigator.wakeLock.request("screen"); _wakeLock.addEventListener("release", ()=>{ _wakeLock=null; }); } }catch(e){}
}
function _releaseWakeLock(){ try{ if(_wakeLock){ _wakeLock.release(); _wakeLock=null; } }catch(e){} }
document.addEventListener("visibilitychange", ()=>{ if(document.visibilityState==="visible" && rec) _acquireWakeLock(); });   // 切走再切回,锁被系统释放→重新持有

/* ---------- 小工具 ---------- */
function ensureMask(id){
  let m=document.getElementById(id);
  if(!m){ m=document.createElement("div"); m.className="mask"; m.id=id; m.innerHTML='<div class="modal" style="width:min(520px,100%)"></div>'; document.body.appendChild(m);
    m.onclick=e=>{ if(e.target===m) m.classList.remove("open"); }; }
  return m;
}
function fmtDur(sec){ sec=Math.max(0,Math.floor(sec||0)); const h=Math.floor(sec/3600),m=Math.floor((sec%3600)/60),s=sec%60,p=n=>(n<10?"0":"")+n; return h?`${h}:${p(m)}:${p(s)}`:`${p(m)}:${p(s)}`; }
function mdLite(s){ return esc(s||"").replace(/\*\*(.+?)\*\*/g,"<b>$1</b>").replace(/^#{1,4}\s+(.+)$/gm,"<b>$1</b>").replace(/^[-*]\s+(.+)$/gm,"• $1").replace(/\n/g,"<br>"); }
function statusBadge(s){
  const map={draft:["草稿","pill"],uploading:["上传中","pill-info"],uploaded:["待转写","pill-info"],transcribing:["转写中…","pill-warn"],transcribed:["已转写","pill-ok"],done:["已完成","pill-ok"],failed:["转写失败","pill-warn"]};
  const x=map[s]||[s||"?","pill"]; return `<span class="pill ${x[1]}">${x[0]}</span>`;
}
const canAI = m => m.status==="transcribed" || m.status==="done" || (m.transcript||"").trim() || (Array.isArray(m.transcript_json)&&m.transcript_json.length);

/* ---------- 列表 ---------- */
async function renderMinutes(){
  const box=document.getElementById("minutesBox"); if(!box) return;
  if(!state.canMinutes){ box.innerHTML="<p class='note'>你没有「纪要」权限。请联系管理员开通。</p>"; return; }
  currentDetail=null;
  box.innerHTML=`<div class="panel">
    <div class="dsec-h">📝 纪要 <button class="btn btn-sm btn-primary" id="mNew">+ 新建纪要</button> <button class="btn btn-sm" id="mReload">刷新</button></div>
    <p class="hint">会议/谈话录音<b>永久保存</b>,AI 自动转文字(带时间戳/说话人)、摘要、任务、脑图。新建后可现场录音或上传音频文件。</p>
    <div id="minutesList">加载中…</div></div>`;
  $("#mNew").onclick=openNewMinute; $("#mReload").onclick=loadMinutes;
  await loadMinutes();
}
async function loadMinutes(){
  const box=document.getElementById("minutesList"); if(!box) return;
  try{
    _minutes=await window.MINUTES.list();
    box.innerHTML = _minutes.length ? _minutes.map(m=>`<div class="mrow" data-id="${m.id}">
        <div class="mrow-main"><b>${esc(m.title||"(无标题)")}</b> ${statusBadge(m.status)}</div>
        <div class="hint">${esc(m.meeting_at||"未注明时间")}${m.duration_sec?(" · "+fmtDur(m.duration_sec)):""} · ${esc(m.created_by_email||"")} · 建于 ${esc((m.created_at||"").slice(0,16).replace("T"," "))}</div>
      </div>`).join("") : "<p class='hint'>还没有纪要。点「+ 新建纪要」开始。</p>";
    box.querySelectorAll(".mrow").forEach(r=> r.onclick=()=>openMinuteDetail(+r.dataset.id));
    _minutes.filter(m=>m.status==="transcribing").forEach(m=>startPolling(m.id));   // 刷新页面也接着转(F11)
  }catch(e){ box.innerHTML=`<p class="err">加载失败:${esc(e.message)}</p>`; }
}

function openNewMinute(){
  const m=ensureMask("minuteNewMask");
  m.querySelector(".modal").innerHTML=`<h2>新建纪要</h2>
    <div class="field"><label for="mn_title">标题</label><input id="mn_title" placeholder="如:2026 春节家族会议"></div>
    <div class="field"><label for="mn_at">会议时间(备注)</label><input id="mn_at" placeholder="如:2026-02-17 上午 / 大年初一晚饭后"></div>
    <div class="field"><label for="mn_note">备注</label><textarea id="mn_note" rows="2" placeholder="地点 / 参会人 / 议题…"></textarea></div>
    <div class="err" id="mn_err"></div>
    <div class="modal-foot"><span class="spacer"></span><button class="btn" id="mn_cancel">取消</button><button class="btn btn-primary" id="mn_ok">创建并进入</button></div>`;
  m.classList.add("open"); setTimeout(()=>{const e=document.getElementById("mn_title"); if(e)e.focus();},50);
  document.getElementById("mn_cancel").onclick=()=>m.classList.remove("open");
  document.getElementById("mn_ok").onclick=async()=>{
    const err=document.getElementById("mn_err");
    try{ err.textContent="创建中…";
      const row=await window.MINUTES.create({ title:document.getElementById("mn_title").value.trim(), meeting_at:document.getElementById("mn_at").value.trim(), note:document.getElementById("mn_note").value.trim() });
      m.classList.remove("open"); await openMinuteDetail(row.id);
    }catch(e){ err.textContent="失败:"+e.message; }
  };
}

/* ---------- 详情 ---------- */
async function openMinuteDetail(id){
  const box=document.getElementById("minutesBox"); if(!box) return;
  let m; try{ m=await window.MINUTES.get(id); }catch(e){ alert("加载失败:"+e.message); return; }
  if(!m){ alert("纪要不存在或无权限"); return renderMinutes(); }
  currentDetail=id;
  box.innerHTML=detailHtml(m);
  bindDetail(m);
  if(m.status==="transcribing") startPolling(id);
  if(m.mindmap) drawMindmap(id, m.mindmap);
  if(m.audio_path){ window.MINUTES.playUrl(id).then(u=>{ const a=document.getElementById("mAudio"); if(a&&u) a.src=u; }).catch(()=>{}); }
}
function transcribeBtnHtml(m){
  if(m.status==="uploaded"||m.status==="failed")
    return `<button class="btn btn-primary btn-sm" id="trGo">${m.status==="failed"?"重试转写":"开始转写(AI)"}</button>`+(m.status==="failed"&&m.asr_error?`<div class="err">${esc(m.asr_error)}</div>`:"");
  return "";
}
// 说话人显示名:有真名映射(minutes.speaker_names)就显真名,否则「说话人N」。名字封顶 40 字、非对象 map 当空(与后端一致)。
function speakerName(spk, names){ if(spk==null||spk==="") return ""; const map=(names&&typeof names==="object")?names:{}; const nm=map[String(spk)]; return (nm&&String(nm).trim())?String(nm).trim().slice(0,40):("说话人"+spk); }
function hasSpk(s){ return s.speaker!=null && s.speaker!==""; }
function transcriptHtml(segs, transcript, names){
  names=names||{};
  if(Array.isArray(segs)&&segs.length)
    return `<div class="tlist">`+segs.map(s=>`<div class="tseg" data-start="${s.start||0}"><span class="tt">${fmtDur(s.start||0)}</span>${hasSpk(s)?`<span class="tspk" data-spk="${esc(String(s.speaker))}" title="点我给这位说话人起名(全场同步)">${esc(speakerName(s.speaker,names))}</span>`:""}<span class="ttx">${esc(s.text||"")}</span></div>`).join("")+`</div>`;
  if(transcript) return `<div class="tplain">${esc(transcript).replace(/\n/g,"<br>")}</div>`;
  return "<span class='hint'>—(尚无转写)</span>";
}
function tasksHtml(tasks){
  if(!Array.isArray(tasks)||!tasks.length) return "<span class='hint'>—</span>";
  return `<ul class="tasklist">`+tasks.map(t=>`<li><input type="checkbox" disabled> ${esc(t.task||"")}${t.owner?` <span class="hint">@${esc(t.owner)}</span>`:""}${t.due?` <span class="hint">⏰${esc(t.due)}</span>`:""}</li>`).join("")+`</ul>`;
}
function detailHtml(m){
  const hasAudio=!!m.audio_path, segs=Array.isArray(m.transcript_json)?m.transcript_json:[];
  return `<div class="panel mdetail">
    <div class="mdet-top"><button class="btn btn-sm" id="mBack">← 返回</button>
      <b class="mdet-title">${esc(m.title||"(无标题)")}</b> ${statusBadge(m.status)}<span class="spacer"></span>
      <button class="btn btn-sm" id="mEdit">编辑信息</button><button class="btn btn-sm btn-danger" id="mDel">删除</button></div>
    <div class="hint mdet-meta">🕒 ${esc(m.meeting_at||"未注明时间")} · 创建人 ${esc(m.created_by_email||"")} · 建于 ${esc((m.created_at||"").slice(0,16).replace("T"," "))}${m.duration_sec?(" · 录音时长 "+fmtDur(m.duration_sec)):""}</div>
    ${m.note?`<div class="mdet-note">${esc(m.note)}</div>`:""}

    <div class="mdet-sec"><div class="dsec-h">🎙 录音</div>
      ${hasAudio
        ? `<audio id="mAudio" controls preload="none" style="width:100%"></audio><div class="hint">录音已永久保存(私有,仅有纪要权限者可听)。</div>`
        : (m.segment_count>0
            ? `<div class="note">⚠️ 上次录音中断,已自动保存 ${m.segment_count} 段(每段约 3 分钟)。<button class="btn btn-primary btn-sm" id="recRecover">恢复并保存整场</button></div>
               <div class="hint" id="recMsg"></div>`
            : `<div class="recctl"><button class="btn btn-primary" id="recStart">● 开始录音</button>
                 <button class="btn btn-danger" id="recStop" style="display:none">■ 停止并保存</button>
                 <span class="rectime" id="recTime" style="display:none">00:00</span></div>
               <div class="hint" style="margin:.3rem 0">或 <button class="btn btn-sm" id="upPick">📁 上传音频文件</button>(mp3 / m4a / wav 等)
                 <input type="file" id="upFile" accept="audio/*" style="display:none"></div>
               <div class="hint" id="recMsg">边录边自动保存,可录数小时;超过 2 小时只出文字、不区分说话人。</div>`)}
    </div>

    <div class="mdet-sec"><div class="dsec-h">📝 转写文字 ${m.status==="transcribing"?'<span class="hint" id="trMsg">转写中…(可关闭页面,稍后回来查看)</span>':""}</div>
      ${transcribeBtnHtml(m)}
      ${(m.status==="transcribed"&&m.diarized===false&&((m.transcript||"").trim()||segs.length))?'<div class="hint">ℹ️ 本次录音超过 2 小时,未做说话人分离,仅文字。</div>':""}
      ${(m.status==="transcribed"&&segs.some(hasSpk))?'<div class="hint" style="margin:.3rem 0">💡 点转写里的<b>说话人名字</b>可改成真名(全场同步)。<button class="btn btn-sm" id="spkGuess">🤖 让 AI 猜说话人</button></div>':""}
      <div id="transcriptBox">${transcriptHtml(segs, m.transcript, m.speaker_names)}</div></div>

    <div class="mdet-sec ai-sec"><div class="dsec-h">🤖 AI 整理(DeepSeek)</div>
      <div class="hint">基于转写文字生成,需先完成转写。</div>
      <div class="ai-grid">
        <div class="ai-card"><div class="ai-h">摘要 <button class="btn btn-sm aiGen" data-kind="summary" ${canAI(m)?"":"disabled"}>生成</button></div><div class="ai-body" id="ai-summary">${m.summary?mdLite(m.summary):"<span class='hint'>—</span>"}</div></div>
        <div class="ai-card"><div class="ai-h">任务 <button class="btn btn-sm aiGen" data-kind="tasks" ${canAI(m)?"":"disabled"}>生成</button></div><div class="ai-body" id="ai-tasks">${tasksHtml(m.tasks)}</div></div>
        <div class="ai-card ai-card-wide"><div class="ai-h">脑图 <button class="btn btn-sm aiGen" data-kind="mindmap" ${canAI(m)?"":"disabled"}>生成</button></div><div class="ai-body mindmap-body" id="ai-mindmap">${m.mindmap?"":"<span class='hint'>—</span>"}</div></div>
      </div></div>
  </div>`;
}
function bindDetail(m){
  $("#mBack").onclick=renderMinutes;
  $("#mEdit").onclick=()=>openEditMinute(m);
  $("#mDel").onclick=async()=>{ if(!confirm("删除纪要「"+(m.title||"")+"」及其录音?不可恢复。")) return; try{ await window.MINUTES.del(m.id); stopPolling(m.id); await renderMinutes(); }catch(e){ alert("删除失败:"+e.message); } };
  const trGo=document.getElementById("trGo"); if(trGo) trGo.onclick=()=>doTranscribe(m.id);
  const rs=document.getElementById("recStart"); if(rs) rs.onclick=()=>startRecording(m.id);
  const rp=document.getElementById("recStop"); if(rp) rp.onclick=()=>stopRecording(m.id);
  const rr=document.getElementById("recRecover"); if(rr) rr.onclick=()=>recoverRecording(m.id);
  const up=document.getElementById("upPick"), uf=document.getElementById("upFile");
  if(up&&uf){ up.onclick=()=>uf.click(); uf.onchange=()=>{ if(uf.files[0]) uploadAndAttach(m.id, uf.files[0], 0); }; }
  document.querySelectorAll(".aiGen").forEach(b=> b.onclick=()=>genAI(m.id, b.dataset.kind, b));
  document.querySelectorAll(".tseg").forEach(s=> s.onclick=()=>{ const a=document.getElementById("mAudio"); if(a){ a.currentTime=+s.dataset.start||0; a.play().catch(()=>{}); } });
  document.querySelectorAll(".tspk").forEach(s=> s.onclick=(e)=>{ e.stopPropagation(); renameSpeaker(m, s.dataset.spk); });   // 阻止冒泡到 .tseg(那是跳播放)
  const gs=document.getElementById("spkGuess"); if(gs) gs.onclick=()=>guessSpeakers(m, gs);
}

/* ---------- 说话人改名(v0.47:点名字改真名,存 minutes.speaker_names,同编号全场同步)---------- */
async function saveSpeakerNames(id, names){ await window.MINUTES.update(id, { speaker_names: names }); await openMinuteDetail(id); }
async function renameSpeaker(m, spk){
  const cur=(m.speaker_names&&m.speaker_names[spk])||"";
  const nv=prompt("给「说话人"+spk+"」起个真名(全场同一说话人会一起改;留空=恢复成编号):", cur);
  if(nv===null) return;   // 取消
  const base=(m.speaker_names&&typeof m.speaker_names==="object")?m.speaker_names:{};
  const names={...base}; const v=nv.trim().slice(0,40);   // 封顶 40 字(与后端/DB 约束一致)
  if(v) names[spk]=v; else delete names[spk];
  try{ await saveSpeakerNames(m.id, names); }catch(e){ alert("改名失败:"+e.message+"(名字过长或格式不对会被数据库拒绝)"); }
}
async function guessSpeakers(m, btn){
  if(btn){ btn.disabled=true; btn.textContent="AI 猜测中…"; }
  try{ const props=await window.MINUTES.guessSpeakers(m.id); openSpeakerGuess(m, props); }
  catch(e){ alert("猜测失败:"+e.message); }
  finally{ if(btn){ btn.disabled=false; btn.textContent="🤖 让 AI 猜说话人"; } }
}
function openSpeakerGuess(m, props){
  const mask=ensureMask("spkGuessMask");
  const rows = (props&&props.length) ? props.map(p=>{
    const cur=(m.speaker_names&&m.speaker_names[p.speaker])||"";
    return `<div class="mergerow" style="display:block;padding:.4rem 0">
      <b>说话人${esc(p.speaker)}</b>${cur?` <span class="hint">(当前:${esc(cur)})</span>`:""}
      ${p.name?`&nbsp;→&nbsp;建议 <b style="color:#047857">${esc(p.name)}</b> <button class="btn btn-sm spkAccept" data-spk="${esc(p.speaker)}" data-name="${esc(p.name)}">采纳</button>`:`&nbsp;<span class="hint">拿不准,建议留空(可手动改)</span>`}
      ${p.reason?`<div class="hint">依据:${esc(p.reason)}</div>`:""}
    </div>`;
  }).join("") : '<div class="hint">没有可猜的说话人(未做说话人分离,或无对话内容)。</div>';
  mask.querySelector(".modal").innerHTML=`<h2>🤖 AI 猜说话人</h2>
    <p class="hint">仅根据对话内容(谁被喊名字/自报身份)推测,<b>可能不准</b>;点「采纳」才写入,写入后仍可手动改。</p>
    <div style="max-height:52vh;overflow:auto">${rows}</div>
    <div class="modal-foot"><span class="spacer"></span><button class="btn" id="spkClose">关闭</button></div>`;
  mask.classList.add("open");
  document.getElementById("spkClose").onclick=()=>mask.classList.remove("open");
  mask.onclick=e=>{ if(e.target===mask) mask.classList.remove("open"); };
  mask.querySelectorAll(".spkAccept").forEach(b=>b.onclick=async()=>{
    const names={...(m.speaker_names||{})}; names[b.dataset.spk]=b.dataset.name;
    try{ mask.classList.remove("open"); await saveSpeakerNames(m.id, names); }catch(e){ alert("采纳失败:"+e.message); }
  });
}
function openEditMinute(m){
  const mask=ensureMask("minuteEditMask");
  mask.querySelector(".modal").innerHTML=`<h2>编辑纪要信息</h2>
    <div class="field"><label for="me_title">标题</label><input id="me_title" value="${esc(m.title||"")}"></div>
    <div class="field"><label for="me_at">会议时间(备注)</label><input id="me_at" value="${esc(m.meeting_at||"")}"></div>
    <div class="field"><label for="me_note">备注</label><textarea id="me_note" rows="2">${esc(m.note||"")}</textarea></div>
    <div class="err" id="me_err"></div>
    <div class="modal-foot"><span class="spacer"></span><button class="btn" id="me_cancel">取消</button><button class="btn btn-primary" id="me_ok">保存</button></div>`;
  mask.classList.add("open");
  document.getElementById("me_cancel").onclick=()=>mask.classList.remove("open");
  document.getElementById("me_ok").onclick=async()=>{
    try{ await window.MINUTES.update(m.id,{ title:document.getElementById("me_title").value.trim(), meeting_at:document.getElementById("me_at").value.trim(), note:document.getElementById("me_note").value.trim() }); mask.classList.remove("open"); await openMinuteDetail(m.id); }
    catch(e){ document.getElementById("me_err").textContent="失败:"+e.message; }
  };
}

/* ---------- 录音(v0.42:低码率 + 分段即传兜底 + 停止拼单文件;扛 4-5h)---------- */
// 优先 mp4/AAC(Fun-ASR 兼容确定);Chrome 无 mp4 时用 webm/opus(紧凑;Fun-ASR 是否接受为上线实测项);都不支持才 WAV。
function pickMime(){
  const prefs=["audio/mp4","audio/aac","audio/webm;codecs=opus","audio/webm","audio/ogg;codecs=opus"];
  if(!window.MediaRecorder||!MediaRecorder.isTypeSupported) return "";
  for(const t of prefs){ if(MediaRecorder.isTypeSupported(t)) return t; }
  return "";
}
function mimeExt(mime){ if(!mime||mime==="audio/wav"||/wav/.test(mime)) return "wav"; if(/mp4|aac|m4a/.test(mime)) return "m4a"; if(/ogg/.test(mime)) return "ogg"; return "webm"; }
// 用 Web Audio 采 PCM → 编码 16k 单声道 WAV(ScriptProcessor 已弃用但兼容性最好;无构建,不需 worklet 文件)
function makeWavRecorder(stream){
  const Ctx=window.AudioContext||window.webkitAudioContext;
  let ctx; try{ ctx=new Ctx({sampleRate:16000}); }catch(e){ ctx=new Ctx(); }
  const src=ctx.createMediaStreamSource(stream);
  const proc=ctx.createScriptProcessor(4096,1,1);
  const gain=ctx.createGain(); gain.gain.value=0;   // 静音,避免回放啸叫
  const chunks=[]; let len=0;
  proc.onaudioprocess=e=>{ const d=e.inputBuffer.getChannelData(0); chunks.push(new Float32Array(d)); len+=d.length; };
  src.connect(proc); proc.connect(gain); gain.connect(ctx.destination);
  return { stop(){ const sr=ctx.sampleRate; try{proc.disconnect();src.disconnect();gain.disconnect();}catch(e){} const buf=new Float32Array(len); let o=0; for(const c of chunks){ buf.set(c,o); o+=c.length; } try{ctx.close();}catch(e){} return encodeWav(buf,sr); } };
}
function encodeWav(samples, sampleRate){
  const n=samples.length, ab=new ArrayBuffer(44+n*2), v=new DataView(ab);
  const ws=(off,s)=>{ for(let i=0;i<s.length;i++) v.setUint8(off+i,s.charCodeAt(i)); };
  ws(0,"RIFF"); v.setUint32(4,36+n*2,true); ws(8,"WAVE"); ws(12,"fmt "); v.setUint32(16,16,true);
  v.setUint16(20,1,true); v.setUint16(22,1,true); v.setUint32(24,sampleRate,true); v.setUint32(28,sampleRate*2,true);
  v.setUint16(32,2,true); v.setUint16(34,16,true); ws(36,"data"); v.setUint32(40,n*2,true);
  let off=44; for(let i=0;i<n;i++){ const s=Math.max(-1,Math.min(1,samples[i])); v.setInt16(off, s<0?s*0x8000:s*0x7fff, true); off+=2; }
  return new Blob([ab],{type:"audio/wav"});
}
async function startRecording(id){
  const msg=document.getElementById("recMsg");
  try{
    const stream=await navigator.mediaDevices.getUserMedia({ audio:{ channelCount:1, echoCancellation:true, noiseSuppression:true } });
    const mime=pickMime(), ext=mimeExt(mime);
    let ctl;
    if(mime){   // MediaRecorder(mp4/webm):低码率 + 分段 timeslice(每片:内存留存拼整场 + 即传兜底)
      let mr; try{ mr=new MediaRecorder(stream,{ mimeType:mime, audioBitsPerSecond:32000 }); }
      catch(e){ mr=new MediaRecorder(stream,{ mimeType:mime }); }   // 个别浏览器不支持 audioBitsPerSecond
      const chunks=[]; let seq=0;
      mr.ondataavailable=e=>{ if(e.data&&e.data.size){ chunks.push(e.data); const s=seq++; window.MINUTES.segUpload(id,s,e.data,ext).catch(()=>{}); } };
      mr.start(180000);   // 3 分钟一片
      ctl={ stream, mime, ext, mode:"mr", chunks, stop:()=>new Promise(res=>{ mr.onstop=()=>res(new Blob(chunks,{type:mime})); mr.stop(); }) };
    }else{   // 极少数无 mp4/webm 的浏览器 → WAV(无分段;不建议长录音)
      const w=makeWavRecorder(stream);
      ctl={ stream, mime:"audio/wav", ext:"wav", mode:"wav", stop:async()=>w.stop() };
    }
    rec={ ...ctl, start:Date.now() };
    _acquireWakeLock();   // A1-2:录音中防息屏
    document.getElementById("recStart").style.display="none";
    const stopBtn=document.getElementById("recStop"), tEl=document.getElementById("recTime");
    stopBtn.style.display=""; tEl.style.display="";
    rec.timer=setInterval(()=>{ const s=Math.floor((Date.now()-rec.start)/1000); tEl.textContent=fmtDur(s);
      if(s>=18000){ msg.textContent="接近 5 小时,已自动停止保存。"; stopRecording(id); } },500);   // 5h 安全上限
    msg.className="hint"; msg.textContent = rec.mode==="wav" ? "● 录音中(WAV 兼容模式,不建议长录音)…"
      : "● 录音中…(边录边自动保存;超过 2 小时只出文字、不区分说话人)";
  }catch(e){ msg.className="err"; msg.textContent="无法录音:"+(e&&e.message||e)+"(请允许麦克风权限,且需 https / localhost)"; }
}
async function stopRecording(id){
  if(!rec) return;
  clearInterval(rec.timer);
  _releaseWakeLock();
  const dur=Math.floor((Date.now()-rec.start)/1000), msg=document.getElementById("recMsg");
  msg.className="hint"; msg.textContent="处理录音…";
  let blob; try{ blob=await rec.stop(); }catch(e){ msg.className="err"; msg.textContent="录音失败:"+e.message; rec=null; return; }
  try{ rec.stream.getTracks().forEach(t=>t.stop()); }catch(e){}
  const ext=rec.ext||mimeExt(rec.mime);
  const file=new File([blob], "recording."+ext, { type: blob.type||rec.mime });
  rec=null;
  await uploadAndAttach(id, file, dur);
}
async function uploadAndAttach(id, file, dur){
  const msg=document.getElementById("recMsg")||{};
  try{
    msg.className="hint"; msg.textContent="保存整场录音…("+(Math.round(file.size/1024/1024*10)/10)+" MB)";
    await window.MINUTES.uploadAudio(id, file, dur||0);   // 单文件上传 + 服务端 attach(设 audio_path/status/时长,并清理分片兜底)
    await openMinuteDetail(id);   // 刷到"待转写"
  }catch(e){ msg.className="err"; msg.textContent="保存失败:"+e.message+"(录音过长可能超出单文件上限)"; }
}
// 崩溃恢复:录到一半页面崩了(有分片台账、无整场文件)→ 下载分片、按序拼成整场、上传
async function recoverRecording(id){
  const msg=document.getElementById("recMsg")||{};
  try{
    msg.className="hint"; msg.textContent="下载已保存的分片…";
    const segs=await window.MINUTES.segList(id);
    if(!segs.length){ msg.className="err"; msg.textContent="没有可恢复的分片"; return; }
    const blobs=[];
    for(const s of segs){ const r=await fetch(s.url); if(r.ok) blobs.push(await r.blob()); }
    if(!blobs.length){ msg.className="err"; msg.textContent="分片下载失败"; return; }
    const type=blobs[0].type||"audio/webm", ext=mimeExt(type);
    const full=new Blob(blobs,{type});
    // 时长:优先让浏览器解码出真实时长(B7-2);解不出(编码残缺等)再按段数估(每段3分钟,略高估→>2h 偏向"关分人",Fun-ASR 开分人仅 ≤2h,更安全)
    const estDur = (await _blobDuration(full)) || segs.length*180;
    await uploadAndAttach(id, new File([full],"recording."+ext,{type}), estDur);
  }catch(e){ msg.className="err"; msg.textContent="恢复失败:"+e.message; }
}
// 读一段音频 Blob 的真实时长(秒);解不出/超时返回 0(调用方回退估算)。
// 注:MediaRecorder 的 webm 常无时长头(duration=Infinity)→ 用"跳到极大时间点再读"迫使浏览器算出真实值(Chrome 惯用法)。
function _blobDuration(blob){
  return new Promise(res=>{
    const url=URL.createObjectURL(blob), a=new Audio();
    let settled=false;
    const done=v=>{ if(settled) return; settled=true; clearTimeout(to); URL.revokeObjectURL(url); res((v>0&&isFinite(v))?Math.round(v):0); };
    const to=setTimeout(()=>done(0), 8000);
    a.onloadedmetadata=()=>{ if(a.duration===Infinity){ a.currentTime=1e7; a.ontimeupdate=()=>{ a.ontimeupdate=null; done(a.duration); }; } else done(a.duration); };
    a.onerror=()=>done(0);
    a.preload="metadata"; a.src=url;
  });
}

/* ---------- 转写 + 轮询 ---------- */
async function doTranscribe(id){
  const trGo=document.getElementById("trGo"); if(trGo){ trGo.disabled=true; trGo.textContent="提交中…"; }
  try{ await window.MINUTES.transcribe(id); await openMinuteDetail(id); startPolling(id); }
  catch(e){ alert("提交转写失败:"+e.message); if(trGo){ trGo.disabled=false; trGo.textContent="重试转写"; } }
}
function startPolling(id){
  if(pollTimers[id]) return;
  pollTimers[id]=setInterval(async()=>{
    try{ const r=await window.MINUTES.pollStatus(id);
      if(r.status!=="transcribing"){ stopPolling(id); if(currentDetail===id) await openMinuteDetail(id); else await loadMinutes(); }
    }catch(e){ stopPolling(id); }
  }, 6000);
}
function stopPolling(id){ if(pollTimers[id]){ clearInterval(pollTimers[id]); delete pollTimers[id]; } }

/* ---------- AI:摘要 / 任务 / 脑图 ---------- */
async function genAI(id, kind, btn){
  const old=btn.textContent; btn.disabled=true; btn.textContent="生成中…";
  try{ const r=await window.MINUTES.ai(id, kind);
    if(kind==="summary") document.getElementById("ai-summary").innerHTML=mdLite(r.summary||"");
    else if(kind==="tasks") document.getElementById("ai-tasks").innerHTML=tasksHtml(r.tasks||[]);
    else if(kind==="mindmap") await drawMindmap(id, r.mindmap||"");
  }catch(e){ alert("生成失败:"+e.message); }
  btn.disabled=false; btn.textContent=old;
}
async function drawMindmap(id, code){
  const box=document.getElementById("ai-mindmap"); if(!box) return;
  if(!code){ box.innerHTML="<span class='hint'>—</span>"; return; }
  try{ const mermaid=await window.getMermaid(); const {svg}=await mermaid.render("mm_"+id+"_"+String(Math.floor(performance.now())), code); box.innerHTML=svg; }
  catch(e){ box.innerHTML="<pre class='hint' style='white-space:pre-wrap'>"+esc(code)+"</pre><div class='err'>脑图渲染失败,可重试生成</div>"; }
}

window.renderMinutes = renderMinutes;
