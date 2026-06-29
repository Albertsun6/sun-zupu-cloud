// 万年历选择器(自包含,不依赖 app.js)。
// 点带 .cal-btn(data-ev="birth"|"death")的按钮 → 弹出 → 选公历或农历日期 →
// "填入"后自动把对应的【公历】(#f_birth/#f_death)与【农历】(#f_birth_lunar/#f_death_lunar)两个框都写好。
// 阴阳历互转用 lunar-javascript;残缺/模糊日期(如"无考""约1808")仍可直接手填,不强制用此选择器。
import * as L from "https://cdn.jsdelivr.net/npm/lunar-javascript@1.7.7/+esm";
const Solar = L.Solar || (L.default && L.default.Solar);
const Lunar = L.Lunar || (L.default && L.default.Lunar);
const LunarYear = L.LunarYear || (L.default && L.default.LunarYear);
const LunarMonth = L.LunarMonth || (L.default && L.default.LunarMonth);

const pad = n => String(n).padStart(2, "0");
const FIELDS = { birth: ["f_birth", "f_birth_lunar"], death: ["f_death", "f_death_lunar"] };
let targetEv = "birth";

// 暴露万年历换算给 app.js(导入/AI识别时把农历↔公历精确互转,而非靠 AI 猜)
const _shichen12 = ["子","丑","寅","卯","辰","巳","午","未","申","酉","戌","亥"];
const _shichenOf = h => _shichen12[Math.floor(((h + 1) % 24) / 2)] + "时";
window.LUNARCONV = {
  get ready(){ return !!Solar; },
  shichenOf: _shichenOf,
  lunarToSolar(y, m, d, leap){ try { const lo = Lunar.fromYmd(y, leap ? -m : m, d), so = lo.getSolar();
    return { solar: `${so.getYear()}-${pad(so.getMonth())}-${pad(so.getDay())}`, lunar: `农历${lo.getMonthInChinese()}月${lo.getDayInChinese()} 属${lo.getYearShengXiao()}`, gz: lo.getYearInGanZhi(), shengxiao: lo.getYearShengXiao() }; } catch (e) { return null; } },
  solarToLunar(y, m, d){ try { const lu = Solar.fromYmd(y, m, d).getLunar();
    return { solar: `${y}-${pad(m)}-${pad(d)}`, lunar: `农历${lu.getMonthInChinese()}月${lu.getDayInChinese()} 属${lu.getYearShengXiao()}`, gz: lu.getYearInGanZhi(), shengxiao: lu.getYearShengXiao() }; } catch (e) { return null; } }
};

const mask = document.createElement("div");
mask.className = "mask"; mask.id = "calMask";
mask.innerHTML = `
  <div class="modal" style="width:min(420px,100%)">
    <h2 id="calTitle">万年历</h2>
    <div class="field">
      <label>按哪种历选(选完自动互转)</label>
      <div style="display:flex;gap:1.2rem;align-items:center">
        <label class="switch"><input type="radio" name="calMode" value="solar" checked> 公历(阳历)</label>
        <label class="switch"><input type="radio" name="calMode" value="lunar"> 农历(阴历)</label>
      </div>
    </div>
    <div class="grid2" style="grid-template-columns:1.2fr 1fr 1fr">
      <div class="field"><label>年</label><input type="number" id="calY" placeholder="如 1952"></div>
      <div class="field"><label>月</label><select id="calM"></select></div>
      <div class="field"><label>日</label><select id="calD"></select></div>
    </div>
    <label class="switch" id="calLeapWrap" style="display:none;margin-top:.4rem"><input type="checkbox" id="calLeap"> 闰月</label>
    <div class="hint" id="calPrev" style="margin-top:.7rem;font-size:.85rem"></div>
    <div class="modal-foot">
      <button class="btn" id="calClear" type="button">不详(清空)</button>
      <span class="spacer"></span>
      <button class="btn" id="calCancel" type="button">取消</button>
      <button class="btn btn-primary" id="calOk" type="button">填入</button>
    </div>
  </div>`;
document.body.appendChild(mask);

const q = id => mask.querySelector("#" + id);
const calY = q("calY"), calM = q("calM"), calD = q("calD"), calLeap = q("calLeap"),
      calLeapWrap = q("calLeapWrap"), calPrev = q("calPrev"), calTitle = q("calTitle"), calOk = q("calOk");
