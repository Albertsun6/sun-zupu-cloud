// probes/person-api.mjs —— 查人接口本地探针(假 Supabase 响应,不断真库)
// 用法: node probes/person-api.mjs
import { timingSafeEqualStr, requireServiceToken } from "../functions/api/_shared.js";
import {
  matchPersons, isExactName, buildRelMaps, buildGenOf,
  toCandidate, toDetail, safePhotoKey, normalizeSbUrl,
  handlePersonRequest, PHOTO_SIGN_EXPIRES,
} from "../functions/api/person.js";

let fails = 0;
function ok(name) { console.log("CONFIRMED  " + name); }
function bad(name, detail) { fails++; console.log("REFUTED   " + name + (detail ? " — " + detail : "")); }
function assert(name, cond, detail) { if (cond) ok(name); else bad(name, detail); }

const persons = [
  { id: "S001", name: "孙甲", alias: "甲公", sex: "男", gen: "1", char_gen: "德", birth: "1901", alive: "", photo: "people/S001/a.jpg", mother: "", spouse: "", father_note: "", contact: "SHOULD_NOT_LEAK", address: "SHOULD_NOT_LEAK", occupation: "务农", residence: "吉林", note: "始迁祖" },
  { id: "S002", name: "孙乙", alias: "", sex: "男", gen: "", char_gen: "永", birth: "1930", alive: "", photo: "", mother: "李氏", spouse: "", father_note: "长子", contact: "13800000000", address: "某路1号", occupation: "", residence: "", note: "" },
  { id: "S003", name: "孙乙", alias: "", sex: "女", gen: "", char_gen: "永", birth: "1932", alive: "是", photo: "", mother: "", spouse: "", father_note: "", contact: "x", address: "y", occupation: "", residence: "", note: "" },
  { id: "S004", name: "孙丙", alias: "", sex: "男", gen: "", char_gen: "世", birth: "1960年春", alive: "是", photo: "people/S004/b.jpg", mother: "", spouse: "外记配偶", father_note: "", contact: "c", address: "d", occupation: "教师", residence: "沈阳", note: "" },
];
const rels = [
  { from_id: "S001", to_id: "S002", type: "father" },
  { from_id: "S001", to_id: "S003", type: "father" },
  { from_id: "S002", to_id: "S004", type: "father" },
  { from_id: "W001", to_id: "S002", type: "mother" },
  { from_id: "S002", to_id: "W002", type: "spouse" },
];
const extraPersons = [
  { id: "W001", name: "李氏", alias: "", sex: "女", gen: "", char_gen: "", birth: "", alive: "", photo: "", mother: "", spouse: "", father_note: "" },
  { id: "W002", name: "王氏", alias: "", sex: "女", gen: "", char_gen: "", birth: "", alive: "", photo: "", mother: "", spouse: "", father_note: "" },
];
const all = persons.concat(extraPersons);
const maps = buildRelMaps(rels);
const genOf = buildGenOf(all, maps);

assert("精确姓名命中两人", matchPersons(all, "孙乙").map(p => p.id).join(",") === "S002,S003");
assert("别名精确命中", matchPersons(all, "甲公")[0]?.id === "S001");
assert("模糊子串命中", matchPersons(all, "孙丙")[0]?.id === "S004");
assert("无人命中为空", matchPersons(all, "不存在的人").length === 0);
assert("isExactName 区分精确", isExactName(persons[0], "孙甲") && !isExactName(persons[0], "孙"));

assert("世代:锚点本人=1", genOf("S001") === 1);
assert("世代:子=2", genOf("S002") === 2);
assert("世代:孙女随父=2", genOf("S003") === 2);
assert("世代:孙=3", genOf("S004") === 3);
assert("安全照片 key 拒绝穿越", safePhotoKey("../x") === "" && safePhotoKey("/abs") === "" && safePhotoKey("people/S001/a.jpg") === "people/S001/a.jpg");
assert("normalizeSbUrl 只接受 https", normalizeSbUrl("https://abc.supabase.co/") === "https://abc.supabase.co" && normalizeSbUrl("http://evil") === "");

