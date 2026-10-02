#!/usr/bin/env node
// probes/person-write-live.mjs —— 真实写入端到端(不进 CI)
//
// 预览连的是正式 Supabase。只有 Preview 已配 PERSON_WRITE_TOKEN 的部署才该跑。
// 本机/CI 没有令牌时不要跑,也绝不要把令牌写进仓库。
//
// 需要的环境变量:
//   PERSON_WRITE_BASE    预览根地址。请用分支别名,例如
//                        https://cursor-person-write-api-e940.sun-zupu-cloud.pages.dev
//                        (hash 预览每次部署会变,别名稳定)
//   PERSON_WRITE_TOKEN   Preview 里配的写令牌
//   PERSON_API_TOKEN     只读令牌(可选,有则用 GET /api/person 核对配偶和照片)
//
// 用法:
//   PERSON_WRITE_BASE="https://cursor-person-write-api-e940.sun-zupu-cloud.pages.dev" \
//   PERSON_WRITE_TOKEN="…" \
//   PERSON_API_TOKEN="…" \
//   node probes/person-write-live.mjs
//
// 顺序:建两人 → 重名候选 → 挂父子 → 挂配偶 → 改字段 → 传极小 png
//      → GET 核对配偶/照片并打开签名链接 → 清照片+配偶 → 彻底删除两人。
//
// 清理了什么:
//   - 测试照片:media 行 + photos 桶对象(DELETE photo?purge=1)
//   - 测试配偶边(relation unlink;随后 purge 人也会 cascade)
//   - 测试父子边(随 person ON DELETE CASCADE)
//   - 两个人物行(purge,不是进回收站)
//   - 不删 history:[聊天助手] 记录留下作审计
//
// 网页里怎么核对已清理:
//   1. 名册/搜索「测试勿用」应找不到
//   2. 回收站也不应有这两人
//   3. 打开原先那两人详情不应再看到测试配偶/测试照片
//   4. 操作历史顶部有本趟记录,可忽略;不要点撤销 purge / 撤销删照片

const BASE = String(process.env.PERSON_WRITE_BASE || "").replace(/\/+$/, "");
const WRITE = process.env.PERSON_WRITE_TOKEN || "";
const READ = process.env.PERSON_API_TOKEN || "";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";

