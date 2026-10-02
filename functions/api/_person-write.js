// Cloudflare Pages Function —— 写人接口核心(给主人的聊天助手,server-to-server)
// 不单独成路由(下划线开头);由 person.js / person/relation.js / person/photo.js 挂到 HTTP 方法上。
// 第一版:新建 / 查重+confirm / 部分更新 / 父子边 / 软删·彻底删 / history 留痕。
// 第二版:type=spouse(只写 relationships 对称边,不写退役列 spouse / marriages 表) + 存/删照片。
// 写响应里的 father/spouses 一律从 relationships 边现查,不读退役列。
// 鉴权:Authorization: Bearer <PERSON_WRITE_TOKEN>(与只读 PERSON_API_TOKEN 分开;读令牌不能写)。
//      令牌未配置 → 一律 401(fail-closed)。不开放 CORS。不写退役列。

import { json, requireServiceToken, upstreamError } from "./_shared.js";

export const WRITE_SOURCE = "聊天助手";
export const WRITE_KEYS = [
  "name", "char_gen", "alias", "sex", "birth",
  "birth_lunar", "birth_time", "death", "death_lunar", "birth_place", "burial", "alive",
  "occupation", "company", "residence", "contact", "address", "deeds", "source", "status", "note",
];
// 与网页 FORM_KEYS 对齐(去掉只读 id)。退役列故意不在此:gen/kind/mother/rank/relation_type/father_note/spouse/father_id。
export const RETIRED_KEYS = ["gen", "kind", "mother", "rank", "relation_type", "father_note", "spouse", "father_id"];
export const CONTROL_KEYS = ["confirm", "father_id", "spouse_id", "idempotency_key", "id", "purge"];
export const ENUMS = {
  sex: new Set(["", "男", "女"]),
  alive: new Set(["", "是", "否"]),
  status: new Set(["", "确认", "存疑", "待考", "待补"]),
};
export const FIELD_LIMITS = {
  name: 64, id: 64, char_gen: 32, alias: 64, sex: 8,
  birth: 64, birth_lunar: 64, birth_time: 32, death: 64, death_lunar: 64,
  birth_place: 200, burial: 200, alive: 8,
  occupation: 200, company: 200, residence: 200, contact: 200, address: 200,
  deeds: 4000, source: 400, status: 16, note: 4000,
};
export const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
export const IDEM_RE = /^[A-Za-z0-9._:-]{8,128}$/;
export const BODY_MAX = 64 * 1024;
export const PHOTO_BODY_MAX = 16 * 1024 * 1024; // 照片端点单独放宽:网页上限 12MB,base64 约 ×4/3
export const PHOTO_BYTES_MAX = 12 * 1024 * 1024; // 与 db.js addMedia 一致
export const PHOTO_SIGN_EXPIRES = 3600;
export const PHOTO_FETCH_MS = 10000;
export const PHOTO_EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };
export const RELATION_TYPES = new Set(["father", "spouse"]);

// 与 db.js EDITABLE 同序,只用于 history.after 快照形状(撤销 create 不读 after;撤销 update 只读 EDITABLE)。
const EDITABLE = ["gen", "char_gen", "name", "alias", "sex", "birth", "birth_lunar", "birth_time", "birth_place",
  "death", "death_lunar", "alive", "rank", "relation_type", "kind", "father_id", "father_note", "mother",
  "spouse", "occupation", "company", "residence", "burial", "contact", "address", "deeds", "source", "status", "note"];

export function normalizeSbUrl(raw) {
  const u = String(raw || "").trim().replace(/\/+$/, "");
  return /^https:\/\//i.test(u) ? u : "";
}

export function nowStr() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = n => String(n).padStart(2, "0");
  return d.getUTCFullYear() + "-" + p(d.getUTCMonth() + 1) + "-" + p(d.getUTCDate()) + " "
    + p(d.getUTCHours()) + ":" + p(d.getUTCMinutes()) + ":" + p(d.getUTCSeconds());
}

export function allocNextId(ids) {
  let mx = 0;
  (ids || []).forEach(id => {
    const m = /^[A-Za-z](\d+)/.exec(id || "");
    if (m) mx = Math.max(mx, +m[1]);
  });
  return "S" + String(mx + 1).padStart(3, "0");
}

export function truthy(v) {
  return v === true || v === 1 || v === "1" || String(v).toLowerCase() === "true";
}

export function histSummary(idem, text) {
  const key = (idem || "").trim();
  return key
    ? "[" + WRITE_SOURCE + "][idem:" + key + "] " + text
    : "[" + WRITE_SOURCE + "] " + text;
}

export function createAfterSnapshot(pid, rec) {
  return { id: pid, ...Object.fromEntries(EDITABLE.map(k => [k, rec[k] != null ? rec[k] : ""])) };
}

export function publicPerson(row) {
  if (!row) return null;
  const o = { id: row.id || "" };
  WRITE_KEYS.forEach(k => {
    if (k === "contact" || k === "address") return;
    o[k] = row[k] != null ? row[k] : "";
  });
  return o;
}

export function pickIdempotencyKey(request, body) {
  const h = (request && request.headers && (request.headers.get("idempotency-key") || request.headers.get("Idempotency-Key"))) || "";
  const fromHeader = String(h || "").trim();
  const fromBody = String((body && body.idempotency_key) || "").trim();
  return fromHeader || fromBody;
}

export function validateIdempotencyKey(key) {
  if (!key) return null;
  if (!IDEM_RE.test(key)) return { error: "idempotency_key 格式不正确(8-128 位,仅字母数字 . _ : -)", code: "validation", field: "idempotency_key" };
  return null;
}

