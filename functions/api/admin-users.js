// Cloudflare Pages Function —— 用户权限管理(仅 admin;service_role)
// 路由:POST /api/admin-users   body = { action, ... }
// 安全要点:
//  - service_role 存 CF 环境变量 SUPABASE_SERVICE_ROLE(服务端,绝不入前端/仓库/日志)。
//  - 每个动作先 requireAdmin():校验调用者 Supabase JWT 的 app_metadata.role==='admin' + aud==='authenticated'。
//    editor/viewer 一律拒;这是整道墙(本函数公网可达,JWT 校验是唯一门禁)。
//  - 【关键】GoTrue 的 PUT app_metadata 是【整体替换非合并】→ 改 role/perms 一律 read-modify-write 合成完整对象,
//    绝不让前端直接传 app_metadata blob(否则漏字段会把 role 或 perms 清掉,静默降权)。
//  - role/perms 走白名单(防注入任意 app_metadata 提权)。
//  - 防锁死:禁止对自己降级/禁用/删除;禁止删/禁/降空"最后一名启用中的管理员"。
//  - 错误不回传 service_role、不回传上游响应体。
// 配置:CF Pages → Settings → Environment variables 添加 SUPABASE_SERVICE_ROLE(必填,service_role key)。
//      另需在 Supabase → Auth 关闭"公开注册(Enable signups)",否则有人可自助注册绕过本函数。

import { SB_URL, json, requireAdmin, roleOf, permsOf } from "./_shared.js";   // 门禁/常量统一走 _shared(原本函数的 requireAdmin 即其蓝本)

const ROLES = new Set(["admin", "editor", "viewer"]);
const PERMS = new Set(["minutes"]);

function admHeaders(env) { const k = env.SUPABASE_SERVICE_ROLE; return { apikey: k, authorization: "Bearer " + k, "content-type": "application/json" }; }

// 调 GoTrue Admin API;失败抛错但不外泄上游响应体
async function adm(env, method, path, body) {
  const r = await fetch(SB_URL + "/auth/v1" + path, { method, headers: admHeaders(env), body: body ? JSON.stringify(body) : undefined });
  const txt = await r.text(); let data = null; try { data = txt ? JSON.parse(txt) : null; } catch (e) {}
  if (!r.ok) { console.warn("GoTrue admin " + method + " " + path + " -> " + r.status, txt.slice(0, 200)); const e = new Error("AUTH_ADMIN"); e.status = r.status; throw e; }
  return data;
}

const isBanned = u => { const b = u && u.banned_until; if (!b) return false; const t = Date.parse(b); return !isNaN(t) && t > Date.now(); };

