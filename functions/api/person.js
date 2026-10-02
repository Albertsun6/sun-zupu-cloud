// Cloudflare Pages Function —— 查人接口(给主人的聊天助手,server-to-server)
// 路由:GET /api/person?name=…  或  GET /api/person?id=…
// 鉴权:Authorization: Bearer <PERSON_API_TOKEN>(独立查询令牌,不是登录 JWT)
//      令牌未配置 → 一律 401(fail-closed)。不开放 CORS。
// 数据:用 SUPABASE_SERVICE_ROLE + SUPABASE_URL(均只从 CF 环境变量读)只读查库。
//      不返回 contact/address;照片走 photos 桶 1 小时签名 URL。
// 配置(建议只配 Preview,不动 Production):PERSON_API_TOKEN、SUPABASE_URL、SUPABASE_SERVICE_ROLE。

import { json, requireServiceToken, upstreamError } from "./_shared.js";

export const PHOTO_SIGN_EXPIRES = 3600;
export const CANDIDATE_LIMIT = 20;
const PHOTO_CAP = 8;
const PERSON_SELECT = [
  "id", "gen", "char_gen", "name", "alias", "sex",
  "birth", "birth_lunar", "birth_time", "birth_place",
  "death", "death_lunar", "alive", "rank", "relation_type", "kind",
  "father_note", "mother", "spouse",
  "occupation", "company", "residence", "burial",
  "deeds", "source", "status", "note", "photo",
].join(",");

export function normalizeSbUrl(raw) {
  const u = String(raw || "").trim().replace(/\/+$/, "");
  return /^https:\/\//i.test(u) ? u : "";
}

export function safePhotoKey(key) {
  if (!key || typeof key !== "string") return "";
  const k = key.trim();
  if (!k || k.length > 512 || k.includes("..") || k.startsWith("/") || k.includes("\\")) return "";
  return k;
}

export function isExactName(p, name) {
  const q = String(name || "").trim();
  if (!q || !p) return false;
  return p.name === q || (p.alias && p.alias === q);
}

export function matchPersons(persons, name) {
  const q = String(name || "").trim();
  if (!q) return [];
  const exact = (persons || []).filter(p => isExactName(p, q));
  if (exact.length) return exact;
  return (persons || []).filter(p => (p.name && p.name.includes(q)) || (p.alias && p.alias.includes(q)));
}

export function buildRelMaps(relationships) {
  const fatherOf = {}, motherOf = {}, spouseOf = {}, childrenMap = {};
  (relationships || []).forEach(r => {
    if (r.type === "father") {
      fatherOf[r.to_id] = r.from_id;
      (childrenMap[r.from_id] = childrenMap[r.from_id] || []).push(r.to_id);
    } else if (r.type === "mother") {
      motherOf[r.to_id] = r.from_id;
      (childrenMap[r.from_id] = childrenMap[r.from_id] || []).push(r.to_id);
    } else if (r.type === "spouse") {
      (spouseOf[r.from_id] = spouseOf[r.from_id] || []).push(r.to_id);
      (spouseOf[r.to_id] = spouseOf[r.to_id] || []).push(r.from_id);
    }
  });
  return { fatherOf, motherOf, spouseOf, childrenMap };
}

// 复刻 app.js genOf / db.js buildGenOf(双实现契约的只读副本,供本接口返回世代)。
// 改世代算法时仍以 app.js + db.js 为准,并跑 probes/gen-parity.mjs;这里只跟着抄。
export function buildGenOf(persons, maps) {
  const byId = {};
  (persons || []).forEach(p => { byId[p.id] = p; });
  const fatherOf = maps.fatherOf || {}, motherOf = maps.motherOf || {}, spouseOf = maps.spouseOf || {};
  const memo = {};
  const walk = (id, seen) => {
    if (id in memo) return memo[id];
    if (seen.has(id)) return null;
    seen.add(id);
    const p = byId[id]; if (!p) return null;
    const m = parseInt(p.gen, 10);
    if (!isNaN(m)) { memo[id] = m; return m; }
    const par = fatherOf[id] || motherOf[id];
    if (par) { const g = walk(par, seen); memo[id] = (g == null ? null : g + 1); return memo[id]; }
    for (const sp of (spouseOf[id] || [])) {
      const g = walk(sp, seen);
      if (g != null) { memo[id] = g; return g; }
    }
    memo[id] = null; return null;
  };
  return id => walk(id, new Set());
}