if (!BASE || !WRITE) {
  console.error("缺少 PERSON_WRITE_BASE 或 PERSON_WRITE_TOKEN。建议 BASE 用分支别名。本脚本不进 CI。");
  process.exit(2);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const nameA = "测试勿用-" + stamp + "-甲";
const nameB = "测试勿用-" + stamp + "-乙";
const created = [];
let mediaId = null;

function headers(token, extra) {
  return Object.assign({
    authorization: "Bearer " + token,
    "content-type": "application/json",
    "user-agent": UA,
  }, extra || {});
}

async function call(method, path, { token, body, idem } = {}) {
  const h = headers(token || WRITE);
  if (idem) h["idempotency-key"] = idem;
  const r = await fetch(BASE + path, {
    method,
    headers: h,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = { raw: text.slice(0, 200) }; }
  return { status: r.status, body: json };
}

function show(step, res) {
  console.log("\n=== " + step + " ===");
  console.log("HTTP " + res.status);
  console.log(JSON.stringify(res.body, null, 2));
}

async function cleanup(reason) {
  console.log("\n=== 清理(" + reason + ") ===");
  if (mediaId != null) {
    const res = await call("DELETE", "/api/person/photo?media_id=" + encodeURIComponent(mediaId) + "&purge=1");
    show("删除测试照片 media_id=" + mediaId + " (桶+media)", res);
    mediaId = null;
  }
  if (created.length >= 2) {
    const un = await call("POST", "/api/person/relation", {
      body: { type: "spouse", person_id: created[0], spouse_id: created[1], unlink: true },
    });
    show("解除测试配偶", un);
  }
  for (const id of [...new Set(created)].reverse()) {
    const res = await call("DELETE", "/api/person?id=" + encodeURIComponent(id) + "&purge=1");
    show("彻底删除 " + id, res);
  }
  console.log("\n清理说明:已删测试照片(桶+media)、测试配偶边、并 purge 人物 " + created.join(", ") + "。");
  console.log("名册和回收站不应再有「" + nameA + " / " + nameB + "」。操作历史里的 [聊天助手] 记录保留。");
}

try {
  const unauth = await fetch(BASE + "/api/person", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": UA },
    body: JSON.stringify({ name: nameA }),
  });
  show("不带令牌 POST /api/person(应为 401)", { status: unauth.status, body: await unauth.json().catch(() => ({})) });

  const fake = await call("POST", "/api/person", { token: "fake-not-the-real-token", body: { name: nameA } });
  show("带假令牌 POST /api/person(应为 401)", fake);
  const fakeRel = await call("POST", "/api/person/relation", { token: "fake-not-the-real-token", body: { type: "spouse", person_id: "S001", spouse_id: "S002" } });
  show("带假令牌 POST /api/person/relation(应为 401)", fakeRel);
  const fakePhoto = await call("POST", "/api/person/photo", { token: "fake-not-the-real-token", body: { id: "S001", data: TINY_PNG } });
  show("带假令牌 POST /api/person/photo(应为 401)", fakePhoto);

  const a = await call("POST", "/api/person", {
    body: { name: nameA, sex: "男", note: "live-probe-a" },
    idem: "live-" + stamp + "-a",
  });
  show("新建甲", a);
  if (a.status !== 201 || !a.body || !a.body.person || !a.body.person.id) throw new Error("新建甲失败");
  created.push(a.body.person.id);

  const b = await call("POST", "/api/person", {
    body: { name: nameB, sex: "女", note: "live-probe-b" },
    idem: "live-" + stamp + "-b",
  });
  show("新建乙", b);
  if (b.status !== 201 || !b.body || !b.body.person || !b.body.person.id) throw new Error("新建乙失败");
  created.push(b.body.person.id);

  const dup = await call("POST", "/api/person", { body: { name: nameA, sex: "男" } });
  show("同名未 confirm(应为 409 候选)", dup);

  const rel = await call("POST", "/api/person/relation", {
    body: { type: "father", child_id: b.body.person.id, father_id: a.body.person.id },
    idem: "live-" + stamp + "-rel",
  });
  show("挂父子 甲→乙", rel);

  const sp = await call("POST", "/api/person/relation", {
    body: { type: "spouse", person_id: a.body.person.id, spouse_id: b.body.person.id, note: "测试勿用" },
    idem: "live-" + stamp + "-spouse",
  });
  show("挂配偶 甲↔乙", sp);

  const patch = await call("PATCH", "/api/person?id=" + encodeURIComponent(b.body.person.id), {
    body: { occupation: "测试职业", note: "live-probe-b-updated" },
    idem: "live-" + stamp + "-patch",
  });
  show("部分更新乙(father 应仍是甲,来自边)", patch);
  if (!patch.body || !patch.body.father || patch.body.father.id !== a.body.person.id) {
    throw new Error("PATCH 响应未带回已有父边");
  }

  const photo = await call("POST", "/api/person/photo", {
    body: { id: b.body.person.id, data: TINY_PNG, caption: "测试勿用" },
    idem: "live-" + stamp + "-photo",
  });
  show("上传极小 png", photo);
  if (photo.status !== 201 || !photo.body || !photo.body.media || !photo.body.media.id) throw new Error("上传照片失败");
  mediaId = photo.body.media.id;

  if (READ) {
    const got = await call("GET", "/api/person?id=" + encodeURIComponent(b.body.person.id), { token: READ });
    show("只读 GET 核对乙(配偶+照片)", got);
    const person = got.body && got.body.person;
    if (!person) throw new Error("GET 无 person");
    const hasSpouse = (person.spouses || []).some(s => s.id === a.body.person.id);
    if (!hasSpouse) throw new Error("GET 未见测试配偶");
    const link = person.photo_url || (person.photos && person.photos[0]);
    if (!link) throw new Error("GET 无照片签名链接");
    const img = await fetch(link, { headers: { "user-agent": UA } });
    const ct = img.headers.get("content-type") || "";
    console.log("\n=== 打开签名照片 ===");
    console.log("HTTP " + img.status + " content-type=" + ct);
    if (img.status !== 200 || !/^image\//i.test(ct)) throw new Error("签名照片打不开或不是图片");
    await img.arrayBuffer();
  } else {
    console.log("\n(未设 PERSON_API_TOKEN,跳过只读 GET / 打开照片)");
  }

  await cleanup("正常结束");
  console.log("\n=== person-write-live: 跑完 ===");
} catch (e) {
  console.error("\n失败: " + (e && e.message ? e.message : e));
  try { await cleanup("失败后尽量清"); } catch (e2) {
    console.error("清理也失败,请到网页搜「测试勿用」手工处理: " + (e2 && e2.message ? e2.message : e2));
  }
  process.exit(1);
}