export function validatePersonFields(patch, { requireName, allowEmptyName }) {
  if (patch == null || typeof patch !== "object" || Array.isArray(patch)) {
    return { error: "请求体必须是 JSON 对象", code: "validation" };
  }
  const retired = Object.keys(patch).filter(k => RETIRED_KEYS.includes(k) && k !== "father_id");
  if (retired.length) {
    return { error: "退役列不能写入: " + retired.join("、"), code: "retired_field", fields: retired };
  }
  const unknown = Object.keys(patch).filter(k => !WRITE_KEYS.includes(k) && !CONTROL_KEYS.includes(k) && !RETIRED_KEYS.includes(k));
  if (unknown.length) {
    return { error: "不支持的字段: " + unknown.join("、"), code: "validation", fields: unknown };
  }
  if (requireName) {
    const name = String(patch.name == null ? "" : patch.name).trim();
    if (!name) return { error: "姓名必填", code: "validation", field: "name" };
  }
  if ("name" in patch) {
    if (typeof patch.name !== "string") return { error: "name 必须是字符串", code: "validation", field: "name" };
    const name = patch.name.trim();
    if (!allowEmptyName && !name) return { error: "姓名不能为空", code: "validation", field: "name" };
    if (name.length > FIELD_LIMITS.name) return { error: "name 过长", code: "validation", field: "name" };
  }
  if ("id" in patch && patch.id != null && String(patch.id).trim()) {
    const id = String(patch.id).trim();
    if (!ID_RE.test(id)) return { error: "id 格式不正确", code: "validation", field: "id" };
  }
  for (const k of WRITE_KEYS) {
    if (!(k in patch) || k === "name") continue;
    const v = patch[k];
    if (v == null) continue;
    if (typeof v !== "string") return { error: k + " 必须是字符串", code: "validation", field: k };
    const lim = FIELD_LIMITS[k] || 200;
    if (v.length > lim) return { error: k + " 过长(最多 " + lim + " 字)", code: "validation", field: k };
    if (ENUMS[k] && !ENUMS[k].has(v.trim() === "" ? "" : v)) {
      return { error: k + " 取值不合法", code: "validation", field: k, allowed: [...ENUMS[k]] };
    }
  }
  if ("father_id" in patch && patch.father_id != null && String(patch.father_id).trim()) {
    const fid = String(patch.father_id).trim();
    if (!ID_RE.test(fid)) return { error: "father_id 格式不正确", code: "validation", field: "father_id" };
  }
  if ("spouse_id" in patch && patch.spouse_id != null && String(patch.spouse_id).trim()) {
    const sid = String(patch.spouse_id).trim();
    if (!ID_RE.test(sid)) return { error: "spouse_id 格式不正确", code: "validation", field: "spouse_id" };
  }
  return null;
}

export function collectWriteRec(body, { forCreate }) {
  const rec = {};
  WRITE_KEYS.forEach(k => {
    if (forCreate) rec[k] = body[k] != null ? String(body[k]) : "";
    else if (k in body) rec[k] = body[k] != null ? String(body[k]) : "";
  });
  if (forCreate && !String(rec.alive || "").trim()) rec.alive = "是";
  if (forCreate && rec.name) rec.name = rec.name.trim();
  return rec;
}

function svcHeaders(env) {
  const k = env.SUPABASE_SERVICE_ROLE;
  return { apikey: k, authorization: "Bearer " + k, "content-type": "application/json" };
}

async function restRaw(fetchFn, url, init) {
  const r = await fetchFn(url, init);
  if (!r.ok) { const e = await upstreamError("Supabase", r); throw e; }
  const txt = await r.text();
  if (!txt) return null;
  try { return JSON.parse(txt); } catch (e) { return null; }
}

function one(data) {
  if (data == null) return null;
  if (Array.isArray(data)) return data[0] || null;
  return data;
}

async function restGet(fetchFn, sb, env, pathQuery) {
  const rows = await restRaw(fetchFn, sb + "/rest/v1/" + pathQuery, { headers: svcHeaders(env) });
  return Array.isArray(rows) ? rows : (rows ? [rows] : []);
}

async function restMutate(fetchFn, sb, env, method, pathQuery, body) {
  const headers = { ...svcHeaders(env), Prefer: "return=representation" };
  const data = await restRaw(fetchFn, sb + "/rest/v1/" + pathQuery, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return data;
}

async function parseBody(request, maxBytes) {
  const cap = maxBytes || BODY_MAX;
  const len = Number((request.headers && request.headers.get("content-length")) || 0);
  if (len > cap) {
    const err = new Error("请求体过大");
    err.http = { error: "请求体过大", code: "payload_too_large" };
    err.status = 413;
    throw err;
  }
  const txt = await request.text();
  if (txt.length > cap) {
    const err = new Error("请求体过大");
    err.http = { error: "请求体过大", code: "payload_too_large" };
    err.status = 413;
    throw err;
  }
  if (!String(txt || "").trim()) return {};
  try { return JSON.parse(txt); } catch (e) {
    const err = new Error("JSON");
    err.http = { error: "请求体不是合法 JSON", code: "validation" };
    err.status = 400;
    throw err;
  }
}

export function canonSpousePair(a, b) {
  return a > b ? [b, a] : [a, b];
}

export function sniffImage(bytes) {
  if (!bytes || bytes.length < 12) return null;
  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return { mime: "image/jpeg", ext: "jpg" };
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return { mime: "image/png", ext: "png" };
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return { mime: "image/gif", ext: "gif" };
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return { mime: "image/webp", ext: "webp" };
  }
  return null;
}

export function decodeBase64Bytes(raw) {
  const s = String(raw || "").trim();
  const comma = s.indexOf(",");
  const b64 = /^data:/i.test(s) && comma >= 0 ? s.slice(comma + 1) : s.replace(/\s+/g, "");
  if (!b64) return new Uint8Array(0);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function parseIPv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(n => +n);
  if (parts.some(n => n > 255)) return null;
  return parts;
}

export function isPrivateIPv4(parts) {
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  return false;
}

export function isBlockedDownloadHost(hostname) {
  const h = String(hostname || "").trim().toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (!h) return true;
  if (h === "localhost" || h === "0.0.0.0" || h === "::1" || h === "0" || h === "::") return true;
  if (h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".home") || h.endsWith(".lan")) return true;
  if (h === "metadata.google.internal" || h === "metadata.google.com") return true;
  const v4 = parseIPv4(h);
  if (v4) return isPrivateIPv4(v4);
  if (h.includes(":")) {
    if (h === "::1" || h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("::ffff:")) return true;
  }
  return false;
}

export function validateDownloadUrl(raw) {
  let u;
  try { u = new URL(String(raw || "").trim()); } catch (e) {
    return { error: "图片 URL 不合法", code: "validation", field: "url" };
  }
  if (u.protocol !== "https:") return { error: "只允许 https 图片 URL", code: "ssrf", field: "url" };
  if (u.username || u.password) return { error: "图片 URL 不能带用户名密码", code: "ssrf", field: "url" };
  if (isBlockedDownloadHost(u.hostname)) return { error: "图片 URL 主机不允许(内网/私有地址)", code: "ssrf", field: "url" };
  if (u.port && u.port !== "443") return { error: "图片 URL 只允许 443 端口", code: "ssrf", field: "url" };
  return { url: u.toString() };
}

function safePhotoKey(key) {
  if (!key || typeof key !== "string") return "";
  const k = key.trim();
  if (!k || k.length > 512 || k.includes("..") || k.startsWith("/") || k.includes("\\")) return "";
  return k;
}

