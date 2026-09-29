// probes/check-migrations.mjs —— 核对"线上库跑过哪些 SQL"vs 仓库里有哪些 SQL(防漏跑迁移)。
// 凭证只从环境变量(或本地 gitignore 的 config.js)读,仓库里不再写 url/anon。
// 用法:SUPABASE_URL=... SUPABASE_ANON_KEY=... node probes/check-migrations.mjs
//      或本地已有 config.js 时直接 node probes/check-migrations.mjs
// CI / fork PR 未配变量时优雅跳过(exit 0),不把检查弄红。
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadSb() {
  let url = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  let anon = String(process.env.SUPABASE_ANON_KEY || "");
  if (url && anon) return { url, anon };
  const cfgPath = join(ROOT, "config.js");
  if (!existsSync(cfgPath)) return { url: "", anon: "" };
  const cfg = readFileSync(cfgPath, "utf8");
  url = (cfg.match(/url:\s*"([^"]+)"/) || [])[1] || "";
  anon = (cfg.match(/anon:\s*"([^"]+)"/) || [])[1] || "";
  if (!url || !anon || url.includes("YOUR_PROJECT") || anon.includes("YOUR_SUPABASE")) return { url: "", anon: "" };
  return { url, anon };
}

const { url: SB_URL, anon: SB_ANON } = loadSb();
if (!SB_URL || !SB_ANON) {
  console.log("跳过 check-migrations:未设置 SUPABASE_URL / SUPABASE_ANON_KEY(fork PR 或未配 secret/本地 config.js)。");
  process.exit(0);
}

// 仓库里应有的迁移 = supabase/*.sql 的基名
const files = readdirSync(join(ROOT, "supabase")).filter(f => f.endsWith(".sql")).map(f => f.replace(/\.sql$/, "")).sort();

const r = await fetch(SB_URL + "/rest/v1/schema_migrations?select=version", { headers: { apikey: SB_ANON, authorization: "Bearer " + SB_ANON } });
if (r.status === 404 || r.status === 400) { console.error("❌ 线上还没有 schema_migrations 表 —— 先在 Supabase 跑 supabase/migrations-registry.sql"); process.exit(1); }
if (!r.ok) { console.error("查询失败 HTTP " + r.status); process.exit(2); }
const applied = new Set((await r.json()).map(x => x.version));
// RLS 挡读时 PostgREST 回 200+[](不是 404)——空集≠"9 份全缺",别给错误处方
if (!applied.size) {
  console.error("❌ 线上 schema_migrations 读出来是空的——通常是 supabase/migrations-registry.sql 没跑完整(建了表但读策略/登记没落)。请在 SQL Editor 整段重跑它,再来核对。");
  process.exit(1);
}

const missing = files.filter(f => !applied.has(f));
const orphans = [...applied].filter(v => !files.includes(v));
console.log("仓库 SQL 文件:", files.join(", "));
console.log("线上已登记 :", [...applied].sort().join(", "));
if (orphans.length) console.warn("⚠️  线上登记了仓库里没有的版本(自登记行拼错?文件改名?):", orphans.join(", "));
if (missing.length) {
  console.error("\n❌ 线上库缺这些迁移(需在 Supabase SQL Editor 跑对应文件):\n  " + missing.map(m => "supabase/" + m + ".sql").join("\n  "));
  process.exit(1);
}
console.log("\n✅ 线上库已跑全部仓库内 SQL 迁移");
