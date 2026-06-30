// ============================================================
// tree-classic.js —— 传统族谱挂图(银幕式分代排版)
// 把家族树画成像手绘族谱挂图那样:夫妻同框、按"世代"分层、同辈横向连、
// 子女竖线下挂;左侧世代/字辈栏;绿色=本谱直系。可缩放/打印(存 PDF)。
//
// 设计要点(与照片格式对齐):
//  · 一个"框"= 一位本族(父系同姓)成员 + 框内列出其配偶(嫁入者不单独成框)。
//  · 分代成行(band):纵坐标由 genOf(世代)决定 —— 即便断裂的支系也落在正确的世代行。
//  · 横坐标用"叶子计数"布局:每个叶子占一个横格,内部节点居中于子女之上;
//    不同支系的叶子区间天然不相交 → 任何世代行都不会左右重叠(已用真实数据探针证实)。
//  · 无父子连接的本族孤立成员不强行接树 —— 单列"待接续"附录,点开可考证补录(留痕不脑补)。
//
// 依赖(全部由 app.js 末尾挂到 window,本模块裸引用经全局对象解析):
//   state, $, el, esc, byId, genOf, surnameOfSelf, familiesOf, lineageOf,
//   charGenFor, lineagesList, DIRECT_LINE, openDetail
//   以及 state.fatherOf / state.motherOf / state.childrenMap / state.spouseOf
// ============================================================

// ---- 版面常量(像素)----
const CT = {
  BOX_W: 128,         // 框宽
  COL: 152,           // 每个横格(叶子)的间距
  PAD_NAME: 9,        // 框上下内边距(单边近似)
  H_NAME: 21,         // 姓名行高
  H_YEAR: 15,         // 生卒行高
  H_SP: 15,           // 每位配偶一行
  ROW_GAP: 60,        // 行间连线留白
  HEADER_H: 16,       // 图顶留白
  GUTTER_W: 64,       // 左侧世代/字辈栏宽
  PAD_L: 26           // 图左内边距(在 gutter 右)
};

// 取某人框内"配偶行"= 与其有夫妻关系、但本身不单独成框(嫁入者)的人;排除已软删者(否则删掉的配偶仍泄到图里)
function ctInnerSpouses(id, nodeSet){
  return (state.spouseOf[id] || [])
    .filter(s => !nodeSet.has(s) && byId(s) && !byId(s).deleted)
    .filter((s, i, a) => a.indexOf(s) === i);   // 去重(对称边可能两侧都记)
}
// 框高(由内容决定,确定性估算 → 行高/连线几何一致,无需二次回流测量)
function ctBoxH(id, nodeSet){
  const p = byId(id) || {};
  const hasYear = !!ctYears(p);
  const nSp = ctInnerSpouses(id, nodeSet).length;
  return CT.PAD_NAME * 2 + CT.H_NAME + (hasYear ? CT.H_YEAR : 0) + nSp * CT.H_SP;
}
function ctYears(p){
  const clean = x => (x && x !== "无考") ? String(x).replace(/[()（）]/g, "").trim() : "";
  const b = clean(p.birth), d = clean(p.death);
  if (b && d) return b + "–" + d;
  return b || (d ? "–" + d : "");
}

// 取当前要画的家族(默认孙氏;无则取最大家族)
function ctLineage(){
  if (state.classicLineage) return state.classicLineage;
  const list = lineagesList();
  const sun = list.find(l => l.name === "孙氏");
  return (state.classicLineage = sun ? sun.name : (list[0] ? list[0].name : "孙氏"));
}