async function gateWrite(request, env) {
  const gate = await requireServiceToken(request, env && env.PERSON_WRITE_TOKEN);
  if (gate.resp) return { resp: gate.resp };
  const sb = normalizeSbUrl(env && env.SUPABASE_URL);
  if (!sb) return { resp: json({ error: "服务器未配置 SUPABASE_URL" }, 503) };
  if (!(env && env.SUPABASE_SERVICE_ROLE)) return { resp: json({ error: "服务器未配置 SUPABASE_SERVICE_ROLE" }, 503) };
  return { sb };
}

async function insertHist(fetchFn, sb, env, { action, entity, entity_id, summary, before, after }) {
  try {
    const row = one(await restMutate(fetchFn, sb, env, "POST", "history", {
      ts: nowStr(),
      action,
      entity,
      entity_id: String(entity_id),
      summary: summary || "",
      before: before != null ? JSON.stringify(before) : "",
      after: after != null ? JSON.stringify(after) : "",
      undone: 0,
    }));
    return row && row.id != null ? row.id : null;
  } catch (e) {
    return null;
  }
}

async function findIdempotent(fetchFn, sb, env, idem, action, entity) {
  if (!idem) return null;
  const needle = "[" + WRITE_SOURCE + "][idem:" + idem + "]";
  const rows = await restGet(fetchFn, sb, env,
    "history?summary=like." + encodeURIComponent(needle + "*")
    + "&action=eq." + encodeURIComponent(action)
    + "&entity=eq." + encodeURIComponent(entity)
    + "&undone=eq.0&select=id,action,entity,entity_id,summary,before,after,undone&order=id.desc&limit=5");
  return rows[0] || null;
}

async function getPersonAny(fetchFn, sb, env, pid) {
  const rows = await restGet(fetchFn, sb, env, "persons?id=eq." + encodeURIComponent(pid) + "&select=*");
  return rows[0] || null;
}

async function getPersonLive(fetchFn, sb, env, pid) {
  const p = await getPersonAny(fetchFn, sb, env, pid);
  if (!p || Number(p.deleted) === 1) return null;
  return p;
}

async function sameNameLive(fetchFn, sb, env, name, excludeId) {
  const rows = await restGet(fetchFn, sb, env,
    "persons?name=eq." + encodeURIComponent(name) + "&deleted=eq.0&select=id,name,alias,sex,birth,alive,char_gen,photo");
  return (rows || []).filter(r => r.id !== excludeId);
}

async function loadFatherMaps(fetchFn, sb, env, personIds) {
  const ids = [...new Set((personIds || []).filter(Boolean))];
  if (!ids.length) return { fatherOf: {}, byId: {} };
  const rels = await restGet(fetchFn, sb, env,
    "relationships?type=eq.father&to_id=in.(" + ids.map(id => encodeURIComponent(id)).join(",") + ")&select=from_id,to_id,type");
  const fatherOf = {};
  (rels || []).forEach(r => { if (r.type === "father") fatherOf[r.to_id] = r.from_id; });
  const fids = [...new Set(Object.values(fatherOf).filter(Boolean))];
  const byId = {};
  if (fids.length) {
    const fathers = await restGet(fetchFn, sb, env,
      "persons?id=in.(" + fids.map(id => encodeURIComponent(id)).join(",") + ")&select=id,name");
    (fathers || []).forEach(p => { byId[p.id] = p; });
  }
  return { fatherOf, byId };
}

export function toWriteCandidate(p, maps) {
  const fid = maps && maps.fatherOf && maps.fatherOf[p.id];
  const f = fid && maps.byId && maps.byId[fid];
  return {
    id: p.id,
    name: p.name || "",
    alias: p.alias || "",
    sex: p.sex || "",
    char_gen: p.char_gen || "",
    birth: p.birth || "",
    alive: p.alive || "",
    father: fid ? { id: fid, name: (f && f.name) || "" } : null,
  };
}

async function nextId(fetchFn, sb, env) {
  const rows = await restGet(fetchFn, sb, env, "persons?select=id");
  return allocNextId((rows || []).map(r => r.id));
}

// 写响应里的父亲/配偶一律从 relationships 现查,不读 persons.father_id / persons.spouse。
export async function familyRefs(fetchFn, sb, env, pid) {
  const asFrom = await restGet(fetchFn, sb, env,
    "relationships?from_id=eq." + encodeURIComponent(pid) + "&type=in.(father,spouse)&select=from_id,to_id,type");
  const asTo = await restGet(fetchFn, sb, env,
    "relationships?to_id=eq." + encodeURIComponent(pid) + "&type=in.(father,spouse)&select=from_id,to_id,type");
  const rels = [...(asFrom || []), ...(asTo || [])];
  let fatherId = null;
  const spouseIds = [];
  (rels || []).forEach(r => {
    if (r.type === "father" && r.to_id === pid) fatherId = r.from_id;
    if (r.type === "spouse") {
      const other = r.from_id === pid ? r.to_id : r.from_id;
      if (other && !spouseIds.includes(other)) spouseIds.push(other);
    }
  });
  const ids = [...new Set([fatherId, ...spouseIds].filter(Boolean))];
  const byId = {};
  if (ids.length) {
    const people = await restGet(fetchFn, sb, env,
      "persons?id=in.(" + ids.map(id => encodeURIComponent(id)).join(",") + ")&select=id,name");
    (people || []).forEach(p => { byId[p.id] = p; });
  }
  return {
    father: fatherId ? { id: fatherId, name: (byId[fatherId] && byId[fatherId].name) || "" } : null,
    spouses: spouseIds.map(id => ({ id, name: (byId[id] && byId[id].name) || "" })),
  };
}

