# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 这是什么

本仓库 = 「关系图谱」(产品名,品牌固定常量 `APP_NAME`;2026-06-29 由「谱系」改名——用户点明本质是人物关系图谱、非单一族谱)——一个**人物 + 人际关系图谱**的 Web 应用,由家族族谱(《孙氏族谱》东北一脉)演化而来,现已泛化为不限一族一姓的 property graph 工具,但仍能当家谱用。

纯静态前端(**无构建**) + Cloudflare Pages 托管 + Supabase(Postgres / Auth / Storage)。线上 https://sun-zupu-cloud.pages.dev 。

- 本仓库**就是 git 仓库根**(分支 `main`,remote `origin` = 私有 repo `Albertsun6/sun-zupu-cloud`)。worktree 约定按本仓库为基准。
- 仓库**只含代码**,不含任何家谱数据或密钥(数据在 Supabase)。
- 上一级目录 `../`(非 git)放周边物料:`../存档/旧本地版-族谱系统/` 是**已退役**的本地版(Python `http.server` + SQLite,只读历史归档,勿与现行版混淆);`../存档/` 其余是早期整理底稿(.md/.csv/.html,原始证据,不手改);`../migration-data/zupu-export.json` 是一次性迁移用的导出;`../待做功能清单.md` 是 backlog(P0 全完成;P1 部分)。

## 命令

无 `package.json`、无构建、无 lint、无测试框架——这是有意的简单(纯 ESM + CDN 依赖:supabase-js / mermaid / echarts / lunar-javascript)。

- **本地预览**:`python3 -m http.server 8000`,浏览器开 `http://localhost:8000`。需联网(CDN + Supabase)且要登录;`config.js` 已填真实 url/anon。
- **部署**:`git push`(到 `Albertsun6/sun-zupu-cloud`)→ Cloudflare Pages 自动构建(Framework=None,Build command 留空,输出目录=仓库根)。无需 CLI。
- **改版本必做(双改,否则 CF/浏览器缓存旧码)**:同时改 `app.js` 的 `APP_VERSION` 和 `index.html` 底部所有 `?v=x.y.z` 查询串。提交信息惯例见 `git log`(`feat:`/`fix:` + 一句中文 + `vX.Y.Z`)。
- **Supabase 建表/改库**:在 Supabase SQL Editor **按序整段跑** `supabase/{schema,policies,functions,relationships}.sql`(均幂等,可重复跑)。Supabase 项目 ref `ktalsyrxueabdisrszde`(新加坡)。
- **一次性数据迁移**:`SUPABASE_URL=... SUPABASE_SERVICE_ROLE=... node scripts/migrate.mjs <导出JSON> <原谱目录>`(service_role 只在本地命令行用一次,绝不入库)。

### 验证(无自动化测试 → 必须可执行对抗)

本项目结论靠**可执行探针 + 异构评审**硬化(见全局 CLAUDE.md ④⑤),不是"我觉得对了":
- **写一次性 `.mjs` 探针**(放 scratchpad)断言 CONFIRMED/REFUTED,跑真实库;历史上 `verify-*.mjs`/`*-migrate.mjs` 即此模式。
- **直连 DB** 做只读核验:用 Node `pg` 经 **pooler `aws-1-ap-southeast-1.pooler.supabase.com:5432`、user `postgres.<ref>`、SSL `rejectUnauthorized:false`**(本机走代理,`psql` 没装、direct `db.<ref>` 不通)。DB 密码在用户记录,不写库。
- **浏览器实测**:登录后点开弹窗/截图核验(chrome-devtools / evaluate_script);关键 CRUD/迁移/撤销都这样验过。

## 架构(读多文件才看得清的"大图")

### 属性图三层(核心心智模型)
- **L1 人(`persons`)= 纯个人属性的节点**。世代/亲属字段已退出节点(见下)。
- **L2 关系(`relationships`)= 独立边表 = 所有亲属与社会关系**:`from_id`/`to_id`/`type`/`directed`/`start_date`/`end_date`/`note`。类型在字典表 `relationship_types`(预置 父子/母子/夫妻/兄弟/朋友/同事/师生/上下级/合作;加类型只 insert 一行,不改 schema;`is_symmetric` 决定有向/对称,对称边存"规范序" from<to)。
- **L3 派生 = 纯算不落库**:世代 `genOf`、家族 `familiesOf`/`lineageOf`、字辈顺推、家族树、最短关系链、关系圈,全部从 L1+L2 实时推算。

### 单一真源 = 关系图的 `father` 边,不是 `persons.father_id`
`refreshRelCount()`(`app.js`)一次性拉所有边,构出 `state.fatherOf / motherOf / childrenMap / spouseOf`。`genOf`/`renderTree`/`childrenOf`/`ancestorChain`/详情父母/表单父亲下拉(`reconcileFatherEdge`)**全走它**。`persons.father_id` 已退役——保留对照、**不读不写**。