calM.add(new Option("— 月(可不选)", ""));
for (let m = 1; m <= 12; m++) calM.add(new Option(m + " 月", m));
const _SX12 = ["鼠","牛","虎","兔","龙","蛇","马","羊","猴","鸡","狗","猪"];
const sxOf = y => y ? _SX12[(((y - 4) % 12) + 12) % 12] : "";   // 只年时按公历年近似属相

const mode = () => mask.querySelector("input[name=calMode]:checked").value;
const leapMonthOf = y => { try { return LunarYear.fromYear(y).getLeapMonth(); } catch { return 0; } };
const solarDays = (y, m) => new Date(y, m, 0).getDate();
const lunarDays = (y, m, leap) => { try { return LunarMonth.fromYm(y, leap ? -m : m).getDayCount() || 0; } catch { return 0; } };

function rebuildLeap() {
  const y = parseInt(calY.value), m = parseInt(calM.value);
  const show = mode() === "lunar" && y && leapMonthOf(y) === m;
  calLeapWrap.style.display = show ? "" : "none";
  if (!show) calLeap.checked = false;
}
function rebuildDays() {
  const y = parseInt(calY.value), m = parseInt(calM.value), cur = parseInt(calD.value) || 0;
  calD.innerHTML = "";
  calD.add(new Option("— 日(可不选)", ""));
  if (y && m) { const n = mode() === "solar" ? solarDays(y, m) : (lunarDays(y, m, calLeap.checked) || 30);
    for (let d = 1; d <= n; d++) calD.add(new Option(d + " 日", d)); if (cur && cur <= n) calD.value = cur; }
}
function compute() {
  const y = parseInt(calY.value); if (!y) return { err: "请填年份(月、日可不选)" };
  const m = parseInt(calM.value) || 0, d = parseInt(calD.value) || 0;
  try {
    if (!m) return { solar: String(y), lunar: `属${sxOf(y)}`, partial: true };                 // 只年
    if (mode() === "solar") {
      if (d && d > solarDays(y, m)) return { err: `公历 ${y}年${m}月 没有 ${d} 日` };
      if (!d) return { solar: `${y}-${pad(m)}`, lunar: `属${sxOf(y)}`, partial: true };          // 年月
      const lu = Solar.fromYmd(y, m, d).getLunar();
      return { solar: `${y}-${pad(m)}-${pad(d)}`, lunar: `农历${lu.getMonthInChinese()}月${lu.getDayInChinese()} 属${lu.getYearShengXiao()}`, gz: lu.getYearInGanZhi() };
    }
    if (!d) return { solar: String(y), lunar: `属${sxOf(y)}`, partial: true };                   // 农历缺日→只能给年
    const leap = calLeap.checked && leapMonthOf(y) === m, dc = lunarDays(y, m, leap);
    if (!dc) return { err: "该年没有这个(闰)月" };
    if (d > dc) return { err: `农历${leap ? "闰" : ""}${m}月 只有 ${dc} 天` };
    const lo = Lunar.fromYmd(y, leap ? -m : m, d), so = lo.getSolar();
    return { solar: `${so.getYear()}-${pad(so.getMonth())}-${pad(so.getDay())}`, lunar: `农历${lo.getMonthInChinese()}月${lo.getDayInChinese()} 属${lo.getYearShengXiao()}`, gz: lo.getYearInGanZhi() };
  } catch { return { err: "无法换算(年份可能超出范围)" }; }
}
function updatePreview() {
  const r = compute();
  if (r.err) { calPrev.textContent = "⚠ " + r.err; calPrev.style.color = "#b45309"; calOk.disabled = true; }
  else if (r.partial) { calPrev.innerHTML = `公历 <b>${r.solar}</b>(残缺,月/日可不选) · <b>${r.lunar}</b>`; calPrev.style.color = "#475569"; calOk.disabled = false; }
  else { calPrev.innerHTML = `公历 <b>${r.solar}</b> &nbsp;·&nbsp; ${r.gz}年 <b>${r.lunar}</b>`; calPrev.style.color = "#475569"; calOk.disabled = false; }
}
function refresh() { rebuildLeap(); rebuildDays(); updatePreview(); }

