// Cloudflare Pages Function —— AI 规范出生/卒日期(代理 DeepSeek)
// 路由:POST /api/normalize-dates   (随 git push 自动部署)
// 入参:{ dates: ["光绪三年","约1900","农历六月十六 1948",...] }(只传规则解析不了的)
// 出参:{ results: [{ input, value, ok, note }] }  value=公历 ISO(年月日可缺);ok=false=无法识别
// 安全:同 ai-parse.js——仅放行已登录 editor;DeepSeek key 存 CF 环境变量 DEEPSEEK_API_KEY。

const SB_URL  = "https://ktalsyrxueabdisrszde.supabase.co";
const SB_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt0YWxzeXJ4dWVhYmRpc3JzemRlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI1Mjc3MjYsImV4cCI6MjA5ODEwMzcyNn0.Chj8Zdn9BbK7PbpiEoa7iKDmuq_fSab019vL5X5vtPc";

const SYSTEM = `你是中文出生日期/时辰解析助手。把每个输入解析成结构化信息(年月日时,可缺):
每条输出 4 个字段:
- value: 【公历】ISO 日期。完整→"YYYY-MM-DD";只确定年月→"YYYY-MM";只确定年→"YYYY";无法确定→""。
    · 农历输入(如"六月初五""腊月初九")请尽量换算成公历日期;若换算没把握就只给能确定的公历年(YYYY)。
    · 帝王年号/民国纪年("光绪三年""民国卅八年")换算成公历年。生肖("属羊")可辅助定年。
    · 模糊("约1900""1992/93")取最可能公历年,note 写"约"。
- lunar: 农历生辰原文/标准化(如"农历六月初五""腊月初九");输入里没有农历成分就 ""。
- time: 出生时辰/钟点。"早9时"→"09:00","下午3点"→"15:00","子时"→"子时","巳时"→"巳时";没有就 ""。
- ok: 至少能确定公历年=true,否则 false。
绝不编造:拿不准的就留空对应字段。只输出一个 JSON,不要解释、不要 markdown:
{"results":[{"input":"原文","value":"YYYY-MM-DD|YYYY-MM|YYYY|","lunar":"","time":"","ok":true,"note":""}]}
results 顺序与输入数组一致、长度一致。`;

function json(o, status){ return new Response(JSON.stringify(o), { status: status||200, headers: { "content-type": "application/json; charset=utf-8" } }); }
function extractJson(s){ try{ return JSON.parse(s); }catch(e){} const a=s.indexOf("{"), b=s.lastIndexOf("}"); if(a>=0&&b>a){ try{ return JSON.parse(s.slice(a,b+1)); }catch(e){} } return null; }

export async function onRequestPost({ request, env }){
  try{
    const token = (request.headers.get("authorization")||"").replace(/^Bearer\s+/i,"");
    if(!token) return json({ error:"未登录" }, 401);
    const ures = await fetch(SB_URL+"/auth/v1/user", { headers:{ apikey:SB_ANON, authorization:"Bearer "+token } });
    if(!ures.ok) return json({ error:"登录校验失败,请重新登录" }, 401);
    const user = await ures.json();
    if(((user&&user.app_metadata&&user.app_metadata.role)||"viewer")!=="editor") return json({ error:"需要 editor 权限" }, 403);

    const body = await request.json().catch(()=>({}));
    const dates = Array.isArray(body.dates) ? body.dates.map(x=>String(x||"").trim()).filter(Boolean) : [];
    if(!dates.length) return json({ results:[] });
    if(dates.length > 200) return json({ error:"一次最多 200 条,请分批" }, 400);

    const key = env.DEEPSEEK_API_KEY;
    if(!key) return json({ error:"服务器未配置 DEEPSEEK_API_KEY" }, 500);
    const model = env.DEEPSEEK_MODEL || "deepseek-v4-flash";
    const base = (env.DEEPSEEK_BASE || "https://api.deepseek.com").replace(/\/+$/,"");

    const dres = await fetch(base+"/chat/completions", {
      method:"POST", headers:{ "content-type":"application/json", authorization:"Bearer "+key },
      body: JSON.stringify({ model, stream:false, temperature:0,
        messages:[{ role:"system", content:SYSTEM }, { role:"user", content: JSON.stringify(dates) }] }),
    });
    if(!dres.ok){ const t=await dres.text(); return json({ error:"DeepSeek 调用失败 ("+dres.status+"): "+t.slice(0,300) }, 502); }
    const data = await dres.json();
    const content = (data&&data.choices&&data.choices[0]&&data.choices[0].message&&data.choices[0].message.content)||"";
    const parsed = extractJson(content);
    if(!parsed || !Array.isArray(parsed.results)) return json({ error:"AI 未返回有效结果", raw: content.slice(0,500) }, 502);
    // 按 input 对齐(防 AI 漏条/乱序);未命中的标 ok=false
    const map = {}; parsed.results.forEach(r=>{ if(r&&typeof r.input==="string") map[r.input.trim()] = r; });
    const results = dates.map(d=>{ const r=map[d]||{}; const v=(r.value||"").trim();
      const valOk = /^\d{3,4}(-\d{2}(-\d{2})?)?$/.test(v);
      return { input:d, value: valOk?v:"", lunar:(r.lunar||"").trim(), time:(r.time||"").trim(), ok:(r.ok===true&&valOk), note:(r.note||"") }; });
    return json({ results, model });
  }catch(e){ return json({ error:String((e&&e.message)||e) }, 500); }
}
