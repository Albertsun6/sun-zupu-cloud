// ============================================================
// tools-entry.js —— 数据录入工具(出生日期规范化 + 表格导入 + AI批量),从 app.js 抽出 v0.32.0
// 在 app.js 之后加载;裸引用 app.js 核心(已 window 暴露)与 window.api/REL/LUNARCONV(db.js/calendar.js)。
// 块间(import↔ai↔date)同文件直接解析。公开函数 + 事件绑定挂回 window 供 app.js 裸调用。
// ============================================================
/* ---------- 出生日期规范化(规则优先 + AI 兜底)---------- */
// 规则解析:→ {ok:true,value:"YYYY"|"YYYY-MM"|"YYYY-MM-DD"|""}  或 {ok:false,needAI:true}(交 AI)
function normalizeDate(raw){
  const s=(raw||"").trim(); if(!s) return {ok:true,value:""};
  const p2=n=>String(n).padStart(2,"0"); let m;
  if((m=s.match(/^(\d{3,4})\s*[\-\/.年]\s*(\d{1,2})\s*[\-\/.月]\s*(\d{1,2})\s*日?$/))){ const y=+m[1],mo=+m[2],d=+m[3]; if(mo>=1&&mo<=12&&d>=1&&d<=31) return {ok:true,value:y+"-"+p2(mo)+"-"+p2(d)}; return {ok:false,needAI:true}; }
  if((m=s.match(/^(\d{3,4})\s*[\-\/.年]\s*(\d{1,2})\s*月?$/))){ const y=+m[1],mo=+m[2]; if(mo>=1&&mo<=12) return {ok:true,value:y+"-"+p2(mo)}; return {ok:false,needAI:true}; }
  if((m=s.match(/^(\d{3,4})\s*年?$/))){ const y=+m[1]; if(y>=1000&&y<=2200) return {ok:true,value:String(y)}; return {ok:false,needAI:true}; }
  return {ok:false,needAI:true};
}
async function aiNormalizeDates(list){
  if(!list.length) return [];
  const session=await window.SBAUTH.getSession(); const token=session&&session.access_token;
  const r=await fetch("/api/normalize-dates",{ method:"POST", headers:{ "content-type":"application/json", authorization:"Bearer "+(token||"") }, body:JSON.stringify({dates:list}) });
  const j=await r.json().catch(()=>({})); if(!r.ok) throw new Error(j.error||("HTTP "+r.status)); return j.results||[];
}
// 第二个 AI(智谱 GLM)做同样的日期拆解,用于双重验证;未配置 GLM_API_KEY 时后端返回空 + note。
// 不阻断导入,但把「第二模型未启用/失败」记进 _glmOff,由预览层显式提示,不再静默退化成单模型。
let _glmOff=false;
async function aiNormalizeDatesGLM(list){
  if(!list.length) return [];
  const session=await window.SBAUTH.getSession(); const token=session&&session.access_token;
  const ctrl=new AbortController(); const t=setTimeout(()=>ctrl.abort(),28000);   // GLM 慢/挂不阻断导入
  try{
    const r=await fetch("/api/normalize-dates-glm",{ method:"POST", headers:{ "content-type":"application/json", authorization:"Bearer "+(token||"") }, body:JSON.stringify({dates:list}), signal:ctrl.signal });
    const j=await r.json().catch(()=>({})); if(!r.ok){ _glmOff=true; return []; }
    _glmOff = !!(j.note && /未配置|未启用/.test(j.note));   // 后端明确回「未配置 GLM_API_KEY(第二验证未启用)」
    return j.results||[];
  }catch(e){ _glmOff=true; return []; } finally{ clearTimeout(t); }
}
// 双 AI 拆日期:DeepSeek + GLM 并行,逐条对齐;两者对 年/月/日/农历 判断不一致→标 _conflict 供人工核对
async function aiNormalizeDatesDual(list){
  if(!list.length) return [];
  const [ds, glm] = await Promise.all([ aiNormalizeDates(list).catch(()=>[]), aiNormalizeDatesGLM(list).catch(()=>[]) ]);
  const gmap={}; (glm||[]).forEach(r=>{ if(r&&r.input) gmap[r.input]=r; });
  return (ds||[]).map(d=>{ const g=gmap[d.input]; if(!g) return d;
    const conflict = (d.year||null)!==(g.year||null) || (d.month||null)!==(g.month||null) || (d.day||null)!==(g.day||null) || (!!d.is_lunar)!==(!!g.is_lunar);
    return { ...d, _glm:g, _conflict:conflict }; });
}
// 给定原始串与双AI结果,生成一句"不一致"提示(没冲突→"")
function dateConflictNote(raw, r){ if(!r||!r._conflict||!r._glm) return "";
  const fmt=x=>x?`${x.year||"?"}年${x.month||"?"}月${x.day||"?"}日·${x.is_lunar?"农历":"公历"}`:"?";
  return `两模型对「${raw}」判断不一致:DeepSeek=${fmt(r)} / GLM=${fmt(r._glm)},请核对`; }
const _SHICHEN12=["子","丑","寅","卯","辰","巳","午","未","申","酉","戌","亥"];
const _shichenOf = h => (window.LUNARCONV&&window.LUNARCONV.shichenOf)?window.LUNARCONV.shichenOf(h):(_SHICHEN12[Math.floor(((h+1)%24)/2)]+"时");
const _SHENGXIAO=["鼠","牛","虎","兔","龙","蛇","马","羊","猴","鸡","狗","猪"];
const _shengXiao = y => y?_SHENGXIAO[(((y-4)%12)+12)%12]:"";   // 按公历年近似生肖(精确随立春的由 LUNARCONV 给)
// 展示用属相:birth_lunar 已含则不重复;否则从 公历全日期(精确,经万年历)或仅年份(近似)算出 "属X"
function shengXiaoLabel(p){
  if(/属[鼠牛虎兔龙蛇马羊猴鸡狗猪]/.test((p.birth_lunar||"")+" "+(p.birth||""))) return "";
  const LC=window.LUNARCONV; let sx="";
  const bm=(p.birth||"").match(/^(\d{3,4})-(\d{1,2})-(\d{1,2})$/);
  if(bm && LC && LC.ready){ const c=LC.solarToLunar(+bm[1],+bm[2],+bm[3]); const mm=c&&(c.lunar||"").match(/属([鼠牛虎兔龙蛇马羊猴鸡狗猪])/); if(mm) sx=mm[1]; }
  if(!sx){ const ym=(p.birth||"").match(/\d{4}/)||(p.birth_lunar||"").match(/\d{4}/); if(ym) sx=_shengXiao(+ym[0]); }
  return sx?("属"+sx):"";
}
// 从任意中文/数字串抽出生时间 → "H:MM 时辰" 或 "X时";抽不到返回 ""。纯客户端规则(阿拉伯+中文数字+时辰名+早晚上下午/半夜判时段),不依赖 AI 格式。
const _CNNUM={零:0,"〇":0,一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};
function _cnNum(s){ s=String(s||"").trim(); if(!s)return null; if(/^\d+$/.test(s))return +s;
  if(s==="十")return 10; if(s==="廿"||s==="卄")return 20; if(s==="卅")return 30; let m;
  if((m=s.match(/^十([一二两三四五六七八九])$/)))return 10+_CNNUM[m[1]];
  if((m=s.match(/^([一二两三四五六七八九])十([一二两三四五六七八九])?$/)))return _CNNUM[m[1]]*10+(m[2]?_CNNUM[m[2]]:0);
  if((m=s.match(/^廿([一二两三四五六七八九])$/)))return 20+_CNNUM[m[1]];
  if((m=s.match(/^[零〇]([一二两三四五六七八九])$/)))return _CNNUM[m[1]];
  if(s.length===1&&_CNNUM[s]!=null)return _CNNUM[s]; return null; }
