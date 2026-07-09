// zupu-backup —— 独立 Cloudflare Worker(每日 cron)把关系图谱【全量数据 JSON】拓到 R2 私有桶。
// 传家档案不再只靠"人记得点导出"。设计要点(安全):
//  - 用 service_role 只读全库主要表 → 组一份 JSON → 写 R2(按日期命名)。service_role 只在本 Worker secret,绝不入前端/仓库。
//  - 【只写 R2,永不把数据回给任何调用方】:scheduled 无返回;/run 手动触发也只回 {ok, key, 各表行数},绝不回数据体。
//    故即便 BACKUP_TOKEN 泄露,攻击者最多触发几次多余备份(写进你自己的私有 R2),拿不到任何数据。
//  - /run 需 BACKUP_TOKEN(未配 → 一律 403,fail-closed)。R2 桶必须是私有(默认即私有)。
// 部署:见同目录 README.md(CF 后台建 R2 桶 + 建 Worker + 绑定 + 加 secret + cron;或 wrangler)。

const SB_URL = "https://ktalsyrxueabdisrszde.supabase.co";
// 传家核心数据表(录音音频不备,在 Supabase 私有桶另有平台备份;见决策)。值=主键列,分页必须按它排序。
const TABLES = {
  persons: "id", relationships: "id", relationship_types: "type", marriages: "id",
  media: "id", narratives: "key", verify: "id", transcription: "page", meta: "key",
  history: "id", minutes: "id", minute_segments: "id",
};

async function fetchAll(sr, table, pk) {
  const out = [], page = 1000; let offset = 0;
  for (;;) {
    // order=<主键> 必带:无 ORDER BY 的 limit/offset 跨请求行序不稳,>1000 行的表(history)会静默丢/重行
    const r = await fetch(`${SB_URL}/rest/v1/${table}?select=*&order=${pk}.asc&limit=${page}&offset=${offset}`,
      { headers: { apikey: sr, authorization: "Bearer " + sr } });
    if (!r.ok) throw new Error(`${table} -> ${r.status}`);
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) break;   // 只以空页终止(不假设服务器 Max Rows 恰为 1000)
    out.push(...rows);
    offset += rows.length;
  }
  return out;
}

async function doBackup(env) {
  const sr = env.SUPABASE_SERVICE_ROLE;
  if (!sr) throw new Error("未配置 SUPABASE_SERVICE_ROLE");
  if (!env.BACKUP_BUCKET) throw new Error("未绑定 R2 桶 BACKUP_BUCKET");
  const at = new Date().toISOString();
  const data = { _meta: { app: "zupu-cloud", at } }, counts = {};
  for (const [t, pk] of Object.entries(TABLES)) { const rows = await fetchAll(sr, t, pk); data[t] = rows; counts[t] = rows.length; }
  // 哨兵:persons 0 行 = key 贴错(anon key 会被 RLS 滤成空结果而非报错)或库空——拒绝写"成功"的空备份
  if (!counts.persons) throw new Error("persons 0 行,拒绝写空备份——检查 SUPABASE_SERVICE_ROLE 是否贴成了 anon key");
  const json = JSON.stringify(data);
  // 文件名用北京日期(cron UTC 19:00 = 北京次日 03:00,直接用 UTC 日期会与用户心智恒差一天);同日重跑覆盖当天
  const key = "backup-" + new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10) + ".json";
  await env.BACKUP_BUCKET.put(key, json, { httpMetadata: { contentType: "application/json" } });
  return { key, bytes: json.length, counts };
}

export default {
  // 每日 cron 自动备份
  async scheduled(event, env, ctx) { ctx.waitUntil(doBackup(env)); },
  // 手动触发(测试用):POST/GET /run,需 BACKUP_TOKEN;只回状态,绝不回数据
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/run") {
      const tok = request.headers.get("x-backup-token") || url.searchParams.get("token");
      if (!env.BACKUP_TOKEN || tok !== env.BACKUP_TOKEN) return new Response("forbidden", { status: 403 });
      try { return Response.json({ ok: true, ...(await doBackup(env)) }); }
      catch (e) { return Response.json({ ok: false, error: String(e && e.message || e) }, { status: 500 }); }
    }
    return new Response("zupu-backup worker（每日 cron 备份到 R2;/run 需 token 手动触发）", { status: 200 });
  },
};
