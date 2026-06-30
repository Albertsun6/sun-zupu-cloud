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
  const sortKey = id => {
    const p = byId(id) || {}; const g = genOf(id); const so = parseInt(p.sort_order, 10); const yrm = (p.birth || "").match(/\d{4}/);
    return [g == null ? 9999 : g, isNaN(so) ? 0 : so, yrm ? +yrm[0] : 9999, id];
  };
  const cmp = (a, b) => { const ka = sortKey(a), kb = sortKey(b);
    for (let i = 0; i < ka.length; i++){ if (ka[i] < kb[i]) return -1; if (ka[i] > kb[i]) return 1; } return 0; };
  const children = {};
  nodes.forEach(id => { const par = parentOf(id); if (par != null) (children[par] = children[par] || []).push(id); });
  Object.keys(children).forEach(k => children[k].sort(cmp));
  const roots = nodes.filter(id => parentOf(id) == null).sort(cmp);

  const X = {}; const seen = new Set(); let leaf = 0;
  const assign = id => {
    if (seen.has(id)) return; seen.add(id);
    const kids = children[id] || [];
    if (!kids.length){ X[id] = leaf++; return; }
    kids.forEach(assign);
    const xs = kids.filter(k => X[k] != null);
    X[id] = xs.length ? (X[xs[0]] + X[xs[xs.length - 1]]) / 2 : leaf++;
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

  const bands = [...new Set(F.nodes.map(id => F.band[id]))].sort((a, b) => a - b);
  const cx = id => CT.GUTTER_W + CT.PAD_L + F.X[id] * CT.COL + CT.BOX_W / 2;
  const boxLeft = id => cx(id) - CT.BOX_W / 2;
  const totalW = CT.GUTTER_W + CT.PAD_L * 2 + (F.leafCount > 0 ? (F.leafCount - 1) : 0) * CT.COL + CT.BOX_W;

  // 1) 注入外壳(含可滚动容器),稍后填内容
  box.innerHTML = ctControlsHtml(famOpts, 1)
    + ctHeaderHtml(LIN, F)
    + `<div class="ct-scroll"><div class="ct-wrap"><div class="ct-canvas" style="width:${totalW}px"></div></div></div>`
    + ctAppendixHtml(F);
  const scroll = box.querySelector(".ct-scroll");
  const wrap = box.querySelector(".ct-wrap");
  const canvas = box.querySelector(".ct-canvas");

  // 2) 建竖排框(先 top=0、隐藏待测)
  const nodeEls = {};
  F.nodes.forEach(id => {
    const p = byId(id) || {};
    let inner = `<span class="ct-name" style="color:${sexColor(p)}">${esc(p.name || "(无名)")}</span>`;
    ctInnerSpouses(id, F.nodeSet).forEach(s => { const q = byId(s) || {};
      inner += `<span class="ct-spsep">　</span><span class="ct-sp" style="color:${sexColor(q)}">${esc(q.name || "")}</span>`; });
    const aliveCls = p.alive === "否" ? " ct-dead" : (p.alive === "是" ? "" : " ct-unknown");   // 已故=灰底;在世=白底;未知=虚线框
    const d = el("div", "ct-box" + (DIRECT_LINE.has(id) ? " ct-direct" : "") + aliveCls);
    d.dataset.pid = id;
    d.title = (p.name || "") + (p.sex ? (" · " + p.sex) : "") + (p.alive === "否" ? " · 已故" : (p.alive === "是" ? " · 在世" : " · 在世未知"));
    d.style.left = boxLeft(id) + "px"; d.style.top = "0px"; d.style.visibility = "hidden";
    d.innerHTML = inner;
    d.onclick = () => { const pp = byId(id); if (pp) openDetail(pp); };
    canvas.appendChild(d); nodeEls[id] = d;
  });

  // 3) 测高 → 逐代行高 → 行顶
  const boxH = {}; F.nodes.forEach(id => boxH[id] = nodeEls[id].offsetHeight || 40);
  const bandH = {}; bands.forEach(b => bandH[b] = Math.max(...F.nodes.filter(id => F.band[id] === b).map(id => boxH[id])));
  const rowTop = {}; let acc = CT.HEADER_H;
  bands.forEach(b => { rowTop[b] = acc; acc += bandH[b] + CT.ROW_GAP; });
  const totalH = acc;
  const topOf = id => rowTop[F.band[id]];
  const botOf = id => rowTop[F.band[id]] + boxH[id];

  // 4) 缩放:默认整页可见(state.classicZoom==null 即自动适应);否则用用户设定值
  const availW = (scroll ? scroll.clientWidth : box.clientWidth || 900) - 10;
  const availH = Math.round(window.innerHeight * 0.72);
  const fit = Math.max(0.1, Math.min(1.6, Math.min(availW / totalW, availH / totalH)));
  const zoom = (state.classicZoom == null) ? fit : state.classicZoom;
  state._classicZoomEff = zoom;

  // 5) 定位框
  F.nodes.forEach(id => { const d = nodeEls[id]; d.style.top = topOf(id) + "px"; d.style.visibility = ""; });

  // 6) 连线(父框底→子女总线→各子框顶)
  let paths = "";
  F.nodes.forEach(pid => {
    const kids = F.children[pid] || []; if (!kids.length) return;
    const pb = botOf(pid), px = cx(pid);
    const tops = kids.map(topOf); const busY = Math.min(...tops) - Math.min(CT.ROW_GAP * 0.55, 16);
    const kxs = kids.map(cx); const minX = Math.min(...kxs), maxX = Math.max(...kxs);
    paths += `<path d="M ${px} ${pb} L ${px} ${busY}"/>`;
    if (kids.length > 1) paths += `<path d="M ${minX} ${busY} L ${maxX} ${busY}"/>`;
    kids.forEach((k, i) => { paths += `<path d="M ${kxs[i]} ${busY} L ${kxs[i]} ${tops[i]}"/>`; });
  });

  // 7) 世代栏(左)+ 行分隔
  let gutter = "";
  bands.forEach(b => { const top = rowTop[b], h = bandH[b]; const cg = ctDominantCharGen(F, b);
    gutter += `<div class="ct-gut" style="top:${top}px;height:${h}px"><div class="ct-gut-gen">${b}世</div>${cg ? `<div class="ct-gut-cg">${esc(cg)}</div>` : ""}</div>`;
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
  box.querySelectorAll(".ct-orphan").forEach(a => a.onclick = () => { const p = byId(a.dataset.pid); if (p) openDetail(p); });
  ctBindControls();
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
    + `<span class="ct-zoom">缩放 <button class="btn btn-sm" id="ctZoomOut">−</button>`
    + `<span id="ctZoomVal">${Math.round(zoom * 100)}%</span>`
    + `<button class="btn btn-sm" id="ctZoomIn">＋</button>`
    + `<button class="btn btn-sm" id="ctZoomFit">适应整页</button>`
    + `<button class="btn btn-sm" id="ctZoomReset">100%</button></span>`
    + `<button class="btn btn-sm" id="ctPrint">🖨 打印 / 存 PDF</button>`
    + `<span class="hint"><b style="color:#1d4ed8">男</b>·<b style="color:#db2777">女</b> 不同色;<span class="ct-leg-dead">灰底</span>=已故 · 白底=在世 · <span class="ct-leg-unk">虚线</span>=未知;绿框=直系;点框看详情。</span>`
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
}

Object.assign(window, { renderClassicTree, buildClassicForest });