const _PERIODRE="凌晨|清晨|早晨|一早|大早|早上|上午|中午|晌午|下午|傍晚|黄昏|晚上|半夜|子夜|夜里|夜间|晌|早|晚|夜";
function _applyPeriod(h,pd){ pd=pd||"";
  if(/半夜|子夜|凌晨/.test(pd)) return h===12?0:((h%24)+24)%24;                          // 半夜/子夜/凌晨:12→0,其余AM
  if(/下午|傍晚|黄昏|晚上|晚/.test(pd)) return (h>=1&&h<=11)?h+12:((h%24)+24)%24;          // 下午/晚:1-11 +12
  if(/夜里|夜间|夜/.test(pd)) return (h>=1&&h<=5)?h:(h>=6&&h<=11?h+12:((h%24)+24)%24);     // 夜里:1-5 AM、6-11 PM
  return ((h%24)+24)%24; }
function extractTime(raw){
  const s=String(raw||""); if(!s) return "";
  let m=s.match(new RegExp(`(${_PERIODRE})?\\s*(\\d{1,2})\\s*[:：时點点]\\s*(半|[0-5]?\\d)?\\s*分?`));   // 阿拉伯数字钟点
  if(m && +m[2]<=23){ let h=+m[2],min=0; if(m[3]==="半")min=30; else if(m[3])min=Math.min(59,+m[3]); h=_applyPeriod(h,m[1]);
    return `${h}:${String(min).padStart(2,"0")} ${_shichenOf(h)}`; }
  m=s.match(new RegExp(`(${_PERIODRE})?\\s*([零〇一二两三四五六七八九十廿卄卅]{1,3})\\s*[点時时]\\s*(半|[零〇一二两三四五六七八九十]{1,3}\\s*分|[一二三四]\\s*刻|[0-5]?\\d\\s*分)?`));   // 中文数字钟点
  if(m){ const hh=_cnNum(m[2]); if(hh!=null&&hh<=23){ let h=hh,min=0; const mm=m[3]||"";
    if(mm==="半")min=30; else if(/刻/.test(mm)){const k=_cnNum(mm.replace(/刻/,""));min=(k||0)*15;} else if(/分/.test(mm)){const x=_cnNum(mm.replace(/分/,""));if(x!=null)min=Math.min(59,x);}
    h=_applyPeriod(h,m[1]); return `${h}:${String(min).padStart(2,"0")} ${_shichenOf(h)}`; } }
  const sc=s.match(/([子丑寅卯辰巳午未申酉戌亥])时/); if(sc) return sc[1]+"时";   // 时辰名
  return "";
}
// AI 拆出的结构化字段(+原文)→ {birth(公历)/birth_lunar(农历)/birth_time(时辰)};农历↔公历用万年历精确换算,时间用客户端规则抽(原文优先、AI 兜底)
// 客户端解析日期组件(不靠弱模型):年(阿拉伯/中文四位)+ 农历或公历的月日(初十=10/廿三=23/腊月=12/2月=2/26日=26)+ 闰 + is_lunar
const _LMON={正:1,冬:11,腊:12};
function _cnDay(s){ let m;
  if(/初十/.test(s))return 10;
  if((m=s.match(/初([一二三四五六七八九])/)))return _CNNUM[m[1]];
  if((m=s.match(/(?:廿|卄)([一二三四五六七八九])/)))return 20+_CNNUM[m[1]];
  if((m=s.match(/二十([一二三四五六七八九])/)))return 20+_CNNUM[m[1]];
  if(/三十|卅/.test(s))return 30;
  if(/(?:廿|卄|二十)(?![一二三四五六七八九])/.test(s))return 20;
  if((m=s.match(/十([一二三四五六七八九])/)))return 10+_CNNUM[m[1]];
  if((m=s.match(/(\d{1,2})\s*[日号]/)))return +m[1];
  return null; }
function parseDateParts(raw){
  const s=String(raw||""); const o={is_lunar:false,year:null,month:null,day:null,leap:false};
  { const t=s.trim(); if(/^\d{4,5}$/.test(t)){ const n=+t; if(n>2200&&n<73510){ const dt=new Date(Date.UTC(1899,11,30)+n*86400000);   // Excel 日期序列号(如 27235=1974-07-25):表格未格式化成日期时被读成纯数字
    o.year=dt.getUTCFullYear(); o.month=dt.getUTCMonth()+1; o.day=dt.getUTCDate(); return o; } } }
  let m=s.match(/(\d{3,4})\s*年/)||s.match(/(?:^|\D)(\d{4})(?:\D|$)/); if(m&&+m[1]>=1000&&+m[1]<=2200)o.year=+m[1];
  if(o.year==null){ const cm=s.match(/([〇零一二三四五六七八九]{4})\s*年/); if(cm){ const y=+[...cm[1]].map(c=>_CNNUM[c]).join(""); if(y>=1000&&y<=2200)o.year=y; } }
  if(/闰/.test(s))o.leap=true;
  if(/农历|阴历|初[一二三四五六七八九十]|廿|卄|卅|腊月|冬月|正月|闰.{0,2}月|光绪|宣统|同治|咸丰|道光|嘉庆|乾隆|雍正|康熙|顺治|崇祯|万历|民国|[甲乙丙丁戊己庚辛壬癸][子丑寅卯辰巳午未申酉戌亥]/.test(s))o.is_lunar=true;
  let mo=s.match(/([正冬腊])月/); if(mo){ o.month=_LMON[mo[1]]; o.is_lunar=true; }
  else if((mo=s.match(/(?:闰)?\s*(\d{1,2})\s*月/)))o.month=+mo[1];
  else if((mo=s.match(/(?:闰)?\s*(十[一二]|[一二三四五六七八九]|十)\s*月/))){ const v=_cnNum(mo[1]); if(v)o.month=v; }
  const d=_cnDay(s); if(d!=null){ o.day=d; if(/初|廿|卄|卅/.test(s) || /[一二三四五六七八九十][日号]/.test(s))o.is_lunar=true; }   // 初/廿 或 中文数字日(如"十一日")=农历写法(公历日多写阿拉伯"11日")
  if(o.month==null||o.day==null){ const iso=s.match(/(\d{3,4})[\-\/.](\d{1,2})[\-\/.](\d{1,2})/); if(iso){ o.year=+iso[1];o.month=+iso[2];o.day=+iso[3]; } }
  if(o.month==null){ const i2=s.match(/(\d{3,4})[\-\/.](\d{1,2})(?![\-\/.\d])/); if(i2){ o.year=o.year||+i2[1];o.month=+i2[2]; } }
  if(o.month!=null&&(o.month<1||o.month>12))o.month=null; if(o.day!=null&&(o.day<1||o.day>31))o.day=null;
  return o; }
