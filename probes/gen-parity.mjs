// probes/gen-parity.mjs —— 世代双实现一致性探针(健康度评审 P4 固化)
// 断言:app.js 的 genOf/_genWalk 与 db.js 的 buildGenOf 对真实库【全员】给出相同世代。
// 两份都是从源码文件【原样提取后执行】——不存在第三份实现,防"探针自己又是一份复刻"。
// 用法:ZUPU_EMAIL=... ZUPU_PASSWORD=... node probes/gen-parity.mjs   (凭证只经环境变量,绝不写死)
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EMAIL = process.env.ZUPU_EMAIL, PW = process.env.ZUPU_PASSWORD;
if (!EMAIL || !PW) { console.error("需要 ZUPU_EMAIL / ZUPU_PASSWORD 环境变量(任一已确认账号)"); process.exit(2); }

// url/anon:环境变量优先,否则读本地 gitignore 的 config.js
function loadSb() {
  let url = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  let anon = String(process.env.SUPABASE_ANON_KEY || "");
  if (url && anon) return { url, anon };
  const cfg = readFileSync(join(ROOT, "config.js"), "utf8");
  return { url: (cfg.match(/url:\s*"([^"]+)"/) || [])[1], anon: (cfg.match(/anon:\s*"([^"]+)"/) || [])[1] };
}
const { url: SB_URL, anon: SB_ANON } = loadSb();
if (!SB_URL || !SB_ANON) { console.error("读不到 SUPABASE_URL / SUPABASE_ANON_KEY(环境变量或本地 config.js)"); process.exit(2); }

async function req(method, path, body, tok) {
  const r = await fetch(SB_URL + path, { method, headers: { apikey: SB_ANON, "Content-Type": "application/json", ...(tok ? { Authorization: "Bearer " + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); if (!r.ok) throw new Error(method + " " + path + " -> " + r.status);
  return t ? JSON.parse(t) : null;
}
const tok = (await req("POST", "/auth/v1/token?grant_type=password", { email: EMAIL, password: PW })).access_token;
const persons = await req("GET", "/rest/v1/persons?select=id,gen,deleted&limit=3000", null, tok);
const rels = await req("GET", "/rest/v1/relationships?select=from_id,to_id,type&limit=5000", null, tok);
const live = persons.filter(p => !p.deleted);

// —— 提取并执行 db.js 的 buildGenOf(自包含纯函数) ——
const dbSrc = readFileSync(join(ROOT, "db.js"), "utf8");
const mDb = dbSrc.match(/function buildGenOf\(persons, relationships\)\{[\s\S]*?\n\}/);
if (!mDb) { console.error("db.js 里找不到 buildGenOf(签名变了?同步本探针)"); process.exit(2); }
const buildGenOf = new Function("persons", "relationships", mDb[0] + "; return buildGenOf(persons, relationships);");
const dbGen = buildGenOf(live, rels);

// —— 提取并执行 app.js 的 genOf/_genWalk(依赖 state/byId,搭最小桩) ——
const appSrc = readFileSync(join(ROOT, "app.js"), "utf8");
const mWalk = appSrc.match(/function _genWalk\(id, seen\)\{[\s\S]*?\n\}/);
if (!mWalk) { console.error("app.js 里找不到 _genWalk(签名变了?同步本探针)"); process.exit(2); }
const state = { fatherOf: {}, motherOf: {}, spouseOf: {}, _genCache: {} };
rels.forEach(r => {
  if (r.type === "father") state.fatherOf[r.to_id] = r.from_id;
  else if (r.type === "mother") state.motherOf[r.to_id] = r.from_id;
  else if (r.type === "spouse") { (state.spouseOf[r.from_id] = state.spouseOf[r.from_id] || []).push(r.to_id); (state.spouseOf[r.to_id] = state.spouseOf[r.to_id] || []).push(r.from_id); }
});
const byMap = Object.fromEntries(live.map(p => [p.id, p]));
const byId = id => byMap[id];
const appGenOf = new Function("state", "byId", mWalk[0] + "; return id => _genWalk(id, new Set());")(state, byId);

// —— 全员断言 ——
let bad = 0;
for (const p of live) {
  const a = appGenOf(p.id), d = dbGen(p.id);
  if (a !== d) { bad++; if (bad <= 10) console.error(`✗ ${p.id}: app=${a} db=${d}`); }
}
if (bad) { console.error(`=== gen-parity: ${bad}/${live.length} 不一致 —— app.js genOf 与 db.js buildGenOf 已分叉!===`); process.exit(1); }
console.log(`=== gen-parity: ${live.length} 人全员一致 ✓(app.js genOf === db.js buildGenOf)===`);
