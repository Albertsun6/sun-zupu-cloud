// ============================================================
// tree-classic.js —— 传统族谱挂图(竖排·紧凑·一页可览)
// 仿手绘族谱:名字**竖排**、按世代分层成行、夫妻同框(本人在上/配偶在下)、
// **男女不同色**(男蓝/女粉)、**无字辈无生卒无"配"字**、直角折线连父子兄弟。
// 默认整棵树缩放到**一页可见**;可缩放细看、可打印存 PDF。
//
// 依赖(app.js 经 window 暴露,本模块裸引用):
//   state,$,el,esc,byId,genOf,surnameOfSelf,familiesOf,lineageOf,charGenFor,lineagesList,DIRECT_LINE,openDetail
//   + state.fatherOf/motherOf/childrenMap/spouseOf
// ============================================================

const CT = { BOX_W: 26, COL: 38, ROW_GAP: 32, HEADER_H: 12, GUTTER_W: 42, PAD_L: 12 };
const SEX_COLOR = { "男": "#1d4ed8", "女": "#db2777" };          // 男=蓝 女=粉;未知=灰
const sexColor = p => SEX_COLOR[(p && p.sex)] || "#64748b";

// 框内"配偶名"= 与本人有夫妻关系、本身不单独成框(嫁入者)且未软删者
function ctInnerSpouses(id, nodeSet){
  return (state.spouseOf[id] || [])
    .filter(s => !nodeSet.has(s) && byId(s) && !byId(s).deleted)
    .filter((s, i, a) => a.indexOf(s) === i);
}
function ctLineage(){
  if (state.classicLineage) return state.classicLineage;
  const list = lineagesList();
  const sun = list.find(l => l.name === "孙氏");
  return (state.classicLineage = sun ? sun.name : (list[0] ? list[0].name : "孙氏"));
}

// ---- 父系森林(骨架=父系同姓,嫁入者收进框内)----
function buildClassicForest(LIN){
  const live = state.persons.filter(p => !p.deleted);
  const liveSet = new Set(live.map(p => p.id));
  const isBlood = id => surnameOfSelf(id) === LIN;
  const hasBloodChild = id => (state.childrenMap[id] || []).some(c => liveSet.has(c) && isBlood(c));
  const bloodParentInSet = id => (liveSet.has(state.fatherOf[id]) && isBlood(state.fatherOf[id])) || (liveSet.has(state.motherOf[id]) && isBlood(state.motherOf[id]));
  const nodes = live.map(p => p.id).filter(id => isBlood(id) && (bloodParentInSet(id) || hasBloodChild(id)));
  const nodeSet = new Set(nodes);
  const parentOf = id => {
    const f = state.fatherOf[id]; if (nodeSet.has(f)) return f;
    const m = state.motherOf[id]; if (nodeSet.has(m)) return m;
    return null;
  };
  const sexRank = p => p.sex === "男" ? 0 : (p.sex === "女" ? 1 : 2);   // 同辈:男前 女后 性别未知最后
  const sortKey = id => {
    const p = byId(id) || {}; const g = genOf(id); const so = parseInt(p.sort_order, 10); const yrm = (p.birth || "").match(/\d{4}/);
    return [g == null ? 9999 : g, sexRank(p), yrm ? +yrm[0] : 9999, isNaN(so) ? 0 : so, id];   // 世代→性别(男前女后)→出生年(长幼)→手排号→ID
  };
  const cmp = (a, b) => { const ka = sortKey(a), kb = sortKey(b);
    for (let i = 0; i < ka.length; i++){ if (ka[i] < kb[i]) return -1; if (ka[i] > kb[i]) return 1; } return 0; };
  const children = {};
  nodes.forEach(id => { const par = parentOf(id); if (par != null) (children[par] = children[par] || []).push(id); });
  Object.keys(children).forEach(k => children[k].sort(cmp));
  // 根的排序键:世代锚点,无锚点视为 1(最老)——新补的始祖常没填世代,若按普通键(null=9999)会被排到断片之后、抢走最右"长房"位
  const rootKey = id => { const g = genOf(id); return g != null ? g : 1; };
  const roots = nodes.filter(id => parentOf(id) == null).sort((a, b) => rootKey(a) - rootKey(b) || cmp(a, b));

  // 横坐标(raw,叶子计数):父框**压在长子正上方**(取 kids[0] 的 x,不再取中点)——
  // 老祖宗主干因此成一条竖直线;整图再经镜像(见 renderClassicTree 的 mx)变成古式"长在右、自右向左读"。
  const X = {}; const seen = new Set(); let leaf = 0;
  const assign = id => {
    if (seen.has(id)) return; seen.add(id);
    const kids = children[id] || [];
    if (!kids.length){ X[id] = leaf++; return; }
    kids.forEach(assign);
    const xs = kids.filter(k => X[k] != null);
    X[id] = xs.length ? X[xs[0]] : leaf++;   // 压长子正上方(长子 x = 本支最小叶,镜像后=本支最右)
  };
  roots.forEach(assign);
  nodes.forEach(id => { if (X[id] == null) X[id] = leaf++; });

  // 世代行:genOf 对齐世代,但强制"子行>父行"(防 genOf 偶发不一致致父子同行重叠)
  const band = {};
  const compBand = (id, parentBand) => {
    if (band[id] != null) return;
    const g = genOf(id);
    band[id] = (parentBand == null) ? (g != null ? g : 1) : Math.max(g != null ? g : (parentBand + 1), parentBand + 1);
    (children[id] || []).forEach(c => compBand(c, band[id]));
  };
  roots.forEach(r => compBand(r, null));
  nodes.forEach(id => { if (band[id] == null) band[id] = (genOf(id) != null ? genOf(id) : 1); });

  const shownAsSpouse = new Set();
  nodes.forEach(id => ctInnerSpouses(id, nodeSet).forEach(s => shownAsSpouse.add(s)));
  const orphans = live.map(p => p.id)
    .filter(id => isBlood(id) && !nodeSet.has(id) && !shownAsSpouse.has(id))
    .sort(cmp);

  return { nodes, nodeSet, children, roots, X, band, parentOf, leafCount: leaf, orphans };
}