// 是否还需要 AI:客户端缺年(多为年号/民国,需AI换算)、或农历但缺月/日 时才调 AI
function needsAIDate(raw){ const cp=parseDateParts(raw); if(!cp.year)return true; if(cp.is_lunar)return !(cp.month&&cp.day); return false; }
// 客户端组件优先、AI 仅补缺(尤其年号年);用万年历把 公历↔农历 双向补齐;时间走 extractTime
function resolveDate(r, raw){
  r=r||{}; const out={birth:"",birth_lunar:"",birth_time:""}, p2=n=>String(n).padStart(2,"0"), LC=window.LUNARCONV;
  out.birth_time = extractTime(raw||"") || extractTime(r.time||"");
  const cp=parseDateParts(raw||"");
  const is_lunar = cp.is_lunar || r.is_lunar===true;
  const y = cp.year  || (Number.isInteger(r.year)?r.year:null);
  const m = cp.month || (Number.isInteger(r.month)?r.month:null);
  const d = cp.day   || (Number.isInteger(r.day)?r.day:null);
  const leap = cp.leap || r.leap===true;
  if(!y) return out;
  const sx=_shengXiao(y);   // 属相(加进农历字段)
  if(is_lunar){
    if(m&&d&&LC&&LC.ready){ const c=LC.lunarToSolar(y,m,d,!!leap); if(c){ out.birth=c.solar; out.birth_lunar=c.lunar; return out; } }   // c.lunar 已含属相
    out.birth=String(y); out.birth_lunar=(m&&d)?`农历${m}月${d}日 属${sx}`:`属${sx}`;   // 转换失败/缺月日:至少给年+属相
  } else if(m&&d){ out.birth=`${y}-${p2(m)}-${p2(d)}`; let lu=""; if(LC&&LC.ready){ const c=LC.solarToLunar(y,m,d); if(c) lu=c.lunar; } out.birth_lunar=lu||`属${sx}`; }
  else if(m){ out.birth=`${y}-${p2(m)}`; out.birth_lunar=`属${sx}`; } else { out.birth=String(y); out.birth_lunar=`属${sx}`; }
  return out;
}
// 表单失焦:统一走万年历拆 公历/农历/时辰(客户端优先,缺年的年号才调 AI),空的农历/时辰自动补
async function onBirthBlur(){
  const inp=$("#f_birth"), hint=$("#birthHint"); if(!inp) return; const raw=inp.value.trim();
  if(!raw){ if(hint) hint.textContent=""; return; }
  let g={}; if(needsAIDate(raw)){ if(hint){ hint.textContent="识别中…"; hint.style.color="#64748b"; } try{ g=(await aiNormalizeDates([raw]))[0]||{}; }catch(e){} }
  const rd=resolveDate(g, raw);
  if(rd.birth||rd.birth_lunar||rd.birth_time){ if(rd.birth) inp.value=rd.birth;
    const lf=$("#f_birth_lunar"); if(lf&&rd.birth_lunar&&!lf.value.trim()) lf.value=rd.birth_lunar;
    const tf=$("#f_birth_time");  if(tf&&rd.birth_time &&!tf.value.trim()) tf.value=rd.birth_time;
    if(hint){ hint.textContent="已按万年历拆为 公历/农历/时辰"; hint.style.color="#047857"; } }
  else if(hint){ hint.textContent="⚠无法识别,请填 年/年-月/年-月-日"; hint.style.color="#b45309"; }
}
// 批量规范:扫全部 birth → 规则 + AI兜底 → 预览(原→新,不识别标红)→ 勾选确认才改(可撤销)
const _messyDate = s => !(s||"").trim() || /\d{4}|时|分/.test(s);   // 空 或 含年/时=未拆的原始串,可被万年历清洗版覆盖
// 出生串里"被识别为日期/时间/属相"之外的残余文字(用于判断是否不符合规则);留 约/无考/前后 等当残余信号
function dateLeftover(raw){
  return String(raw||"")
    .replace(/光绪|宣统|同治|咸丰|道光|嘉庆|乾隆|雍正|康熙|顺治|崇祯|天启|万历|嘉靖|民国|生于?|殁于?|卒于?|葬于?|享年|于/g,"")
    .replace(/\d/g,"").replace(/[年月日号时点分秒]/g,"")
    .replace(/农历|阴历|公历|阳历|闰/g,"")
    .replace(/[零〇一二两三四五六七八九十廿卄卅]/g,"")
    .replace(/[正冬腊端荷巧桂菊阳寒]/g,"").replace(/初/g,"")
    .replace(/[子丑寅卯辰巳午未申酉戌亥]/g,"").replace(/[甲乙丙丁戊己庚辛壬癸]/g,"")
    .replace(/属?[鼠牛虎兔龙蛇马羊猴鸡狗猪]/g,"")
    .replace(/凌晨|清晨|早晨|早上|上午|中午|晌午|下午|傍晚|黄昏|晚上|夜里|夜间|半夜|子夜|早|晚|晌|夜|半|刻/g,"")
    .replace(/[\s\-\/.:：·,，。、;；()（）]/g,"").trim();
}
async function openDateNormalizer(){
  let mask=$("#dateNormMask"); if(!mask){ mask=el("div","mask"); mask.id="dateNormMask"; document.body.appendChild(mask); }
  // 只处理"非干净ISO"的记录(避免给全部已规范的公历批量加农历);对它们用万年历拆 公历/农历/时辰,缺年的年号才调 AI
  const todo=[]; state.persons.filter(p=>!p.deleted && (p.birth||"").trim()).forEach(p=>{ const raw=(p.birth||"").trim(); const nd=normalizeDate(raw); if(nd.ok && nd.value===raw) return; todo.push({p,raw}); });
  const rows=[]; const aiNeed=[...new Set(todo.filter(x=>needsAIDate(x.raw)).map(x=>x.raw))];
  mask.innerHTML=`<div class="modal" style="width:min(700px,100%)"><h2>规范出生日期</h2><p class="hint">正用万年历拆 ${todo.length} 条${aiNeed.length?(",其中 "+aiNeed.length+" 条年号/民国年调 AI 补年…"):"…"}</p></div>`;
  mask.classList.add("open");
  const mp={}; if(aiNeed.length){ try{ (await aiNormalizeDates(aiNeed)).forEach(r=>{ if(r&&r.input) mp[r.input]=r; }); }catch(e){} }
  todo.forEach(x=>{ const rd=resolveDate(mp[x.raw], x.raw); const patch={}, desc=[];
    if(rd.birth){ if(rd.birth!==x.raw) patch.birth=rd.birth; desc.push("公历 "+rd.birth); }
    else { patch.birth=""; desc.push("公历清空(无法解析)"); }                       // 解析不出→清掉乱串
    if(rd.birth_lunar && _messyDate(x.p.birth_lunar)){ patch.birth_lunar=rd.birth_lunar; desc.push("农历 "+rd.birth_lunar); }
    if(rd.birth_time  && _messyDate(x.p.birth_time)){  patch.birth_time =rd.birth_time;  desc.push("🕐"+rd.birth_time); }
    // 不符合规则的残余(无考/约X/夹带描述)→ 原文并进备注 + 状态存疑(幂等)
    if(!rd.birth || dateLeftover(x.raw).length>0 || /约|大约|前后|左右|许|无考|不详|未详|失考|待考|存疑/.test(x.raw)){
      const note0=(x.p.note||"").trim();
      if(!note0.includes("原日期记载")) patch.note=(note0?note0+" · ":"")+"原日期记载:"+x.raw;
      if((x.p.status||"")!=="存疑") patch.status="存疑";
      desc.push("→备注+存疑");
    }
    if(Object.keys(patch).length) rows.push({p:x.p,raw:x.raw,patch,desc:desc.join(" · "),src:needsAIDate(x.raw)?"AI+万年历":"万年历",ok:true}); });
  const good=rows.filter(r=>r.ok), bad=rows.filter(r=>!r.ok);
  const list=good.map((r,i)=>`<label class="mergerow"><input type="checkbox" class="dn" data-i="${i}" checked> <b>${esc(r.p.name||r.p.id)}</b> <span class="hint">「${esc(r.raw)}」→</span> <b style="color:#047857">${esc(r.desc)}</b> <span class="hint">(${esc(r.src)})</span></label>`).join("");
  const badList=bad.map(r=>`<div class="hint" style="color:#b45309;padding:.2rem 0">⚠ <b>${esc(r.p.name||r.p.id)}</b>:「${esc(r.raw)}」无法识别,请手动编辑</div>`).join("");
  mask.innerHTML=`<div class="modal" style="width:min(700px,100%)">
    <h2>规范出生日期 <span class="pill pill-info">${good.length}</span></h2>
    <p class="hint">拆成 公历日期 / 农历生辰(含属相) / 时辰(用万年历换算);<b>解析不出/约X/无考 等不规则的</b>:原文并进备注、状态标存疑。逐条核对,取消勾选不对的,确认后改(可撤销)。</p>
    ${_glmOff?'<p class="hint" style="color:#b45309">⚠ 第二模型(智谱 GLM)未启用——本次仅 DeepSeek 单模型识别,无双模型交叉校验,请对结果多加核对。</p>':''}
    <div style="max-height:52vh;overflow:auto">${list||'<div class="hint">没有需要规范的(都已是标准格式)。</div>'}${badList}</div>
    <div class="modal-foot">${good.length?`<label class="hint"><input type="checkbox" id="dnAll" checked> 全选</label>`:""}<span class="spacer"></span><button class="btn" id="dnCancel">关闭</button>${good.length?`<button class="btn btn-primary" id="dnOk">应用所选</button>`:""}</div>
  </div>`;
  $("#dnCancel").onclick=()=>mask.classList.remove("open"); mask.onclick=e=>{ if(e.target===mask) mask.classList.remove("open"); };
  const dnAll=$("#dnAll"); if(dnAll) dnAll.onclick=e=>mask.querySelectorAll(".dn").forEach(c=>c.checked=e.target.checked);
  const dnOk=$("#dnOk"); if(dnOk) dnOk.onclick=async()=>{
    const picks=[...mask.querySelectorAll(".dn:checked")].map(c=>good[+c.dataset.i]); if(!picks.length){ mask.classList.remove("open"); return; }
    dnOk.disabled=true; dnOk.textContent="应用中…"; let ok=0; const fails=[];
    for(const r of picks){ try{ await api("PUT","/api/persons/"+encodeURIComponent(r.p.id),r.patch); ok++; }catch(e){ fails.push((r.p.name||r.p.id)+":"+e.message); } }
    mask.classList.remove("open"); await reloadPersons(); await refreshRelCount(); renderHeader(); renderPeople(); renderHealth();
    if(fails.length) alert("已规范 "+ok+" 条,失败 "+fails.length+":\n"+fails.join("\n"));
  };
}