function personById(persons) {
  const m = {};
  (persons || []).forEach(p => { m[p.id] = p; });
  return m;
}

function namedRef(id, byId, legacyName) {
  if (id && byId[id]) return { id, name: byId[id].name || "" };
  const legacy = String(legacyName || "").trim();
  if (legacy) return { id: null, name: legacy };
  return null;
}

function uniqIds(ids) {
  const seen = new Set(), out = [];
  for (const id of ids || []) { if (!id || seen.has(id)) continue; seen.add(id); out.push(id); }
  return out;
}

export function toCandidate(p, persons, maps, genOf) {
  const byId = personById(persons);
  const father = namedRef(maps.fatherOf[p.id], byId, "");
  return {
    id: p.id,
    name: p.name || "",
    alias: p.alias || "",
    sex: p.sex || "",
    generation: genOf(p.id),
    char_gen: p.char_gen || "",
    birth: p.birth || "",
    alive: p.alive || "",
    father: father,
    has_photo: !!safePhotoKey(p.photo),
  };
}

export function toDetail(p, persons, maps, genOf, photo) {
  const byId = personById(persons);
  const fatherRef = namedRef(maps.fatherOf[p.id], byId, "");
  const mother = namedRef(maps.motherOf[p.id], byId, p.mother);
  const spouses = uniqIds(maps.spouseOf[p.id] || []).map(id => namedRef(id, byId, "")).filter(Boolean);
  if (!spouses.length && String(p.spouse || "").trim()) spouses.push({ id: null, name: String(p.spouse).trim() });
  const children = uniqIds(maps.childrenMap[p.id] || []).map(id => {
    const c = byId[id];
    return c ? { id: c.id, name: c.name || "", sex: c.sex || "" } : null;
  }).filter(Boolean);
  const signed = photo || { photo_url: null, photos: [], photo_expires_in: null };
  return {
    id: p.id,
    name: p.name || "",
    alias: p.alias || "",
    sex: p.sex || "",
    generation: genOf(p.id),
    char_gen: p.char_gen || "",
    birth: p.birth || "",
    birth_lunar: p.birth_lunar || "",
    birth_time: p.birth_time || "",
    birth_place: p.birth_place || "",
    death: p.death || "",
    death_lunar: p.death_lunar || "",
    alive: p.alive || "",
    rank: p.rank || "",
    relation_type: p.relation_type || "",
    kind: p.kind || "",
    occupation: p.occupation || "",
    company: p.company || "",
    residence: p.residence || "",
    burial: p.burial || "",
    deeds: p.deeds || "",
    source: p.source || "",
    status: p.status || "",
    note: p.note || "",
    father_note: p.father_note || "",
    parents: { father: fatherRef, mother },
    spouses,
    children,
    photo_url: signed.photo_url,
    photos: signed.photos || [],
    photo_expires_in: signed.photo_expires_in,
  };
}

function svcHeaders(env) {
  const k = env.SUPABASE_SERVICE_ROLE;
  return { apikey: k, authorization: "Bearer " + k };
}

async function restJson(fetchFn, url, init) {
  const r = await fetchFn(url, init);
  if (!r.ok) { const e = await upstreamError("Supabase", r); throw e; }
  return r.json();
}

async function restAll(fetchFn, sb, env, pathQuery) {
  const page = 1000;
  let offset = 0;
  const out = [];
  const joiner = pathQuery.includes("?") ? "&" : "?";
  for (;;) {
    const url = sb + "/rest/v1/" + pathQuery + joiner + "limit=" + page + "&offset=" + offset;
    const rows = await restJson(fetchFn, url, { headers: svcHeaders(env) });
    if (!Array.isArray(rows) || !rows.length) break;
    out.push(...rows);
    if (rows.length < page) break;
    offset += rows.length;
    if (offset > 20000) break;
  }
  return out;
}

function encodeObjectPath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

