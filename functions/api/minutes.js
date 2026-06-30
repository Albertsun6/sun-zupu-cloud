// Cloudflare Pages Function —— 纪要后端(录音签名URL / 阿里 Fun-ASR 转写 / DeepSeek 摘要任务脑图)
// 路由:POST /api/minutes   body = { action, ... }
// 安全:
//  - 持 service_role + DASHSCOPE_API_KEY + DEEPSEEK_API_KEY,全在 CF 环境变量(绝不入前端/仓库)。
//  - 每个动作先 requireMinutes():校验调用者 JWT 的 can_minutes(role=admin 或 app_metadata.perms 含 'minutes')。
//  - 录音桶 recordings 私有:签名URL 由本函数 service_role 签发(绕开 storage-api 对 app_metadata RLS 的古怪)。
//  - minutes 的【受控列】(状态机/转写/音频/审计)只由本函数 service_role 写(restSvc);DB 触发器禁止普通 JWT 改这些列。
//    每个 action 先 requireMinutes(权限)+ getMinute(调用者 JWT 读,RLS 行可见性)再做受控写;客户端经 PostgREST 只能改 title/meeting_at/note。
// 配置:CF Pages env:SUPABASE_SERVICE_ROLE、DASHSCOPE_API_KEY、DASHSCOPE_BASE(按 key 归属区:
//      境内 https://dashscope.aliyuncs.com / 国际 https://dashscope-intl.aliyuncs.com)、DEEPSEEK_API_KEY(已配)。

const SB_URL  = "https://ktalsyrxueabdisrszde.supabase.co";
const SB_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt0YWxzeXJ4dWVhYmRpc3JzemRlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI1Mjc3MjYsImV4cCI6MjA5ODEwMzcyNn0.Chj8Zdn9BbK7PbpiEoa7iKDmuq_fSab019vL5X5vtPc";
const REST = SB_URL + "/rest/v1";
const STORAGE = SB_URL + "/storage/v1";
const BUCKET = "recordings";
const EXT_OK = new Set(["mp3", "mp4", "m4a", "aac", "wav", "flac", "ogg", "opus", "amr", "wma", "webm"]);

function json(o, status) { return new Response(JSON.stringify(o), { status: status || 200, headers: { "content-type": "application/json; charset=utf-8" } }); }
function extractJson(s) { try { return JSON.parse(s); } catch (e) {} const a = s.indexOf("{"), b = s.lastIndexOf("}"); if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch (e) {} } return null; }

// 校验调用者具备纪要权限(role=admin 或 perms 含 minutes)。返回 { user, token } 或 { resp }
async function requireMinutes(request) {
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return { resp: json({ error: "未登录" }, 401) };
  const ures = await fetch(SB_URL + "/auth/v1/user", { headers: { apikey: SB_ANON, authorization: "Bearer " + token } });
  if (!ures.ok) return { resp: json({ error: "登录校验失败,请重新登录" }, 401) };
  const user = await ures.json();
  if (!user || user.aud !== "authenticated") return { resp: json({ error: "无效令牌" }, 401) };
  const role = (user.app_metadata && user.app_metadata.role) || "viewer";
  const perms = (user.app_metadata && user.app_metadata.perms) || [];
  if (role !== "admin" && !(Array.isArray(perms) && perms.includes("minutes")))
    return { resp: json({ error: "无纪要权限" }, 403) };
  return { user, token };
}

