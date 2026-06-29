<!-- 本文件由 /zupu-spec-sync 维护:每次功能/数据契约变更后自动更新对应小节 + 下面的"最近更新/版本"。
     手工编辑也可,但请保持小节结构稳定(skill 按二级/三级标题定位)。 -->

# 关系图谱（zupu-cloud）· 功能与需求规格

| | |
|---|---|
| **产品名** | 关系图谱（品牌固定常量 `APP_NAME`；本质=人物关系图谱，由《孙氏族谱》东北一脉演化而来，已泛化为不限一族一姓的属性图工具，仍能当家谱用） |
| **当前版本** | v0.31.0 |
| **最近更新** | 2026-06-30 |
| **技术栈** | 纯静态 vanilla JS（无构建、纯 ESM + CDN）+ Cloudflare Pages + Supabase(Postgres/Auth/Storage) + CF Pages Functions(代理 AI) |
| **线上** | https://sun-zupu-cloud.pages.dev ｜ Supabase ref `ktalsyrxueabdisrszde`(新加坡) |
| **维护说明** | 本规格描述"系统能做什么"(功能/数据契约/安全模型)；操作手册见各项目 USAGE 约定；backlog 见 `../待做功能清单.md`。 |

---

## 1. 核心心智模型:属性图三层

- **L1 人（`persons`）= 纯个人属性的节点**。世代/亲属字段已退出节点。
- **L2 关系（`relationships` + `relationship_types`）= 独立边表 = 所有亲属与社会关系**：`from_id/to_id/type/directed/start_date/end_date/note`。
- **L3 派生 = 纯算不落库**：世代 `genOf`、家族 `familiesOf/lineageOf`、字辈顺推、家族树、最短关系链、关系圈。

**单一真源 = 关系图的 `father` 边，不是 `persons.father_id`**（后者已退役）。`refreshRelCount()` 一次性拉全部边，构出 `state.fatherOf/motherOf/childrenMap/spouseOf`，所有派生与 UI 走它。

**数据维护哲学（用户核心需求，落到代码约束）**：族谱是会持续考证修订的传家活档案；先祖与后代双向可增改；靠稳定 ID + 关系边建模，绝不强行编干净世系；矛盾标 `待考`/`存疑` 不脑补；改动留痕（`history` + 一键撤销），不抹原始线索。

---

## 2. 功能目录

### 2.0 全局 / 入口骨架
| 功能 | 说明 | editor-only |
|---|---|---|
| 登录门 | 邮箱+密码；未登录看不到任何数据；登录态变化自动回弹登录 | — |
| 角色判定 + AuthBar | 显示登录邮箱 + 可编辑/只读；`body.classList.toggle("viewer")` 隐藏所有 `.edit-only` | — |
| 标签切换(SPA) | 10 个标签，`location.hash` 同步、刷新可恢复、惰性渲染 | — |
| 页头统计 | 共 N 人 · 在世 N · 待核实 N 项；显示版本号 | — |
| 全量加载 | `loadAll` 并行拉 meta/persons/narratives/verify/transcription + relTypes，再 `refreshRelCount`（全量读已分页防 1000 行截断，见 §3.6） | — |
| 改密码 | 登录态改自己密码(≥6 位、两次一致) | 任意登录者 |
| 登出 / Esc 键栈 / 照片画廊 | 登出 reload；Esc 按层级关弹窗；画廊 ◀▶/方向键/滑动 | — |

### 2.1 名册（默认页）— 列表 / 卡片 / 孙氏三模式
- **共用筛选条**：搜索（姓名/字号/备注/事迹/居地/字辈/职业/出生地/生卒，IME 不打断、回车选词不误提交）；多条"字段筛选"(字段·包含/等于·值，AND)；命中计数；清除；最近搜索 chips(localStorage)。
- **列表**：22 可选列(默认 10，存 localStorage)、点表头排序、点行→详情、农历列附属相、`gen/rel_count/lineage` 派生列实时算。
- **卡片**：平铺(按世代→排序)、缩略图/首字占位、在世标/状态徽/关系数、分享模式脱敏。
- **孙氏**：`state.lineage="孙氏"` 过滤。
- **🔗 批量加关系**(editor)：把当前筛选这组人批量加为某中心人物的某关系(默认同事)，排除本人/已存在边，逐条可撤销。
- 关键函数：`renderPeople/renderRoster/renderCards/peopleFiltered/cellVal/personCard/openBulkRel`。