/* ---------- 表格导入(CSV/Excel)+ reconcile:按 姓名+出生年 匹配,逐条 合并/覆盖/跳过/新建 ---------- */
const IMPORT_FIELDS=[
  {k:"name",label:"姓名"},{k:"sex",label:"性别"},{k:"birth",label:"出生日期"},{k:"birth_lunar",label:"农历生辰"},{k:"birth_time",label:"出生时间"},{k:"death",label:"卒年"},
  {k:"alive",label:"在世"},{k:"char_gen",label:"字辈"},{k:"alias",label:"字号"},{k:"birth_place",label:"出生地"},
  {k:"occupation",label:"学历/职业"},{k:"company",label:"公司"},{k:"residence",label:"居地"},
  {k:"contact",label:"联系方式"},{k:"address",label:"住址"},{k:"deeds",label:"事迹"},{k:"note",label:"备注"},{k:"source",label:"来源"}
];
const IMPORT_HMAP={"姓名":"name","名字":"name","name":"name","性别":"sex","sex":"sex","出生":"birth","生年":"birth","出生日期":"birth","出生年月":"birth","生日":"birth","birth":"birth","农历":"birth_lunar","农历生辰":"birth_lunar","生辰":"birth_lunar","出生时间":"birth_time","时辰":"birth_time","出生地":"birth_place","籍贯":"birth_place","卒":"death","卒年":"death","享年":"death","在世":"alive","字辈":"char_gen","派字":"char_gen","字号":"alias","别名":"alias","学历":"occupation","职业":"occupation","occupation":"occupation","公司":"company","单位":"company","company":"company","工作单位":"company","居地":"residence","居住地":"residence","住址":"address","地址":"address","现住址":"address","联系方式":"contact","电话":"contact","手机":"contact","备注":"note","note":"note","来源":"source","事迹":"deeds","简历":"deeds"};
// 表头常见繁体字→简体(只为匹配关键词,不改写入值)
const _T2S={別:"别",號:"号",碼:"码",證:"证",類:"类",齡:"龄",歲:"岁",稱:"称",聯:"联",係:"系",話:"话",機:"机",職:"职",業:"业",曆:"历",歷:"历",鄉:"乡",貫:"贯",學:"学",單:"单",員:"员",傳:"传",備:"备",註:"注",來:"来",蹟:"迹",績:"绩",親:"亲",戶:"户",齒:"齿",鄰:"邻",鎮:"镇",縣:"县",點:"点",時:"时",歿:"殁",齡:"龄",藉:"籍",貫:"贯",檔:"档",編:"编",齡:"龄"};
const _simp = s => String(s||"").replace(/[一-鿿]/g,c=>_T2S[c]||c);
// 用关键词表猜列→字段:先繁转简、去空白小写,精确命中→子串包含(长关键词优先,避免"出生地"被"出生"抢走)
const _HMAP_KEYS = Object.keys(IMPORT_HMAP).sort((a,b)=>b.length-a.length);
function guessField(header){
  const h=_simp(header).trim().toLowerCase().replace(/\s+/g,""); if(!h) return "";
  if(IMPORT_HMAP[h]) return IMPORT_HMAP[h];
  for(const k of _HMAP_KEYS){ if(k.length>=2 && h.includes(_simp(k))) return IMPORT_HMAP[k]; }
  return "";
}
// AI 推荐列映射(人工审核);走 CF 代理 DeepSeek,editor 鉴权,失败抛错由调用方提示
async function aiMapColumns(headers, sample){
  const session=await window.SBAUTH.getSession(); const token=session&&session.access_token;
  const r=await fetch("/api/map-columns",{ method:"POST", headers:{ "content-type":"application/json", authorization:"Bearer "+(token||"") }, body:JSON.stringify({ headers, sample, fields:IMPORT_FIELDS.map(f=>({k:f.k,label:f.label})) }) });
  const j=await r.json().catch(()=>({})); if(!r.ok) throw new Error(j.error||("HTTP "+r.status)); return j.mapping||{};
}
let _imp=null;
function parseDelimited(text,delim){
  const rows=[]; let row=[],cell="",inQ=false;
  for(let i=0;i<text.length;i++){ const c=text[i];
    if(inQ){ if(c==='"'){ if(text[i+1]==='"'){cell+='"';i++;} else inQ=false; } else cell+=c; }
    else if(c==='"') inQ=true;
    else if(c===delim){ row.push(cell); cell=""; }
    else if(c==='\n'){ row.push(cell); rows.push(row); row=[]; cell=""; }
    else if(c==='\r'){}
    else cell+=c; }
  if(cell.length||row.length){ row.push(cell); rows.push(row); }
  return rows.filter(r=>r.some(x=>(x||"").trim()));
}
async function parseTable(file){
  const name=(file.name||"").toLowerCase();
  if(name.endsWith(".xlsx")||name.endsWith(".xls")){
    const XLSX=await import("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm");
    const buf=await file.arrayBuffer(); const wb=XLSX.read(buf,{type:"array"});
    const sh=wb.Sheets[wb.SheetNames[0]]; const aoa=XLSX.utils.sheet_to_json(sh,{header:1,defval:""}).filter(r=>r.some(c=>String(c||"").trim()));
    const note=wb.SheetNames.length>1?("注意:检测到 "+wb.SheetNames.length+" 个工作表,仅导入第一个「"+wb.SheetNames[0]+"」;合并单元格会致字段丢失,建议先取消合并。"):"";
    return { headers:(aoa[0]||[]).map(x=>String(x||"")), rows:aoa.slice(1), note };
  }
  let text=await file.text(); text=text.replace(/^﻿/,"");   // 去 BOM(Excel「CSV UTF-8」会加,自家导出也加)
  const lines=text.split(/\r?\n/).filter(l=>l.trim()).slice(0,8);   // 按前几行的众数判分隔符,比只看首行稳
  let tabs=0,commas=0; lines.forEach(l=>{ tabs+=(l.match(/\t/g)||[]).length; commas+=(l.match(/,/g)||[]).length; });
  const delim=(tabs>commas&&tabs>0)?"\t":",";
  const all=parseDelimited(text,delim);
  return { headers:(all[0]||[]).map(x=>String(x||"")), rows:all.slice(1) };
}
function openImporter(){ _imp={step:1,headers:[],rows:[],mapping:{},preview:[]}; let mask=$("#importMask"); if(!mask){ mask=el("div","mask"); mask.id="importMask"; document.body.appendChild(mask); } renderImporter(); mask.classList.add("open"); }
function renderImporter(){
  const mask=$("#importMask"); if(!mask) return;
  if(_imp.step===1){
    mask.innerHTML=`<div class="modal" style="width:min(560px,100%)"><h2>表格导入(CSV / Excel)</h2>
      <p class="hint">上传 .csv / .tsv / .xlsx(第一行须为表头)。按 <b>姓名 + 出生年</b> 匹配现有人,逐条让你选 合并/覆盖/跳过/新建,确认后才写(可在操作历史撤销)。<b>只导入人物字段,不导关系</b>。</p>
      <input type="file" id="impFile" accept=".csv,.tsv,.xlsx,.xls,text/csv,text/tab-separated-values">
      <div class="err" id="impErr"></div>
      <div class="modal-foot"><span class="spacer"></span><button class="btn" id="impCancel">取消</button></div></div>`;
    $("#impCancel").onclick=()=>mask.classList.remove("open"); mask.onclick=e=>{ if(e.target===mask) mask.classList.remove("open"); };
    $("#impFile").onchange=async e=>{ const f=e.target.files[0]; if(!f) return; $("#impErr").textContent="解析中…";
      try{ const {headers,rows,note}=await parseTable(f); if(!headers.length||!rows.length){ $("#impErr").textContent="没读到数据(需表头+至少1行数据)"; return; } _imp.note=note||"";
        _imp.headers=headers; _imp.rows=rows; _imp.mapping={};
        const _used=new Set();   // 同一字段不重复映射(第二个同义列降为忽略,人工再调)
        headers.forEach((h,i)=>{ let k=guessField(h); if(k&&_used.has(k)) k=""; _imp.mapping[i]=k; if(k)_used.add(k); });
        _imp.step=2; renderImporter();
      }catch(err){ $("#impErr").textContent="解析失败:"+err.message; } };
  } else if(_imp.step===2){
    const rowsHtml=_imp.headers.map((h,i)=>`<div class="mergerow"><b style="min-width:7em;display:inline-block">${esc(h||"(空列"+(i+1)+")")}</b> → <select class="impmap" data-i="${i}"><option value="">忽略</option>${IMPORT_FIELDS.map(f=>`<option value="${f.k}"${_imp.mapping[i]===f.k?" selected":""}>${esc(f.label)}</option>`).join("")}</select> <span class="hint">例:${esc(String((_imp.rows[0]&&_imp.rows[0][i])||"").slice(0,18))}</span></div>`).join("");
    mask.innerHTML=`<div class="modal" style="width:min(640px,100%)"><h2>列映射(${_imp.rows.length} 行)</h2>${_imp.note?`<p class="hint" style="color:#b45309">${esc(_imp.note)}</p>`:""}
      <p class="hint">把每列对到人物字段(已自动猜,核对)。<b>姓名必须映射</b>;选「忽略」的列不导入。猜不准可点 🤖 让 AI 推荐,再人工核对。</p>
      <div style="margin:.2rem 0 .5rem"><button class="btn btn-sm" id="impAimap">🤖 AI 推荐映射</button> <span class="hint" id="impAimapMsg"></span></div>
      <div style="max-height:48vh;overflow:auto">${rowsHtml}</div><div class="err" id="impErr"></div>
      <div class="modal-foot"><button class="btn" id="impBack">上一步</button><span class="spacer"></span><button class="btn btn-primary" id="impNext">下一步:匹配预览</button></div></div>`;
    mask.querySelectorAll(".impmap").forEach(s=>s.onchange=()=>{ _imp.mapping[+s.dataset.i]=s.value; });
    $("#impAimap").onclick=async()=>{ const b=$("#impAimap"), m=$("#impAimapMsg"); b.disabled=true; b.textContent="AI 推荐中…"; if(m)m.textContent="";
      try{ const sample=_imp.headers.map((h,i)=>String((_imp.rows[0]&&_imp.rows[0][i])||"").slice(0,40));
        const mp=await aiMapColumns(_imp.headers, sample); let n=0;
        _imp.headers.forEach((h,i)=>{ const k=mp[String(i)]; if(k!==undefined && (k===""||IMPORT_FIELDS.some(f=>f.k===k))){ if(_imp.mapping[i]!==k)n++; _imp.mapping[i]=k; } });
        renderImporter(); const m2=$("#impAimapMsg"); if(m2)m2.textContent=`AI 已推荐(改动 ${n} 列),请核对`;
      }catch(e){ b.disabled=false; b.textContent="🤖 AI 推荐映射"; const m3=$("#impAimapMsg"); if(m3){ m3.style.color="#dc2626"; m3.textContent="AI 推荐失败:"+e.message; } } };
    $("#impBack").onclick=()=>{ _imp.step=1; renderImporter(); };
    $("#impNext").onclick=async()=>{ if(!Object.values(_imp.mapping).includes("name")){ $("#impErr").textContent="请把某列映射为「姓名」"; return; } $("#impErr").textContent="匹配 + 识别日期中(含农历/时辰)…"; await buildImportPreview(); _imp.step=3; renderImporter(); };
  } else { renderImportPreview(); }
}
const normName = s => (s||"").normalize("NFKC").replace(/\s+/g,"").trim();   // 匹配键:折叠全/半角空白(只用于匹配,不改写入值)
function matchIncoming(inc){
  const nm=(inc.name||"").trim(), key=normName(inc.name);
  const yr=(inc.birth||"").match(/\d{4}/), y=yr?yr[0]:null;
  const same=state.persons.filter(p=>!p.deleted && normName(p.name)===key);
  let cands=same, byYear=false;
  if(y){ const yc=same.filter(p=>{ const m=(p.birth||"").match(/\d{4}/); return m&&m[0]===y; }); if(yc.length){ cands=yc; byYear=true; } }   // 生年命中才用它过滤;不命中退回全部同名(不丢匹配)
  // 用户偏好(2026-06-29 重新导入补全):有同名现有就【默认指向它】(优先生年命中,否则第一个同名)、处理【默认覆盖】;无同名才新建。
  // 安全:覆盖只写"导入有值"的字段、绝不用空值抹掉已有(runImport line ~1428 保证);仅按姓名/多同名会显著标黄提示;逐条可改、整批可撤销。
  const hasMatch = same.length>=1, tgt = hasMatch?cands[0]:null;
  const tYr = tgt ? (((tgt.birth||"").match(/\d{4}/)||[])[0]||null) : null;
  const yearConflict = !!(hasMatch && !byYear && y && tYr && tYr!==y);   // 导入有生年、命中对象也有生年但不同→疑似不同人,标红
  return { inc, nm, y, byYear, yearConflict, options:same, target:(hasMatch?cands[0].id:"__new__"), strategy:(hasMatch?"overwrite":"new") };
}
// 异步:出生日期 规则优先,复杂的(农历/年号/带时辰)交 AI → 拆出 公历birth / 农历birth_lunar / 时辰birth_time,再匹配
async function buildPreviewFromIncoming(incList){
  const list=incList.filter(inc=>(inc.name||"").trim());
  _imp.skippedNoName = incList.length - list.length;   // 无姓名行被静默过滤,在预览标题里如实告知
  const aiNeed=new Set();
  list.forEach(inc=>{ const b=(inc.birth||"").trim(), bl=(inc.birth_lunar||"").trim();
    const raw = _DATESIG.test(b)?b:(_DATESIG.test(bl)?bl:b); if(!raw){ return; } inc._braw=raw;   // 日期可能在 birth 或 农历列
    if(needsAIDate(raw) || (parseDateParts(raw).is_lunar && parseDateParts(raw).year)) aiNeed.add(raw); });   // 农历/年号送双AI验证
  const mp={}; if(aiNeed.size){ try{ (await aiNormalizeDatesDual([...aiNeed])).forEach(r=>{ if(r&&r.input) mp[r.input]=r; }); }catch(e){} }
  const messy = s => !(s||"").trim() || /\d{4}|时|分/.test(s);   // 空 或 含年/时=未拆原串,可被万年历清洗版覆盖
  list.forEach(inc=>{ if(!inc._braw) return; const raw=inc._braw; const rd=resolveDate(mp[raw], raw);
    if(rd.birth) inc.birth=rd.birth; else inc.birth=raw;                             // 公历(认不出保留原文)
    if(rd.birth_lunar && messy(inc.birth_lunar)) inc.birth_lunar=rd.birth_lunar;      // 农历(双向补齐)
    if(rd.birth_time  && messy(inc.birth_time))  inc.birth_time =rd.birth_time;       // 时辰
    inc._dateWarn = dateConflictNote(raw, mp[raw]);                                   // 两模型不一致→预览标红
    delete inc._braw; });
  _imp.preview = list.map(matchIncoming);
}
function buildImportPreview(){
  const incs=_imp.rows.map(r=>{ const inc={}; Object.keys(_imp.mapping).forEach(i=>{ const k=_imp.mapping[i]; if(!k) return; inc[k]=(r[i]==null?"":String(r[i])).trim(); }); return inc; });
  return buildPreviewFromIncoming(incs);   // async:含 AI 识别年月日+时辰
}
function renderImportPreview(){
  const mask=$("#importMask"); if(!mask) return; const P=_imp.preview;
  const newCount=P.filter(x=>x.target==="__new__").length;
  const rows=P.map((x,i)=>{
    const sum=[x.inc.name,x.inc.sex,x.inc.birth,x.inc.birth_time&&("🕐"+x.inc.birth_time),x.inc.birth_lunar&&("农历:"+x.inc.birth_lunar),x.inc.company].filter(Boolean).join(" · ");
    const dwarn=(x.target!=="__skip__"&&x.inc._dateWarn)?` <span class="hint" style="color:#dc2626;font-weight:600">⚠ ${esc(x.inc._dateWarn)}</span>`:"";
    const opts=`<option value="__new__"${x.target==="__new__"?" selected":""}>➕ 新建</option><option value="__skip__"${x.target==="__skip__"?" selected":""}>🚫 忽略(不导入)</option>`+(x.options||[]).map(p=>`<option value="${esc(p.id)}"${x.target===p.id?" selected":""}>${esc(p.name)}·${esc(p.birth||"无生年")}·${esc(p.id)}</option>`).join("");
    const strat = x.target==="__new__" ? `<span class="hint">新建</span>` : (x.target==="__skip__" ? `<span class="hint" style="color:#94a3b8">不导入</span>` : `<select class="imp-strat" data-i="${i}"><option value="merge"${x.strategy==="merge"?" selected":""}>合并·填空</option><option value="overwrite"${x.strategy==="overwrite"?" selected":""}>覆盖</option><option value="skip"${x.strategy==="skip"?" selected":""}>跳过</option></select>`);
    const warn = (x.target==="__new__"||x.target==="__skip__") ? ''
      : ((x.options||[]).length>1 ? ` <span class="hint" style="color:#b45309;font-weight:600">⚠ 多个同名(${(x.options||[]).length}),已默认第一个,务必核对</span>`
        : (x.yearConflict ? ` <span class="hint" style="color:#dc2626;font-weight:600">⚠ 生年不一致(现有 ${esc(((byId(x.target)||{}).birth)||"?")}),可能非同一人,请核对</span>`
          : (!x.byYear ? ' <span class="hint" style="color:#b45309">按姓名匹配(现有缺生年),可填补</span>'
            : ' <span class="hint" style="color:#15803d">✓ 姓名+生年命中</span>')));
    return `<tr><td>${esc(sum)}${dwarn}${warn}</td><td><select class="imp-match" data-i="${i}">${opts}</select></td><td>${strat}</td></tr>`;
  }).join("");
  const skipCount=P.filter(x=>x.target==="__skip__").length;
  mask.innerHTML=`<div class="modal" style="width:min(840px,100%)"><h2>匹配预览(${P.length} 行 · 新建 ${newCount}${skipCount?(" · 忽略 "+skipCount):""}${_imp.skippedNoName?(" · 空名跳过 "+_imp.skippedNoName):""})</h2>
    <p class="hint">左=导入数据,中=匹配到谁(可改/新建/<b>忽略不导入</b>),右=命中现有时怎么处理。<b>合并·填空</b>只补空字段(不动已有);<b>覆盖</b>用导入值覆盖;<b>跳过</b>不动。</p>
    <div style="margin:.3rem 0">命中现有的全部设为: <button class="btn btn-sm" data-all="merge">合并</button> <button class="btn btn-sm" data-all="overwrite">覆盖</button> <button class="btn btn-sm" data-all="skip">跳过</button> <button class="btn btn-sm" data-skipwarn="1" title="把生年不一致/多同名的行全部设为忽略">🚫 忽略全部有警告的</button></div>
    <div style="max-height:50vh;overflow:auto"><table class="roster"><thead><tr><th>导入数据</th><th>匹配到</th><th>处理</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="err" id="impErr"></div>
    <div class="modal-foot"><button class="btn" id="impBack">上一步</button><span class="spacer"></span><button class="btn btn-primary" id="impRun">确认导入</button></div></div>`;
  mask.querySelectorAll(".imp-match").forEach(s=>s.onchange=()=>{ const i=+s.dataset.i; _imp.preview[i].target=s.value; _imp.preview[i].strategy=(s.value==="__new__")?"new":(_imp.preview[i].strategy==="new"?"overwrite":_imp.preview[i].strategy); renderImporter(); });   // 选中现有→默认覆盖(与默认一致)
  mask.querySelectorAll(".imp-strat").forEach(s=>s.onchange=()=>{ _imp.preview[+s.dataset.i].strategy=s.value; });
  mask.querySelectorAll("[data-all]").forEach(b=>b.onclick=()=>{ _imp.preview.forEach(x=>{ if(x.target!=="__new__"&&x.target!=="__skip__") x.strategy=b.dataset.all; }); renderImporter(); });
  { const sb=mask.querySelector("[data-skipwarn]"); if(sb) sb.onclick=()=>{ _imp.preview.forEach(x=>{ if(x.yearConflict||(x.options||[]).length>1||x.inc._dateWarn) x.target="__skip__"; }); renderImporter(); }; }   // 一键忽略所有有警告(生年不一致/多同名/两模型分歧)的行
  $("#impBack").onclick=()=>{ _imp.step=2; renderImporter(); };
  $("#impRun").onclick=runImport;
}
async function runImport(){
  const mask=$("#importMask"), P=_imp.preview, btn=$("#impRun"); btn.disabled=true; btn.textContent="导入中…";
  let created=0,merged=0,over=0,skipped=0; const fails=[];
  const clean=inc=>{ const o={}; Object.keys(inc).forEach(k=>{ const v=(inc[k]||"").trim(); if(v) o[k]=v; }); return o; };
  // 止血①:本批新建的行一次性预分配 ID,消灭 createPerson 内逐行 nextId 全表扫(原 O(N^2) → O(1) 一次取号)
  const newRows=P.filter(x=>x.target==="__new__"&&x.nm);
  try{ if(newRows.length){ const ids=await window.allocIds(newRows.length); newRows.forEach((x,k)=>{ if(ids[k]) x._allocId=ids[k]; }); } }catch(e){ /* 取号失败→回退逐行 nextId(见下并发降级) */ }
  const allNewHaveIds = newRows.every(x=>x._allocId);
  const doRow=async(x)=>{
    if(x.target==="__skip__"){ skipped++; return; }   // 忽略=完全不导入
    if(x.target==="__new__"){ if(!x.nm) return; const body={ ...clean(x.inc), status:(x.inc.status||"待考") }; if(x._allocId) body.id=x._allocId; await api("POST","/api/persons",body); created++; return; }
    const ex=byId(x.target); if(!ex){ fails.push(x.nm+":匹配对象不存在"); return; }
    if(ex.deleted){ fails.push(x.nm+":目标已在回收站,已跳过"); return; }   // 防 stale/并发改回收站
    if(x.strategy==="skip"){ skipped++; return; }
    const patch={}; Object.keys(x.inc).forEach(k=>{ const v=(x.inc[k]||"").trim(); if(!v) return;
      if(x.strategy==="merge"){ if(!((ex[k]||"").trim())) patch[k]=v; } else patch[k]=v; });   // merge 只补空、绝不用空值抹已有
    if(Object.keys(patch).length){ await api("PUT","/api/persons/"+encodeURIComponent(x.target),patch); if(x.strategy==="merge")merged++; else over++; } else skipped++;
  };
  // 止血②:有上限的并发池(墙钟≈总往返/并发度)。预分配 ID 成功才并发;失败则降级串行,保留原 nextId 串行不撞号的安全性。
  const LIMIT = allNewHaveIds ? 8 : 1; let i=0;
  await Promise.all(Array.from({length:Math.min(LIMIT,P.length||1)}, async()=>{ while(i<P.length){ const x=P[i++]; try{ await doRow(x); }catch(e){ fails.push((x.nm||"?")+":"+(e.message||e)); } } }));
  mask.classList.remove("open"); await reloadPersons(); await refreshRelCount(); renderHeader(); renderPeople(); renderHealth();
  alert(`导入完成:新建 ${created} · 合并 ${merged} · 覆盖 ${over} · 跳过 ${skipped}`+(fails.length?`\n失败 ${fails.length}:\n`+fails.slice(0,12).join("\n"):"")+"\n(均可在操作历史撤销)");
}