export async function setSpouseEdge(fetchFn, sb, env, a, b, { unlink, note, start_date, end_date, idem } = {}) {
  a = String(a || "").trim();
  b = String(b || "").trim();
  if (!a || !b) {
    const err = new Error("spouse ids");
    err.http = { error: "请提供 person_id 和 spouse_id", code: "validation" };
    err.status = 400;
    throw err;
  }
  if (a === b) {
    const err = new Error("self");
    err.http = { error: "不能和自己建立配偶关系", code: "validation", field: "spouse_id" };
    err.status = 400;
    throw err;
  }
  const pa = await getPersonLive(fetchFn, sb, env, a);
  const pb = await getPersonLive(fetchFn, sb, env, b);
  if (!pa) {
    const err = new Error("missing a");
    err.http = { error: "人物不存在或已在回收站", code: "not_found", id: a };
    err.status = 404;
    throw err;
  }
  if (!pb) {
    const err = new Error("missing b");
    err.http = { error: "配偶不存在或已在回收站", code: "spouse_not_found", spouse_id: b };
    err.status = 404;
    throw err;
  }
  const [from_id, to_id] = canonSpousePair(a, b);
  const asFrom = await restGet(fetchFn, sb, env,
    "relationships?from_id=eq." + encodeURIComponent(a) + "&type=eq.spouse&select=*");
  const asTo = await restGet(fetchFn, sb, env,
    "relationships?to_id=eq." + encodeURIComponent(a) + "&type=eq.spouse&select=*");
  const existing = [...(asFrom || []), ...(asTo || [])].filter(r =>
    (r.from_id === a && r.to_id === b) || (r.from_id === b && r.to_id === a));
  if (unlink) {
    if (!existing.length) {
      return { changed: false, action: "spouse_absent", person_id: a, spouse_id: b, history_ids: [] };
    }
    const history_ids = [];
    let histFail = false;
    for (const old of existing) {
      await restMutate(fetchFn, sb, env, "DELETE", "relationships?id=eq." + encodeURIComponent(old.id));
      const hid = await insertHist(fetchFn, sb, env, {
        action: "delete",
        entity: "relationship",
        entity_id: String(old.id),
        summary: histSummary(idem, "删除关系"),
        before: old,
        after: null,
      });
      if (hid == null) histFail = true; else history_ids.push(hid);
    }
    return { changed: true, action: "spouse_cleared", person_id: a, spouse_id: b, history_ids, history_error: histFail };
  }
  if (existing.length) {
    return {
      changed: false,
      action: "spouse_exists",
      person_id: a,
      spouse_id: b,
      relationship_id: existing[0].id,
      history_ids: [],
    };
  }
  const row = one(await restMutate(fetchFn, sb, env, "POST", "relationships", {
    from_id,
    to_id,
    type: "spouse",
    directed: false,
    start_date: start_date || "",
    end_date: end_date || "",
    note: note || "",
  }));
  if (!row || row.id == null) {
    const err = new Error("spouse insert");
    err.http = { error: "配偶关系写入失败", code: "relation_failed" };
    err.status = 502;
    throw err;
  }
  const hid = await insertHist(fetchFn, sb, env, {
    action: "create",
    entity: "relationship",
    entity_id: String(row.id),
    summary: histSummary(idem, "新增关系: 夫妻 " + from_id + "→" + to_id),
    before: null,
    after: null,
  });
  return {
    changed: true,
    action: "spouse_set",
    person_id: a,
    spouse_id: b,
    from_id,
    to_id,
    directed: false,
    relationship_id: row.id,
    history_ids: hid != null ? [hid] : [],
    history_error: hid == null,
  };
}

export async function reconcileFatherEdge(fetchFn, sb, env, childId, newFatherId, idem) {
  newFatherId = String(newFatherId || "").trim();
  if (newFatherId === childId) {
    return { changed: false, father_id: null, skipped: "self", history_ids: [] };
  }
  const existing = await restGet(fetchFn, sb, env,
    "relationships?to_id=eq." + encodeURIComponent(childId) + "&type=eq.father&select=*&order=id.asc");
  const cur = existing[0] || null;
  const curFather = cur ? cur.from_id : "";
  if (newFatherId === curFather) {
    return { changed: false, father_id: curFather || null, history_ids: [] };
  }
  if (newFatherId) {
    const dad = await getPersonLive(fetchFn, sb, env, newFatherId);
    if (!dad) {
      const err = new Error("father missing");
      err.http = { error: "父亲不存在或已在回收站", code: "father_not_found", father_id: newFatherId };
      err.status = 404;
      throw err;
    }
  }
  const history_ids = [];
  let histFail = false;
  for (const old of existing) {
    await restMutate(fetchFn, sb, env, "DELETE", "relationships?id=eq." + encodeURIComponent(old.id));
    const hid = await insertHist(fetchFn, sb, env, {
      action: "delete",
      entity: "relationship",
      entity_id: String(old.id),
      summary: histSummary(idem, "删除关系"),
      before: old,
      after: null,
    });
    if (hid == null) histFail = true; else history_ids.push(hid);
  }
  if (newFatherId) {
    const row = one(await restMutate(fetchFn, sb, env, "POST", "relationships", {
      from_id: newFatherId,
      to_id: childId,
      type: "father",
      directed: true,
      start_date: "",
      end_date: "",
      note: "",
    }));
    if (!row || row.id == null) {
      const err = new Error("rel insert");
      err.http = { error: "父子关系写入失败;人物字段已保存,可重试挂关系", code: "relation_failed" };
      err.status = 502;
      throw err;
    }
    const hid = await insertHist(fetchFn, sb, env, {
      action: "create",
      entity: "relationship",
      entity_id: String(row.id),
      summary: histSummary(idem, "新增关系: 父子 " + newFatherId + "→" + childId),
      before: null,
      after: null,
    });
    if (hid == null) histFail = true; else history_ids.push(hid);
  }
  return {
    changed: true,
    father_id: newFatherId || null,
    previous_father_id: curFather || null,
    history_ids,
    history_error: histFail,
  };
}

function personsInsertBody(pid, rec) {
  // 只写 FORM_KEYS 字段 + id。绝不带退役列(含 father_id)。
  const body = { id: pid };
  WRITE_KEYS.forEach(k => { body[k] = rec[k] != null ? rec[k] : ""; });
  return body;
}

export async function handlePersonWriteRequest({ request, env }, deps) {
  const fetchFn = (deps && deps.fetch) || globalThis.fetch;
  try {
    const g = await gateWrite(request, env);
    if (g.resp) return g.resp;
    const sb = g.sb;
    const method = String(request.method || "POST").toUpperCase();
    const url = new URL(request.url);
    const body = await parseBody(request);
    const idem = pickIdempotencyKey(request, body);
    const idemErr = validateIdempotencyKey(idem);
    if (idemErr) return json(idemErr, 400);

    if (method === "POST") return await handleCreate(fetchFn, sb, env, request, body, idem);
    if (method === "PATCH") return await handleUpdate(fetchFn, sb, env, url, body, idem);
    return json({ error: "方法不允许", code: "method_not_allowed" }, 405);
  } catch (e) {
    if (e && e.http) return json(e.http, e.status || 400);
    const status = (e && e.status) || 500;
    return json({ error: (e && e.msg) || (e && e.message) || "写入失败" }, status >= 400 && status < 600 ? status : 500);
  }
}

