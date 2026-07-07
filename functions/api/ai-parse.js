// Cloudflare Pages Function —— AI 批量识别人物草稿(代理 DeepSeek)
// 路由:POST /api/ai-parse   (随 git push 自动部署,无需 CLI)
// 安全:DeepSeek key 存 CF 环境变量 DEEPSEEK_API_KEY(服务端,绝不入前端/仓库);
//       仅放行"已登录的 editor"调用(校验前端传来的 Supabase JWT),防止他人盗刷 key。
// 配置:Cloudflare Pages → Settings → Environment variables 添加 DEEPSEEK_API_KEY(必填),
//       可选 DEEPSEEK_MODEL(默认 deepseek-v4-flash)、DEEPSEEK_BASE(默认 https://api.deepseek.com)。

import { json, extractJson, requireWrite, upstreamError } from "./_shared.js";   // 门禁/常量/错误脱敏统一走 _shared(禁止内联,见其头注释)

const SYSTEM = `你是中文族谱/人物信息抽取助手。用户给你一段中文文字(族谱片段、名单、讣告、简历、回忆等),请识别其中提到的"人物",每人一条记录,组成 JSON。
只输出一个 JSON 对象,形如 {"persons":[{...},{...}]},不要任何解释、不要 markdown 代码块。
每个人物对象可含下列字段(不知道就留空字符串 "",绝不编造):
- name: 姓名(必填,识别不到姓名的不要输出)
- kind: "本族" 或 "外部"(默认 "本族";明显是非家族的朋友/同事/外姓人填 "外部")
- sex: "男" 或 "女"
- gen: 世代数字(仅当文中明确"第N世/第N代"时填,否则留空)
- char_gen: 字辈(单字,如"德")
- rank: 行第(如"长子""次子""三女")
- birth: 出生信息【完整照录到这一个字段】——年月日 + 时辰/钟点 + 生肖全留在这,别拆、别删、别丢"早9时""下午3点"这类时间(如"1979年6月初五日早9时属羊""1948""光绪三年"),不确定留空。程序会自动拆成 公历/农历/时辰,你不要换算。
- birth_lunar: 仅当原文【另给了一个独立的农历日期】且没并进 birth 时才填;否则留空(程序会从 birth 自动换算农历)。
- death: 卒年/享年(原文照录)
- birth_place: 出生地
- occupation: 学历/职业/功名
- residence: 居住地/迁徙
- spouse: 配偶姓名
- mother: 母亲姓名
- father: 父亲姓名(若文中有"X之子/X生Y/父X"等)
- note: 其它信息或原文摘录(便于人工核对)。【不要】把出生日期/时辰/生肖放进 note——那些一律进 birth。
规则:忠于原文,宁缺勿造;一段话提到多人(父子/兄弟/夫妻)就拆成多条;保留原文用词。`;

export async function onRequestPost({ request, env }) {
  try {
    // 1) 校验调用者 = 已登录 editor/admin(_shared 统一门禁,含 aud 校验)
    const gate = await requireWrite(request); if (gate.resp) return gate.resp;

    // 2) 文本
    const body = await request.json().catch(() => ({}));
    const text = (body.text || "").trim();
    if (!text) return json({ error: "没有要识别的文字" }, 400);
    if (text.length > 8000) return json({ error: "文字过长(>8000字),请分批粘贴" }, 400);

    // 3) DeepSeek key
    const key = env.DEEPSEEK_API_KEY;
    if (!key) return json({ error: "服务器未配置 DEEPSEEK_API_KEY。请在 Cloudflare Pages → Settings → Environment variables 添加后重新部署。" }, 500);
    const model = env.DEEPSEEK_MODEL || "deepseek-chat";   // 旗舰准确版(原 flash 为快但弱);可用 CF 环境变量 DEEPSEEK_MODEL 覆盖
    const base = (env.DEEPSEEK_BASE || "https://api.deepseek.com").replace(/\/+$/, "");

    // 4) 调 DeepSeek
    const dres = await fetch(base + "/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + key },
      body: JSON.stringify({ model, stream: false, temperature: 0,
        messages: [{ role: "system", content: SYSTEM }, { role: "user", content: text }] }),
    });
    if (!dres.ok) { const e = await upstreamError("DeepSeek", dres); return json({ error: e.message }, 502); }   // 脱敏:不回传上游响应体
    const data = await dres.json();
    const content = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
    const parsed = extractJson(content);
    if (!parsed || !Array.isArray(parsed.persons)) return json({ error: "AI 未返回有效人物列表,请重试或换一段文字" }, 502);   // 脱敏:不回传模型原始输出
    const persons = parsed.persons.filter(p => p && (p.name || "").trim());
    return json({ persons, model, count: persons.length });
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, 500);
  }
}
