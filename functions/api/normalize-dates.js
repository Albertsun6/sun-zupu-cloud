// Cloudflare Pages Function —— AI 规范出生/卒日期(代理 DeepSeek)
// 路由:POST /api/normalize-dates   (随 git push 自动部署)
// 入参:{ dates: ["光绪三年","约1900","农历六月十六 1948",...] }(只传规则解析不了的)
// 出参:{ results: [{ input, value, ok, note }] }  value=公历 ISO(年月日可缺);ok=false=无法识别
// 安全:同 ai-parse.js——仅放行已登录 editor;DeepSeek key 存 CF 环境变量 DEEPSEEK_API_KEY。

const SB_URL  = "https://ktalsyrxueabdisrszde.supabase.co";
const SB_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt0YWxzeXJ4dWVhYmRpc3JzemRlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI1Mjc3MjYsImV4cCI6MjA5ODEwMzcyNn0.Chj8Zdn9BbK7PbpiEoa7iKDmuq_fSab019vL5X5vtPc";

const SYSTEM = `你是中文日期规范化助手。把每个输入字符串规范成【公历】ISO 日期,年月日可以不全:
- 完整 → "YYYY-MM-DD";只能确定年月 → "YYYY-MM";只能确定年 → "YYYY";完全无法识别 → value 留空 ""、ok=false。
- 农历日期:若给了农历月日但无法可靠换算成公历具体日,就只输出能确定的年(YYYY);能可靠换算才给月日。
- 帝王年号/民国纪年(如"光绪三年""民国卅八年""康熙十年"):换算成公历年(通常只给 YYYY)。
- 模糊(如"约1900""1900年前后""1992/93""1948左右"):取最可能的公历年,只给 YYYY,note 写"约"。
- 已是干净数字日期的也照常规范(如"1996/6/26"→"1996-06-26")。
- 绝不编造:拿不准月/日就不要给月/日;整体拿不准就 ok=false。
只输出一个 JSON 对象,不要解释、不要 markdown:
{"results":[{"input":"原文","value":"YYYY-MM-DD|YYYY-MM|YYYY|","ok":true,"note":"换算依据,可空"}]}
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
      const ok = (r.ok===true) && /^\d{3,4}(-\d{2}(-\d{2})?)?$/.test(v);
      return { input:d, value: ok?v:"", ok, note:(r.note||"") }; });
    return json({ results, model });
  }catch(e){ return json({ error:String((e&&e.message)||e) }, 500); }
}