// ---- 主渲染(测高布局:竖排框高随内容,逐代行高取本代最高框)----
function renderClassicTree(){
  const box = $("#treeBox");
  if (!box) return;
  const LIN = ctLineage();
  let F;
  try { F = buildClassicForest(LIN); }
  catch (e){ box.innerHTML = `<p class="note">谱图生成失败:${esc(e.message || e)}</p>`; return; }

  const fams = lineagesList();
  const famOpts = fams.map(l => `<option value="${esc(l.name)}"${l.name === LIN ? " selected" : ""}>${esc(famCfgLabel(l.name) || l.name)}(${l.count})</option>`).join("");

  if (!F.nodes.length){
    box.innerHTML = ctControlsHtml(famOpts, 1)
      + ctHeaderHtml(LIN, F)
      + `<p class="note">「${esc(LIN)}」暂无可绘制的父系谱系。${F.orphans.length ? "下列本族成员可在「名册→详情」里补上父亲后归位。" : "可在「名册」给成员连上父亲后再来。"}</p>`
      + ctAppendixHtml(F);
    ctBindControls();
    box.querySelectorAll(".ct-orphan").forEach(a => a.onclick = () => { const p = byId(a.dataset.pid); if (p) openDetail(p); });
    return;
  }

  // ---- 待接续(无父子连接的本族成员):像孙景发那样,作为普通浮框接在各自世代行的行末(raw 在右,镜像后=最左端;无上连线、无独立面板/标签/虚线)----
  const ORPHAN_GAP = 2;                                  // 与主树之间留一点点空隙(列)
  const rightBase = F.leafCount + ORPHAN_GAP;
  const bandsMain = [...new Set(F.nodes.map(id => F.band[id]))];
  const maxMainBand = bandsMain.length ? Math.max(...bandsMain) : 1;
  const NULL_BAND = maxMainBand + 1;                     // 世代未定者放最底一行
  const orphanBand = {}, orphanX = {};
  if (F.orphans.length){
    const osex = id => { const s = (byId(id) || {}).sex; return s === "男" ? 0 : (s === "女" ? 1 : 2); };
    const oyr = id => { const m = ((byId(id) || {}).birth || "").match(/\d{4}/); return m ? +m[0] : 9999; };
    const byB = {};
    F.orphans.forEach(o => { const g = genOf(o); const b = (g == null ? NULL_BAND : g); orphanBand[o] = b; (byB[b] = byB[b] || []).push(o); });
    Object.keys(byB).forEach(b => { byB[b].sort((a, c) => osex(a) - osex(c) || oyr(a) - oyr(c) || (a < c ? -1 : a > c ? 1 : 0));
      byB[b].forEach((o, i) => { orphanX[o] = rightBase + i; }); });
  }
  const isOrphan = id => orphanBand[id] !== undefined;
  const bandOf = id => isOrphan(id) ? orphanBand[id] : F.band[id];   // 待接续落在自己 genOf 的世代行(与主树该世代对齐)
  const xOf = id => isOrphan(id) ? orphanX[id] : F.X[id];
  const drawn = F.nodes.concat(F.orphans);
  const bands = [...new Set(drawn.map(bandOf))].sort((a, b) => a - b);
  const maxX = Math.max(F.leafCount - 1, ...(F.orphans.length ? F.orphans.map(o => orphanX[o]) : [0]));
  // 古式镜像:raw x(长在左)→ maxX-x(长在右、自右向左读);老祖宗主干贴最右、待接续被镜到最左端
  const mx = id => maxX - xOf(id);
  const cx = id => CT.GUTTER_W + CT.PAD_L + mx(id) * CT.COL + CT.BOX_W / 2;
  const boxLeft = id => cx(id) - CT.BOX_W / 2;
  const totalW = CT.GUTTER_W + CT.PAD_L * 2 + maxX * CT.COL + CT.BOX_W;

  // 1) 注入外壳(含可滚动容器),稍后填内容
  box.innerHTML = ctControlsHtml(famOpts, 1)
    + ctHeaderHtml(LIN, F)
    + `<div class="ct-scroll"><div class="ct-wrap"><div class="ct-canvas" style="width:${totalW}px"></div></div></div>`;
  const scroll = box.querySelector(".ct-scroll");
  const wrap = box.querySelector(".ct-wrap");
  const canvas = box.querySelector(".ct-canvas");

  // 2) 建竖排框(连通节点 + 右侧待接续;先 top=0、隐藏待测)
  const els = {};
  const goneCls = pp => (pp && pp.alive === "否") ? " ct-gone" : "";   // 已故=该人名字外加"牌位"框(框+浅灰底;不动整框、夫妻一存一殁只标殁者)
  drawn.forEach(id => {
    const p = byId(id) || {};
    // 每个名字 span 带 data-pid → 悬浮显示该人主要信息;点该名字开该人详情(配偶名亦然)
    let inner = `<span class="ct-name${goneCls(p)}" data-pid="${esc(id)}" style="color:${sexColor(p)}">${esc(p.name || "(无名)")}</span>`;
    ctInnerSpouses(id, F.nodeSet).forEach(s => { const q = byId(s) || {};
      inner += `<span class="ct-spsep">　</span><span class="ct-sp${goneCls(q)}" data-pid="${esc(s)}" style="color:${sexColor(q)}">${esc(q.name || "")}</span>`; });
    const d = el("div", "ct-box" + (DIRECT_LINE.has(id) ? " ct-direct" : ""));   // 待接续=普通框,外观同孙景发(仅无上连线)
    d.dataset.pid = id;
    d.style.left = boxLeft(id) + "px"; d.style.top = "0px"; d.style.visibility = "hidden";
    d.innerHTML = inner;
    d.onclick = (e) => { const sp = e.target.closest && e.target.closest("[data-pid]"); const pp = byId(sp ? sp.dataset.pid : id); if (pp) openDetail(pp); };
    canvas.appendChild(d); els[id] = d;
  });
  ctAttachTips(canvas);   // 名字悬浮提示(主要信息)

  // 3) 测高 → 逐代行高(连通+待接续同代一起算高)→ 行顶
  const boxH = {}; drawn.forEach(id => boxH[id] = els[id].offsetHeight || 40);
  const bandH = {}; bands.forEach(b => bandH[b] = Math.max(40, ...drawn.filter(id => bandOf(id) === b).map(id => boxH[id])));
  const rowTop = {}; let acc = CT.HEADER_H;
  bands.forEach(b => { rowTop[b] = acc; acc += bandH[b] + CT.ROW_GAP; });
  const totalH = acc;
  const topOf = id => rowTop[bandOf(id)];
  const botOf = id => rowTop[bandOf(id)] + boxH[id];

  // 4) 缩放:默认整页可见(state.classicZoom==null 即自动适应);否则用用户设定值
  const availW = (scroll ? scroll.clientWidth : box.clientWidth || 900) - 10;
  const availH = Math.round(window.innerHeight * 0.72);
  const fit = Math.max(0.1, Math.min(1.6, Math.min(availW / totalW, availH / totalH)));
  const zoom = (state.classicZoom == null) ? fit : state.classicZoom;
  state._classicZoomEff = zoom;

  // 5) 定位框
  drawn.forEach(id => { const d = els[id]; d.style.top = topOf(id) + "px"; d.style.visibility = ""; });

  // 6) 连线(仅连通节点;待接续无连线)
  let paths = "";
  F.nodes.forEach(pid => {
    const kids = F.children[pid] || []; if (!kids.length) return;
    const pb = botOf(pid), px = cx(pid);
    const tops = kids.map(topOf); const busY = Math.min(...tops) - Math.min(CT.ROW_GAP * 0.55, 16);
    const kxs = kids.map(cx); const minKX = Math.min(...kxs), maxKX = Math.max(...kxs);
    paths += `<path d="M ${px} ${pb} L ${px} ${busY}"/>`;
    if (kids.length > 1) paths += `<path d="M ${minKX} ${busY} L ${maxKX} ${busY}"/>`;
    kids.forEach((k, i) => { paths += `<path d="M ${kxs[i]} ${busY} L ${kxs[i]} ${tops[i]}"/>`; });
  });

  // 7) 世代栏(左)+ 行分隔(待接续随其 genOf 落在对应世代行,无独立面板/标签/虚线)
  let gutter = "";
  bands.forEach(b => { const top = rowTop[b], h = bandH[b]; const cg = ctDominantCharGen(F, b);
    const lab = (b === NULL_BAND && F.orphans.some(o => orphanBand[o] === NULL_BAND)) ? "未定" : (b + "世");
    gutter += `<div class="ct-gut" style="top:${top}px;height:${h}px"><div class="ct-gut-gen">${esc(lab)}</div>${cg ? `<div class="ct-gut-cg">${esc(cg)}</div>` : ""}</div>`;
    gutter += `<div class="ct-band-line" style="top:${top + h + CT.ROW_GAP / 2}px;width:${totalW}px"></div>`;
  });

  // 8) 组装:svg 底层、gutter 其次、框最上;canvas 用 transform 缩放,wrap 收缩到缩放后尺寸以正确滚动
  canvas.insertAdjacentHTML("afterbegin", `<svg class="ct-lines" width="${totalW}" height="${totalH}" viewBox="0 0 ${totalW} ${totalH}">${paths}</svg>`);
  canvas.insertAdjacentHTML("beforeend", gutter);
  canvas.style.height = totalH + "px";
  canvas.style.transform = `scale(${zoom})`;
  if (wrap){ wrap.style.width = Math.ceil(totalW * zoom) + "px"; wrap.style.height = Math.ceil(totalH * zoom) + "px"; }
  if (scroll) scroll.style.maxHeight = Math.round(window.innerHeight * 0.74) + "px";

  const zv = $("#ctZoomVal"); if (zv) zv.textContent = Math.round(zoom * 100) + "%";
  ctBindControls();
}