// ---- 构建谱系森林(父系同姓为骨架,嫁入者收进框内)----
function buildClassicForest(LIN){
  const live = state.persons.filter(p => !p.deleted);
  const liveSet = new Set(live.map(p => p.id));
  const isBlood = id => surnameOfSelf(id) === LIN;          // 父系顶祖同姓 = 本族血脉
  // 本族成员里:有(在世)本族父亲、或本身有本族子女者,才入树(过滤完全孤立的单点)
  const hasBloodChild = id => (state.childrenMap[id] || []).some(c => liveSet.has(c) && isBlood(c));
  // 入树 = 本族血脉 且 (有在世的本族父亲 或 本族母亲,或 本身有本族子女)。母系连接也算 —— 否则只挂在母亲下的本族叶子会被误丢到附录。
  const bloodParentInSet = id => (liveSet.has(state.fatherOf[id]) && isBlood(state.fatherOf[id])) || (liveSet.has(state.motherOf[id]) && isBlood(state.motherOf[id]));
  const nodes = live
    .map(p => p.id)
    .filter(id => isBlood(id) && (bloodParentInSet(id) || hasBloodChild(id)));
  const nodeSet = new Set(nodes);
  // 树父亲:父边优先,无则母边(都需在框集合内)
  const parentOf = id => {
    const f = state.fatherOf[id]; if (nodeSet.has(f)) return f;
    const m = state.motherOf[id]; if (nodeSet.has(m)) return m;
    return null;
  };
  const sortKey = id => {
    const p = byId(id) || {}; const g = genOf(id); const gg = (g == null ? 9999 : g);
    const so = parseInt(p.sort_order, 10); const yrm = (p.birth || "").match(/\d{4}/);
    return [gg, isNaN(so) ? 0 : so, yrm ? +yrm[0] : 9999, id];
  };
  const cmp = (a, b) => { const ka = sortKey(a), kb = sortKey(b);
    for (let i = 0; i < ka.length; i++){ if (ka[i] < kb[i]) return -1; if (ka[i] > kb[i]) return 1; } return 0; };
  const children = {};
  nodes.forEach(id => { const par = parentOf(id); if (par != null) (children[par] = children[par] || []).push(id); });
  Object.keys(children).forEach(k => children[k].sort(cmp));
  const roots = nodes.filter(id => parentOf(id) == null).sort(cmp);

  // 横坐标:叶子计数(防环 seen);纵坐标:世代 band(genOf,缺则父 band+1)
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
  // 极端兜底:仍未定位的(理论上不会)给个新叶子位
  nodes.forEach(id => { if (X[id] == null) X[id] = leaf++; });

  // 世代行(band):用 genOf 对齐世代(断裂支系也落在正确世代行),但强制"子 band > 父 band" ——
  // 否则 genOf 偶发不一致(父子被算成同代)会让父子框落在同一行而重叠。自顶向下取 max(genOf, 父band+1)。
  const band = {};
  const compBand = (id, parentBand) => {
    if (band[id] != null) return;                       // 防环/重复(父子是森林,正常每点只算一次)
    const g = genOf(id);
    band[id] = (parentBand == null) ? (g != null ? g : 1) : Math.max(g != null ? g : (parentBand + 1), parentBand + 1);
    (children[id] || []).forEach(c => compBand(c, band[id]));
  };
  roots.forEach(r => compBand(r, null));
  nodes.forEach(id => { if (band[id] == null) band[id] = (genOf(id) != null ? genOf(id) : 1); });  // 兜底(理论不可达)

  // 孤立本族成员(有血脉但无任何本族父子连接)→ 待接续附录;但已作为框内配偶显示者不重复列(避免又在框里又在附录)
  const shownAsSpouse = new Set();
  nodes.forEach(id => ctInnerSpouses(id, nodeSet).forEach(s => shownAsSpouse.add(s)));
  const orphans = live.map(p => p.id)
    .filter(id => isBlood(id) && !nodeSet.has(id) && !shownAsSpouse.has(id))
    .sort(cmp);

  return { nodes, nodeSet, children, roots, X, band, parentOf, leafCount: leaf, orphans };
}