async function handleCreate(fetchFn, sb, env, request, body, idem) {
  const v = validatePersonFields(body, { requireName: true });
  if (v) return json(v, 400);
  const rec = collectWriteRec(body, { forCreate: true });
  const wantId = String(body.id || "").trim();
  const fatherId = ("father_id" in body) ? String(body.father_id || "").trim() : "";
  const spouseId = ("spouse_id" in body) ? String(body.spouse_id || "").trim() : "";

  if (idem) {
    const prev = await findIdempotent(fetchFn, sb, env, idem, "create", "person");
    if (prev) {
      const existing = await getPersonAny(fetchFn, sb, env, prev.entity_id);
      const fam = existing ? await familyRefs(fetchFn, sb, env, prev.entity_id) : { father: null, spouses: [] };
      return json({
        ok: true,
        action: "created",
        idempotent: true,
        person: publicPerson(existing) || { id: prev.entity_id, name: rec.name },
        father: fam.father,
        spouses: fam.spouses,
        history_ids: prev.id != null ? [prev.id] : [],
      });
    }
  }

  if (fatherId) {
    const dad = await getPersonLive(fetchFn, sb, env, fatherId);
    if (!dad) return json({ error: "父亲不存在或已在回收站", code: "father_not_found", father_id: fatherId }, 404);
    if (wantId && fatherId === wantId) return json({ error: "不能把自己设为父亲", code: "validation", field: "father_id" }, 400);
  }
  if (spouseId) {
    const sp = await getPersonLive(fetchFn, sb, env, spouseId);
    if (!sp) return json({ error: "配偶不存在或已在回收站", code: "spouse_not_found", spouse_id: spouseId }, 404);
    if (wantId && spouseId === wantId) return json({ error: "不能和自己建立配偶关系", code: "validation", field: "spouse_id" }, 400);
  }

  const dups = await sameNameLive(fetchFn, sb, env, rec.name, null);
  if (dups.length && !truthy(body.confirm)) {
    const maps = await loadFatherMaps(fetchFn, sb, env, dups.map(p => p.id));
    return json({
      error: "存在同名人物，未新建",
      code: "duplicate_name",
      count: dups.length,
      candidates: dups.map(p => toWriteCandidate(p, maps)),
      hint: "带 confirm=true 强制新建，或改用 PATCH /api/person?id= 更新已有人",
    }, 409);
  }

  let pid = wantId || await nextId(fetchFn, sb, env);
  if (wantId) {
    const clash = await getPersonAny(fetchFn, sb, env, wantId);
    if (clash) return json({ error: "ID 已存在: " + wantId, code: "id_exists", id: wantId }, 409);
  } else {
    const clash = await getPersonAny(fetchFn, sb, env, pid);
    if (clash) return json({ error: "ID 已存在: " + pid + "(请重试)", code: "id_conflict", id: pid }, 409);
  }

  const insert = personsInsertBody(pid, rec);
  const row = one(await restMutate(fetchFn, sb, env, "POST", "persons", insert));
  if (!row) return json({ error: "新建失败", code: "insert_failed" }, 502);
  const after = createAfterSnapshot(pid, rec);
  const hid = await insertHist(fetchFn, sb, env, {
    action: "create",
    entity: "person",
    entity_id: pid,
    summary: histSummary(idem, "新增人物: " + (rec.name || pid)),
    before: null,
    after,
  });

  let fatherMut = null;
  if (fatherId) {
    try {
      fatherMut = await reconcileFatherEdge(fetchFn, sb, env, pid, fatherId, idem);
    } catch (e) {
      fatherMut = { ok: false, error: (e && e.http && e.http.error) || "父子关系写入失败;人物已保存,可重试 POST /api/person/relation" };
    }
  }
  let spouseMut = null;
  if (spouseId) {
    try {
      spouseMut = await setSpouseEdge(fetchFn, sb, env, pid, spouseId, { idem });
    } catch (e) {
      spouseMut = { ok: false, error: (e && e.http && e.http.error) || "配偶关系写入失败;人物已保存,可重试 POST /api/person/relation" };
    }
  }

  const fam = await familyRefs(fetchFn, sb, env, pid);
  let father = fam.father ? Object.assign({}, fam.father) : null;
  if (father && fatherMut && fatherMut.ok !== false) {
    if (fatherMut.changed != null) father.changed = fatherMut.changed;
    if (fatherMut.history_ids) father.history_ids = fatherMut.history_ids;
    if (fatherMut.previous_father_id) father.previous_father_id = fatherMut.previous_father_id;
  }
  if (fatherMut && fatherMut.ok === false) {
    father = { id: fatherId, name: (father && father.name) || "", ok: false, error: fatherMut.error };
  }
  const out = {
    ok: true,
    action: "created",
    idempotent: false,
    person: publicPerson(row),
    father,
    spouses: fam.spouses,
    history_ids: hid != null ? [hid] : [],
  };
  if (spouseMut && spouseMut.ok === false) out.spouse_error = spouseMut.error;
  if (hid == null) out.warning = "已写入但历史留痕失败，网页可能无法撤销这次新建";
  return json(out, 201);
}

async function handleUpdate(fetchFn, sb, env, url, body, idem) {
  const qid = (url.searchParams.get("id") || "").trim();
  const bid = String(body.id || "").trim();
  const pid = qid || bid;
  if (!pid) return json({ error: "请提供 id", code: "validation", field: "id" }, 400);
  if (!ID_RE.test(pid)) return json({ error: "id 格式不正确", code: "validation", field: "id" }, 400);
  if (qid && bid && qid !== bid) return json({ error: "query id 与 body id 不一致", code: "validation", field: "id" }, 400);

  const v = validatePersonFields(body, { requireName: false, allowEmptyName: false });
  if (v) return json(v, 400);

  if (idem) {
    const prev = await findIdempotent(fetchFn, sb, env, idem, "update", "person");
    if (prev && prev.entity_id === pid) {
      const existing = await getPersonLive(fetchFn, sb, env, pid);
      if (existing) {
        const fam = await familyRefs(fetchFn, sb, env, pid);
        return json({
          ok: true,
          action: "updated",
          idempotent: true,
          person: publicPerson(existing),
          changed: [],
          father: fam.father,
          spouses: fam.spouses,
          history_ids: prev.id != null ? [prev.id] : [],
        });
      }
    }
  }

  const before = await getPersonLive(fetchFn, sb, env, pid);
  if (!before) return json({ error: "人物不存在", code: "not_found", id: pid }, 404);

  const patch = collectWriteRec(body, { forCreate: false });
  const hasField = Object.keys(patch).length > 0;
  const wantsFather = "father_id" in body;
  const wantsSpouse = "spouse_id" in body && String(body.spouse_id || "").trim();
  if (!hasField && !wantsFather && !wantsSpouse) return json({ error: "没有可更新的字段", code: "validation" }, 400);

  let row = before;
  const history_ids = [];
  let warning;
  let changedFields = [];
  if (hasField) {
    patch.updated_at = nowStr();
    row = one(await restMutate(fetchFn, sb, env, "PATCH", "persons?id=eq." + encodeURIComponent(pid), patch));
    if (!row) return json({ error: "更新失败", code: "update_failed" }, 502);
    changedFields = WRITE_KEYS.filter(k => k in patch && String(before[k] || "") !== String(row[k] || ""));
    if (changedFields.length) {
      const hid = await insertHist(fetchFn, sb, env, {
        action: "update",
        entity: "person",
        entity_id: pid,
        summary: histSummary(idem, "修改人物: " + (row.name || pid)),
        before,
        after: row,
      });
      if (hid == null) warning = "已写入但历史留痕失败，网页可能无法撤销这次修改";
      else history_ids.push(hid);
    }
  }

  if (wantsFather) {
    const rel = await reconcileFatherEdge(fetchFn, sb, env, pid, String(body.father_id || "").trim(), idem);
    if (rel.history_ids) history_ids.push(...rel.history_ids);
    if (rel.history_error) warning = warning || "已写入但历史留痕失败，网页可能无法撤销这次改父";
  }
  if (wantsSpouse) {
    const rel = await setSpouseEdge(fetchFn, sb, env, pid, String(body.spouse_id).trim(), { idem });
    if (rel.history_ids) history_ids.push(...rel.history_ids);
    if (rel.history_error) warning = warning || "已写入但历史留痕失败，网页可能无法撤销这次挂配偶";
  }

  const fam = await familyRefs(fetchFn, sb, env, pid);
  const out = {
    ok: true,
    action: "updated",
    idempotent: false,
    person: publicPerson(row),
    changed: changedFields,
    father: fam.father,
    spouses: fam.spouses,
    history_ids,
  };
  if (warning) out.warning = warning;
  return json(out);
}

