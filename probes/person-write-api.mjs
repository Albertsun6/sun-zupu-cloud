// probes/person-write-api.mjs —— 写人接口本地探针(假 Supabase 响应,不断真库)
// 用法: node probes/person-write-api.mjs
import { requireServiceToken } from "../functions/api/_shared.js";
import { handlePersonRequest } from "../functions/api/person.js";
import {
  allocNextId, validatePersonFields, collectWriteRec, createAfterSnapshot,
  histSummary, publicPerson, truthy, WRITE_KEYS, RETIRED_KEYS,
  handlePersonWriteRequest, handlePersonDeleteRequest, handlePersonRelationRequest,
  handlePersonPhotoRequest, canonSpousePair, sniffImage, decodeBase64Bytes,
  validateDownloadUrl, isBlockedDownloadHost, PHOTO_SIGN_EXPIRES,
} from "../functions/api/_person-write.js";

let fails = 0;
function ok(name) { console.log("CONFIRMED  " + name); }
function bad(name, detail) { fails++; console.log("REFUTED   " + name + (detail ? " — " + detail : "")); }
function assert(name, cond, detail) { if (cond) ok(name); else bad(name, detail); }

assert("nextId 与网页一致 S003→S004", allocNextId(["S001", "S003", "W010"]) === "S011");
assert("nextId 空表从 S001", allocNextId([]) === "S001");
assert("truthy 认 true/1/true", truthy(true) && truthy("true") && truthy(1) && !truthy(false));
assert("history summary 带来源", histSummary("", "新增人物: 甲") === "[聊天助手] 新增人物: 甲");
assert("history summary 带幂等钥匙", histSummary("abc-12345", "新增人物: 甲").includes("[idem:abc-12345]"));

const afterSnap = createAfterSnapshot("S099", { name: "孙例", alive: "是" });
assert("create after 含 EDITABLE 形状", afterSnap.id === "S099" && afterSnap.name === "孙例" && afterSnap.father_id === "" && afterSnap.alive === "是");
assert("publicPerson 剥 contact/address", !("contact" in publicPerson({ id: "S1", name: "甲", contact: "x", address: "y" })));

assert("姓名必填", validatePersonFields({ sex: "男" }, { requireName: true }).field === "name");
assert("非法性别", validatePersonFields({ name: "甲", sex: "未知" }, { requireName: true }).field === "sex");
assert("退役列拒写", validatePersonFields({ name: "甲", kind: "本族" }, { requireName: true }).code === "retired_field");
assert("合法字段通过", validatePersonFields({ name: "甲", sex: "男", alive: "是" }, { requireName: true }) === null);
assert("新建默认 alive=是", collectWriteRec({ name: "甲" }, { forCreate: true }).alive === "是");
assert("显式 alive 空保持空再被兜底", collectWriteRec({ name: "甲", alive: "" }, { forCreate: true }).alive === "是");
assert("FORM_KEYS 不含退役列", WRITE_KEYS.every(k => !RETIRED_KEYS.includes(k)));