// ---- 主渲染 ----
function renderClassicTree(){
  const box = $("#treeBox");
  if (!box) return;
  const LIN = ctLineage();
  let F;
  try { F = buildClassicForest(LIN); }
  catch (e){ box.innerHTML = `<p class="note">谱图生成失败:${esc(e.message || e)}</p>`; return; }

  // 顶部控制条(家族选择 / 缩放 / 打印)
  const fams = lineagesList();
  const famOpts = fams.map(l => `<option value="${esc(l.name)}"${l.name === LIN ? " selected" : ""}>${esc(famCfgLabel(l.name) || l.name)}(${l.count})</option>`).join("");
  const zoom = state.classicZoom || (state.classicZoom = 1);

  if (!F.nodes.length){
    box.innerHTML = ctControlsHtml(famOpts, zoom)
      + ctHeaderHtml(LIN, F)
      + `<p class="note">「${esc(LIN)}」暂无可绘制的父系谱系(没有已连成父子的本族成员)。${F.orphans.length ? "下列本族成员可在「名册→详情」里补上父亲后归位。" : "可在「名册」给成员连上父亲后再来。"}</p>`
      + ctAppendixHtml(F);
    ctBindControls();
    box.querySelectorAll(".ct-orphan").forEach(a => a.onclick = () => { const p = byId(a.dataset.pid); if (p) openDetail(p); });
    return;
  }

  // 行(世代 band)→ 连续行号映射(缺代不留巨大空隙)
  const bands = [...new Set(F.nodes.map(id => F.band[id]))].sort((a, b) => a - b);
  const rowIndex = {}; bands.forEach((b, i) => rowIndex[b] = i);
  const maxBoxH = Math.max(...F.nodes.map(id => ctBoxH(id, F.nodeSet)));
  const ROW_H = maxBoxH + CT.ROW_GAP;
  const rowTop = b => CT.HEADER_H + rowIndex[b] * ROW_H;
  const cx = id => CT.GUTTER_W + CT.PAD_L + F.X[id] * CT.COL + CT.BOX_W / 2;
  const boxLeft = id => cx(id) - CT.BOX_W / 2;
  const boxTop = id => rowTop(F.band[id]);
  const boxBottom = id => boxTop(id) + ctBoxH(id, F.nodeSet);

  const totalW = CT.GUTTER_W + CT.PAD_L * 2 + (F.leafCount > 0 ? (F.leafCount - 1) : 0) * CT.COL + CT.BOX_W;
  const totalH = CT.HEADER_H + bands.length * ROW_H;

  // 连线(SVG):父框底 → 子女总线 → 各子框顶(直角折线,像照片)
  let paths = "";
  F.nodes.forEach(pid => {
    const kids = (F.children[pid] || []);
    if (!kids.length) return;
    const pb = boxBottom(pid), px = cx(pid);
    const childTops = kids.map(boxTop);
    const busY = Math.min(...childTops) - 18;
    const kxs = kids.map(cx);
    const minX = Math.min(...kxs), maxX = Math.max(...kxs);
    paths += `<path d="M ${px} ${pb} L ${px} ${busY}"/>`;                 // 父向下
    if (kids.length > 1) paths += `<path d="M ${minX} ${busY} L ${maxX} ${busY}"/>`;  // 横向总线
    kids.forEach((k, i) => { paths += `<path d="M ${kxs[i]} ${busY} L ${kxs[i]} ${childTops[i]}"/>`; });  // 各子向下
  });

  // 左侧世代/字辈栏 + 行底分隔
  let gutter = "";
  bands.forEach(b => {
    const top = rowTop(b);
    const cg = ctDominantCharGen(F, b);
    gutter += `<div class="ct-gut" style="top:${top}px;height:${ROW_H}px">`
      + `<div class="ct-gut-gen">第${b}世</div>${cg ? `<div class="ct-gut-cg">${esc(cg)}</div>` : ""}</div>`;
    gutter += `<div class="ct-band-line" style="top:${top + ROW_H}px;width:${totalW}px"></div>`;
  });

  // 框
  const boxesHtml = F.nodes.map(id => {
    const p = byId(id) || {};
    const yrs = ctYears(p);
    const sps = ctInnerSpouses(id, F.nodeSet);
    const cg = (p.char_gen && p.char_gen !== "—") ? `<span class="ct-cg">${esc(p.char_gen)}</span>` : "";
    const direct = DIRECT_LINE.has(id) ? " ct-direct" : "";
    const dead = p.alive === "否" ? " ct-dead" : "";
    const spHtml = sps.map(s => `<div class="ct-sp">配 ${esc((byId(s) || {}).name || "(无名)")}</div>`).join("");
    const h = ctBoxH(id, F.nodeSet);
    return `<div class="ct-box${direct}${dead}" data-pid="${esc(id)}" title="点开看详情/编辑"`
      + ` style="left:${boxLeft(id)}px;top:${boxTop(id)}px;width:${CT.BOX_W}px;height:${h}px">`
      + `<div class="ct-name">${esc(p.name || "(无名)")}${cg}</div>`
      + (yrs ? `<div class="ct-years">${esc(yrs)}</div>` : "")
      + spHtml + `</div>`;
  }).join("");

  const head = ctHeaderHtml(LIN, F);
  const appendix = ctAppendixHtml(F);

  box.innerHTML = ctControlsHtml(famOpts, zoom)
    + head
    + `<div class="ct-scroll"><div class="ct-canvas" style="width:${totalW}px;height:${totalH}px;transform:scale(${zoom});transform-origin:top left">`
    + `<svg class="ct-lines" width="${totalW}" height="${totalH}" viewBox="0 0 ${totalW} ${totalH}">${paths}</svg>`
    + gutter
    + boxesHtml
    + `</div></div>`
    + appendix;

  // 缩放后让滚动容器高度跟上(transform 不撑开父级)
  const canvas = box.querySelector(".ct-canvas");
  const scroll = box.querySelector(".ct-scroll");
  if (canvas && scroll){ scroll.style.height = Math.min(totalH * zoom + 24, Math.round(window.innerHeight * 0.74)) + "px";
    canvas.parentElement.style.minHeight = (totalH * zoom) + "px"; }

  box.querySelectorAll(".ct-box").forEach(b => b.onclick = () => { const p = byId(b.dataset.pid); if (p) openDetail(p); });
  box.querySelectorAll(".ct-orphan").forEach(a => a.onclick = () => { const p = byId(a.dataset.pid); if (p) openDetail(p); });
  ctBindControls();
}