export async function handlePersonDeleteRequest({ request, env }, deps) {
  const fetchFn = (deps && deps.fetch) || globalThis.fetch;
  try {
    const g = await gateWrite(request, env);
    if (g.resp) return g.resp;
    const sb = g.sb;
    const url = new URL(request.url);
    let body = {};
    try { body = await parseBody(request); } catch (e) {
      if (e && e.status === 413) return json(e.http, 413);
      body = {};
    }
    const pid = (url.searchParams.get("id") || String(body.id || "")).trim();
    if (!pid) return json({ error: "请提供 id", code: "validation", field: "id" }, 400);
    if (!ID_RE.test(pid)) return json({ error: "id 格式不正确", code: "validation", field: "id" }, 400);
    const idem = pickIdempotencyKey(request, body);
    const idemErr = validateIdempotencyKey(idem);
    if (idemErr) return json(idemErr, 400);
    const doPurge = url.searchParams.get("purge") === "1" || truthy(body.purge);

    const before = await getPersonAny(fetchFn, sb, env, pid);
    if (!before) return json({ ok: true, action: "already_gone", id: pid }, 200);

    if (doPurge) {
      const media = await restGet(fetchFn, sb, env, "media?person_id=eq." + encodeURIComponent(pid) + "&select=id,path");
      const keys = (media || []).map(m => m.path).filter(Boolean);
      if (keys.length) await storageRemove(fetchFn, sb, env, keys);
      await restMutate(fetchFn, sb, env, "DELETE", "marriages?person_id=eq." + encodeURIComponent(pid));
      await restMutate(fetchFn, sb, env, "DELETE", "media?person_id=eq." + encodeURIComponent(pid));
      await restMutate(fetchFn, sb, env, "DELETE", "persons?id=eq." + encodeURIComponent(pid));
      const hid = await insertHist(fetchFn, sb, env, {
        action: "purge",
        entity: "person",
        entity_id: pid,
        summary: histSummary(idem, "彻底删除: " + (before.name || pid)),
        before,
        after: null,
      });
      return json({
        ok: true,
        action: "purged",
        id: pid,
        history_ids: hid != null ? [hid] : [],
        warning: hid == null ? "已删除但历史留痕失败" : undefined,
      });
    }

    if (Number(before.deleted) === 1) {
      return json({ ok: true, action: "already_trashed", id: pid });
    }
    const patch = { deleted: 1, deleted_at: nowStr() };
    await restMutate(fetchFn, sb, env, "PATCH", "persons?id=eq." + encodeURIComponent(pid), patch);
    const hid = await insertHist(fetchFn, sb, env, {
      action: "delete",
      entity: "person",
      entity_id: pid,
      summary: histSummary(idem, "移入回收站: " + (before.name || pid)),
      before,
      after: null,
    });
    return json({
      ok: true,
      action: "trashed",
      id: pid,
      history_ids: hid != null ? [hid] : [],
      warning: hid == null ? "已移入回收站但历史留痕失败" : undefined,
    });
  } catch (e) {
    if (e && e.http) return json(e.http, e.status || 400);
    const status = (e && e.status) || 500;
    return json({ error: (e && e.msg) || (e && e.message) || "删除失败" }, status >= 400 && status < 600 ? status : 500);
  }
}

