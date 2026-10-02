#!/usr/bin/env node
// probes/person-write-live.mjs —— 真实写入端到端(第一版,不进 CI)
//
// 预览连的是正式 Supabase。只有主人在 Cloudflare Pages Preview 配好
// PERSON_WRITE_TOKEN 并重新部署之后,才应该跑本脚本。
// 本机/CI 没有令牌时不要跑,也绝不要把令牌写进仓库。
//
// 需要的环境变量:
//   PERSON_WRITE_BASE    预览根地址,如 https://cursor-person-write-api-e940.sun-zupu-cloud.pages.dev
//   PERSON_WRITE_TOKEN   Preview 里配的写令牌
//   PERSON_API_TOKEN     只读令牌(可选,有则用 GET /api/person 核对)
//
// 用法:
//   PERSON_WRITE_BASE="https://….pages.dev" \
//   PERSON_WRITE_TOKEN="…" \
//   PERSON_API_TOKEN="…" \
//   node probes/person-write-live.mjs
//
// 顺序:建两人 → 测重名候选 → 挂父子 → 改字段 → (有读令牌则 GET 核对) → 彻底删除两人。
//
// 清理了什么:
//   - 本趟创建的两个人物行(purge,不是进回收站)
//   - 他们之间的 father 边(随 person 行 ON DELETE CASCADE 一起消失)
//   - 不删 history:操作历史里会留下 [聊天助手] 的 create/update/purge 记录,这是审计,不是测试数据
//
// 网页里怎么核对已清理:
//   1. 名册/搜索框搜「测试勿用」应找不到
//   2. 回收站也不应出现这两人(走的是彻底删除,不是软删)
//   3. 「操作历史」顶部能看到本趟的 [聊天助手] 记录,可忽略;不要点撤销 purge
//      (撤销彻底删除只会重建人物基本信息,等于把测试人救回来)

const BASE = String(process.env.PERSON_WRITE_BASE || "").replace(/\/+$/, "");
const WRITE = process.env.PERSON_WRITE_TOKEN || "";
const READ = process.env.PERSON_API_TOKEN || "";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

if (!BASE || !WRITE) {
  console.error("缺少 PERSON_WRITE_BASE 或 PERSON_WRITE_TOKEN。本脚本不进 CI,请在主人配好 Preview 写令牌后再跑。");
  process.exit(2);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const nameA = "测试勿用-" + stamp + "-甲";
const nameB = "测试勿用-" + stamp + "-乙";
const created = [];

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
  for (const id of [...new Set(created)].reverse()) {
    const res = await call("DELETE", "/api/person?id=" + encodeURIComponent(id) + "&purge=1");
    show("彻底删除 " + id, res);
  }
  console.log("\n清理说明:已对以上 id 发 purge。名册和回收站不应再有「" + nameA + " / " + nameB + "」。");
  console.log("操作历史会留下 [聊天助手] 记录,属审计,不是残留人物。");
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

  if (READ) {
    const getFake = await call("GET", "/api/person?name=" + encodeURIComponent("孙"), { token: "fake-not-the-real-token" });
    show("带假令牌 GET /api/person(应为 401,只读行为不变)", getFake);
  }

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

  const patch = await call("PATCH", "/api/person?id=" + encodeURIComponent(b.body.person.id), {
    body: { occupation: "测试职业", note: "live-probe-b-updated" },
    idem: "live-" + stamp + "-patch",
  });
  show("部分更新乙", patch);

  if (READ) {
    const got = await call("GET", "/api/person?id=" + encodeURIComponent(b.body.person.id), { token: READ });
    show("只读 GET 核对乙", got);
  } else {
    console.log("\n(未设 PERSON_API_TOKEN,跳过只读 GET 核对)");
  }

  await cleanup("正常结束");
  console.log("\n=== person-write-live: 跑完 ===");
} catch (e) {
  console.error("\n失败: " + (e && e.message ? e.message : e));
  try { await cleanup("失败后尽量清"); } catch (e2) {
    console.error("清理也失败,请到网页回收站/名册搜「测试勿用」手工处理: " + (e2 && e2.message ? e2.message : e2));
  }
  process.exit(1);
}