const READ = "tok-read-32-chars-minimum-value";
const WRITE = "tok-write-32-chars-minimum-value";
function envBase(over) {
  return Object.assign({
    PERSON_API_TOKEN: READ,
    PERSON_WRITE_TOKEN: WRITE,
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE: "svc-fake",
  }, over || {});
}
function req(path, { token, method, body, idem } = {}) {
  const headers = { "content-type": "application/json" };
  if (token !== undefined) headers.authorization = "Bearer " + token;
  if (idem) headers["idempotency-key"] = idem;
  return new Request("https://pages.example" + path, {
    method: method || "GET",
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}
async function read(res) { return { status: res.status, body: await res.json() }; }

{
  const deny = await requireServiceToken(req("/api/person", { token: READ }), WRITE);
  assert("读令牌对写门禁是 401", deny.resp && deny.resp.status === 401);
}

function seedDb() {
  return {
    persons: [
      { id: "S001", name: "孙甲", alias: "", sex: "男", birth: "1901", alive: "否", char_gen: "德", deleted: 0, contact: "HIDE", address: "HIDE", occupation: "务农", note: "", photo: "" },
      { id: "S002", name: "孙乙", alias: "", sex: "男", birth: "1930", alive: "是", char_gen: "永", deleted: 0, contact: "", address: "", occupation: "", note: "", photo: "" },
    ],
    rels: [
      { id: 1, from_id: "S001", to_id: "S002", type: "father", directed: true, start_date: "", end_date: "", note: "" },
    ],
    history: [],
    marriages: [],
    media: [],
  };
}

function matchRow(row, params) {
  for (const [k, raw] of params.entries()) {
    if (k === "select" || k === "order" || k === "limit" || k === "offset") continue;
    if (raw.startsWith("eq.")) {
      const want = raw.slice(3);
      if (String(row[k] ?? "") !== want) return false;
    } else if (raw.startsWith("like.")) {
      const pat = raw.slice(5).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*");
      if (!new RegExp("^" + pat + "$").test(String(row[k] || ""))) return false;
    } else if (raw.startsWith("in.")) {
      const inner = raw.slice(3).replace(/^\(/, "").replace(/\)$/, "");
      const set = inner.split(",").map(s => s.trim());
      if (!set.includes(String(row[k]))) return false;
    }
  }
  return true;
}

function createFake(db) {
  const calls = [];
  let relSeq = db.rels.reduce((m, r) => Math.max(m, r.id || 0), 0);
  let histSeq = db.history.reduce((m, r) => Math.max(m, r.id || 0), 0);
  let mediaSeq = (db.media || []).reduce((m, r) => Math.max(m, r.id || 0), 0);
  db.storage = db.storage || {};
  function mockFetch(url, init) {
    const u = String(url);
    const method = ((init && init.method) || "GET").toUpperCase();
    let body = null;
    try { body = init && init.body ? JSON.parse(init.body) : null; } catch (e) { body = null; }
    calls.push({ url: u, method, body });
    const qix = u.indexOf("?");
    const path = qix >= 0 ? u.slice(0, qix) : u;
    const params = new URLSearchParams(qix >= 0 ? u.slice(qix + 1) : "");
    const table = (path.split("/rest/v1/")[1] || "").split("?")[0];

    const reply = (data, status) => Promise.resolve(new Response(data == null ? "" : JSON.stringify(data), { status: status || 200 }));

    if (u.includes("/storage/v1/object/sign/photos/")) {
      return reply({ signedURL: "/object/sign/photos/people/x.jpg?token=sig" });
    }
    if (u.includes("/storage/v1/object/photos")) {
      if (method === "DELETE") return reply({ ok: true });
      const key = u.split("/object/photos/")[1] || "uploaded";
      db.storage[decodeURIComponent(key)] = true;
      return reply({ Key: key });
    }

    if (table === "persons") {
      if (method === "GET") return reply(db.persons.filter(p => matchRow(p, params)));
      if (method === "POST") {
        if (db.persons.some(p => p.id === body.id)) return Promise.resolve(new Response("dup", { status: 409 }));
        const row = Object.assign({ deleted: 0, deleted_at: "", photo: "", sort_order: 0 }, body);
        db.persons.push(row);
        return reply([row]);
      }
      if (method === "PATCH") {
        const hit = db.persons.find(p => matchRow(p, params));
        if (!hit) return reply([]);
        Object.assign(hit, body);
        return reply([hit]);
      }
      if (method === "DELETE") {
        db.persons = db.persons.filter(p => !matchRow(p, params));
        return reply([]);
      }
    }
    if (table === "relationships") {
      if (method === "GET") return reply(db.rels.filter(r => matchRow(r, params)));
      if (method === "POST") {
        const row = Object.assign({ id: ++relSeq }, body);
        db.rels.push(row);
        return reply([row]);
      }
      if (method === "DELETE") {
        db.rels = db.rels.filter(r => !matchRow(r, params));
        return reply([]);
      }
    }
    if (table === "history") {
      if (method === "GET") return reply(db.history.filter(h => matchRow(h, params)));
      if (method === "POST") {
        const row = Object.assign({ id: ++histSeq }, body);
        db.history.push(row);
        return reply([row]);
      }
    }
    if (table === "marriages") {
      if (method === "DELETE") return reply([]);
      if (method === "GET") return reply([]);
    }
    if (table === "media") {
      db.media = db.media || [];
      if (method === "GET") return reply(db.media.filter(m => matchRow(m, params)));
      if (method === "POST") {
        const row = Object.assign({ id: ++mediaSeq, is_primary: 0, sort_order: 999, caption: "" }, body);
        db.media.push(row);
        return reply([row]);
      }
      if (method === "PATCH") {
        const hit = db.media.find(m => matchRow(m, params));
        if (!hit) return reply([]);
        Object.assign(hit, body);
        return reply([hit]);
      }
      if (method === "DELETE") {
        db.media = db.media.filter(m => !matchRow(m, params));
        return reply([]);
      }
    }
    return Promise.resolve(new Response("nope", { status: 404 }));
  }
  return { mockFetch, calls, db };
}

async function postPerson(env, dbtools, body, extra) {
  return read(await handlePersonWriteRequest({
    request: req("/api/person", Object.assign({ token: WRITE, method: "POST", body }, extra || {})),
    env,
  }, { fetch: dbtools.mockFetch }));
}
async function patchPerson(env, dbtools, id, body, extra) {
  return read(await handlePersonWriteRequest({
    request: req("/api/person?id=" + encodeURIComponent(id), Object.assign({ token: WRITE, method: "PATCH", body }, extra || {})),
    env,
  }, { fetch: dbtools.mockFetch }));
}
async function relPerson(env, dbtools, body, extra) {
  return read(await handlePersonRelationRequest({
    request: req("/api/person/relation", Object.assign({ token: WRITE, method: "POST", body }, extra || {})),
    env,
  }, { fetch: dbtools.mockFetch }));
}
async function delPerson(env, dbtools, id, purge) {
  return read(await handlePersonDeleteRequest({
    request: req("/api/person?id=" + encodeURIComponent(id) + (purge ? "&purge=1" : ""), { token: WRITE, method: "DELETE" }),
    env,
  }, { fetch: dbtools.mockFetch }));
}

{
  const t = createFake(seedDb());
  const r = await postPerson(envBase(), t, { name: "孙丙" });
  assert("无 Authorization 走门禁:下面单独测", true);
}
{
  const t = createFake(seedDb());
  const r = await read(await handlePersonWriteRequest({
    request: req("/api/person", { method: "POST", body: { name: "孙丙" } }),
    env: envBase(),
  }, { fetch: t.mockFetch }));
  assert("写接口无令牌 401", r.status === 401 && r.body.error === "未授权");
}
{
  const t = createFake(seedDb());
  const r = await read(await handlePersonWriteRequest({
    request: req("/api/person", { token: "wrong", method: "POST", body: { name: "孙丙" } }),
    env: envBase(),
  }, { fetch: t.mockFetch }));
  assert("写接口错令牌 401", r.status === 401);
}
{
  const t = createFake(seedDb());
  const r = await read(await handlePersonWriteRequest({
    request: req("/api/person", { token: READ, method: "POST", body: { name: "孙丙" } }),
    env: envBase(),
  }, { fetch: t.mockFetch }));
  assert("只读令牌不能写 401", r.status === 401);
}
{
  const t = createFake(seedDb());
  const r = await read(await handlePersonWriteRequest({
    request: req("/api/person", { token: WRITE, method: "POST", body: { name: "孙丙" } }),
    env: envBase({ PERSON_WRITE_TOKEN: "" }),
  }, { fetch: t.mockFetch }));
  assert("未配 PERSON_WRITE_TOKEN fail-closed 401", r.status === 401);
}

{
  const t = createFake(seedDb());
  const r = await read(await handlePersonRequest({
    request: req("/api/person?name=" + encodeURIComponent("孙甲"), { token: WRITE }),
    env: envBase(),
  }, { fetch: t.mockFetch }));
  assert("写令牌访问只读 GET 仍 401", r.status === 401);
}
{
  const t = createFake(seedDb());
  const r = await read(await handlePersonRequest({
    request: req("/api/person?name=" + encodeURIComponent("孙甲"), { token: READ }),
    env: envBase(),
  }, { fetch: t.mockFetch }));
  assert("只读 GET 带读令牌行为不变", r.status === 200 && r.body.match === "exact" && r.body.person.id === "S001");
}

{
  const t = createFake(seedDb());
  const r = await postPerson(envBase(), t, { sex: "男" });
  assert("缺姓名 400", r.status === 400 && r.body.field === "name");
}
{
  const t = createFake(seedDb());
  const r = await postPerson(envBase(), t, { name: "甲", sex: "人妖" });
  assert("非法枚举 400", r.status === 400 && r.body.field === "sex");
}
{
  const t = createFake(seedDb());
  const r = await postPerson(envBase(), t, { name: "甲", father_id: "列", kind: "本族" });
  assert("退役列 kind 400", r.status === 400 && r.body.code === "retired_field");
}

{
  const t = createFake(seedDb());
  const r = await postPerson(envBase(), t, { name: "孙乙" });
  assert("同名未 confirm 409", r.status === 409 && r.body.code === "duplicate_name" && r.body.count === 1);
  assert("候选含已有 id", r.body.candidates && r.body.candidates[0].id === "S002");
  assert("409 没有新建人", t.db.persons.filter(p => p.name === "孙乙").length === 1);
}

{
  const t = createFake(seedDb());
  const r = await postPerson(envBase(), t, { name: "孙乙", confirm: true, sex: "女" });
  assert("confirm 强制新建 201", r.status === 201 && r.body.ok && r.body.person.id === "S003" && r.body.person.sex === "女");
  assert("confirm 后库中两名孙乙", t.db.persons.filter(p => p.name === "孙乙").length === 2);
}

{
  const t = createFake(seedDb());
  const r = await postPerson(envBase(), t, { name: "孙丙", occupation: "教师" });
  assert("无同名新建 201", r.status === 201 && r.body.person.id === "S003" && r.body.person.name === "孙丙");
  assert("新建无父边时 father 为 null(来自边不是退役列)", r.body.father === null);
  assert("新建默认 spouses 空数组", Array.isArray(r.body.spouses) && r.body.spouses.length === 0);
  assert("默认 alive=是", r.body.person.alive === "是");
  assert("响应不含 contact", !("contact" in r.body.person) && !("address" in r.body.person));
  const inserted = t.calls.filter(c => c.method === "POST" && c.url.includes("/persons"));
  assert("persons insert 不含 father_id 列", inserted.length === 1 && inserted[0].body && !("father_id" in inserted[0].body) && !("kind" in inserted[0].body) && !("gen" in inserted[0].body));
  const hist = t.db.history.filter(h => h.action === "create" && h.entity === "person");
  assert("新建写 history create:person", hist.length === 1 && hist[0].entity_id === "S003");
  assert("history summary 标聊天助手", String(hist[0].summary).startsWith("[聊天助手] 新增人物:"));
  const after = JSON.parse(hist[0].after);
  assert("history after 可被网页撤销形状", after.id === "S003" && after.name === "孙丙" && after.alive === "是" && "father_id" in after);
}

{
  const t = createFake(seedDb());
  const r1 = await postPerson(envBase(), t, { name: "孙幂等" }, { idem: "create-key-0001" });
  const r2 = await postPerson(envBase(), t, { name: "孙幂等" }, { idem: "create-key-0001" });
  assert("幂等第二次不新建", r1.status === 201 && r2.status === 200 && r2.body.idempotent === true && r2.body.person.id === r1.body.person.id);
  assert("幂等后仍只有一人", t.db.persons.filter(p => p.name === "孙幂等").length === 1);
}

{
  const t = createFake(seedDb());
  const created = await postPerson(envBase(), t, { name: "孙丁" });
  const r = await patchPerson(envBase(), t, created.body.person.id, { occupation: "木匠", note: "助手补" });
  assert("部分更新 200", r.status === 200 && r.body.ok && r.body.changed.includes("occupation") && r.body.person.occupation === "木匠");
  const hist = t.db.history.filter(h => h.action === "update" && h.entity === "person");
  assert("更新写 history update:person", hist.length === 1);
  const before = JSON.parse(hist[0].before);
  const after = JSON.parse(hist[0].after);
  assert("update before/after 是整行快照", before.name === "孙丁" && after.occupation === "木匠" && hist[0].summary.includes("[聊天助手]"));
}

{
  const t = createFake(seedDb());
  const created = await postPerson(envBase(), t, { name: "孙戊" });
  const child = created.body.person.id;
  const r = await relPerson(envBase(), t, { type: "father", child_id: child, father_id: "S001" });
  assert("挂父子边 200", r.status === 200 && r.body.action === "father_set" && r.body.father_id === "S001" && r.body.changed === true);
  const edges = t.db.rels.filter(x => x.type === "father" && x.to_id === child);
  assert("边 from=父 to=子", edges.length === 1 && edges[0].from_id === "S001" && edges[0].directed === true);
  const ch = t.db.history.filter(h => h.entity === "relationship");
  assert("挂父写 create:relationship 且 entity_id 是边 id", ch.length === 1 && String(ch[0].entity_id) === String(edges[0].id) && ch[0].action === "create");
}

{
  const t = createFake(seedDb());
  const created = await postPerson(envBase(), t, { name: "孙己", father_id: "S001" });
  assert("新建顺带挂父", created.status === 201 && created.body.father && created.body.father.id === "S001" && created.body.father.name === "孙甲");
  const child = created.body.person.id;
  const r = await relPerson(envBase(), t, { type: "father", child_id: child, father_id: "S002" });
  assert("改父 200", r.status === 200 && r.body.father_id === "S002" && r.body.previous_father_id === "S001");
  const edges = t.db.rels.filter(x => x.type === "father" && x.to_id === child);
  assert("改父后只剩一条新边", edges.length === 1 && edges[0].from_id === "S002");
  const dels = t.db.history.filter(h => h.action === "delete" && h.entity === "relationship");
  assert("改父先记 delete:relationship 且带 before", dels.length === 1 && dels[0].before && JSON.parse(dels[0].before).from_id === "S001");
}

assert("配偶规范序 from<to", canonSpousePair("S010", "S002").join(",") === "S002,S010");
assert("SSRF 拒 http", validateDownloadUrl("http://example.com/a.jpg").code === "ssrf");
assert("SSRF 拒内网 IP", validateDownloadUrl("https://192.168.1.8/a.jpg").code === "ssrf");
assert("SSRF 拒 localhost", isBlockedDownloadHost("localhost") && isBlockedDownloadHost("127.0.0.1"));
assert("https 公网 URL 放行", !validateDownloadUrl("https://example.com/a.png").error);
const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
assert("sniff png", sniffImage(decodeBase64Bytes(tinyPng)).mime === "image/png");
assert("sniff 拒非图", sniffImage(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])) === null);

