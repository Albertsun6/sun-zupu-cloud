// Cloudflare Pages Function —— AI 规范出生/卒日期(代理 DeepSeek)
// 路由:POST /api/normalize-dates   (随 git push 自动部署)
// 入参:{ dates: ["光绪三年","约1900","农历六月十六 1948",...] }(只传规则解析不了的)
// 出参:{ results: [{ input, value, ok, note }] }  value=公历 ISO(年月日可缺);ok=false=无法识别
// 安全:同 ai-parse.js——仅放行已登录 editor;DeepSeek key 存 CF 环境变量 DEEPSEEK_API_KEY。

const SB_URL  = "https://ktalsyrxueabdisrszde.supabase.co";
const SB_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt0YWxzeXJ4dWVhYmRpc3JzemRlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI1Mjc3MjYsImV4cCI6MjA5ODEwMzcyNn0.Chj8Zdn9BbK7PbpiEoa7iKDmuq_fSab019vL5X5vtPc";

const SYSTEM = `你是中文出生日期/时辰解析助手。把每个输入【拆成结构化字段】——你只负责拆,不做农历↔公历换算(换算由程序的万年历完成):
- is_lunar: 农历日期=true(出现"初五""腊月""农历""闰X月"等农历写法);公历=false。生肖("属羊")/帝王年号/民国纪年通常配农历,按 true。
- year: 【公历】年数字。年号/民国/生肖请换算成公历年(如"光绪三年"→1877;"1979…属羊"→1979)。拿不准 null。
- month: 月数字 1–12(农历输入就填农历月、公历输入就填公历月,别自己换历);只有年→null。
- day: 日数字 1–31(农历"初五"→5、"廿三"→23、"腊月"是月不是日);没有→null。
- leap: 农历闰月=true,否则 false。
- time: 24 小时制 "HH:MM"("早9时"→"09:00","下午3点"→"15:00","晚9时"→"21:00");给的是时辰名("巳时")就原样返回;没有→""。
- ok: 至少能定 year=true。
关键:year 必须是公历年;month/day 按 is_lunar 指示的历法原样填,【不要自己换算成公历月日】。绝不编造,拿不准就 null/""。
只输出 JSON,不要解释、不要 markdown:
{"results":[{"input":"原文","is_lunar":false,"year":1979,"month":6,"day":5,"leap":false,"time":"09:00","ok":true,"note":""}]}
results 顺序与输入一致、长度一致。`;

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
    const num = (v,lo,hi) => { const n=parseInt(v); return (Number.isFinite(n)&&n>=lo&&n<=hi)?n:null; };
    const results = dates.map(d=>{ const r=map[d]||{};
      const year=num(r.year,1000,2200), month=num(r.month,1,12), day=num(r.day,1,31);
      return { input:d, is_lunar:r.is_lunar===true, year, month, day, leap:r.leap===true, time:(r.time||"").toString().trim(), ok:(r.ok===true&&!!year), note:(r.note||"") }; });
    return json({ results, model });
  }catch(e){ return json({ error:String((e&&e.message)||e) }, 500); }
}
