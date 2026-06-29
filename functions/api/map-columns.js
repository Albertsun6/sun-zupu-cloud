// Cloudflare Pages Function —— AI 推荐"表格列 → 人物字段"映射(代理 DeepSeek)
// 路由:POST /api/map-columns
// 入参:{ headers:["序號","公司名稱",...], sample:["1","银河",...], fields:[{k:"name",label:"姓名"},...] }
// 出参:{ mapping:{ "0":"", "1":"company", "2":"name", ... } }   值=字段 key 或 ""(忽略)
// 安全:仅放行已登录 editor;DeepSeek key 存 CF 环境变量 DEEPSEEK_API_KEY。人工最终审核,故为辅助建议。

const SB_URL  = "https://ktalsyrxueabdisrszde.supabase.co";
const SB_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt0YWxzeXJ4dWVhYmRpc3JzemRlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI1Mjc3MjYsImV4cCI6MjA5ODEwMzcyNn0.Chj8Zdn9BbK7PbpiEoa7iKDmuq_fSab019vL5X5vtPc";

const SYSTEM = `你是表格列映射助手。用户给你:headers(一组表头名)、sample(每列一个样例值,与 headers 一一对应)、fields(目标字段列表,每项含 key 与中文 label)。
为【每一列】选出最贴切的目标字段 key;明显不属于任何字段的列(如序号、证件类型/号码、年龄、ID 等)用空字符串 ""。
规则:① 一个目标字段最多对一列——若多列都像同一字段,只把最合适的那列映上去,其余 ""。② 看表头语义也看样例值(如样例是"男/女"→sex;"银河"这种公司名→company;纯数字日期序列号或 1974-07-25→birth)。③ 拿不准就 ""。
只输出 JSON,不要解释、不要 markdown:
{"mapping":{"0":"name","1":"company","2":""}}
键=列下标(从 0 起的字符串,覆盖每一列),值=fields 里的某个 key 或 ""。`;

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
    const headers = Array.isArray(body.headers) ? body.headers.map(x=>String(x==null?"":x)) : [];
    const sample  = Array.isArray(body.sample)  ? body.sample.map(x=>String(x==null?"":x))  : [];
    const fields  = Array.isArray(body.fields)  ? body.fields.filter(f=>f&&typeof f.k==="string") : [];
    if(!headers.length) return json({ mapping:{} });
    if(headers.length > 200) return json({ error:"列太多(>200)" }, 400);
    if(!fields.length) return json({ error:"缺少字段列表" }, 400);

    const key = env.DEEPSEEK_API_KEY;
    if(!key) return json({ error:"服务器未配置 DEEPSEEK_API_KEY" }, 500);
    const model = env.DEEPSEEK_MODEL || "deepseek-chat";
    const base = (env.DEEPSEEK_BASE || "https://api.deepseek.com").replace(/\/+$/,"");
    const okKeys = new Set(fields.map(f=>f.k)); okKeys.add("");

    async function callLLM(messages){
      const ctrl=new AbortController(); const t=setTimeout(()=>ctrl.abort(),30000);
      try{
        const dres = await fetch(base+"/chat/completions", {
          method:"POST", headers:{ "content-type":"application/json", authorization:"Bearer "+key },
          body: JSON.stringify({ model, stream:false, temperature:0, response_format:{ type:"json_object" }, messages }), signal:ctrl.signal,
        });
        if(!dres.ok){ await dres.text().catch(()=>""); throw new Error("DeepSeek 服务返回错误状态 "+dres.status); }
        const data = await dres.json();
        return (data&&data.choices&&data.choices[0]&&data.choices[0].message&&data.choices[0].message.content)||"";
      } finally { clearTimeout(t); }
    }
    function validate(p){
      if(!p || typeof p.mapping!=="object" || p.mapping===null || Array.isArray(p.mapping)) return "顶层必须是 {\"mapping\":{...}}";
      for(const i in p.mapping){ const v=p.mapping[i]; if(typeof v!=="string" || !okKeys.has(v)) return `列 ${i} 的值不是合法字段 key 或 \"\"`; }
      return "";
    }
    const payload = JSON.stringify({ headers: headers.map((h,i)=>({ index:i, header:h, sample:(sample[i]||"") })), fields });
    let messages=[{ role:"system", content:SYSTEM }, { role:"user", content: payload }];
    let parsed=null, lastErr="";
    for(let attempt=0; attempt<3; attempt++){
      let content; try{ content=await callLLM(messages); }catch(e){ return json({ error:String(e.message||e) }, 502); }
      const p=extractJson(content); const err=validate(p);
      if(!err){ parsed=p; break; }
      lastErr=err;
      messages.push({ role:"assistant", content });
      messages.push({ role:"user", content:`你上次的输出不合格:${err}。请只输出一个 JSON 对象 {"mapping":{...}},键是列下标字符串(覆盖 0..${headers.length-1}),值是给定 fields 的 key 或 ""。不要解释或 markdown。` });
    }
    if(!parsed) return json({ error:"AI 多次未返回合格结构:"+lastErr }, 502);
    // 规整:每列都给出值;非法/缺失→"";去重(一个字段只留第一列)
    const used=new Set(), mapping={};
    for(let i=0;i<headers.length;i++){ let v=parsed.mapping[String(i)]; if(typeof v!=="string"||!okKeys.has(v)) v=""; if(v && used.has(v)) v=""; mapping[String(i)]=v; if(v) used.add(v); }
    return json({ mapping, model });
  }catch(e){ return json({ error:String((e&&e.message)||e) }, 500); }
}