{
  const t = createFake(seedDb());
  const created = await postPerson(envBase(), t, { name: "孙补丁" });
  const id = created.body.person.id;
  await relPerson(envBase(), t, { type: "father", child_id: id, father_id: "S001" });
  const r = await patchPerson(envBase(), t, id, { occupation: "只改字段" });
  assert("PATCH 在已有父边后回 father 来自边", r.status === 200 && r.body.father && r.body.father.id === "S001" && r.body.father.name === "孙甲");
  assert("PATCH 不把 father 写成 null", r.body.father !== null);
  const personsPost = t.calls.filter(c => c.method === "PATCH" && c.url.includes("/persons") && c.body && ("father_id" in c.body));
  assert("PATCH 字段不写退役列 father_id", personsPost.length === 0);
}

{
  const t = createFake(seedDb());
  const created = await postPerson(envBase(), t, { name: "孙妻测" });
  const id = created.body.person.id;
  const r = await relPerson(envBase(), t, { type: "spouse", person_id: id, spouse_id: "S002" });
  assert("挂配偶 200", r.status === 200 && r.body.action === "spouse_set" && r.body.changed === true);
  const edges = t.db.rels.filter(x => x.type === "spouse" && (x.from_id === id || x.to_id === id));
  assert("配偶边 directed=false 且规范序", edges.length === 1 && edges[0].directed === false && edges[0].from_id < edges[0].to_id);
  const personsWrites = t.calls.filter(c => c.body && typeof c.body === "object" && ("spouse" in c.body) && c.url.includes("/persons"));
  assert("不写退役列 spouse", personsWrites.length === 0);
  const marr = t.calls.filter(c => c.url.includes("/marriages") && c.method === "POST");
  assert("加配偶不写 marriages 表", marr.length === 0);
  const hist = t.db.history.filter(h => h.action === "create" && h.entity === "relationship" && String(h.summary).includes("夫妻"));
  assert("配偶 history 是 create:relationship", hist.length === 1 && String(hist[0].entity_id) === String(edges[0].id));
  assert("挂配偶响应带 father/spouses 从边来", r.body.spouses && r.body.spouses.some(s => s.id === "S002"));
}