function open(ev) {
  if (!Solar) { alert("农历库未能加载(检查网络),请直接在框里手填日期。"); return; }
  targetEv = ev in FIELDS ? ev : "birth";
  calTitle.textContent = "万年历 · 选择" + (targetEv === "death" ? "卒日" : "生日");
  const cur = (document.getElementById(FIELDS[targetEv][0]).value || "").trim();
  mask.querySelector("input[name=calMode][value=solar]").checked = true;
  const m3 = cur.match(/^(\d{3,4})-(\d{1,2})-(\d{1,2})$/), m2 = cur.match(/^(\d{3,4})-(\d{1,2})$/), m1 = cur.match(/(\d{3,4})/);
  calY.value = m3 ? +m3[1] : (m2 ? +m2[1] : (m1 ? +m1[1] : ""));
  calM.value = m3 ? +m3[2] : (m2 ? +m2[2] : "");
  refresh();
  if (m3) { calD.value = +m3[3]; updatePreview(); }
  mask.classList.add("open");
}
function close() { mask.classList.remove("open"); }

calY.addEventListener("input", refresh);
mask.addEventListener("change", e => {
  if (e.target.name === "calMode" || e.target.id === "calM" || e.target.id === "calLeap") refresh();
  else if (e.target.id === "calD") updatePreview();
});
q("calCancel").addEventListener("click", close);
q("calClear").addEventListener("click", () => { const [sf, lf] = FIELDS[targetEv]; document.getElementById(sf).value = ""; const lel = document.getElementById(lf); if (lel) lel.value = ""; close(); });   // 不详:清空公历+农历
mask.addEventListener("click", e => { if (e.target === mask) close(); });
calOk.addEventListener("click", () => {
  const r = compute(); if (r.err) return;
  const [sf, lf] = FIELDS[targetEv];
  document.getElementById(sf).value = r.solar;
  document.getElementById(lf).value = r.lunar;
  close();
});
document.addEventListener("click", e => {
  const b = e.target.closest(".cal-btn");
  if (b) { e.preventDefault(); open(b.dataset.ev); }
});

// ---- 出生时间 → 时辰自动生成 ----
// 在 #f_birth_time 里填时:分(如 14:30 / 9点 / 1430),失焦后规范成 "14:30 未时";
// 直接写"未时"等非时间文字则原样保留。十二时辰:子23-1 丑1-3 寅3-5 …(每两小时一时辰)。
const SHICHEN = ["子", "丑", "寅", "卯", "辰", "巳", "午", "未", "申", "酉", "戌", "亥"];
const shichenOf = h => SHICHEN[Math.floor(((h + 1) % 24) / 2)] + "时";
const matchClock = v => (v.trim().match(/^(\d{1,2})(?:[:：点时]?(\d{1,2}))?/));
function liveShichen() {
  const el = document.getElementById("f_birth_time"), hint = document.getElementById("f_birth_time_sc");
  if (!el || !hint) return;
  const m = matchClock(el.value);
  hint.textContent = (m && +m[1] >= 0 && +m[1] <= 23) ? "→ " + shichenOf(+m[1]) : "";
}
function normBirthTime() {
  const el = document.getElementById("f_birth_time"); if (!el) return;
  const m = matchClock(el.value);
  if (m && +m[1] >= 0 && +m[1] <= 23) {
    const h = +m[1], mm = m[2] != null ? String(m[2]).padStart(2, "0") : "00";
    el.value = `${h}:${mm} ${shichenOf(h)}`;
  }
  const hint = document.getElementById("f_birth_time_sc"); if (hint) hint.textContent = "";
}
document.addEventListener("input", e => { if (e.target.id === "f_birth_time") liveShichen(); });
document.addEventListener("change", e => { if (e.target.id === "f_birth_time") normBirthTime(); }, true);

