# AGENTS.md

本仓库的总体说明、架构、命令与坑见 `CLAUDE.md` 与 `README.md` / `FEATURES.md`,请优先参考它们,本文件不重复。

## Cursor Cloud specific instructions

面向后续 Cloud Agent 的常驻、非显然要点(环境已由 update script 预备好,无需再装依赖):

- **纯静态前端,无构建/无 lint/无测试框架**(有意为之,纯 ESM + CDN 依赖)。不要找 `package.json`/`npm run build`——没有。生产构建也不存在,开发即运行。
- **运行开发服务器**:仓库根执行 `python3 -m http.server 8000`,浏览器开 `http://localhost:8000`。`python3` 已是系统自带。
- **运行时强依赖外网**:页面靠 CDN 加载 supabase-js / mermaid / echarts / lunar-javascript,数据/登录走 Supabase(ref `ktalsyrxueabdisrszde`,新加坡)。`config.js` 已内置真实 `url` + 公开 `anon` key(anon key 公开安全,RLS 把门)。本 VM 可正常访问 Supabase。
- **登录是硬门槛**:Supabase 已**关闭自助注册**(`disable_signup: true`),无法在应用内注册账号。要做任何"人物/关系"CRUD(核心功能),必须用管理员在 Supabase 后台预建的账号登录:`editor` 可写、`viewer` 只读。这些账号的邮箱/密码不在仓库内——需作为密钥(Secrets)提供给 Cloud Agent 才能跑通端到端登录后流程。
- **未登录的连通性自检**:不带登录、仅用 anon key `curl` 读 `…/rest/v1/persons` 应返回 `[]`(RLS 把门,证明后端连通且权限正确);在 UI 里用错误账号登录会显示"登录失败:Invalid login credentials"——该报错来自 Supabase,可证明应用→Supabase 全链路连通。
- **service_role 铁律**:绝不进前端/仓库/日志。一次性数据迁移脚本 `scripts/migrate.mjs` 需 `node` + service_role,属一次性运维,不是开发环境的一部分。
- **改版本必做双改**(否则 CF/浏览器缓存旧码):`app.js` 的 `APP_VERSION` 与 `index.html` 底部所有 `?v=x.y.z` 同步改;详见 `CLAUDE.md`。
