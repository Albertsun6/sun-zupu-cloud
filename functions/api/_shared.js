// functions/api/_shared.js —— CF Pages Functions 共享助手
// 下划线开头的文件不会被 CF Pages 当作路由;各函数用相对 import 引用,由 Pages 的 esbuild 打包(零构建约束不破)。
// 收口三件事(2026-07-07 健康度评审 P2:6 份复制粘贴已漂移出真实缺口):
//   ① Supabase 常量从环境变量读(SUPABASE_URL / SUPABASE_ANON_KEY),不写进仓库;
//   ② JWT 门禁统一且含 aud==='authenticated' 校验(原 4 个 AI 函数漏了 aud);
//   ③ 上游错误脱敏统一——绝不把 AI/Auth/Storage 的响应体或模型原始输出回传给客户端(FEATURES §4.3 不变量)。
// 规则(见 CLAUDE.md 已知坑):新 CF 函数禁止内联 门禁/Supabase 常量/上游错误拼接,一律 import 本文件。

export function sbCreds(env) {
  const url = String((env && env.SUPABASE_URL) || "").replace(/\/+$/, "");
  const anon = String((env && env.SUPABASE_ANON_KEY) || "");
  return { url, anon };
}

export function configJsResponse(env) {
  const { url, anon } = sbCreds(env);
  const body = "window.SB = {\n  url: " + JSON.stringify(url) + ",\n  anon: " + JSON.stringify(anon) + "\n};\n";
  return new Response(body, {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export function json(o, status) {
  return new Response(JSON.stringify(o), { status: status || 200, headers: { "content-type": "application/json; charset=utf-8" } });
}
export function extractJson(s) {
  try { return JSON.parse(s); } catch (e) {}
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch (e) {} }
  return null;
}

export const roleOf  = u => (u && u.app_metadata && u.app_metadata.role) || "viewer";
export const permsOf = u => { const p = u && u.app_metadata && u.app_metadata.perms; return Array.isArray(p) ? p : []; };

// 统一 JWT 门禁:令牌有效 + aud==='authenticated' + 授权谓词。返回 { user, token } 或 { resp:Response }。
export async function requireUser(request, env, pred, denyMsg) {
  const { url, anon } = sbCreds(env);
  if (!url || !anon) return { resp: json({ error: "服务器未配置 SUPABASE_URL / SUPABASE_ANON_KEY" }, 500) };
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return { resp: json({ error: "未登录" }, 401) };
  const ures = await fetch(url + "/auth/v1/user", { headers: { apikey: anon, authorization: "Bearer " + token } });
  if (!ures.ok) return { resp: json({ error: "登录校验失败,请重新登录" }, 401) };
  const user = await ures.json();
  if (!user || user.aud !== "authenticated") return { resp: json({ error: "无效令牌" }, 401) };
  if (!pred(user)) return { resp: json({ error: denyMsg }, 403) };
  return { user, token };
}
export const requireWrite   = (req, env) => requireUser(req, env, u => ["editor", "admin"].includes(roleOf(u)), "需要 editor 或 admin 权限");
export const requireAdmin   = (req, env) => requireUser(req, env, u => roleOf(u) === "admin", "需要管理员(admin)权限");
export const requireMinutes = (req, env) => requireUser(req, env, u => roleOf(u) === "admin" || permsOf(u).includes("minutes"), "无纪要权限");

// 上游服务失败 → 排空响应体(只进不出)并返回脱敏 Error(只含服务名+状态码)。调用方 throw 或取 .message 回传。
export async function upstreamError(label, res) {
  try { await res.text(); } catch (e) {}
  const err = new Error(label + " 服务返回错误状态 " + res.status);
  err.status = 502; err.msg = err.message;
  return err;
}