function famCfgLabel(name){
  try { const f = ((state.meta && state.meta.families) || {})[name]; return f && f.label; } catch (e){ return null; }
}
// 某世代行内出现最多的字辈(数据驱动,不按派语序号硬套 —— 本谱代数与派语不对齐)
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
    + `<button class="btn btn-sm" id="ctZoomFit">适应宽度</button>`
    + `<button class="btn btn-sm" id="ctZoomReset">100%</button></span>`
    + `<button class="btn btn-sm" id="ctPrint">🖨 打印 / 存为 PDF</button>`
    + `<span class="hint">点框看详情;<b style="color:#047857">绿框</b>=本谱直系</span>`
    + `</div>`;
}
function ctHeaderHtml(LIN, F){
  const meta = state.meta || {};
  const fam = ((meta.families || {})[LIN] || {});
  const isMain = !!(meta.title && LIN && meta.title.includes(LIN[0]));   // 谱名含本族姓 = 本谱主家族(避免给其他家族套用孙氏的谱名/地望)
  const title = fam.label || (isMain && meta.title ? meta.title : (LIN + "族谱"));
  const sub = isMain ? [meta.origin, meta.migration].filter(Boolean).join("　·　") : (fam.note || "");
  const bands = new Set(F.nodes.map(id => F.band[id]));
  const counts = `本族框 ${F.nodes.length} · 计 ${bands.size} 世${F.orphans.length ? ` · 待接续 ${F.orphans.length}` : ""}`;
  return `<div class="ct-head"><div class="ct-title">${esc(title)}</div>`
    + (sub ? `<div class="ct-sub">${esc(sub)}</div>` : "")
    + `<div class="ct-counts">${esc(counts)}</div></div>`;
}
function ctAppendixHtml(F){
  if (!F.orphans.length) return "";
  const byGen = {};
  F.orphans.forEach(id => { const g = genOf(id); const k = (g == null ? "未定世代" : ("第" + g + "世")); (byGen[k] = byGen[k] || []).push(id); });
  const order = Object.keys(byGen).sort((a, b) => (parseInt(a.replace(/\D/g, "")) || 9999) - (parseInt(b.replace(/\D/g, "")) || 9999));
  const rows = order.map(k => `<div class="ct-orphan-row"><span class="ct-orphan-gen">${esc(k)}</span>`
    + byGen[k].map(id => `<a class="ct-orphan" data-pid="${esc(id)}">${esc((byId(id) || {}).name || id)}</a>`).join("、")
    + `</div>`).join("");
  return `<div class="ct-appendix"><div class="ct-appendix-h">尚未连入谱系的本族成员(${F.orphans.length})</div>`
    + `<p class="hint">以下本族成员暂无可连接的父子关系,故未入上图。在「名册→详情」里给他们补上父亲后会自动归位;无考者保持待考,不强行编入。</p>`
    + rows + `</div>`;
}
function ctBindControls(){
  const fam = $("#ctFam");
  if (fam) fam.onchange = () => { state.classicLineage = fam.value; renderClassicTree(); };
  const setZoom = z => { state.classicZoom = Math.max(0.3, Math.min(2, Math.round(z * 100) / 100)); renderClassicTree(); };
  const zi = $("#ctZoomIn"); if (zi) zi.onclick = () => setZoom((state.classicZoom || 1) + 0.1);
  const zo = $("#ctZoomOut"); if (zo) zo.onclick = () => setZoom((state.classicZoom || 1) - 0.1);
  const zr = $("#ctZoomReset"); if (zr) zr.onclick = () => setZoom(1);
  const zf = $("#ctZoomFit"); if (zf) zf.onclick = () => {
    const canvas = $("#treeBox .ct-canvas"); const scroll = $("#treeBox .ct-scroll");
    if (!canvas || !scroll) return;
    const w = canvas.offsetWidth || 1; const avail = scroll.clientWidth - 8;
    setZoom(avail / w);
  };
  const pr = $("#ctPrint"); if (pr) pr.onclick = () => { document.body.classList.add("ct-printing"); window.print();
    setTimeout(() => document.body.classList.remove("ct-printing"), 500); };
}

Object.assign(window, { renderClassicTree, buildClassicForest });