export async function signPhotoUrls(fetchFn, sb, env, keys, expiresIn) {
  const urls = [];
  const seen = new Set();
  for (const raw of keys || []) {
    if (urls.length >= PHOTO_CAP) break;
    const key = safePhotoKey(raw);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const r = await fetchFn(sb + "/storage/v1/object/sign/photos/" + encodeObjectPath(key), {
      method: "POST",
      headers: { ...svcHeaders(env), "content-type": "application/json" },
      body: JSON.stringify({ expiresIn }),
    });
    if (!r.ok) { try { await r.text(); } catch (e) {} continue; }
    let d = {};
    try { d = await r.json(); } catch (e) { continue; }
    const rel = d.signedURL || d.signedUrl || "";
    if (!rel) continue;
    urls.push(/^https?:\/\//i.test(rel) ? rel : (sb + "/storage/v1" + (rel.startsWith("/") ? rel : "/" + rel)));
  }
  return urls;
}

async function loadPhotoBundle(fetchFn, sb, env, person) {
  let media = [];
  try {
    media = await restAll(fetchFn, sb, env, "media?person_id=eq." + encodeURIComponent(person.id) + "&select=path,is_primary,sort_order&order=is_primary.desc,sort_order.asc");
  } catch (e) { media = []; }
  const keys = [];
  const primary = safePhotoKey(person.photo);
  if (primary) keys.push(primary);
  (media || []).forEach(m => { const k = safePhotoKey(m && m.path); if (k) keys.push(k); });
  if (!keys.length) return { photo_url: null, photos: [], photo_expires_in: null };
  const photos = await signPhotoUrls(fetchFn, sb, env, keys, PHOTO_SIGN_EXPIRES);
  if (!photos.length) return { photo_url: null, photos: [], photo_expires_in: null };
  return { photo_url: photos[0], photos, photo_expires_in: PHOTO_SIGN_EXPIRES };
}

export async function handlePersonRequest({ request, env }, deps) {
  const fetchFn = (deps && deps.fetch) || globalThis.fetch;
  try {
    const gate = await requireServiceToken(request, env && env.PERSON_API_TOKEN);
    if (gate.resp) return gate.resp;

    const sb = normalizeSbUrl(env && env.SUPABASE_URL);
    if (!sb) return json({ error: "服务器未配置 SUPABASE_URL" }, 503);
    if (!(env && env.SUPABASE_SERVICE_ROLE)) return json({ error: "服务器未配置 SUPABASE_SERVICE_ROLE" }, 503);

    const url = new URL(request.url);
    const id = (url.searchParams.get("id") || "").trim();
    const name = (url.searchParams.get("name") || "").trim();
    if (!id && !name) return json({ error: "请提供 name 或 id 参数" }, 400);
    if (id && !/^[A-Za-z0-9._-]{1,64}$/.test(id)) return json({ error: "id 格式不正确" }, 400);
    if (name.length > 64) return json({ error: "name 过长" }, 400);

    const persons = await restAll(fetchFn, sb, env,
      "persons?deleted=eq.0&select=" + PERSON_SELECT + "&order=sort_order.asc,id.asc");
    const rels = await restAll(fetchFn, sb, env,
      "relationships?select=from_id,to_id,type&type=in.(father,mother,spouse)");
    const maps = buildRelMaps(rels);
    const genOf = buildGenOf(persons, maps);

    const hits = id ? persons.filter(p => p.id === id) : matchPersons(persons, name);
    if (!hits.length) return json({ error: "未找到此人", query: id ? { id } : { name } }, 404);

    if (hits.length > 1) {
      return json({
        match: "ambiguous",
        count: hits.length,
        candidates: hits.slice(0, CANDIDATE_LIMIT).map(p => toCandidate(p, persons, maps, genOf)),
      });
    }

    const person = hits[0];
    const photo = await loadPhotoBundle(fetchFn, sb, env, person);
    return json({
      match: id ? "id" : (isExactName(person, name) ? "exact" : "fuzzy"),
      person: toDetail(person, persons, maps, genOf, photo),
    });
  } catch (e) {
    const status = (e && e.status) || 500;
    return json({ error: (e && e.msg) || "查询失败" }, status >= 400 && status < 600 ? status : 500);
  }
}

export async function onRequestGet(context) {
  return handlePersonRequest(context);
}