### 2.2 家族树（`renderTree`）
- 由 father 边自动生成 Mermaid `graph TD`；节点显姓名+生卒；绿色高亮 `DIRECT_LINE` 直系；按 `state.lineage` 可限族；离线/失败回退文字。Mermaid 懒加载。

### 2.3 关系图（`renderGraph`，ECharts 力导向，懒加载）
- 节点=人(绿在世/灰已故/黄未知，大小随度数)，边=关系(按类型上色、有向箭头、连线显称谓)；拖拽/缩放/悬停高亮；点节点→详情。
- **🎯 局部圈**：选中心(可搜)+跳数 1/2/3，BFS N 跳子图。
- **🔗 最短关系链**：选 A↔B，无向 BFS 最短路，高亮路径+文字列出。
- **图例点选筛选**：点关系类型显隐(影响图/局部圈/关系链)。
- 关键函数：`renderGraph/bfsPath/fillGraphControls`，`state.graphCenter/graphHops/pathA/pathB/graphTypesOff`。

### 2.4 家史（`renderHistory`）
- 每条叙事一面板，可改标题+正文。编辑/保存 editor-only。数据 `narratives` + `PUT /api/narratives/{key}`。

### 2.5 家族管理（`renderFamilies`，L3 配置）
- 谱头信息(族谱名/支系地望/调查编纂/整理者→`PUT /api/meta`)；各家族卡片(按父系姓氏**自动识别**)：显示名/字辈谱(派语)/堂号/备注。保存 editor-only。`meta.families[fam]={label,charGen,hall,note}`。

### 2.6 待核实（`renderVerify`）
- 按 category 分组；改状态(待考/存疑/待补/已确认)、结论、日期、删除、新增。增删改 editor-only。`verify[]` + `POST/PUT/DELETE /api/verify`。

### 2.7 数据体检（`runHealth`，只读诊断 + 一键修复）
12 类诊断，点条目→详情；含 editor 一键修复：
| 检测 | 修复(editor) |
|---|---|
| ① 父子成环 / ② 父指向不存在或已删 / ③ 字辈不顺 / ④ 年代矛盾 | — |
| ⑤ 残留手填世代≠推算 | 采用推算(清手填 gen) |
| ⑥ 疑缺父系连接(世代断点) | — |
| ⑦ 重名 | 合并…(去重弹窗) |
| ⑧ 配偶待整理(`persons.spouse` 旧文本) | 整理为配偶(转真实人物+边) |
| ⑨ 可回填另一方父母边 | 一键回填预览 |
| ⑩ 在世状态空白 | 统一设为是(批量、可撤销) |
| 🤖 出生日期规范化 | 规范出生日期…(日期规范化器) |

### 2.8 原谱影像与原文 / 回收站 / 操作历史
- **原谱影像**(`renderSource`)：4 页原谱(`ORIG_IMG p1..p4` Storage `yuanpu/`)+ 折叠誊录，只读证据。
- **回收站**(`renderTrash`)：列软删人物，恢复/彻底删除(editor)。`GET /api/trash`、`POST .../restore`、`DELETE .../purge`。
- **操作历史**(`renderLog` + `renderBackup`)：时间/操作/说明/撤销；update 类可"查看改动"diff(contact/address 打码)；**一键撤销**(限 `UNDOABLE`)。备份：editor 可"上传 JSON 恢复"(覆盖全部、二次确认、不可逆)。`GET /api/history`、`POST /api/history/{id}/undo`、`POST /api/import/json`。

### 2.9 工具 / 向导
| 工具 | 做什么 | 后端 | editor |
|---|---|---|---|
| **AI 批量添加** | 粘文字/选文件(txt/csv/tsv/md/json ≤3MB)→DeepSeek 识别成草稿→编辑/勾跳过→全部新建或匹配现有；识别时双 AI(DeepSeek+GLM)拆日期、标冲突/闰月歧义 | `/api/ai-parse` | ✅ |
| **表格导入向导** | 3 步:上传 CSV/TSV/XLSX(判分隔符/繁→简表头/Excel 序列号日期/BOM)→列映射(关键词猜 + 🤖AI 推荐)→匹配预览(姓名+生年)→逐条 合并/覆盖/跳过/新建/忽略 + 一键全部 | `/api/map-columns`、`/api/normalize-dates(-glm)` | ✅ |
| **配偶整理器** | 把 `persons.spouse` 旧文本转真实人物 + spouse 边(同名查重"用已有/仍新建") | — | ✅ |
| **合并去重** | 同名检测 + 人工确认合并(迁子女/关系/婚姻/照片，survivor 补空，dup 进回收站，留痕) | `window.DEDUP` | ✅ |
| **万年历 / 时辰选择器** | 公农历双向 + 属相 + 十二时辰(`calendar.js` / `window.LUNARCONV`) | — | — |
| **导出** | CSV / GEDCOM 5.5.1 / 分享版 HTML / 备份 JSON（客户端生成，见 §3.7） | `window.EXPORT` | — |