/* ---------- AI 批量添加(粘贴文字 → DeepSeek 识别 → 草稿审核 → 创建)---------- */
let _aiDrafts=[];
// 世代(派生)/本族外部 已不在草稿;配偶/母/父(文字)暂留(写入退役列,供 v0.11 整理为关系)。
const AI_DRAFT_FIELDS=[
  {k:"name",label:"姓名"},{k:"sex",label:"性别",type:"sex"},
  {k:"char_gen",label:"字辈"},{k:"rank",label:"行第"},
  {k:"birth",label:"出生(公历)"},{k:"birth_lunar",label:"农历生(含属相)"},{k:"birth_time",label:"出生时间"},{k:"death",label:"卒年"},
  {k:"birth_place",label:"出生地"},{k:"occupation",label:"职业"},{k:"residence",label:"居地"},
  {k:"spouse",label:"配偶(暂存)"},{k:"mother",label:"母(暂存)"},{k:"father_note",label:"父(文字)"},{k:"note",label:"备注"}
];
// 农历日期落在该年闰月、但原文没标"闰"→ 歧义(正月 vs 闰月差约一个月)。返回闰月号(0=无歧义)
function lunarLeapAmbiguous(raw){ const cp=parseDateParts(raw); if(!(cp.is_lunar&&cp.year&&cp.month&&!cp.leap)) return 0; const lc=window.LUNARCONV; const lm=(lc&&lc.leapMonthOf)?lc.leapMonthOf(cp.year):0; return lm===cp.month?lm:0; }
// 出生串里"含日期信号"的判断:用于在 birth / 农历 两个字段里挑出真正放了日期的那个
const _DATESIG=/\d{4}|年|时|初|廿|卄|卅|腊月|冬月|正月|闰|[一二三四五六七八九十][日号]|[子丑寅卯辰巳午未申酉戌亥]时/;
// 把草稿的出生串用万年历拆成 公历/农历(属相)/时辰(客户端优先);农历/年号等送双AI(DeepSeek+GLM)验证。幂等,供 识别 与 创建 共用
async function cleanDraftsDates(drafts){
  const need=new Set();
  drafts.forEach(d=>{ const b=(d.birth||"").trim(), bl=(d.birth_lunar||"").trim();
    const raw = _DATESIG.test(b)?b:(_DATESIG.test(bl)?bl:b);   // DeepSeek 有时把整串(年月日时)塞进农历字段→取含日期信号的那个当源
    d._braw=raw; if(raw && (needsAIDate(raw) || (parseDateParts(raw).is_lunar && parseDateParts(raw).year))) need.add(raw); });   // 农历(带年)也送 AI 做双重验证
  const mp={}; if(need.size){ try{ (await aiNormalizeDatesDual([...need])).forEach(r=>{ if(r&&r.input) mp[r.input]=r; }); }catch(e){} }
  drafts.forEach(d=>{ const raw=d._braw; delete d._braw; d._leapWarn=""; d._dateWarn=""; if(!raw) return;
    const rd=resolveDate(mp[raw], raw);
    if(rd.birth) d.birth=rd.birth;
    if(rd.birth_lunar && _messyDate(d.birth_lunar)) d.birth_lunar=rd.birth_lunar;
    if(rd.birth_time && _messyDate(d.birth_time)) d.birth_time=rd.birth_time;
    // DeepSeek 常把"属羊"塞进备注;换算后农历已含属相 → 去掉纯属相的冗余备注
    if(/^属[鼠牛虎兔龙蛇马羊猴鸡狗猪]$/.test((d.note||"").trim()) && /属[鼠牛虎兔龙蛇马羊猴鸡狗猪]/.test(d.birth_lunar||"")) d.note="";
    const lm=lunarLeapAmbiguous(raw); if(lm) d._leapWarn=`农历${lm}月落在闰${lm}月之年,已按正${lm}月算→${d.birth};若实为闰月,用万年历勾「闰月」改`;
    d._dateWarn = dateConflictNote(raw, mp[raw]);   // DeepSeek 与 GLM 判断不一致→提示
  });
  const vals=Object.values(mp);
  return { ai:vals.length, dual:vals.filter(r=>r&&r._glm).length, conflicts:vals.filter(r=>r&&r._conflict).length };   // 供 UI 显示"双验证 N 条"
}
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
    msg.textContent=`识别到 ${_aiDrafts.length} 人,正用万年历换算日期/时辰…`;
    const st=await cleanDraftsDates(_aiDrafts);   // 当场拆 公历/农历(属相)/时辰,所见即所得(不必等创建)
    const dualNote = st&&st.dual ? `,DeepSeek+GLM 双验证 ${st.dual} 条日期${st.conflicts?(`,${st.conflicts} 条两模型不一致已标红`):`(均一致)`}` : (st&&st.ai?`(GLM 未参与——检查 GLM_API_KEY)`:``);
    msg.textContent=`识别到 ${_aiDrafts.length} 人,日期已按万年历换算${dualNote},请核对补齐后创建`;
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
    const lw=d._leapWarn?`<span class="aidup" style="background:#fef9c3;color:#854d0e;border-color:#fde68a">⚠ ${esc(d._leapWarn)}</span>`:"";
    const dw=d._dateWarn?`<span class="aidup" style="background:#fee2e2;color:#991b1b;border-color:#fecaca">⚠ ${esc(d._dateWarn)}</span>`:"";
    return `<div class="aidraft${d._skip?" skipped":""}"><div class="aidraft-h">#${i+1} ${esc(d.name||"(未命名)")} ${warn}${lw}${dw} <button class="btn btn-sm aidraft-del" data-i="${i}">删除此条</button></div><div class="aidraft-grid">`
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
  const btn=$("#aiCreateAll"); btn.disabled=true; btn.textContent="识别日期+创建中…";
  await cleanDraftsDates(valid);   // 兜底再拆一次(识别时已拆;用户若手改了出生串这里纠正),幂等
  let ok=0, fail=0;
  for(const d of valid){ try{ await api("POST","/api/persons",{ ...d, status:"待考" }); ok++; }catch(e){ fail++; } }
  btn.textContent="全部新建为人物";
  btn.disabled=false;
  await reloadPersons(); renderPeople(); renderHeader();
  $("#aiMsg").textContent=`已创建 ${ok} 人${fail?(",失败 "+fail):""}`;
  _aiDrafts=[]; renderAIDrafts();
  if(!fail) setTimeout(()=>$("#aiMask").classList.remove("open"), 1200);
}
// AI 草稿走 reconcile:按 姓名+生年 匹配现有 → 逐条 合并/覆盖/跳过/新建(复用表格导入预览)
async function aiReconcile(){
  const valid=_aiDrafts.filter(d=>(d.name||"").trim() && !d._skip);
  if(!valid.length){ alert("没有可用草稿(需姓名,且未勾「跳过」)"); return; }
  const incs=valid.map(d=>{ const inc={}; IMPORT_FIELDS.forEach(f=>{ const v=String(d[f.k]==null?"":d[f.k]).trim(); if(v) inc[f.k]=v; }); return inc; });   // birth 识别交 buildPreviewFromIncoming
  _imp={step:3,headers:[],rows:[],mapping:{},preview:[]};
  const msg=$("#aiMsg"); if(msg) msg.textContent="匹配 + 识别日期中(含农历/时辰)…";
  await buildPreviewFromIncoming(incs);
  const aiM=$("#aiMask"); if(aiM) aiM.classList.remove("open");
  let mask=$("#importMask"); if(!mask){ mask=el("div","mask"); mask.id="importMask"; document.body.appendChild(mask); }
  renderImportPreview(); mask.classList.add("open");
}