export async function handlePersonRelationRequest({ request, env }, deps) {
  const fetchFn = (deps && deps.fetch) || globalThis.fetch;
  try {
    const g = await gateWrite(request, env);
    if (g.resp) return g.resp;
    const sb = g.sb;
    if (String(request.method || "").toUpperCase() !== "POST") {
      return json({ error: "方法不允许", code: "method_not_allowed" }, 405);
    }
    const body = await parseBody(request);
    const idem = pickIdempotencyKey(request, body);
    const idemErr = validateIdempotencyKey(idem);
    if (idemErr) return json(idemErr, 400);

    const type = String(body.type || "father").trim();
    if (type === "mother") {
      return json({ error: "暂不支持 type=mother", code: "unsupported_relation", type }, 400);
    }
    if (!RELATION_TYPES.has(type)) {
      return json({ error: "不支持的关系类型: " + type, code: "unsupported_relation", type }, 400);
    }

    if (type === "spouse") {
      const personId = String(body.person_id || body.from_id || body.child_id || "").trim();
      const spouseId = String(body.spouse_id || body.to_id || "").trim();
      if (!personId) return json({ error: "请提供 person_id", code: "validation", field: "person_id" }, 400);
      if (!spouseId) return json({ error: "请提供 spouse_id", code: "validation", field: "spouse_id" }, 400);
      if (!ID_RE.test(personId)) return json({ error: "person_id 格式不正确", code: "validation", field: "person_id" }, 400);
      if (!ID_RE.test(spouseId)) return json({ error: "spouse_id 格式不正确", code: "validation", field: "spouse_id" }, 400);
      if (idem) {
        const prev = await findIdempotent(fetchFn, sb, env, idem, truthy(body.unlink) ? "delete" : "create", "relationship");
        if (prev) {
          const fam = await familyRefs(fetchFn, sb, env, personId);
          return json({
            ok: true,
            action: truthy(body.unlink) ? "spouse_cleared" : "spouse_set",
            idempotent: true,
            person_id: personId,
            spouse_id: spouseId,
            father: fam.father,
            spouses: fam.spouses,
            history_ids: prev.id != null ? [prev.id] : [],
          });
        }
      }
      const rel = await setSpouseEdge(fetchFn, sb, env, personId, spouseId, {
        unlink: truthy(body.unlink),
        note: body.note != null ? String(body.note) : "",
        start_date: body.start_date != null ? String(body.start_date) : "",
        end_date: body.end_date != null ? String(body.end_date) : "",
        idem,
      });
      const fam = await familyRefs(fetchFn, sb, env, personId);
      return json({
        ok: true,
        action: rel.action,
        idempotent: false,
        person_id: personId,
        spouse_id: spouseId,
        from_id: rel.from_id,
        to_id: rel.to_id,
        directed: false,
        changed: rel.changed,
        father: fam.father,
        spouses: fam.spouses,
        history_ids: rel.history_ids,
        warning: rel.history_error ? "已写入但历史留痕失败，网页可能无法撤销这次配偶关系" : undefined,
      });
    }

    const childId = String(body.child_id || body.to_id || "").trim();
    const fatherId = body.father_id != null ? String(body.father_id).trim()
      : (body.from_id != null ? String(body.from_id).trim() : "");
    if (!childId) return json({ error: "请提供 child_id", code: "validation", field: "child_id" }, 400);
    if (!ID_RE.test(childId)) return json({ error: "child_id 格式不正确", code: "validation", field: "child_id" }, 400);
    if (fatherId && !ID_RE.test(fatherId)) return json({ error: "father_id 格式不正确", code: "validation", field: "father_id" }, 400);

    if (idem) {
      const prev = await findIdempotent(fetchFn, sb, env, idem, "create", "relationship");
      if (prev) {
        const fam = await familyRefs(fetchFn, sb, env, childId);
        return json({
          ok: true,
          action: "father_set",
          idempotent: true,
          child_id: childId,
          father_id: (fam.father && fam.father.id) || fatherId || null,
          father: fam.father,
          spouses: fam.spouses,
          history_ids: prev.id != null ? [prev.id] : [],
        });
      }
    }

    const child = await getPersonLive(fetchFn, sb, env, childId);
    if (!child) return json({ error: "子女不存在或已在回收站", code: "not_found", id: childId }, 404);

    const rel = await reconcileFatherEdge(fetchFn, sb, env, childId, fatherId, idem);
    const fam = await familyRefs(fetchFn, sb, env, childId);
    return json({
      ok: true,
      action: fatherId ? "father_set" : "father_cleared",
      idempotent: false,
      child_id: childId,
      father_id: (fam.father && fam.father.id) || null,
      previous_father_id: rel.previous_father_id || null,
      changed: rel.changed,
      father: fam.father,
      spouses: fam.spouses,
      history_ids: rel.history_ids,
      warning: rel.history_error ? "已写入但历史留痕失败，网页可能无法撤销这次改父" : undefined,
    });
  } catch (e) {
    if (e && e.http) return json(e.http, e.status || 400);
    const status = (e && e.status) || 500;
    return json({ error: (e && e.msg) || (e && e.message) || "关系写入失败" }, status >= 400 && status < 600 ? status : 500);
  }
}

function encodeObjectPath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

async function storageRemove(fetchFn, sb, env, keys) {
  const list = (keys || []).map(safePhotoKey).filter(Boolean);
  if (!list.length) return;
  try {
    await fetchFn(sb + "/storage/v1/object/photos", {
      method: "DELETE",
      headers: { ...svcHeaders(env), "content-type": "application/json" },
      body: JSON.stringify({ prefixes: list }),
    });
  } catch (e) {}
}

async function storageUpload(fetchFn, sb, env, key, bytes, mime) {
  const r = await fetchFn(sb + "/storage/v1/object/photos/" + encodeObjectPath(key), {
    method: "POST",
    headers: { ...svcHeaders(env), "content-type": mime, "x-upsert": "false" },
    body: bytes,
  });
  if (!r.ok) { const e = await upstreamError("Supabase", r); throw e; }
  try { await r.text(); } catch (e) {}
}

async function signPhotoUrl(fetchFn, sb, env, key) {
  const k = safePhotoKey(key);
  if (!k) return null;
  const r = await fetchFn(sb + "/storage/v1/object/sign/photos/" + encodeObjectPath(k), {
    method: "POST",
    headers: { ...svcHeaders(env), "content-type": "application/json" },
    body: JSON.stringify({ expiresIn: PHOTO_SIGN_EXPIRES }),
  });
  if (!r.ok) { try { await r.text(); } catch (e) {} return null; }
  let d = {};
  try { d = await r.json(); } catch (e) { return null; }
  const rel = d.signedURL || d.signedUrl || "";
  if (!rel) return null;
  return /^https?:\/\//i.test(rel) ? rel : (sb + "/storage/v1" + (rel.startsWith("/") ? rel : "/" + rel));
}

async function refreshPrimary(fetchFn, sb, env, pid) {
  const rows = await restGet(fetchFn, sb, env,
    "media?person_id=eq." + encodeURIComponent(pid) + "&select=id,path,is_primary,sort_order&order=sort_order.asc,id.asc");
  const prim = (rows || []).find(r => r.is_primary);
  if (prim) {
    await restMutate(fetchFn, sb, env, "PATCH", "persons?id=eq." + encodeURIComponent(pid), { photo: prim.path });
    return prim.path;
  }
  if (rows && rows.length) {
    await restMutate(fetchFn, sb, env, "PATCH", "media?id=eq." + encodeURIComponent(rows[0].id), { is_primary: 1 });
    await restMutate(fetchFn, sb, env, "PATCH", "persons?id=eq." + encodeURIComponent(pid), { photo: rows[0].path });
    return rows[0].path;
  }
  await restMutate(fetchFn, sb, env, "PATCH", "persons?id=eq." + encodeURIComponent(pid), { photo: "" });
  return "";
}