// ---- 名字悬浮提示:鼠标移到名字上显示该人主要信息(姓名/性别/世代/生卒/在世/籍居/配偶/职业等)----
function ctTipEl(){ let t = document.getElementById("ctTip"); if (!t){ t = el("div"); t.id = "ctTip"; document.body.appendChild(t); } return t; }
function ctTipHtml(p){
  const e = esc, g = genOf(p.id);
  const clean = x => (x && x !== "无考") ? String(x).replace(/[()（）]/g, "").trim() : "";
  const bb = clean(p.birth), dd = clean(p.death);
  const yrs = (bb && dd) ? (bb + "–" + dd) : (bb || (dd ? "–" + dd : ""));   // 生卒(无 ctYears 助手,内联)
  const cg = (p.char_gen && p.char_gen !== "—") ? ` · ${e(p.char_gen)}字辈` : "";
  const alive = p.alive === "否" ? "已故" : (p.alive === "是" ? "在世" : "在世未知");
  const sps = (state.spouseOf[p.id] || []).map(s => byId(s)).filter(x => x && !x.deleted).map(x => x.name).filter(Boolean);
  const rows = [`<div class="ct-tip-name" style="color:${sexColor(p)}">${e(p.name || "(无名)")}<span class="ct-tip-sub">${e(p.sex || "")}${cg}</span></div>`];
  const l2 = [(g == null ? "" : "第" + g + "世"), yrs, alive].filter(Boolean).join("　·　");
  if (l2) rows.push(`<div class="ct-tip-row">${e(l2)}</div>`);
  if (p.birth_place) rows.push(`<div class="ct-tip-row">籍 ${e(p.birth_place)}</div>`);
  if (p.residence) rows.push(`<div class="ct-tip-row">居 ${e(p.residence)}</div>`);
  if (p.occupation) rows.push(`<div class="ct-tip-row">${e(p.occupation)}</div>`);
  if (sps.length) rows.push(`<div class="ct-tip-row">配偶:${e(sps.join("、"))}</div>`);
  if (p.deeds) rows.push(`<div class="ct-tip-row ct-tip-soft">${e(p.deeds.slice(0, 48))}${p.deeds.length > 48 ? "…" : ""}</div>`);
  rows.push(`<div class="ct-tip-row ct-tip-hint">点名字看完整详情</div>`);
  return rows.join("");
}
function ctAttachTips(canvas){
  if (!canvas) return; const tip = ctTipEl();
  const hide = () => { tip.style.display = "none"; };
  canvas.addEventListener("mousemove", e => {
    const span = e.target.closest && e.target.closest(".ct-name[data-pid],.ct-sp[data-pid]");
    if (!span){ hide(); return; }
    const p = byId(span.dataset.pid); if (!p){ hide(); return; }
    tip.innerHTML = ctTipHtml(p); tip.style.display = "block";
    const pad = 14, vw = window.innerWidth, vh = window.innerHeight, w = tip.offsetWidth, h = tip.offsetHeight;
    let x = e.clientX + pad, y = e.clientY + pad;
    if (x + w > vw - 6) x = e.clientX - w - pad; if (x < 6) x = 6;
    if (y + h > vh - 6) y = vh - h - 6; if (y < 6) y = 6;
    tip.style.left = x + "px"; tip.style.top = y + "px";
  });
  canvas.addEventListener("mouseleave", hide);
}
function famCfgLabel(name){ try { const f = ((state.meta && state.meta.families) || {})[name]; return f && f.label; } catch (e){ return null; } }
function ctDominantCharGen(F, b){
  const cnt = {};
  F.nodes.forEach(id => { if (F.band[id] !== b) return; const cg = ((byId(id) || {}).char_gen || "").trim();
    if (cg && cg !== "—") cnt[cg] = (cnt[cg] || 0) + 1; });
  let best = "", n = 0; Object.keys(cnt).forEach(k => { if (cnt[k] > n){ n = cnt[k]; best = k; } });
  return best;
}
function ctControlsHtml(famOpts, zoom){
  return `<div class="ct-controls">`
    + `<label>家族 <select id="ctFam">${famOpts}</select></label>`
    + `<button class="btn btn-sm" id="ctRefresh" title="重新拉取最新人物/关系后重画">🔄 刷新</button>`
    + `<span class="ct-zoom">缩放 <button class="btn btn-sm" id="ctZoomOut">−</button>`
    + `<span id="ctZoomVal">${Math.round(zoom * 100)}%</span>`
    + `<button class="btn btn-sm" id="ctZoomIn">＋</button>`
    + `<button class="btn btn-sm" id="ctZoomFit">适应整页</button>`
    + `<button class="btn btn-sm" id="ctZoomReset">100%</button></span>`
    + `<button class="btn btn-sm" id="ctFull">${document.fullscreenElement ? "⛶ 退出全屏" : "⛶ 全屏"}</button>`
    + `<button class="btn btn-sm" id="ctPrint">🖨 打印 / 存 PDF</button>`
    + `<span class="hint">古式:<b>自右向左读,长在右</b>;<b style="color:#1d4ed8">男</b>·<b style="color:#db2777">女</b> 不同色;<span class="ct-leg-gone">名字加框</span>=已故;绿框=直系;点框看详情。</span>`
    + `</div>`;
}
function ctHeaderHtml(LIN, F){
  const meta = state.meta || {};
  const fam = ((meta.families || {})[LIN] || {});
  const isMain = !!(meta.title && LIN && meta.title.includes(LIN[0]));
  const title = fam.label || (isMain && meta.title ? meta.title : (LIN + "族谱"));
  const bands = new Set(F.nodes.map(id => F.band[id]));
  const counts = `本族 ${F.nodes.length} 框 · ${bands.size} 世${F.orphans.length ? ` · 待接续 ${F.orphans.length}` : ""}`;
  return `<div class="ct-head"><span class="ct-title">${esc(title)}</span> <span class="ct-counts">${esc(counts)}</span></div>`;
}
function ctAppendixHtml(F){
  if (!F.orphans.length) return "";
  const byGen = {};
  F.orphans.forEach(id => { const g = genOf(id); const k = (g == null ? "未定世代" : ("第" + g + "世")); (byGen[k] = byGen[k] || []).push(id); });
  const order = Object.keys(byGen).sort((a, b) => (parseInt(a.replace(/\D/g, "")) || 9999) - (parseInt(b.replace(/\D/g, "")) || 9999));
  const rows = order.map(k => `<div class="ct-orphan-row"><span class="ct-orphan-gen">${esc(k)}</span>`
    + byGen[k].map(id => { const p = byId(id) || {}; return `<a class="ct-orphan" data-pid="${esc(id)}" style="color:${sexColor(p)}">${esc(p.name || id)}</a>`; }).join("、")
    + `</div>`).join("");
  return `<details class="ct-appendix"><summary class="ct-appendix-h">尚未连入谱系的本族成员(${F.orphans.length})</summary>`
    + `<p class="hint">以下本族成员暂无可连接的父子关系,故未入上图。在「名册→详情」里补上父亲后会自动归位;无考者保持待考,不强行编入。</p>`
    + rows + `</details>`;
}
function ctBindControls(){
  const fam = $("#ctFam");
  if (fam) fam.onchange = () => { state.classicLineage = fam.value; state.classicZoom = null; renderClassicTree(); };   // 换家族重新适应整页
  const setZoom = z => { state.classicZoom = Math.max(0.1, Math.min(2.5, Math.round(z * 100) / 100)); renderClassicTree(); };
  const cur = () => state._classicZoomEff || 1;
  const zi = $("#ctZoomIn"); if (zi) zi.onclick = () => setZoom(cur() + 0.1);
  const zo = $("#ctZoomOut"); if (zo) zo.onclick = () => setZoom(cur() - 0.1);
  const zr = $("#ctZoomReset"); if (zr) zr.onclick = () => setZoom(1);
  const zf = $("#ctZoomFit"); if (zf) zf.onclick = () => { state.classicZoom = null; renderClassicTree(); };   // 适应整页
  const pr = $("#ctPrint"); if (pr) pr.onclick = () => { document.body.classList.add("ct-printing"); window.print();
    setTimeout(() => document.body.classList.remove("ct-printing"), 500); };
  const rf = $("#ctRefresh"); if (rf) rf.onclick = async () => {   // 重新拉最新人物+关系边后重画(别处改了人,回这里点一下即更新)
    rf.disabled = true; const old = rf.textContent; rf.textContent = "刷新中…";
    try { await reloadPersons(); await refreshRelCount(); } catch (e) {}
    renderClassicTree();   // 重画时会重建控件,rf 引用失效;无需手动恢复
  };
  const ff = $("#ctFull"); if (ff) ff.onclick = () => {   // 全屏显示谱图(浏览器全屏 API,作用于 #treeBox)
    const box = $("#treeBox");
    if (document.fullscreenElement) { if (document.exitFullscreen) document.exitFullscreen(); }
    else if (box && box.requestFullscreen) box.requestFullscreen().catch(() => {});
  };
  if (!window._ctFsBound) {   // 进/出全屏后按新视口重算"适应整页"并重画(仅绑一次)
    window._ctFsBound = true;
    document.addEventListener("fullscreenchange", () => {
      const v = document.getElementById("view-tree");
      if (v && v.classList.contains("active") && (state.treeMode || "classic") === "classic") renderClassicTree();
    });
  }
}

Object.assign(window, { renderClassicTree, buildClassicForest });
