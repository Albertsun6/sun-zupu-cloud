// Cloudflare Pages Function —— 写人接口核心(给主人的聊天助手,server-to-server)
// 不单独成路由(下划线开头);由 person.js / person/relation.js 挂到 HTTP 方法上。
// 第一版:新建 / 查重+confirm / 部分更新 / 父子边 / 软删·彻底删 / history 留痕。
// 第二版预留:type=spouse、POST /api/person/photo(本文件先拒,避免调用方摸到静默成功)。
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
export const CONTROL_KEYS = ["confirm", "father_id", "idempotency_key", "id", "purge"];
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
export const V2_RELATION_TYPES = new Set(["spouse", "mother"]);
export const V1_RELATION_TYPES = new Set(["father"]);

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

async function parseBody(request) {
  const len = Number((request.headers && request.headers.get("content-length")) || 0);
  if (len > BODY_MAX) {
    const err = new Error("请求体过大");
    err.http = { error: "请求体过大", code: "payload_too_large" };
    err.status = 413;
    throw err;
  }
  const txt = await request.text();
  if (txt.length > BODY_MAX) {
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

  if (idem) {
    const prev = await findIdempotent(fetchFn, sb, env, idem, "create", "person");
    if (prev) {
      const existing = await getPersonAny(fetchFn, sb, env, prev.entity_id);
      return json({
        ok: true,
        action: "created",
        idempotent: true,
        person: publicPerson(existing) || { id: prev.entity_id, name: rec.name },
        history_ids: prev.id != null ? [prev.id] : [],
      });
    }
  }

  if (fatherId) {
    const dad = await getPersonLive(fetchFn, sb, env, fatherId);
    if (!dad) return json({ error: "父亲不存在或已在回收站", code: "father_not_found", father_id: fatherId }, 404);
    if (wantId && fatherId === wantId) return json({ error: "不能把自己设为父亲", code: "validation", field: "father_id" }, 400);
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

  let father = null;
  if (fatherId) {
    try {
      const rel = await reconcileFatherEdge(fetchFn, sb, env, pid, fatherId, idem);
      father = { id: rel.father_id, changed: rel.changed, history_ids: rel.history_ids };
    } catch (e) {
      father = { id: fatherId, ok: false, error: (e && e.http && e.http.error) || "父子关系写入失败;人物已保存,可重试 POST /api/person/relation" };
    }
  }

  const out = {
    ok: true,
    action: "created",
    idempotent: false,
    person: publicPerson(row),
    father,
    history_ids: hid != null ? [hid] : [],
  };
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
        return json({
          ok: true,
          action: "updated",
          idempotent: true,
          person: publicPerson(existing),
          changed: [],
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
  if (!hasField && !wantsFather) return json({ error: "没有可更新的字段", code: "validation" }, 400);

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

  let father = null;
  if (wantsFather) {
    const rel = await reconcileFatherEdge(fetchFn, sb, env, pid, String(body.father_id || "").trim(), idem);
    father = {
      id: rel.father_id,
      changed: rel.changed,
      previous_father_id: rel.previous_father_id || null,
      history_ids: rel.history_ids,
    };
    if (rel.history_ids) history_ids.push(...rel.history_ids);
    if (rel.history_error) warning = warning || "已写入但历史留痕失败，网页可能无法撤销这次改父";
  }

  const out = {
    ok: true,
    action: "updated",
    idempotent: false,
    person: publicPerson(row),
    changed: changedFields,
    father,
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
    if (V2_RELATION_TYPES.has(type)) {
      return json({
        error: "第一版只支持 type=father（配偶/母子将在第二版开放）",
        code: "unsupported_relation",
        type,
      }, 400);
    }
    if (!V1_RELATION_TYPES.has(type)) {
      return json({ error: "不支持的关系类型: " + type, code: "unsupported_relation", type }, 400);
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
        return json({
          ok: true,
          action: "father_set",
          idempotent: true,
          child_id: childId,
          father_id: fatherId || null,
          history_ids: prev.id != null ? [prev.id] : [],
        });
      }
    }

    const child = await getPersonLive(fetchFn, sb, env, childId);
    if (!child) return json({ error: "子女不存在或已在回收站", code: "not_found", id: childId }, 404);

    const rel = await reconcileFatherEdge(fetchFn, sb, env, childId, fatherId, idem);
    return json({
      ok: true,
      action: fatherId ? "father_set" : "father_cleared",
      idempotent: false,
      child_id: childId,
      father_id: rel.father_id,
      previous_father_id: rel.previous_father_id || null,
      changed: rel.changed,
      history_ids: rel.history_ids,
      warning: rel.history_error ? "已写入但历史留痕失败，网页可能无法撤销这次改父" : undefined,
    });
  } catch (e) {
    if (e && e.http) return json(e.http, e.status || 400);
    const status = (e && e.status) || 500;
    return json({ error: (e && e.msg) || (e && e.message) || "关系写入失败" }, status >= 400 && status < 600 ? status : 500);
  }
}

export async function handlePersonPhotoRequest({ request, env }) {
  const g = await gateWrite(request, env);
  if (g.resp) return g.resp;
  return json({
    error: "存照片将在第二版开放",
    code: "not_implemented",
  }, 501);
}