### 2.10 人物详情 / 编辑 / 关系管理（主交互中心）
- **只读详情**(`openDetail`)=关系管理中心：头像画廊、直系链(可点)、信息网格、关系网列表(按 亲属/社交/工作 分类，多配偶①②③按婚年/名分排)；editor 可 +加关系 / 改备注 / ✕删 / 🎯关系圈 / +加亲属 / 编辑。点人物先进只读详情，「编辑」才进表单。
- **编辑/新建表单**(`openEdit/collectForm/saveModal`)：5 分区(基本/世系·关系/生卒·籍葬/生平/联系🔒)，字段=`FORM_KEYS`(纯节点属性)；姓名必填+同名查重；父亲下拉经 `reconcileFatherEdge` 落成边(失败显式报错，不静默丢父子关系)；新建可一次连初始关系。全程 editor-only。
- **相册**(`renderMedia/uploadMedia`)：上传(前端压缩≤1600px JPEG)、设主图、改说明、删除。
- **智能关系联动**：加孩子→fail-closed 推定另一方父母(唯一确定才自动，否则人审)；加配偶→建议补录其已有子女(默认不勾)。

---

## 3. 数据契约

### 3.1 表（10 张业务表）
`persons`(节点，id=TEXT `S###`)、`relationships`(边)、`relationship_types`(类型字典，预置 9 类)、`marriages`(自由文本婚姻，与 spouse 边并存)、`media`(相册)、`narratives`(家史)、`verify`(待核实)、`transcription`(p1-4 誊录)、`meta`(单行 jsonb 谱头)、`history`(留痕)。字段细节见 `supabase/schema.sql` + `relationships.sql`。

### 3.2 退役列（只停用，绝不 DROP）
`gen`(降级为可选世代锚点) `kind` `mother` `rank` `relation_type` `father_note` `spouse`(详情页只读"原始记载") `father_id`。仍在 `EDITABLE`/CSV 列，`updatePerson` 是部分 patch → 零丢失、可回滚。**新功能不写这些列。**

### 3.3 `db.js` REST shim 路由（`api(method,path,body)`）
GET `/api/{meta,persons,trash,narratives,verify,transcription,history,backups,auth}`、`/api/persons/{id}/{marriages,media}`；POST `/api/persons`、`/api/verify`、`/api/import/json`(→`import_full` RPC)、`/api/persons/{id}/{marriages,media,restore}`、`/api/history/{id}/undo`；PUT `/api/{marriages,media,verify}/{id}`、`/api/meta`、`/api/narratives/{key}`、`/api/persons/{id}`；DELETE `/api/persons/{id}/purge`、`/api/{marriages,media,verify}/{id}`、`/api/persons/{id}`(软删)。
**关系 CRUD 不走 shim，走 `window.REL`。**

### 3.4 `window.*` 导出面
`sb`(client)、`SBAUTH`(登录/角色/改密)、`photoUrl`(公开桶直链，留私有桶切换点)、`api`(REST shim)、`REL`(types/all/of/add/update/del)、`DEDUP`(sameName/merge)、`EXPORT`(json/csv/gedcom/shareHtml)、`allocIds(n)`(批量导入预分配 ID)、`LUNARCONV`(万年历)。

### 3.5 RLS（按 JWT `app_metadata.role`）
10 张业务表：`authenticated` 可读、`editor` 可写，anon 全空(故 anon key 公开安全)。Storage `photos` 桶 public 读、editor 写。
> ⚠ **隐私待办(用户暂缓)**：`history` 表 authenticated 全可读，而 before/after 明文存 contact/address → viewer 可经 history API 读到 PII。照片为公开桶。两项隐私策略待用户决定后处理。

### 3.6 全量读取分页（防 1000 行静默截断）
`selectAll(table,build)` 循环 `range` 直到取完(PostgREST 单请求默认上限 1000 行会静默截断)。`listPersons/listAllPersons/listRelationships` 及导出的 marriages/media/relationships 全走它。<1000 行只跑一次，零行为变化。