{
  const t = createFake(seedDb());
  const created = await postPerson(envBase(), t, { name: "孙带偶", spouse_id: "S002" });
  assert("新建顺带 spouse_id", created.status === 201 && created.body.spouses && created.body.spouses.some(s => s.id === "S002"));
  const id = created.body.person.id;
  const gone = await relPerson(envBase(), t, { type: "spouse", person_id: id, spouse_id: "S002", unlink: true });
  assert("解除配偶", gone.status === 200 && gone.body.action === "spouse_cleared");
  assert("解除后边没了", !t.db.rels.some(x => x.type === "spouse" && (x.from_id === id || x.to_id === id)));
  const delh = t.db.history.filter(h => h.action === "delete" && h.entity === "relationship");
  assert("解除配偶写 delete:relationship + before", delh.length >= 1 && delh[delh.length - 1].before);
}

{
  const t = createFake(seedDb());
  const created = await postPerson(envBase(), t, { name: "孙有照" });
  const id = created.body.person.id;
  const bad = await read(await handlePersonPhotoRequest({
    request: req("/api/person/photo", { token: WRITE, method: "POST", body: { id, data: "not-an-image" } }),
    env: envBase(),
  }, { fetch: t.mockFetch }));
  assert("非图片 base64 400", bad.status === 400 && bad.body.code === "validation");
  const ssrf = await read(await handlePersonPhotoRequest({
    request: req("/api/person/photo", { token: WRITE, method: "POST", body: { id, url: "https://127.0.0.1/x.jpg" } }),
    env: envBase(),
  }, { fetch: t.mockFetch }));
  assert("SSRF 内网 URL 400", ssrf.status === 400 && ssrf.body.code === "ssrf");
  const up = await read(await handlePersonPhotoRequest({
    request: req("/api/person/photo", { token: WRITE, method: "POST", body: { id, data: tinyPng, caption: "测" } }),
    env: envBase(),
  }, { fetch: t.mockFetch }));
  assert("上传 png 201", up.status === 201 && up.body.ok && up.body.photo_url && up.body.photo_expires_in === PHOTO_SIGN_EXPIRES);
  assert("media 行落 people/<id>/", t.db.media.length === 1 && String(t.db.media[0].path).startsWith("people/" + id + "/"));
  const ph = t.db.history.filter(h => h.action === "photo" && h.entity === "person");
  assert("上传写 photo:person history(网页不可撤)", ph.length === 1 && ph[0].entity_id === id);
  const person = t.db.persons.find(p => p.id === id);
  assert("refreshPrimary 写下 persons.photo", person && person.photo === t.db.media[0].path);
  const mid = t.db.media[0].id;
  const del = await read(await handlePersonPhotoRequest({
    request: req("/api/person/photo?media_id=" + mid + "&purge=1", { token: WRITE, method: "DELETE" }),
    env: envBase(),
  }, { fetch: t.mockFetch }));
  assert("删照片 purge", del.status === 200 && del.body.action === "photo_purged");
  assert("media 行已删", t.db.media.length === 0);
  const dh = t.db.history.filter(h => h.action === "delete" && h.entity === "media");
  assert("删照片写 delete:media 且 entity_id 是人", dh.length === 1 && dh[0].entity_id === id && dh[0].before);
}