// PostgREST(用调用者 JWT,RLS 生效)
async function rest(method, token, pathQuery, body, prefer) {
  const r = await fetch(REST + pathQuery, { method, headers: { apikey: SB_ANON, authorization: "Bearer " + token, "content-type": "application/json", ...(prefer ? { Prefer: prefer } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const txt = await r.text(); let data = null; try { data = txt ? JSON.parse(txt) : null; } catch (e) {}
  if (!r.ok) { const e = new Error("REST_" + r.status); e.status = r.status; e.detail = txt.slice(0, 150); throw e; }
  return data;
}
async function getMinute(token, id) { const rows = await rest("GET", token, "/minutes?id=eq." + id + "&select=*"); return Array.isArray(rows) ? rows[0] : null; }
// 受控写:用 service_role 写 minutes 的状态机/转写/音频/审计列(DB 触发器禁止普通 JWT 改这些列,故必须经此)。
// 调用者已先过 requireMinutes,授权已校验;service_role 仅用于"受控字段"的服务端原子更新,不放权给客户端。
async function restSvc(method, env, pathQuery, body, prefer) {
  const k = env.SUPABASE_SERVICE_ROLE;
  const r = await fetch(REST + pathQuery, { method, headers: { apikey: k, authorization: "Bearer " + k, "content-type": "application/json", ...(prefer ? { Prefer: prefer } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const txt = await r.text(); let data = null; try { data = txt ? JSON.parse(txt) : null; } catch (e) {}
  if (!r.ok) { const e = new Error("RESTSVC_" + r.status); e.status = r.status; throw e; }
  return data;
}

// Storage 签名URL(service_role,绕开 storage RLS)
function svcHeaders(env) { const k = env.SUPABASE_SERVICE_ROLE; return { apikey: k, authorization: "Bearer " + k, "content-type": "application/json" }; }
async function signedDownload(env, path, expiresIn) {
  const r = await fetch(STORAGE + "/object/sign/" + BUCKET + "/" + path, { method: "POST", headers: svcHeaders(env), body: JSON.stringify({ expiresIn }) });
  if (!r.ok) { const e = new Error("SIGN"); e.status = 502; throw e; }
  const d = await r.json(); return STORAGE + d.signedURL;   // signedURL 形如 /object/sign/recordings/<path>?token=...
}
async function signedUpload(env, path) {
  // 必带 body(哪怕空 {}):content-type=application/json 却无 body 时,storage 解析空体会 400(→502)。
  const r = await fetch(STORAGE + "/object/upload/sign/" + BUCKET + "/" + path, { method: "POST", headers: svcHeaders(env), body: JSON.stringify({}) });
  if (!r.ok) { const e = new Error("UPLOADSIGN"); e.status = 502; throw e; }
  const d = await r.json();   // { url: "/object/upload/sign/recordings/<path>?token=..." }
  const token = (String(d.url || "").split("token=")[1] || "").split("&")[0];
  return { path, token };
}

// 脑图:剥 ``` 代码围栏 + 缺 mindmap 头时补一个(供前端 mermaid 渲染)。导出以便探针验证。
export function normalizeMindmap(content) {
  let mm = String(content || "").trim().replace(/^```[a-z]*\s*/i, "").replace(/```\s*$/i, "").trim();
  if (!/^mindmap/i.test(mm)) mm = "mindmap\n  root((会议))\n" + mm.split("\n").map(l => "    " + l.trim()).filter(Boolean).join("\n");
  return mm;
}
// 校验 attach 的对象 key 严格属于本纪要文件夹:minutes/<id>/<安全文件名>,无路径穿越。导出以便探针验证。
export function validAttachPath(id, path) {
  return typeof path === "string"
    && path.startsWith("minutes/" + id + "/")
    && /^minutes\/\d+\/[A-Za-z0-9._-]+$/.test(path)   // 文件名段不含 "/",故无 ../ 穿越;前缀同号(如 id=1 vs minutes/12/)也被 startsWith 排除
    && !path.includes("..");
}
// 解析 Fun-ASR 结果 JSON → { transcript, segments[] }。导出以便探针验证(ms→s、speaker、多文件拼接)。
export function parseAsr(result) {
  const out = { transcript: "", segments: [] };
  const ts = (result && result.transcripts) || [];
  const texts = [];
  for (const t of ts) {
    if (t.text) texts.push(t.text);
    for (const s of (t.sentences || [])) {
      out.segments.push({ start: Math.round((s.begin_time || 0) / 1000), end: Math.round((s.end_time || 0) / 1000), speaker: (s.speaker_id != null ? String(s.speaker_id) : ""), text: s.text || "" });
    }
  }
  out.transcript = texts.join("\n") || out.segments.map(s => s.text).join("");
  return out;
}
function fmtTime(sec) { sec = Math.max(0, Math.floor(sec || 0)); const m = Math.floor(sec / 60), s = sec % 60; return (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s; }
function transcriptForAI(m) {
  const segs = Array.isArray(m.transcript_json) ? m.transcript_json : [];
  let body = segs.length
    ? segs.map(s => "[" + fmtTime(s.start) + (s.speaker ? " 说话人" + s.speaker : "") + "] " + (s.text || "")).join("\n")
    : (m.transcript || "");
  if (body.length > 12000) body = body.slice(0, 12000) + "\n…(转写过长已截断)";
  return body;
}

const AI_SYS = {
  summary: "你是中文会议纪要助手。根据下面带时间戳/说话人的会议转写,输出结构化中文摘要,含:① 一句话概述;② 关键讨论点(可标注大致在第几分钟、谁说的);③ 形成的决定;④ 待跟进事项。只输出 Markdown 文本,不要代码块包裹。忠于原文,不编造。",
  tasks: "你从下面的会议转写中提取【行动项/任务】。只输出一个 JSON 对象 {\"tasks\":[{\"task\":\"...\",\"owner\":\"负责人或空\",\"due\":\"截止或空\"}]},不要解释、不要 markdown 代码块。没有明确任务就返回 {\"tasks\":[]}。忠于原文,不编造负责人/时间。",
  mindmap: "你把下面的会议转写整理成层级脑图。只输出 mermaid 的 mindmap 语法:第一行是 mindmap,然后 root((会议主题)),再用缩进表示层级(2~3 层)。只输出 mermaid 代码本身,不要 ``` 包裹、不要任何解释。节点文字简短,避免特殊符号 ()[]{} 与引号。",
};

async function deepseek(env, system, userText) {
  const key = env.DEEPSEEK_API_KEY;
  if (!key) { const e = new Error("NO_DEEPSEEK"); e.status = 500; e.msg = "服务器未配置 DEEPSEEK_API_KEY"; throw e; }
  const model = env.DEEPSEEK_MODEL || "deepseek-chat";
  const base = (env.DEEPSEEK_BASE || "https://api.deepseek.com").replace(/\/+$/, "");
  const r = await fetch(base + "/chat/completions", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + key }, body: JSON.stringify({ model, stream: false, temperature: 0, messages: [{ role: "system", content: system }, { role: "user", content: userText }] }) });
  if (!r.ok) { const e = new Error("DEEPSEEK_" + r.status); e.status = 502; throw e; }
  const d = await r.json();
  return (d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || "";
}

export async function onRequestPost({ request, env }) {
  try {
    const gate = await requireMinutes(request); if (gate.resp) return gate.resp;
    const token = gate.token;
    const body = await request.json().catch(() => ({}));
    const action = body.action;

    // ---------- 录音上传:签发签名上传 URL(service_role)----------
    if (action === "upload-url") {
      if (!env.SUPABASE_SERVICE_ROLE) return json({ error: "服务器未配置 SUPABASE_SERVICE_ROLE" }, 500);
      const id = parseInt(body.minuteId, 10); if (!id) return json({ error: "缺少 minuteId" }, 400);
      const mine = await getMinute(token, id); if (!mine) return json({ error: "纪要不存在或无权限" }, 404);
      let ext = String(body.ext || (String(body.filename || "").split(".").pop()) || "m4a").toLowerCase().replace(/[^a-z0-9]/g, "");
      if (!EXT_OK.has(ext)) ext = "m4a";
      const path = "minutes/" + id + "/" + crypto.randomUUID() + "." + ext;
      const up = await signedUpload(env, path);
      return json({ ok: true, ...up });
    }

    // ---------- 回放:签发签名下载 URL ----------
    if (action === "play-url") {
      if (!env.SUPABASE_SERVICE_ROLE) return json({ error: "服务器未配置 SUPABASE_SERVICE_ROLE" }, 500);
      const id = parseInt(body.minuteId, 10); if (!id) return json({ error: "缺少 minuteId" }, 400);
      const mine = await getMinute(token, id); if (!mine || !mine.audio_path) return json({ error: "无录音" }, 404);
      const url = await signedDownload(env, mine.audio_path, 3600);
      return json({ ok: true, url });
    }

    // ---------- 录音上传完成 → 服务端绑定到纪要(受控写;校验路径属于本纪要,防 IDOR/改 audio_path)----------
    if (action === "attach") {
      if (!env.SUPABASE_SERVICE_ROLE) return json({ error: "服务器未配置 SUPABASE_SERVICE_ROLE" }, 500);
      const id = parseInt(body.minuteId, 10); if (!id) return json({ error: "缺少 minuteId" }, 400);
      const mine = await getMinute(token, id); if (!mine) return json({ error: "纪要不存在或无权限" }, 404);
      const path = String(body.path || "");
      if (!validAttachPath(id, path)) return json({ error: "非法的音频路径" }, 400);   // 必须严格是本纪要文件夹(upload-url 签发的),无穿越
      const ext = String(path.split(".").pop() || "").toLowerCase();
      if (!EXT_OK.has(ext)) return json({ error: "不支持的音频格式" }, 400);
      // 仅在"未/待转写"状态可绑定录音;禁止把 transcribing/transcribed/done 打回 uploaded(否则可再触发转写=双计费)
      const rows = await restSvc("PATCH", env, "/minutes?id=eq." + id + "&status=in.(draft,uploading,uploaded,failed)", { audio_path: path, audio_mime: String(body.mime || ""), audio_size: parseInt(body.size, 10) || 0, duration_sec: parseInt(body.duration, 10) || 0, status: "uploaded" }, "return=representation");
      if (!Array.isArray(rows) || !rows.length) return json({ error: "当前状态不可附加录音(正在转写或已转写)" }, 409);
      return json({ ok: true });
    }

    // ---------- 提交转写(阿里 Fun-ASR 异步)----------
    if (action === "transcribe") {
      if (!env.SUPABASE_SERVICE_ROLE) return json({ error: "服务器未配置 SUPABASE_SERVICE_ROLE" }, 500);
      const dkey = env.DASHSCOPE_API_KEY;
      if (!dkey) return json({ error: "服务器未配置 DASHSCOPE_API_KEY(阿里百炼)。请在 CF Pages 环境变量添加后重新部署。" }, 500);
      const base = (env.DASHSCOPE_BASE || "https://dashscope.aliyuncs.com").replace(/\/+$/, "");
      const id = parseInt(body.minuteId, 10); if (!id) return json({ error: "缺少 minuteId" }, 400);
      const m = await getMinute(token, id); if (!m) return json({ error: "纪要不存在或无权限" }, 404);
      if (!m.audio_path) return json({ error: "请先上传录音" }, 400);
      // 幂等:已在转写且有 task_id → 直接返回,不重复提交(防双计费)
      if (m.status === "transcribing" && m.asr_task_id) return json({ ok: true, status: "transcribing", task_id: m.asr_task_id, note: "已在转写中" });
      const ext = String(m.audio_path.split(".").pop() || "").toLowerCase();
      if (ext && !EXT_OK.has(ext)) return json({ error: "音频格式 ." + ext + " 可能不被识别,请上传 mp3/m4a/wav/aac" }, 400);
      // 条件锁:仅 uploaded/failed 可转入 transcribing(并发/双击只有一个能抢到)
      const locked = await restSvc("PATCH", env, "/minutes?id=eq." + id + "&status=in.(uploaded,failed)", { status: "transcribing", asr_error: "", asr_task_id: "" }, "return=representation");
      if (!Array.isArray(locked) || !locked.length) { const cur = await getMinute(token, id); return json({ ok: true, status: (cur && cur.status) || "unknown", task_id: (cur && cur.asr_task_id) || "", note: "已在转写或状态不可转写" }); }
      try {
        const signed = await signedDownload(env, m.audio_path, 21600);   // 6h,覆盖排队+下载
        const sub = await fetch(base + "/api/v1/services/audio/asr/transcription", {
          method: "POST",
          headers: { authorization: "Bearer " + dkey, "content-type": "application/json", "X-DashScope-Async": "enable" },
          body: JSON.stringify({ model: env.DASHSCOPE_MODEL || "fun-asr", input: { file_urls: [signed] }, parameters: { diarization_enabled: true } }),
        });
        const sd = await sub.json().catch(() => ({}));
        const taskId = sd && sd.output && sd.output.task_id;
        if (!sub.ok || !taskId) { await restSvc("PATCH", env, "/minutes?id=eq." + id, { status: "failed", asr_error: "提交转写失败(" + sub.status + ")" }); return json({ error: "提交转写失败" }, 502); }
        await restSvc("PATCH", env, "/minutes?id=eq." + id, { asr_task_id: taskId });
        return json({ ok: true, status: "transcribing", task_id: taskId });
      } catch (e) {
        await restSvc("PATCH", env, "/minutes?id=eq." + id, { status: "failed", asr_error: "提交转写异常" }).catch(() => {});
        throw e;
      }
    }

    // ---------- 轮询转写状态 + 完成即落库 ----------
    if (action === "transcribe-status") {
      const dkey = env.DASHSCOPE_API_KEY;
      if (!dkey) return json({ error: "服务器未配置 DASHSCOPE_API_KEY" }, 500);
      const base = (env.DASHSCOPE_BASE || "https://dashscope.aliyuncs.com").replace(/\/+$/, "");
      const id = parseInt(body.minuteId, 10); if (!id) return json({ error: "缺少 minuteId" }, 400);
      const m = await getMinute(token, id); if (!m) return json({ error: "纪要不存在或无权限" }, 404);
      if (m.status !== "transcribing" || !m.asr_task_id) return json({ ok: true, status: m.status });
      const tr = await fetch(base + "/api/v1/tasks/" + m.asr_task_id, { headers: { authorization: "Bearer " + dkey } });
      const td = await tr.json().catch(() => ({}));
      const st = td && td.output && td.output.task_status;
      if (st === "SUCCEEDED") {
        // 取每个文件的结果 URL(24h 有效)→ 立即拉取解析落库
        const results = (td.output && td.output.results) || [];
        const all = { transcript: "", segments: [] };
        for (const it of results) {
          const u = it.transcription_url || it.url; if (!u) continue;
          const rr = await fetch(u); if (!rr.ok) continue;
          const rj = await rr.json().catch(() => null); if (!rj) continue;
          const p = parseAsr(rj);
          all.transcript += (all.transcript ? "\n" : "") + p.transcript;
          all.segments.push(...p.segments);
        }
        await restSvc("PATCH", env, "/minutes?id=eq." + id + "&status=eq.transcribing", { status: "transcribed", transcript: all.transcript, transcript_json: all.segments, asr_error: "" });
        return json({ ok: true, status: "transcribed", transcript: all.transcript, segments: all.segments });
      }
      if (st === "FAILED" || st === "UNKNOWN") {
        await restSvc("PATCH", env, "/minutes?id=eq." + id, { status: "failed", asr_error: "转写失败:" + st + ((td.output && td.output.message) ? (" " + td.output.message) : "") });
        return json({ ok: true, status: "failed" });
      }
      return json({ ok: true, status: "transcribing", task_status: st || "PENDING" });
    }

    // ---------- DeepSeek:摘要 / 任务 / 脑图 ----------
    if (action === "ai") {
      const id = parseInt(body.minuteId, 10); if (!id) return json({ error: "缺少 minuteId" }, 400);
      const kind = body.kind;
      if (!AI_SYS[kind]) return json({ error: "未知 kind" }, 400);
      const m = await getMinute(token, id); if (!m) return json({ error: "纪要不存在或无权限" }, 404);
      const text = transcriptForAI(m);
      if (!text.trim()) return json({ error: "没有可用的转写文本,请先转写" }, 400);
      const content = await deepseek(env, AI_SYS[kind], text);
      let patch = {}, ret = {};
      if (kind === "summary") { patch = { summary: content.trim() }; ret = { summary: content.trim() }; }
      else if (kind === "tasks") { const j = extractJson(content); const tasks = (j && Array.isArray(j.tasks)) ? j.tasks : []; patch = { tasks }; ret = { tasks }; }
      else if (kind === "mindmap") { const mm = normalizeMindmap(content); patch = { mindmap: mm }; ret = { mindmap: mm }; }
      await restSvc("PATCH", env, "/minutes?id=eq." + id, patch);
      return json({ ok: true, ...ret });
    }

    return json({ error: "未知操作" }, 400);
  } catch (e) {
    const status = (e && e.status) || 500;
    return json({ error: (e && e.msg) || ("操作失败(" + status + ")") }, status >= 400 && status < 600 ? status : 500);
  }
}