/* 事件绑定(从 app.js 迁来) */
$("#aiBtn")       && ($("#aiBtn").onclick=openAI);
$("#importBtn")   && ($("#importBtn").onclick=openImporter);
$("#aiParse")     && ($("#aiParse").onclick=aiParse);
$("#aiCreateAll") && ($("#aiCreateAll").onclick=aiCreateAll);
$("#aiReconcile") && ($("#aiReconcile").onclick=aiReconcile);
$("#aiFileBtn")   && ($("#aiFileBtn").onclick=()=>$("#aiFile").click());
$("#aiFile")      && ($("#aiFile").onchange=async e=>{ const f=e.target.files[0]; e.target.value=""; if(!f) return;
  if(f.size>3*1024*1024){ $("#aiMsg").textContent="文件过大(>3MB),请拆分或转文本"; return; }
  try{ const txt=await f.text(); $("#aiText").value=txt; $("#aiMsg").textContent="已读入「"+f.name+"」("+txt.length+" 字),点「识别」"; }
  catch(err){ $("#aiMsg").textContent="读取失败(请用 txt/csv 等文本文件):"+err.message; } });
$("#aiClose")     && ($("#aiClose").onclick=()=>$("#aiMask").classList.remove("open"));
$("#aiMask")      && ($("#aiMask").onclick=e=>{ if(e.target===$("#aiMask")) $("#aiMask").classList.remove("open"); });

/* 暴露给 app.js / 跨块 裸调用 */
Object.assign(window, { normalizeDate, aiNormalizeDates, aiNormalizeDatesGLM, aiNormalizeDatesDual, dateConflictNote, shengXiaoLabel, _cnNum, _applyPeriod, extractTime, _cnDay, parseDateParts, needsAIDate, resolveDate, onBirthBlur, dateLeftover, openDateNormalizer, guessField, aiMapColumns, parseDelimited, parseTable, openImporter, renderImporter, matchIncoming, buildPreviewFromIncoming, buildImportPreview, renderImportPreview, runImport, lunarLeapAmbiguous, cleanDraftsDates, openAI, aiParse, renderAIDrafts, aiCreateAll, aiReconcile, _SHICHEN12, _shichenOf, _SHENGXIAO, _shengXiao, _CNNUM, _PERIODRE, _LMON, _messyDate, IMPORT_FIELDS, IMPORT_HMAP, _T2S, _simp, _HMAP_KEYS, _imp, normName, _aiDrafts, AI_DRAFT_FIELDS, _DATESIG });