async function downloadHttpsImage(fetchFn, url, timeoutMs) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs || PHOTO_FETCH_MS);
  let r;
  try {
    r = await fetchFn(url, { method: "GET", redirect: "manual", signal: ac.signal, headers: { accept: "image/*" } });
  } catch (e) {
    const err = new Error("fetch");
    err.http = { error: "下载图片失败或超时", code: "photo_fetch" };
    err.status = 502;
    throw err;
  } finally {
    clearTimeout(t);
  }
  if (r.status >= 300 && r.status < 400) {
    const err = new Error("redirect");
    err.http = { error: "不跟随图片 URL 跳转(防 SSRF)", code: "ssrf" };
    err.status = 400;
    throw err;
  }
  if (!r.ok) {
    try { await r.arrayBuffer(); } catch (e) {}
    const err = new Error("fetch status");
    err.http = { error: "下载图片失败", code: "photo_fetch" };
    err.status = 502;
    throw err;
  }
  const cl = Number(r.headers.get("content-length") || 0);
  if (cl > PHOTO_BYTES_MAX) {
    try { await r.arrayBuffer(); } catch (e) {}
    const err = new Error("big");
    err.http = { error: "图片过大(>12MB)", code: "validation" };
    err.status = 400;
    throw err;
  }
  const buf = new Uint8Array(await r.arrayBuffer());
  if (buf.length > PHOTO_BYTES_MAX) {
    const err = new Error("big");
    err.http = { error: "图片过大(>12MB)", code: "validation" };
    err.status = 400;
    throw err;
  }
  return buf;
}

export async function handlePersonPhotoRequest({ request, env }, deps) {
  const fetchFn = (deps && deps.fetch) || globalThis.fetch;
  try {
    const g = await gateWrite(request, env);
    if (g.resp) return g.resp;
    const sb = g.sb;
    const method = String(request.method || "POST").toUpperCase();
    const url = new URL(request.url);

    if (method === "DELETE") {
      let body = {};
      try { body = await parseBody(request, BODY_MAX); } catch (e) {
        if (e && e.status === 413) return json(e.http, 413);
        body = {};
      }
      const mediaId = (url.searchParams.get("media_id") || String(body.media_id || "")).trim();
      if (!mediaId || !/^\d{1,18}$/.test(mediaId)) {
        return json({ error: "请提供 media_id", code: "validation", field: "media_id" }, 400);
      }
      const doPurge = url.searchParams.get("purge") === "1" || truthy(body.purge);
      const idem = pickIdempotencyKey(request, body);
      const rows = await restGet(fetchFn, sb, env, "media?id=eq." + encodeURIComponent(mediaId) + "&select=*");
      const row = rows[0];
      if (!row) return json({ ok: true, action: "already_gone", media_id: Number(mediaId) });
      await restMutate(fetchFn, sb, env, "DELETE", "media?id=eq." + encodeURIComponent(mediaId));
      await refreshPrimary(fetchFn, sb, env, row.person_id);
      if (doPurge && row.path) await storageRemove(fetchFn, sb, env, [row.path]);
      const hid = await insertHist(fetchFn, sb, env, {
        action: "delete",
        entity: "media",
        entity_id: row.person_id,
        summary: histSummary(idem, "删除照片"),
        before: row,
        after: null,
      });
      return json({
        ok: true,
        action: doPurge ? "photo_purged" : "photo_deleted",
        media_id: row.id,
        person_id: row.person_id,
        history_ids: hid != null ? [hid] : [],
        warning: hid == null ? "已删除但历史留痕失败" : (doPurge ? "已从桶里删掉文件,网页撤销删照片无法恢复文件" : undefined),
      });
    }

    if (method !== "POST") return json({ error: "方法不允许", code: "method_not_allowed" }, 405);

    const body = await parseBody(request, PHOTO_BODY_MAX);
    const idem = pickIdempotencyKey(request, body);
    const idemErr = validateIdempotencyKey(idem);
    if (idemErr) return json(idemErr, 400);
    const pid = String(body.id || body.person_id || "").trim();
    if (!pid || !ID_RE.test(pid)) return json({ error: "请提供人物 id", code: "validation", field: "id" }, 400);
    const hasData = body.data != null && String(body.data).trim();
    const hasUrl = body.url != null && String(body.url).trim();
    if (!hasData && !hasUrl) return json({ error: "请提供 data(base64) 或 url(https) 其中之一", code: "validation" }, 400);
    if (hasData && hasUrl) return json({ error: "data 与 url 只能二选一", code: "validation" }, 400);
    const caption = body.caption != null ? String(body.caption) : "";
    if (caption.length > 200) return json({ error: "caption 过长", code: "validation", field: "caption" }, 400);

    const person = await getPersonLive(fetchFn, sb, env, pid);
    if (!person) return json({ error: "人物不存在或已在回收站", code: "not_found", id: pid }, 404);

    let bytes;
    if (hasUrl) {
      const vu = validateDownloadUrl(body.url);
      if (vu.error) return json(vu, 400);
      bytes = await downloadHttpsImage(fetchFn, vu.url, PHOTO_FETCH_MS);
    } else {
      try { bytes = decodeBase64Bytes(body.data); } catch (e) {
        return json({ error: "base64 无法解码", code: "validation", field: "data" }, 400);
      }
    }
    if (!bytes || !bytes.length) return json({ error: "图片为空", code: "validation" }, 400);
    if (bytes.length > PHOTO_BYTES_MAX) return json({ error: "图片过大(>12MB)", code: "validation" }, 400);
    const sniffed = sniffImage(bytes);
    if (!sniffed) return json({ error: "不支持的图片格式(仅 jpeg/png/webp/gif)", code: "validation" }, 400);

    const ext = sniffed.ext;
    const key = "people/" + pid + "/" + crypto.randomUUID() + "." + ext;
    await storageUpload(fetchFn, sb, env, key, bytes, sniffed.mime);
    const row = one(await restMutate(fetchFn, sb, env, "POST", "media", {
      person_id: pid,
      path: key,
      caption,
      is_primary: 0,
      sort_order: 999,
    }));
    if (!row) return json({ error: "写入相册失败", code: "insert_failed" }, 502);
    await refreshPrimary(fetchFn, sb, env, pid);
    const hid = await insertHist(fetchFn, sb, env, {
      action: "photo",
      entity: "person",
      entity_id: pid,
      summary: histSummary(idem, "上传照片"),
      before: null,
      after: null,
    });
    const signed = await signPhotoUrl(fetchFn, sb, env, key);
    return json({
      ok: true,
      action: "photo_added",
      person_id: pid,
      media: { id: row.id, path: key, caption, is_primary: row.is_primary },
      photo_url: signed,
      photos: signed ? [signed] : [],
      photo_expires_in: signed ? PHOTO_SIGN_EXPIRES : null,
      history_ids: hid != null ? [hid] : [],
      warning: hid == null ? "已上传但历史留痕失败" : undefined,
    }, 201);
  } catch (e) {
    if (e && e.http) return json(e.http, e.status || 400);
    const status = (e && e.status) || 500;
    return json({ error: (e && e.msg) || (e && e.message) || "照片处理失败" }, status >= 400 && status < 600 ? status : 500);
  }
}
