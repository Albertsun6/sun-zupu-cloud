#!/usr/bin/env node
// =====================================================================
// 一次性数据迁移:把本地导出的 JSON 灌入 Supabase + 上传 4 张原谱影像。
// 用 service_role 密钥(绕过 RLS),本地运行一次,绝不提交仓库。
//
// 用法:
//   SUPABASE_URL=https://xxxx.supabase.co \
//   SUPABASE_SERVICE_ROLE=eyJ...service_role... \
//   node migrate.mjs <导出JSON路径> <含p1..p4.jpg的原谱目录>
// 例:
//   node migrate.mjs ../../migration-data/zupu-export.json "../../族谱系统/photos/原谱"
// 前提:已在 Supabase SQL Editor 跑过 schema.sql / policies.sql / functions.sql。
// =====================================================================
import fs from "node:fs";
import path from "node:path";

const URL_ = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_ROLE;
if (!URL_ || !KEY) { console.error("请设置环境变量 SUPABASE_URL 与 SUPABASE_SERVICE_ROLE"); process.exit(1); }
const exportPath = process.argv[2] || "zupu-export.json";
const imgDir = process.argv[3] || "原谱";
const H = { apikey: KEY, Authorization: "Bearer " + KEY, "Content-Type": "application/json" };

async function rest(table, rows) {
  if (!rows || !rows.length) { console.log(`  ${table}: (空,跳过)`); return; }
  const r = await fetch(`${URL_}/rest/v1/${table}`, {
    method: "POST",
    headers: { ...H, Prefer: "return=minimal,resolution=merge-duplicates" },
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`${table}: ${r.status} ${await r.text()}`);
  console.log(`  ${table}: 写入 ${rows.length} 行`);
}

async function main() {
  if (!fs.existsSync(exportPath)) throw new Error("找不到导出 JSON: " + exportPath);
  const data = JSON.parse(fs.readFileSync(exportPath, "utf8"));
  console.log("源数据: persons", (data.persons || []).length);

  const persons = (data.persons || []).map(p => { const { marriages, media, _redacted, created_at, updated_at, ...rest } = p; return rest; });
  await rest("persons", persons);

  const marr = [], med = [];
  (data.persons || []).forEach(p => {
    (p.marriages || []).forEach(m => { const { id, ...r } = m; marr.push({ ...r, person_id: p.id }); });
    (p.media || []).forEach(m => { const { id, ...r } = m; med.push({ ...r, person_id: p.id }); });
  });
  await rest("marriages", marr);
  await rest("media", med);
  await rest("narratives", data.narratives || []);
  await rest("verify", (data.verify || []).map(v => { const { id, ...r } = v; return r; }));
  await rest("transcription", data.transcription || []);
  await rest("meta", [{ key: "meta", value: data.meta || {} }]);

  for (const pg of ["p1", "p2", "p3", "p4"]) {
    const fp = path.join(imgDir, pg + ".jpg");
    if (!fs.existsSync(fp)) { console.log("  原谱图缺失,跳过:", fp); continue; }
    const buf = fs.readFileSync(fp);
    const u = await fetch(`${URL_}/storage/v1/object/photos/yuanpu/${pg}.jpg`, {
      method: "POST",
      headers: { apikey: KEY, Authorization: "Bearer " + KEY, "Content-Type": "image/jpeg", "x-upsert": "true" },
      body: buf,
    });
    if (!u.ok) throw new Error(`上传 ${pg}: ${u.status} ${await u.text()}`);
    console.log("  上传 原谱/" + pg + ".jpg");
  }
  console.log("✅ 迁移完成。登录后到「原谱影像与原文」应能看到 4 页扫描。");
}
main().catch(e => { console.error("❌ 失败:", e.message); process.exit(1); });
