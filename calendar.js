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
      <span class="spacer"></span>
      <button class="btn" id="calCancel" type="button">取消</button>
      <button class="btn btn-primary" id="calOk" type="button">填入</button>
    </div>
  </div>`;
document.body.appendChild(mask);

const q = id => mask.querySelector("#" + id);
const calY = q("calY"), calM = q("calM"), calD = q("calD"), calLeap = q("calLeap"),
      calLeapWrap = q("calLeapWrap"), calPrev = q("calPrev"), calTitle = q("calTitle"), calOk = q("calOk");
for (let m = 1; m <= 12; m++) calM.add(new Option(m + " 月", m));

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
  const y = parseInt(calY.value), m = parseInt(calM.value);
  let n = 30;
  if (y && m) n = mode() === "solar" ? solarDays(y, m) : (lunarDays(y, m, calLeap.checked) || 30);
  const cur = parseInt(calD.value) || 1;
  calD.innerHTML = "";
  for (let d = 1; d <= n; d++) calD.add(new Option(d + " 日", d));
  calD.value = Math.min(cur, n);
}
function compute() {
  const y = parseInt(calY.value), m = parseInt(calM.value), d = parseInt(calD.value);
  if (!y || !m || !d) return { err: "请填写 年 / 月 / 日" };
  try {
    if (mode() === "solar") {
      if (d > solarDays(y, m)) return { err: `公历 ${y}年${m}月 没有 ${d} 日` };
      const lu = Solar.fromYmd(y, m, d).getLunar();
      return { solar: `${y}-${pad(m)}-${pad(d)}`, lunar: `农历${lu.getMonthInChinese()}月${lu.getDayInChinese()}`, gz: lu.getYearInGanZhi() };
    }
    const leap = calLeap.checked && leapMonthOf(y) === m;
    const dc = lunarDays(y, m, leap);
    if (!dc) return { err: "该年没有这个(闰)月" };
    if (d > dc) return { err: `农历${leap ? "闰" : ""}${m}月 只有 ${dc} 天` };
    const lo = Lunar.fromYmd(y, leap ? -m : m, d), so = lo.getSolar();
    return { solar: `${so.getYear()}-${pad(so.getMonth())}-${pad(so.getDay())}`, lunar: `农历${lo.getMonthInChinese()}月${lo.getDayInChinese()}`, gz: lo.getYearInGanZhi() };
  } catch { return { err: "无法换算(年份可能超出范围)" }; }
}
function updatePreview() {
  const r = compute();
  if (r.err) { calPrev.textContent = "⚠ " + r.err; calPrev.style.color = "#b45309"; calOk.disabled = true; }
  else { calPrev.innerHTML = `公历 <b>${r.solar}</b> &nbsp;·&nbsp; ${r.gz}年 <b>${r.lunar}</b>`; calPrev.style.color = "#475569"; calOk.disabled = false; }
}
function refresh() { rebuildLeap(); rebuildDays(); updatePreview(); }

function open(ev) {
  if (!Solar) { alert("农历库未能加载(检查网络),请直接在框里手填日期。"); return; }
  targetEv = ev in FIELDS ? ev : "birth";
  calTitle.textContent = "万年历 · 选择" + (targetEv === "death" ? "卒日" : "生日");
  const cur = (document.getElementById(FIELDS[targetEv][0]).value || "").trim();
  const full = cur.match(/^(\d{3,4})-(\d{1,2})-(\d{1,2})$/);
  mask.querySelector("input[name=calMode][value=solar]").checked = true;
  if (full) { calY.value = +full[1]; calM.value = +full[2]; }
  else { const ym = cur.match(/(\d{3,4})/); calY.value = ym ? +ym[1] : ""; calM.value = 1; }
  refresh();
  if (full) { calD.value = +full[3]; updatePreview(); }
  mask.classList.add("open");
}
function close() { mask.classList.remove("open"); }

calY.addEventListener("input", refresh);
mask.addEventListener("change", e => {
  if (e.target.name === "calMode" || e.target.id === "calM" || e.target.id === "calLeap") refresh();
  else if (e.target.id === "calD") updatePreview();
});
q("calCancel").addEventListener("click", close);
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