async function listAllUsers(env) {
  const out = []; let page = 1; const per = 200;
  for (;;) { const d = await adm(env, "GET", "/admin/users?page=" + page + "&per_page=" + per); const us = (d && d.users) || []; out.push(...us); if (us.length < per) break; page++; if (page > 50) break; }
  return out;
}
function sanitize(u) {
  return { id: u.id, email: u.email, role: roleOf(u), perms: permsOf(u), disabled: isBanned(u),
    last_sign_in_at: u.last_sign_in_at || null, created_at: u.created_at || null,
    email_confirmed: !!(u.email_confirmed_at || u.confirmed_at) };
}
// perms 白名单清洗:非数组或含非法项 → null(拒绝);合法 → 去重数组。导出供探针验证。
export function cleanPerms(p) { if (!Array.isArray(p)) return null; const out = []; for (const x of p) { if (!PERMS.has(x)) return null; if (!out.includes(x)) out.push(x); } return out; }
const validEmail = e => typeof e === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const activeAdmins = users => users.filter(u => roleOf(u) === "admin" && !isBanned(u));
// 防锁死判定(纯函数,导出供探针):removesAdmin=该操作是否令目标失去"启用中管理员"身份。
export function lockoutReason({ self, removesAdmin, targetIsActiveAdmin, activeAdminCount }) {
  if (self && removesAdmin) return { msg: "不能对自己降级 / 禁用 / 删除(防止把自己锁在门外)", code: 400 };
  if (removesAdmin && targetIsActiveAdmin && activeAdminCount <= 1) return { msg: "必须保留至少一名启用中的管理员", code: 409 };
  return null;
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.SUPABASE_SERVICE_ROLE)
      return json({ error: "服务器未配置 SUPABASE_SERVICE_ROLE。请在 Cloudflare Pages → Settings → Environment variables 添加后重新部署。" }, 500);
    const gate = await requireAdmin(request); if (gate.resp) return gate.resp;   // ← 任何 service_role 调用之前先过管理员校验
    const caller = gate.user;
    const body = await request.json().catch(() => ({}));
    const action = body.action;

    if (action === "list") {
      const users = await listAllUsers(env);
      return json({ users: users.map(sanitize) });
    }

    if (action === "create") {
      const email = (body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      const role = body.role || "viewer";
      const perms = cleanPerms(body.perms || []);
      if (!validEmail(email)) return json({ error: "邮箱格式不正确" }, 400);
      if (password.length < 6) return json({ error: "密码至少 6 位" }, 400);
      if (!ROLES.has(role)) return json({ error: "非法角色" }, 400);
      if (perms === null) return json({ error: "非法权限项" }, 400);
      const created = await adm(env, "POST", "/admin/users", { email, password, email_confirm: true, app_metadata: { role, perms } });
      return json({ ok: true, user: sanitize(created) });
    }

    // 以下动作针对某个目标用户;先取其当前状态(供 read-modify-write + 防锁死判断)
    const id = String(body.id || "");
    if (!id) return json({ error: "缺少用户 id" }, 400);
    const users = await listAllUsers(env);
    const target = users.find(u => u.id === id);
    if (!target) return json({ error: "用户不存在" }, 404);
    const self = caller.id === id;

    // removesAdmin = 此操作是否令 target 失去"启用中的管理员"身份(删除/禁用/降级)
    const guard = (removesAdmin) => lockoutReason({ self, removesAdmin, targetIsActiveAdmin: roleOf(target) === "admin" && !isBanned(target), activeAdminCount: activeAdmins(users).length });

    if (action === "setRole") {
      const role = body.role;
      if (!ROLES.has(role)) return json({ error: "非法角色" }, 400);
      const g = guard(roleOf(target) === "admin" && role !== "admin"); if (g) return json({ error: g.msg }, g.code);
      const app_metadata = { ...(target.app_metadata || {}), role };   // read-modify-write:保 perms 等不丢
      const u = await adm(env, "PUT", "/admin/users/" + id, { app_metadata });
      return json({ ok: true, user: sanitize(u), note: "该用户需重新登录后角色才生效" });
    }

    if (action === "setPerms") {
      const perms = cleanPerms(body.perms || []);
      if (perms === null) return json({ error: "非法权限项" }, 400);
      const app_metadata = { ...(target.app_metadata || {}), perms };   // 不动 role
      const u = await adm(env, "PUT", "/admin/users/" + id, { app_metadata });
      return json({ ok: true, user: sanitize(u), note: "该用户需重新登录后权限才生效" });
    }

    if (action === "resetPassword") {
      const password = String(body.password || "");
      if (password.length < 6) return json({ error: "密码至少 6 位" }, 400);
      await adm(env, "PUT", "/admin/users/" + id, { password });
      return json({ ok: true });
    }

    if (action === "disable") {
      const g = guard(true); if (g) return json({ error: g.msg }, g.code);
      const u = await adm(env, "PUT", "/admin/users/" + id, { ban_duration: "876000h" });   // ~100 年=停用
      return json({ ok: true, user: sanitize(u) });
    }
    if (action === "enable") {
      const u = await adm(env, "PUT", "/admin/users/" + id, { ban_duration: "none" });
      return json({ ok: true, user: sanitize(u) });
    }

    if (action === "delete") {
      const g = guard(true); if (g) return json({ error: g.msg }, g.code);
      await adm(env, "DELETE", "/admin/users/" + id);
      return json({ ok: true });
    }

    return json({ error: "未知操作" }, 400);
  } catch (e) {
    const status = (e && e.status) || 500;
    return json({ error: "操作失败" + (status ? "(" + status + ")" : "") }, status >= 400 && status < 600 ? status : 500);
  }
}