// ---- 🕐 出生时间选择器:按钟点(时+分,自动算时辰)或 只按时辰,填入 #f_birth_time ----
const SHICHEN_RANGE = ["23-1", "1-3", "3-5", "5-7", "7-9", "9-11", "11-13", "13-15", "15-17", "17-19", "19-21", "21-23"];
const tmask = document.createElement("div");
tmask.className = "mask"; tmask.id = "timeMask";
tmask.innerHTML = `
  <div class="modal" style="width:min(360px,100%)">
    <h2>选择出生时间</h2>
    <div class="field"><label>怎么选(自动算时辰)</label>
      <div style="display:flex;gap:1.2rem;align-items:center">
        <label class="switch"><input type="radio" name="tmMode" value="clock" checked> 按钟点</label>
        <label class="switch"><input type="radio" name="tmMode" value="shichen"> 只按时辰</label>
      </div></div>
    <div class="grid2" id="tmClock" style="grid-template-columns:1fr 1fr">
      <div class="field"><label>时(0–23)</label><select id="tmH"></select></div>
      <div class="field"><label>分</label><select id="tmMin"></select></div>
    </div>
    <div class="field" id="tmShi" style="display:none"><label>时辰</label><select id="tmSc"></select></div>
    <div class="hint" id="tmPrev" style="margin-top:.6rem;font-size:.85rem"></div>
    <div class="modal-foot"><button class="btn" id="tmClear" type="button">不选(清空)</button><span class="spacer"></span>
      <button class="btn" id="tmCancel" type="button">取消</button>
      <button class="btn btn-primary" id="tmOk" type="button">填入</button></div>
  </div>`;
document.body.appendChild(tmask);
const tq = id => tmask.querySelector("#" + id);
const tmH = tq("tmH"), tmMin = tq("tmMin"), tmSc = tq("tmSc"), tmClock = tq("tmClock"), tmShi = tq("tmShi"), tmPrev = tq("tmPrev");
for (let h = 0; h <= 23; h++) tmH.add(new Option(h + " 点(" + shichenOf(h) + ")", h));
for (let mi = 0; mi <= 59; mi++) tmMin.add(new Option(String(mi).padStart(2, "0") + " 分", mi));
SHICHEN.forEach((s, i) => tmSc.add(new Option(s + "时(" + SHICHEN_RANGE[i] + "点)", s + "时")));
const tmMode = () => tmask.querySelector("input[name=tmMode]:checked").value;
function tmRefresh() {
  const clock = tmMode() === "clock";
  tmClock.style.display = clock ? "" : "none";
  tmShi.style.display = clock ? "none" : "";
  tmPrev.innerHTML = clock
    ? `出生时间 <b>${+tmH.value}:${String(+tmMin.value).padStart(2, "0")}</b> &nbsp;·&nbsp; 时辰 <b>${shichenOf(+tmH.value)}</b>`
    : `时辰 <b>${tmSc.value}</b>`;
}
function tmOpen() {
  if (!document.getElementById("f_birth_time")) return;
  const cur = (document.getElementById("f_birth_time").value || "").trim();
  const m = cur.match(/^(\d{1,2})(?:[:：点时]?(\d{1,2}))?/);
  const sc = cur.match(/([子丑寅卯辰巳午未申酉戌亥])时/);
  if (m && +m[1] >= 0 && +m[1] <= 23) {
    tmask.querySelector("input[name=tmMode][value=clock]").checked = true;
    tmH.value = +m[1]; tmMin.value = m[2] != null ? +m[2] : 0;
  } else if (sc) {
    tmask.querySelector("input[name=tmMode][value=shichen]").checked = true;
    tmSc.value = sc[1] + "时";
  } else {
    tmask.querySelector("input[name=tmMode][value=clock]").checked = true;
    tmH.value = 12; tmMin.value = 0;
  }
  tmRefresh();
  tmask.classList.add("open");
}
function tmClose() { tmask.classList.remove("open"); }
tmask.addEventListener("change", e => {
  if (e.target.name === "tmMode" || ["tmH", "tmMin", "tmSc"].includes(e.target.id)) tmRefresh();
});
tq("tmCancel").addEventListener("click", tmClose);
tq("tmClear").addEventListener("click", () => { const el = document.getElementById("f_birth_time"); if (el) el.value = ""; const h = document.getElementById("f_birth_time_sc"); if (h) h.textContent = ""; tmClose(); });
tmask.addEventListener("click", e => { if (e.target === tmask) tmClose(); });
tq("tmOk").addEventListener("click", () => {
  const el = document.getElementById("f_birth_time");
  el.value = tmMode() === "clock"
    ? `${+tmH.value}:${String(+tmMin.value).padStart(2, "0")} ${shichenOf(+tmH.value)}`
    : tmSc.value;
  const hint = document.getElementById("f_birth_time_sc"); if (hint) hint.textContent = "";
  tmClose();
});
document.addEventListener("click", e => {
  const b = e.target.closest(".time-btn");
  if (b) { e.preventDefault(); tmOpen(); }
});