### 退役列(只停用,绝不 DROP):`gen` `kind` `mother` `rank` `relation_type` `father_note` `spouse` `father_id`
仍在 `db.js` 的 `EDITABLE` 与 CSV 列里,`updatePerson` 是**部分 patch** → 零数据丢失、可回滚。其中 `gen` 手填值现降级为**可选的世代锚点覆盖**(空则纯推算);旧 `spouse`/`father_note` 等只在详情页作"原始记载·待整理"线索只读显示,并有专门工具(配偶整理器)逐条转成真实人物 + 边。**新功能不要再写这些列**。

### `db.js` 是关键接缝(REST shim)
`app.js` 用 `api(method, path, body)`(REST 风格路径如 `/api/persons`)约 30 处。`db.js` 的 `api()` 把这些路径**翻译成 supabase-js 调用**,完整复刻了已退役 server.py 的 REST 契约——所以本地版→云端版迁移时 app.js 几乎零改动。**加接口时:在 `db.js` 的 `api()` shim 里加一条路由分支 + 一个真实实现函数**,保持 app.js 不感知后端。`db.js` 还独占:登录/角色(`window.SBAUTH`)、照片公链(`window.photoUrl`)、关系层(`window.REL`)、去重合并(`window.DEDUP`)、客户端导出(`window.EXPORT`:CSV/GEDCOM/分享HTML/JSON)、写操作补 `history`(撤销靠它)。

### 前端结构(`app.js` 单文件 ~1200 行)
`state` 全局对象 + 一组 `render*()`;标签页 `switchView()`(见 `index.html` 的 `.tab`/`.view`)。详情页(`openDetail`)是**关系管理中心**(父/母/配偶/子女/社交全在此增删改);点人物先进只读详情,「编辑」才进表单。表单(`openEdit`/`collectForm`/`saveModal`)字段=`FORM_KEYS`(纯节点属性);父亲选择经 `reconcileFatherEdge` 落成边。重型库(mermaid/echarts)懒加载。

### 鉴权 / 安全模型(动这块务必守住)
- Supabase Auth 邮箱+密码;角色在 JWT `app_metadata.role` = `editor`(可写)/ `viewer`(只读,默认)。RLS:`authenticated` 可读、`editor` 可写(`policies.sql` + `relationships.sql`)。未登录(仅 anon)读不到任何行。
- **anon key 公开安全**(在 `config.js`,RLS 把门)。**service_role 铁律:绝不进前端/仓库/日志**;泄露立刻在 Supabase reset。
- AI 批量识别走 **Cloudflare Pages Function** `functions/api/ai-parse.js`(代理 DeepSeek;key 存 CF 环境变量 `DEEPSEEK_API_KEY`;只放行已登录的 editor JWT)。
- 照片为**公开桶** `photos`(对象名 uuid 不可枚举);文字数据仍受 RLS。原谱影像在桶内 `yuanpu/p1..p4.jpg`(文件夹用拼音)。
- 敏感字段 `contact`/`address`:分享模式 / 分享版 HTML / 脱敏导出里自动隐去,历史 diff 打码。

## 已知坑(改前先看,省得重踩)

- **`import_full` RPC**(`functions.sql`)用 `TRUNCATE` 不是 `DELETE`(裸 DELETE 触发 Supabase `pg_safeupdate`);`jsonb_array_elements` 别名用 `pj` 不能用 `p`(与声明变量撞列引用歧义)。
- **Storage 上传 RLS 古怪**:经 pg 直建的账号 token、甚至 editor token 经 API 上传常被拒;**只有桶级** `with check (bucket_id='photos')` 的策略对 storage-api 生效(按路径的不行)。可行法:pg 临时加一条 public 桶级 policy → 匿名 supabase-js `upload(upsert)` → `finally` drop policy(用完即撤);或走控制台 / service_role。
- **经 pg 直建 Supabase Auth 用户**:insert `auth.users`(`crypt(pw,gen_salt('bf'))`、`email_confirmed_at=now()`、`raw_app_meta_data` 含 role)+ `auth.identities`(provider='email')。pgcrypto 可用。
- **大陆访问**:CF Pages + Supabase 是境外基建,常能用但不保证稳、无 ICP 备案 → 建议定期"备份 JSON"留底。

## 数据维护哲学(用户核心需求,落到代码约束)

族谱是会持续考证修订的传家活档案。**先祖与后代双向可增改**(往上补先祖、往下加后代),靠稳定 ID + 关系边建模,**绝不强行编干净世系**。矛盾标 `待考`/`存疑`,不脑补;改动留痕(`history` + 一键撤销),不抹原始线索。详见 `../待做功能清单.md` 与系统内"待核实""数据体检"标签。