{
  const t = createFake(seedDb());
  const created = await postPerson(envBase(), t, { name: "孙庚" });
  const id = created.body.person.id;
  const soft = await delPerson(envBase(), t, id, false);
  assert("软删进回收站", soft.status === 200 && soft.body.action === "trashed");
  const row = t.db.persons.find(p => p.id === id);
  assert("软删后 deleted=1", row && Number(row.deleted) === 1);
  const hist = t.db.history.filter(h => h.action === "delete" && h.entity === "person");
  assert("软删写 delete:person + before", hist.length === 1 && hist[0].before && JSON.parse(hist[0].before).name === "孙庚");
}

{
  const t = createFake(seedDb());
  const created = await postPerson(envBase(), t, { name: "孙辛", father_id: "S001" });
  const id = created.body.person.id;
  const gone = await delPerson(envBase(), t, id, true);
  assert("彻底删除", gone.status === 200 && gone.body.action === "purged");
  assert("purge 后人不在表", !t.db.persons.some(p => p.id === id));
  const hist = t.db.history.filter(h => h.action === "purge" && h.entity === "person");
  assert("purge 写 history", hist.length === 1 && hist[0].entity_id === id);
}

{
  const t = createFake(seedDb());
  const r = await postPerson(envBase(), t, { name: "孙壬", father_id: "S999" });
  assert("父亲不存在先拒 404 不建人", r.status === 404 && r.body.code === "father_not_found" && !t.db.persons.some(p => p.name === "孙壬"));
}

console.log("");
if (fails) { console.log("=== person-write-api: " + fails + " REFUTED ==="); process.exit(1); }
console.log("=== person-write-api: ALL CONFIRMED ✓ ===");