const cand = toCandidate(persons[1], all, maps, genOf);
assert("候选含父亲姓名", cand.father && cand.father.id === "S001" && cand.father.name === "孙甲");
assert("候选含世代", cand.generation === 2);
assert("候选不含敏感字段", !("contact" in cand) && !("address" in cand));

const detail = toDetail(persons[1], all, maps, genOf, { photo_url: null, photos: [], photo_expires_in: null });
assert("详情父母来自边", detail.parents.father?.name === "孙甲" && detail.parents.mother?.name === "李氏");
assert("详情子女含孙丙", detail.children.some(c => c.id === "S004" && c.name === "孙丙"));
assert("详情配偶来自边", detail.spouses.some(s => s.id === "W002" && s.name === "王氏"));
assert("详情不含 contact/address", !("contact" in detail) && !("address" in detail) && !("photo" in detail));
assert("详情含族谱字段", detail.occupation === "" && detail.father_note === "长子" && detail.residence === "");

const noEdgeSpouse = toDetail(persons[3], all, maps, genOf, null);
assert("无配偶边时回退旧 spouse 文本", noEdgeSpouse.spouses.some(s => s.id === null && s.name === "外记配偶"));

assert("timingSafeEqual 相同为真", await timingSafeEqualStr("abc", "abc"));
assert("timingSafeEqual 不同为假", !(await timingSafeEqualStr("abc", "abd")));

const deny = await requireServiceToken(new Request("https://x/", { headers: { authorization: "Bearer nope" } }), "secret");
assert("错令牌 401", deny.resp && deny.resp.status === 401);
const denyEmpty = await requireServiceToken(new Request("https://x/"), "");
assert("未配置令牌 fail-closed 401", denyEmpty.resp && denyEmpty.resp.status === 401);
const allow = await requireServiceToken(new Request("https://x/", { headers: { authorization: "Bearer secret" } }), "secret");
assert("对令牌放行", allow.ok === true && !allow.resp);

function envBase(over) {
  return Object.assign({
    PERSON_API_TOKEN: "tok-test-32-chars-minimum-value",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE: "svc-fake",
  }, over || {});
}
function req(path, token) {
  const headers = {};
  if (token !== undefined) headers.authorization = "Bearer " + token;
  return new Request("https://pages.example" + path, { headers });
}
async function read(res) { return { status: res.status, body: await res.json() }; }

const calls = [];
function mockFetch(url, init) {
  calls.push({ url: String(url), method: (init && init.method) || "GET" });
  const u = String(url);
  if (u.includes("/rest/v1/persons")) return Promise.resolve(new Response(JSON.stringify(all), { status: 200 }));
  if (u.includes("/rest/v1/relationships")) return Promise.resolve(new Response(JSON.stringify(rels), { status: 200 }));
  if (u.includes("/rest/v1/media")) {
    return Promise.resolve(new Response(JSON.stringify([{ path: "people/S001/a.jpg", is_primary: 1, sort_order: 0 }]), { status: 200 }));
  }
  if (u.includes("/storage/v1/object/sign/photos/")) {
    return Promise.resolve(new Response(JSON.stringify({ signedURL: "/object/sign/photos/people/S001/a.jpg?token=sig" }), { status: 200 }));
  }
  return Promise.resolve(new Response("nope", { status: 404 }));
}

