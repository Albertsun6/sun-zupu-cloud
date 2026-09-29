// ============================================================
// 部署配置示例 —— 复制为本目录 config.js 后填入你的 Supabase 项目信息。
//   cp config.example.js config.js
// config.js 已列入 .gitignore,不要提交。
// 线上(Cloudflare Pages)不读这个文件:由 functions/config.js.js 从环境变量
// SUPABASE_URL / SUPABASE_ANON_KEY 动态输出 /config.js。
// ============================================================
window.SB = {
  url: "https://YOUR_PROJECT_REF.supabase.co", // ← Settings → API → Project URL
  anon: "YOUR_SUPABASE_ANON_KEY"               // ← Settings → API → anon public key
};
