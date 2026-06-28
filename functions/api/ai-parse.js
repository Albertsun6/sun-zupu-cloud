// Cloudflare Pages Function —— AI 批量识别人物草稿(代理 DeepSeek)
// 路由:POST /api/ai-parse   (随 git push 自动部署,无需 CLI)
// 安全:DeepSeek key 存 CF 环境变量 DEEPSEEK_API_KEY(服务端,绝不入前端/仓库);
//       仅放行"已登录的 editor"调用(校验前端传来的 Supabase JWT),防止他人盗刷 key。
// 配置:Cloudflare Pages → Settings → Environment variables 添加 DEEPSEEK_API_KEY(必填),
//       可选 DEEPSEEK_MODEL(默认 deepseek-v4-flash)、DEEPSEEK_BASE(默认 https://api.deepseek.com)。

const SB_URL  = "https://ktalsyrxueabdisrszde.supabase.co";   // 公开,仅用于校验登录令牌
const SB_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt0YWxzeXJ4dWVhYmRpc3JzemRlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI1Mjc3MjYsImV4cCI6MjA5ODEwMzcyNn0.Chj8Zdn9BbK7PbpiEoa7iKDmuq_fSab019vL5X5vtPc";

const SYSTEM = `你是中文族谱/人物信息抽取助手。用户给你一段中文文字(族谱片段、名单、讣告、简历、回忆等),请识别其中提到的"人物",每人一条记录,组成 JSON。
只输出一个 JSON 对象,形如 {"persons":[{...},{...}]},不要任何解释、不要 markdown 代码块。
每个人物对象可含下列字段(不知道就留空字符串 "",绝不编造):
- name: 姓名(必填,识别不到姓名的不要输出)
- kind: "本族" 或 "外部"(默认 "本族";明显是非家族的朋友/同事/外姓人填 "外部")
- sex: "男" 或 "女"
- gen: 世代数字(仅当文中明确"第N世/第N代"时填,否则留空)
- char_gen: 字辈(单字,如"德")
- rank: 行第(如"长子""次子""三女")
- birth: 生年(原文照录,如"1948""民国十年""光绪三年",不确定留空)
- birth_lunar: 农历生辰(如"农历六月十六")
- death: 卒年/享年(原文照录)
- birth_place: 出生地
- occupation: 学历/职业/功名
- residence: 居住地/迁徙
- spouse: 配偶姓名
- mother: 母亲姓名
- father: 父亲姓名(若文中有"X之子/X生Y/父X"等)
- note: 其它信息或原文摘录(便于人工核对)
规则:忠于原文,宁缺勿造;一段话提到多人(父子/兄弟/夫妻)就拆成多条;保留原文用词。`;

function json(o, status) {
  return new Response(JSON.stringify(o), { status: status || 200, headers: { "content-type": "application/json; charset=utf-8" } });
}
function extractJson(s) {
  try { return JSON.parse(s); } catch (e) {}
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch (e) {} }
  return null;
}

export async function onRequestPost({ request, env }) {
  try {
    // 1) 校验调用者 = 已登录 editor
    const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "未登录" }, 401);
    const ures = await fetch(SB_URL + "/auth/v1/user", { headers: { apikey: SB_ANON, authorization: "Bearer " + token } });
    if (!ures.ok) return json({ error: "登录校验失败,请重新登录" }, 401);
    const user = await ures.json();
    if (((user && user.app_metadata && user.app_metadata.role) || "viewer") !== "editor")
      return json({ error: "需要 editor 权限才能用 AI 识别" }, 403);

    // 2) 文本
    const body = await request.json().catch(() => ({}));
    const text = (body.text || "").trim();
    if (!text) return json({ error: "没有要识别的文字" }, 400);
    if (text.length > 8000) return json({ error: "文字过长(>8000字),请分批粘贴" }, 400);

    // 3) DeepSeek key
    const key = env.DEEPSEEK_API_KEY;
    if (!key) return json({ error: "服务器未配置 DEEPSEEK_API_KEY。请在 Cloudflare Pages → Settings → Environment variables 添加后重新部署。" }, 500);
    const model = env.DEEPSEEK_MODEL || "deepseek-v4-flash";
    const base = (env.DEEPSEEK_BASE || "https://api.deepseek.com").replace(/\/+$/, "");

    // 4) 调 DeepSeek
    const dres = await fetch(base + "/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + key },
      body: JSON.stringify({ model, stream: false, temperature: 0,
        messages: [{ role: "system", content: SYSTEM }, { role: "user", content: text }] }),
    });
    if (!dres.ok) { const t = await dres.text(); return json({ error: "DeepSeek 调用失败 (" + dres.status + "): " + t.slice(0, 300) }, 502); }
    const data = await dres.json();
    const content = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
    const parsed = extractJson(content);
    if (!parsed || !Array.isArray(parsed.persons)) return json({ error: "AI 未返回有效人物列表", raw: content.slice(0, 500) }, 502);
    const persons = parsed.persons.filter(p => p && (p.name || "").trim());
    return json({ persons, model, count: persons.length });
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, 500);
  }
}