{
  const r = await read(await handlePersonRequest({ request: req("/api/person?name=孙甲"), env: envBase() }, { fetch: mockFetch }));
  assert("无 Authorization 头应 401", r.status === 401 && r.body.error === "未授权");
}
{
  const r = await read(await handlePersonRequest({ request: req("/api/person?name=孙甲", "wrong"), env: envBase() }, { fetch: mockFetch }));
  assert("错令牌应 401", r.status === 401);
}
{
  const r = await read(await handlePersonRequest({ request: req("/api/person?name=孙甲", "x"), env: envBase({ PERSON_API_TOKEN: "" }) }, { fetch: mockFetch }));
  assert("未配 PERSON_API_TOKEN 应 401", r.status === 401);
}
{
  const r = await read(await handlePersonRequest({ request: req("/api/person?name=孙甲", envBase().PERSON_API_TOKEN), env: envBase({ SUPABASE_URL: "" }) }, { fetch: mockFetch }));
  assert("未配 SUPABASE_URL 应 503", r.status === 503);
}
{
  const r = await read(await handlePersonRequest({ request: req("/api/person?name=孙甲", envBase().PERSON_API_TOKEN), env: envBase({ SUPABASE_SERVICE_ROLE: "" }) }, { fetch: mockFetch }));
  assert("未配 SERVICE_ROLE 应 503", r.status === 503);
}
{
  const r = await read(await handlePersonRequest({ request: req("/api/person", envBase().PERSON_API_TOKEN), env: envBase() }, { fetch: mockFetch }));
  assert("缺参数 400", r.status === 400);
}
{
  const r = await read(await handlePersonRequest({ request: req("/api/person?id=bad id", envBase().PERSON_API_TOKEN), env: envBase() }, { fetch: mockFetch }));
  assert("非法 id 400", r.status === 400);
}

calls.length = 0;
{
  const r = await read(await handlePersonRequest({ request: req("/api/person?name=孙甲", envBase().PERSON_API_TOKEN), env: envBase() }, { fetch: mockFetch }));
  assert("精确单人 200", r.status === 200 && r.body.match === "exact" && r.body.person.id === "S001");
  assert("单人世代", r.body.person.generation === 1);
  assert("签名照片 1 小时", r.body.person.photo_url && r.body.person.photo_url.includes("token=sig") && r.body.person.photo_expires_in === PHOTO_SIGN_EXPIRES);
  const dumped = JSON.stringify(r.body);
  assert("成功响应不带敏感字段", !dumped.includes("SHOULD_NOT_LEAK") && !dumped.includes("contact") && !dumped.includes("address"));
  assert("子女列出孙乙二人", r.body.person.children.length === 2);
}

{
  const r = await read(await handlePersonRequest({ request: req("/api/person?name=" + encodeURIComponent("孙乙"), envBase().PERSON_API_TOKEN), env: envBase() }, { fetch: mockFetch }));
  assert("重名 ambiguous", r.status === 200 && r.body.match === "ambiguous" && r.body.count === 2 && r.body.candidates.length === 2);
  assert("候选带父亲可区分", r.body.candidates.every(c => c.father && c.father.name === "孙甲"));
  assert("候选不签发照片", r.body.candidates.every(c => !c.photo_url));
}

{
  const r = await read(await handlePersonRequest({ request: req("/api/person?id=S004", envBase().PERSON_API_TOKEN), env: envBase() }, { fetch: mockFetch }));
  assert("按 id 精确查", r.status === 200 && r.body.match === "id" && r.body.person.id === "S004" && r.body.person.generation === 3);
}

{
  const r = await read(await handlePersonRequest({ request: req("/api/person?name=" + encodeURIComponent("没有这个人"), envBase().PERSON_API_TOKEN), env: envBase() }, { fetch: mockFetch }));
  assert("查无此人 404", r.status === 404 && r.body.error === "未找到此人" && r.body.query.name === "没有这个人");
}

{
  const r = await read(await handlePersonRequest({ request: req("/api/person?name=孙", envBase().PERSON_API_TOKEN), env: envBase() }, { fetch: mockFetch }));
  assert("模糊多人走候选", r.status === 200 && r.body.match === "ambiguous" && r.body.count >= 3);
}

console.log("");
if (fails) { console.log("=== person-api: " + fails + " REFUTED ==="); process.exit(1); }
console.log("=== person-api: ALL CONFIRMED ✓ ===");