### 3.7 导出格式
| 导出 | 数据源 | contact/address | 在世者 | deleted 行 | 父子结构 |
|---|---|---|---|---|---|
| JSON backup | `fullData()`=全量(active+trash) | 保留 | 全字段 | 含 | — |
| JSON share | 同上 redact | 清空 | 全字段 | 含 | — |
| CSV | active | 保留/脱敏 | 含 | 否 | gen 列=`genOf`推算 |
| GEDCOM 5.5.1 | active | 不脱敏 | 含 | 否 | **读 father 边**(v0.31.0 修，原误读退役 father_id 丢边) |
| 分享 HTML | active | 渲染层不显 | 仅姓名 | 否 | **读 father 边**(v0.31.0 修) |

### 3.8 `import_full(payload jsonb)` RPC
原子"导入/恢复"：`security definer` + 函数内断言 editor + `TRUNCATE ... restart identity cascade`(非裸 DELETE，避 `pg_safeupdate`)→ 按序重灌。`jsonb_array_elements` 别名用 `pj`(避与变量 `p` 歧义)。
> ⚠ **已知契约缺口(Wave 1)**：persons INSERT 漏 `company` 列；`reinsertPerson`(撤销 purge)也漏 company → 导入恢复/purge 撤销会丢 company 值。

---

## 4. 后端 / 部署 / 安全

### 4.1 CF Pages Functions（代理 AI，仅放行 editor JWT）
| Function | 用途 | 外部 AI / env |
|---|---|---|
| `/api/ai-parse` | 粘贴文字→识别成人物 | DeepSeek `deepseek-chat`，`DEEPSEEK_API_KEY` |
| `/api/normalize-dates` | 日期规范化(规则兜底) | DeepSeek，同上 |
| `/api/normalize-dates-glm` | 日期双验证 | 智谱 GLM `glm-4.6`，`GLM_API_KEY`/`GLM_MODEL`/`GLM_BASE` |
| `/api/map-columns` | 表格导入 AI 推荐列映射 | DeepSeek |

### 4.2 部署 / 版本
- `git push` → CF Pages 自动构建(Framework=None，输出=仓库根)。
- **改版本必做(双改)**：`app.js` 的 `APP_VERSION` + `index.html` 所有 `?v=x.y.z`(否则 CF/浏览器缓存旧码)。
- Supabase 建表/改库：按序整段跑 `supabase/{schema,policies,functions,relationships}.sql`(均幂等)。

### 4.3 安全模型
- anon key 公开安全(RLS 把门)；**service_role 铁律：绝不进前端/仓库/日志**。
- AI key 仅存 CF 环境变量，错误响应不回传第三方响应体(防 key 泄露)。
- 敏感字段 contact/address：分享模式 / 分享版 HTML / 脱敏导出里隐去，history diff 打码（注意 §3.5 的 history 库内未脱敏待办）。
- 大陆访问:CF+Supabase 境外基建，常能用但不保证稳、无 ICP → 建议定期备份 JSON 留底。

---

## 5. 已知开放项 / 待办

- 🔒 **隐私(用户暂缓)**：history 库内 PII 对 viewer 可读；照片公开桶 — 待用户定策略。
- 🧩 **company 列未贯通**：import_full RPC / reinsertPerson 漏迁(Wave 1)。
- 🚀 **导入根治**：`import_persons` 批量 RPC(服务端算号+逐行 history+atomic) 替代现"预分配号段+并发池"止血(Wave 1)。
- 📈 **上万人扩展**(Wave 2，看规模是否成真)：ECharts 全图护栏、名册虚拟滚动、服务端搜索/分页、万级图换 WebGL。
- 🔤 GEDCOM 姓氏硬编码"孙"，泛化后待处理；`mergePersons` 仍迁 legacy `father_id`(应只动边)。
- 详细 backlog 见 `../待做功能清单.md`；考证类待办见系统内"待核实"/"数据体检"。

---

## 变更记录（由 /zupu-spec-sync 追加）

- **2026-06-30 v0.31.0**：修导出/备份取数 bug(`fullData` 误取回收站→改 `listAllPersons` 全量)；GEDCOM/分享 HTML 改读 father 边(找回 15 条父子链)；删关系边存 before 并纳入可撤销(改父亲可撤)；reconcileFatherEdge 不再静默吞错；导入止血(预分配号段 `allocIds` + 并发池);全量读取加 `selectAll` 分页防 1000 行截断。首版 FEATURES.md。
