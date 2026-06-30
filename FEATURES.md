<!-- 本文件由 /zupu-spec-sync 维护:每次功能/数据契约变更后自动更新对应小节 + 下面的"最近更新/版本"。
     手工编辑也可,但请保持小节结构稳定(skill 按二级/三级标题定位)。 -->

# 关系图谱（zupu-cloud）· 功能与需求规格

| | |
|---|---|
| **产品名** | 关系图谱（品牌固定常量 `APP_NAME`；本质=人物关系图谱，由《孙氏族谱》东北一脉演化而来，已泛化为不限一族一姓的属性图工具，仍能当家谱用） |
| **当前版本** | v0.41.0 |
| **最近更新** | 2026-06-30 |
| **技术栈** | 纯静态 vanilla JS（无构建、纯 ESM + CDN）+ Cloudflare Pages + Supabase(Postgres/Auth/Storage) + CF Pages Functions(代理 AI / 录音转写 / 用户管理) |
| **前端文件** | `app.js`(核心:state/helpers/render*/CRUD/详情/编辑/boot+权限门禁,~1300行)、`tools-dates-import-ai.js`(日期规范化+表格导入+AI批量)、`tools-spouse.js`(配偶 blob 转边)、`tree-classic.js`(传统谱图挂图渲染)、`minutes.js`(纪要:录音/转写/AI整理,v0.41)、`users.js`(用户管理,admin,v0.41)、`db.js`(数据层)、`calendar.js`(万年历)。**模块加载顺序**:db→app→calendar→tools-*→tree-classic→minutes→users(均在 app 之后,app 末尾把核心符号挂 window 供其裸引用)。改版本必须同步改 `index.html` 全部 `?v=`。 |
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
| 登录门 | 邮箱+密码；未登录看不到任何数据；登录态变化自动回弹登录。**公开注册已关闭**(账号由 admin 在「用户管理」建) | — |
| 角色判定 + AuthBar | 显示登录邮箱 + 管理员/可编辑/只读；`body.classList.toggle("viewer")` 隐藏所有 `.edit-only`。角色 `app_metadata.role`∈{admin,editor,viewer}(admin 是 editor 超集),功能位 `app_metadata.perms`(数组,目前用 `minutes`)。boot 算 `state.isAdmin/canEdit/canMinutes` | — |
| 标签切换(SPA) | 12 个标签，`location.hash` 同步、刷新可恢复、惰性渲染。**受限标签按权限显隐**(`renderAuthBar` 隐藏 `.tab[data-perm]`:纪要需 canMinutes、用户管理需 isAdmin;`switchView` 守卫防直链绕过) | — |
| 页头统计 | 共 N 人 · 在世 N · 待核实 N 项；显示版本号 | — |
| 全量加载 | `loadAll` 并行拉 meta/persons/narratives/verify/transcription + relTypes，再 `refreshRelCount`（全量读已分页防 1000 行截断，见 §3.6） | — |
| 改密码 | 登录态改自己密码(≥6 位、两次一致) | 任意登录者 |
| 登出 / Esc 键栈 / 照片画廊 | 登出 reload；Esc 按层级关弹窗；画廊 ◀▶/方向键/滑动 | — |

### 2.1 名册（默认页）— 列表 / 卡片 / 孙氏三模式
- **共用筛选条**：搜索（姓名/字号/备注/事迹/居地/字辈/职业/出生地/生卒，IME 不打断、回车选词不误提交）；多条"字段筛选"(字段·包含/等于·值，AND)；命中计数；清除；最近搜索 chips(localStorage)。
- **列表**：22 可选列(默认 10，存 localStorage)、点表头排序、点行→详情、农历列附属相、`gen/rel_count/lineage` 派生列实时算。
- **卡片**：平铺(按世代→排序，**不分组**——混合人群)、缩略图/首字占位、在世标/状态徽/关系数、分享模式脱敏。
- **孙氏**：`state.lineage="孙氏"` 过滤；**同族故按世代分组**——每组前加「第N世 · X字辈 · N人」小标题(`.gen-head`，主字辈取该世众数)；卡片本身样式与「卡片」页一致。`renderCards` 按 `state.lineage` 是否设定区分分组/平铺。
- **🔗 批量加关系**(editor)：把当前筛选这组人批量加为某中心人物的某关系(默认同事)，排除本人/已存在边，逐条可撤销。
- 关键函数：`renderPeople/renderRoster/renderCards/peopleFiltered/cellVal/personCard/openBulkRel`。

### 2.2 家族树（`renderTreeView` 双模式：传统谱图 / 自动树图）
- **模式开关**（`#treeModeBar`，记忆于 `localStorage.tree_mode`，**默认传统谱图**）：
  - **📜 传统谱图**（`tree-classic.js`，v0.34.0 改为**竖排紧凑版**）：仿手绘族谱——**名字竖排**(writing-mode vertical-rl)、**按世代分层成行**、一框=一位父系成员、**配偶在本人下方同框**(嫁入者不单独成框、**无"配"字**)、**男蓝女粉**按性别上色(本人+配偶都上色)、**已故=该人名字外加"牌位"框**(细框+浅灰底 `.ct-gone`;**本人与配偶各自判定**,夫妻一存一殁只标殁者,**不动整框颜色**;缩到一页也清晰——面积填色比细线/竖线耐缩)、**直角折线**连父子/兄弟、左侧**世代栏**、**绿边框**=`DIRECT_LINE` 直系。**同辈排序**=世代→**性别(男前女后)**→**出生年(长幼)**→手排号→ID(v0.39.0;原 sort_order 优先致新人 sort_order=0 插队,改为性别+长幼)。**卡片不显字辈/生卒等冗余信息**(只名字+性别色+已故牌位框)。**名字悬浮提示**(`#ctTip`):移到任一名字上显示该人主要信息(姓名/性别/字辈/世代/生卒/在世/籍居/配偶/职业事迹);点某名字开该人详情(配偶名亦然)。**默认"适应整页"**,另有 **🔄 刷新**、**⛶ 全屏**(浏览器全屏 API 作用于 `#treeBox`,进出全屏按新视口重算适应整页)、＋/−/适应整页/100% + **🖨 打印/存 PDF**(横向)。家族下拉默认**孙氏**。**无父子连接的本族成员**:像 `孙景发`(连通断片)那样,作为**普通浮框接在各自 `genOf` 世代行的最右端**(随其 `genOf` 落在对应世代行、与主树该世代同行对齐,留一点空隙,**无上连线**;外观同连通节点、**无独立面板/标签/虚线**),补上父亲后自动连线归位主树。(v0.39 曾试"独立面板"被否)
  - **🌳 自动树图**（`renderTree`）：原 Mermaid `graph TD`，懒加载，离线/失败回退文字。
- 布局算法（纯前端,L3 派生不落库）：节点=父系同姓血脉且与本族有父/母子连接者;纵=`genOf` 世代行,但强制「子行>父行」(防 genOf 偶发不一致致父子同行重叠);横=叶子计数 tidy(叶子顺序排、内部节点居中于子女)——保证同代框水平间距 ≥1 列(无重叠,已用真实库探针证实)。**框高 DOM 实测**(竖排内容高随名字/配偶字数),逐代行高取本代最高框。配偶取 `state.spouseOf` 中**非节点且未软删**者。**适应整页** = `min(可视宽/图宽, 可视高/图高)`,canvas `transform:scale` + wrap 收缩到缩放后尺寸(保证滚动条按缩放后算)。
- 关键文件/函数：`tree-classic.js`(`renderClassicTree/buildClassicForest`)、`app.js`(`renderTreeView` 调度 + 模式开关)、`renderTree`(Mermaid)。`DIRECT_LINE`、`genOf/surnameOfSelf/familiesOf/charGenFor/lineagesList` 经 window 复用。

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
- **编辑/新建表单**(`openEdit/collectForm/saveModal`)：5 分区(基本/世系·关系/生卒·籍葬/生平/联系🔒)，字段=`FORM_KEYS`(纯节点属性)；姓名必填+同名查重；父亲下拉经 `reconcileFatherEdge` 落成边(失败显式报错，不静默丢父子关系)；新建可一次连初始关系。**新建人物默认 `alive=是`(在世)**——在 `db.js createPerson` 兜底:未显式给 `alive` 时填「是」,**覆盖所有创建入口**(表单/详情快速加关系新建/AI批量/配偶整理/导入)。全程 editor-only。
- **相册**(`renderMedia/uploadMedia`)：上传(前端压缩≤1600px JPEG)、设主图、改说明、删除。
- **智能关系联动**：加孩子→fail-closed 推定另一方父母(唯一确定才自动，否则人审)；加配偶→建议补录其已有子女(默认不勾)。

### 2.11 纪要（`minutes.js`，v0.41，权限门:`canMinutes`)— NotebookLM 式录音笔记
- **访问控制**：标签仅当 `role=admin 或 perms 含 minutes` 时展示;无权者连菜单都看不到(RLS + CF 函数各自再校验,非仅前端隐藏)。
- **列表/新建**:列表显 标题/会议时间(`meeting_at` 备注)/状态/时长/创建人;新建填 标题+会议时间+备注。
- **录音**:① 浏览器麦克风 `MediaRecorder`(单声道、计时、停止;**格式优先 mp4/AAC,浏览器只支持 webm 时回退 Web Audio 采 PCM 编码 WAV-16k 单声道**——保证阿里 Fun-ASR 能识别;接近 2h 自动停);② 上传已有音频(mp3/m4a/wav/aac…)。录音存**私有桶 `recordings`**,经 CF 签名上传 URL 直传,**永久保留**。
- **转写**(阿里 Fun-ASR 异步):点「开始转写」→ 提交 → 前端轮询(关页面/刷新可据持久状态续轮)→ 完成显示**带时间戳 + 说话人分离**的分段(点段跳播放音频)。
- **AI 整理**(DeepSeek):**摘要**(结构化,可标"谁第几分钟说")/ **任务**(JSON 清单)/ **脑图**(mermaid `mindmap`,复用 mermaid 懒加载渲染)。
- 关键文件/函数:`minutes.js`(`renderMinutes/openMinuteDetail/startRecording/makeWavRecorder/uploadAndAttach/doTranscribe/startPolling/genAI/drawMindmap`)、`window.MINUTES`(db.js)、`functions/api/minutes.js`(见 §4.1)。

### 2.12 用户管理（`users.js`，v0.41，权限门:`isAdmin`)— 完整自助
- **访问控制**:标签仅 admin 可见。
- 用户表(邮箱/角色/纪要权限/状态/最近登录)+ 操作:**新建用户**(邮箱+初始密码+角色+纪要开关)、**改角色**(admin/editor/viewer 下拉)、**纪要权限开关**、**重置密码**、**停用/启用**、**删除**。
- 前端只发语义意图(setRole/setPerms…),实际经 `functions/api/admin-users.js`(service_role 调 GoTrue Admin API)执行;含**白名单/防自我锁死/防删空最后一名 admin**(见 §4.1)。改完提示对方需重新登录生效。
- 关键文件/函数:`users.js`(`renderUsers/userTable/openUserCreate/openResetPw`)、`window.ADMIN`(db.js)。

---

## 3. 数据契约

### 3.1 表（11 张业务表）
`persons`(节点，id=TEXT `S###`)、`relationships`(边)、`relationship_types`(类型字典，预置 9 类)、`marriages`(自由文本婚姻，与 spouse 边并存)、`media`(相册)、`narratives`(家史)、`verify`(待核实)、`transcription`(p1-4 誊录)、`meta`(单行 jsonb 谱头)、`history`(留痕)、**`minutes`**(纪要,v0.41:`title/meeting_at/note/status/audio_path/audio_mime/audio_size/duration_sec/asr_task_id/asr_error/transcript/transcript_json(分段jsonb)/summary/tasks(jsonb)/mindmap/created_by/created_by_email`;触发器强制作者+守卫受控列,见 §3.5)。字段细节见 `supabase/schema.sql` + `relationships.sql` + `minutes.sql`。

### 3.2 退役列（只停用，绝不 DROP）
`gen`(降级为可选世代锚点) `kind` `mother` `rank` `relation_type` `father_note` `spouse`(详情页只读"原始记载") `father_id`。仍在 `EDITABLE`/CSV 列，`updatePerson` 是部分 patch → 零丢失、可回滚。**新功能不写这些列。**

### 3.3 `db.js` REST shim 路由（`api(method,path,body)`）
GET `/api/{meta,persons,trash,narratives,verify,transcription,history,backups,auth}`、`/api/persons/{id}/{marriages,media}`；POST `/api/persons`、`/api/verify`、`/api/import/json`(→`import_full` RPC)、`/api/persons/{id}/{marriages,media,restore}`、`/api/history/{id}/undo`；PUT `/api/{marriages,media,verify}/{id}`、`/api/meta`、`/api/narratives/{key}`、`/api/persons/{id}`；DELETE `/api/persons/{id}/purge`、`/api/{marriages,media,verify}/{id}`、`/api/persons/{id}`(软删)。
**关系 CRUD 不走 shim，走 `window.REL`。**

### 3.4 `window.*` 导出面
`sb`(client)、`SBAUTH`(登录/角色/改密)、`photoUrl`(公开桶直链，留私有桶切换点)、`api`(REST shim)、`REL`(types/all/of/add/update/del)、`DEDUP`(sameName/merge)、`EXPORT`(json/csv/gedcom/shareHtml)、`allocIds(n)`(批量导入预分配 ID)、`LUNARCONV`(万年历)、**`MINUTES`**(纪要:list/get/create/update/del + uploadAudio/playUrl/transcribe/pollStatus/ai,元数据走 PostgREST、录音/转写/AI 走 CF 函数)、**`ADMIN`**(用户管理:listUsers/createUser/setRole/setPerms/resetPassword/disable/enable/del,均带 JWT 调 `/api/admin-users`)。

### 3.5 RLS（按 JWT `app_metadata`）
- **SQL 助手**(`policies.sql`,`stable`,读 JWT):`can_write()`=`role∈{editor,admin}`;`can_minutes()`=`role='admin' 或 coalesce(app_metadata.perms,'[]'::jsonb) ? 'minutes'`(`#>` 取 jsonb、coalesce 保 null-safe、含 admin)。
- 原 10 张业务表：`authenticated` 可读、**`can_write()`**(editor|admin)可写,anon 全空(故 anon key 公开安全)。Storage `photos` 桶 public 读、`can_write()` 写。
- **纪要(v0.41)**:`minutes` 表 select/insert/update/delete 全门 **`can_minutes()`**;insert `with check (created_by=auth.uid())` + `minutes_set_author` 触发器(`security definer`)服务端强制 `created_by/created_by_email`(防伪造)。**受控列守卫 `minutes_guard_cols`(BEFORE INSERT OR UPDATE)**:`current_user<>'service_role'` 时把 `status/asr_*/transcript*/summary/tasks/mindmap/audio_*/duration_sec/created_*/created_at` 强制为安全默认(INSERT)或原值(UPDATE)→ **普通客户端经 PostgREST 只能改 `title/meeting_at/note`**,状态机/转写/音频只许 CF 函数 service_role 写(防双计费/改 audio_path/伪造)。
- **`recordings` 私有桶**(`public:false`):**仅 `select` 给 `can_minutes()`**,**不给客户端 insert/update/delete**(防经 storage-api 覆盖/删他人录音);上传走 CF service_role 签发的签名上传 URL、回放走 CF service_role 签名下载 URL。
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

### 4.1 CF Pages Functions（均先校验调用者 JWT 再动作)
| Function | 用途 | 鉴权 | 外部服务 / env |
|---|---|---|---|
| `/api/ai-parse` | 粘贴文字→识别成人物 | editor\|admin | DeepSeek `deepseek-chat`，`DEEPSEEK_API_KEY` |
| `/api/normalize-dates` | 日期规范化(规则兜底) | editor\|admin | DeepSeek，同上 |
| `/api/normalize-dates-glm` | 日期双验证 | editor\|admin | 智谱 GLM `glm-4.6`，`GLM_API_KEY`/`GLM_MODEL`/`GLM_BASE` |
| `/api/map-columns` | 表格导入 AI 推荐列映射 | editor\|admin | DeepSeek |
| **`/api/admin-users`**(v0.41) | 用户管理(list/create/setRole/setPerms/resetPassword/disable/enable/delete) | **admin** | **`SUPABASE_SERVICE_ROLE`** 调 GoTrue Admin API。`requireAdmin` 在任何 service_role 调用前;role/perms 白名单;**read-modify-write 整体 app_metadata**(不丢字段);防自我降级/禁用/删除、防删空最后一名启用 admin;错误不回传 service_role/上游 body |
| **`/api/minutes`**(v0.41) | 纪要后端(action:upload-url/play-url/attach/transcribe/transcribe-status/ai) | **canMinutes**(admin 或 perms 含 minutes) | **`SUPABASE_SERVICE_ROLE`**(签发 recordings 签名 URL + 写受控列)、**`DASHSCOPE_API_KEY`+`DASHSCOPE_BASE`**(阿里 Fun-ASR 异步转写:提交 `X-DashScope-Async`、轮询 tasks、6h 签名URL、`diarization_enabled`)、`DEEPSEEK_API_KEY`(摘要/任务/脑图)。`attach` 校验路径 `validAttachPath`(本纪要文件夹、无穿越)+ 状态锁(仅 draft/uploading/uploaded/failed)防双计费 |

### 4.2 部署 / 版本
- `git push` → CF Pages 自动构建(Framework=None，输出=仓库根)。
- **改版本必做(双改)**：`app.js` 的 `APP_VERSION` + `index.html` 所有 `?v=x.y.z`(否则 CF/浏览器缓存旧码)。
- Supabase 建表/改库：按序整段跑 `supabase/{schema,policies,functions,relationships,minutes}.sql`(均幂等;`minutes.sql` 用到 `policies.sql` 的 `can_minutes()`,故在其后)。
- **CF Pages 环境变量(v0.41 新增)**:`SUPABASE_SERVICE_ROLE`(service_role key,admin-users + minutes 必需)、`DASHSCOPE_API_KEY`(阿里百炼)、`DASHSCOPE_BASE`(按 key 归属区:境内 `https://dashscope.aliyuncs.com` / 国际 `https://dashscope-intl.aliyuncs.com`)。
- **Supabase Auth 关闭公开注册**(否则有人自助注册绕过 admin 建号)。**引导首个 admin**:跑 `supabase/bootstrap-admin.sql`(改 email),之后网页「用户管理」自助。改 `app_metadata` 后该用户需重新登录生效。

### 4.3 安全模型
- anon key 公开安全(RLS 把门)；**service_role 铁律：绝不进前端/仓库/日志**。v0.41 起 service_role 仅用于两个**已先做 JWT 权限校验**的 CF 函数(`/api/admin-users` requireAdmin、`/api/minutes` requireMinutes),用于建/改用户与写纪要受控列/签发录音签名 URL;前端永不持有。
- **三级角色 + 功能位**:`role`∈{admin,editor,viewer}(admin⊇editor);`perms`(目前 `minutes`)与角色正交。受限标签前端隐藏只是 UX,**真门禁在 RLS + CF 函数**(详链:§3.5 / §4.1)。
- AI key 仅存 CF 环境变量，错误响应不回传第三方响应体(防 key 泄露)。
- 敏感字段 contact/address：分享模式 / 分享版 HTML / 脱敏导出里隐去，history diff 打码（注意 §3.5 的 history 库内未脱敏待办）。
- 大陆访问:CF+Supabase 境外基建，常能用但不保证稳、无 ICP → 建议定期备份 JSON 留底。

---

## 5. 已知开放项 / 待办

- 🔒 **隐私(用户暂缓)**：history 库内 PII 对 viewer 可读；照片公开桶 — 待用户定策略。
- 👥 **用户管理并发 TOCTOU(接受的低风险,v0.41)**:防"删空最后一名 admin" + `setRole/setPerms` 用请求开始时的快照,两个 admin 极端并发互删/同改同一用户存在竞态窗口。家族 1–3 admin 场景实际风险极低;彻底消除需 DB `security definer` RPC + advisory lock/事务 compare-and-swap(规模需要再做)。两轮跨模型评审(GPT-5.5+codex)均标此为唯一残留 Medium。
- 🎙 **纪要待验证(部署后实测)**:① 开说话人分离时阿里 Fun-ASR 实际上限约 **2h + 单声道**,超时需分段;② Chrome 默认 webm/opus Fun-ASR 可能不收 → 已回退 mp4/WAV-16k,但需真机确认所选格式被识别;③ `DASHSCOPE_BASE` 须与 key 归属区一致(境内/国际),否则提交/轮询失败;④ 转写中文人名/方言准确率需真实样本验,必要时切讯飞(备选,需 HMAC)。
- 🧩 **company 列未贯通**：import_full RPC / reinsertPerson 漏迁(Wave 1)。
- 🚀 **导入根治**：`import_persons` 批量 RPC(服务端算号+逐行 history+atomic) 替代现"预分配号段+并发池"止血(Wave 1)。
- 📈 **上万人扩展**(Wave 2，看规模是否成真)：ECharts 全图护栏、名册虚拟滚动、服务端搜索/分页、万级图换 WebGL。
- 🔤 GEDCOM 姓氏硬编码"孙"，泛化后待处理；`mergePersons` 仍迁 legacy `father_id`(应只动边)。
- 详细 backlog 见 `../待做功能清单.md`；考证类待办见系统内"待核实"/"数据体检"。

---

## 变更记录（由 /zupu-spec-sync 追加）

- **2026-06-30 v0.41.0**:三大新功能——**①用户权限管理**(新 admin 角色 + `app_metadata.perms` 功能位;`can_write()/can_minutes()` 助手;放宽全部 editor→editor|admin;新「用户管理」tab(仅admin)+ `users.js` + `functions/api/admin-users.js`(service_role 调 GoTrue Admin API,白名单+防锁死)+ `window.ADMIN`);**②纪要菜单访问控制**(标签按 canMinutes/isAdmin 显隐,无权不展示);**③纪要(NotebookLM 式)**(新 `minutes` 表 + 私有桶 `recordings` + 作者/受控列守卫触发器;新「纪要」tab + `minutes.js`(MediaRecorder mp4→WAV-16k 回退/上传/转写轮询/AI整理)+ `functions/api/minutes.js`(阿里 Fun-ASR 异步转写+DeepSeek 摘要/任务/脑图,service_role 签名URL+受控写,attach 路径校验+状态锁防双计费)+ `window.MINUTES`)。新 CF env `SUPABASE_SERVICE_ROLE`/`DASHSCOPE_API_KEY`/`DASHSCOPE_BASE`;新 SQL `minutes.sql`/`bootstrap-admin.sql`;关公开注册。**经两轮跨模型评审(GPT-5.5+codex):修复 客户端任意改列(UPDATE+INSERT 列守卫)、attach 状态回退、recordings 客户端直写、路径穿越;42 条逻辑探针全过;残留 M4/M5 管理端并发 TOCTOU 接受为低风险**。
- **2026-06-30 v0.31.0**：修导出/备份取数 bug(`fullData` 误取回收站→改 `listAllPersons` 全量)；GEDCOM/分享 HTML 改读 father 边(找回 15 条父子链)；删关系边存 before 并纳入可撤销(改父亲可撤)；reconcileFatherEdge 不再静默吞错；导入止血(预分配号段 `allocIds` + 并发池);全量读取加 `selectAll` 分页防 1000 行截断。首版 FEATURES.md。
- **2026-06-30 v0.32.0**：app.js 模块化(零构建)——把「配偶 blob 转边」抽到 `tools-spouse.js`、「日期规范化+表格导入+AI批量」抽到 `tools-dates-import-ai.js`;app.js 1934→~1300 行。机制:app.js 末尾把核心符号挂 window,工具模块裸引用经全局对象解析、并把自己公开函数+事件绑定挂回 window。函数体零改写。浏览器实测全过(登录/渲染/导入·AI·日期规范化·配偶转换 各入口零报错)。
- **2026-06-30 v0.40.0**:待接续展示再调(用户先要面板→嫌散→最终拍板)——**去掉 v0.39 的右上角独立面板/标签/虚线**,把无父子连接的本族成员当**普通浮框接在各自世代行最右端**(像孙景发:随 genOf 落对应世代行、与主树同代对齐、留空隙、无上连线、外观同连通框)。出图前先给用户 ASCII 样式图、批准后才改。浏览器实测:孙耀堂(6世待接续)与孙耀荣(6世连通)同 top=645、孙景才(7世)与孙景发同 top=818、无 tag/divider/dashed、零报错(仅 lunar CDN CORS 环境噪声)。
- **2026-06-30 v0.39.0**:传统谱图四连改(用户逐条提)——① **同辈排序改"男前女后→长幼"**(根因:新人 sort_order=0 插到旧人前,用户指孙德龙1987 被妹孙溶泽1995 排前;真实库模拟仅动 5 组、均合理);② **名字悬浮提示**主要信息(`#ctTip`,移到名字上显 姓名/性别/字辈/世代/生卒/籍居/配偶/职业;点名字开该人详情);③ **⛶ 全屏**按钮(全屏 API,进出按新视口重算适应整页);④ **「待接续」从文字附录改右上角紧凑面板**——无父子连接的本族成员汇成一个面板、按世代分行挨在一起(竖虚线分隔+「N世」标签;用户先要"各落世代行"、看后嫌散又改"都在一起")。浏览器实测四项全过(德龙左于溶泽/悬浮显信息/全屏进入/11 待接续框 2 行紧凑在右上)、零报错。**修一处:`ctTipHtml` 误用已删的 `ctYears`→内联生卒。**
- **2026-06-30 v0.38.0**:名册「**孙氏**」页按世代分组(用户:孙氏页应按辈分排)——`renderCards` 对同族(`state.lineage` 已设)按 `genOf` 分组、每组加「第N世 · X字辈 · N人」小标题(`.gen-head`);**「卡片」「列表」两页保持原样**(平铺/表格不变)。浏览器实测:孙氏 10 组头/104 卡、卡片 0 头/210 卡、列表 210 行、零报错。
- **2026-06-30 v0.37.0**:已故标记 v0.36 的"名字旁竖线"用户嫌不清晰→经 AskUserQuestion(对比 牌位框/「故」字前缀/已故变灰 三方案+ASCII 预览)定 **"牌位式:名字外加框+浅灰底"**。`.ct-gone` 从 underline 改 `background+border+border-radius+padding`(本人与配偶各自判定不变);名字仍按性别上色。**面积填色比细线耐缩**,适应整页(44%)也一眼可辨。实测 S010 孙鸿林框 于氏/王氏 加框、刘氏(在世)素名无框;零报错。
- **2026-06-30 v0.36.0**:① **新建人物默认在世**(`db.js createPerson` 未给 `alive` 时兜底「是」,覆盖全部创建入口;api 往返实测新建无 alive 返回「是」)。② 传统谱图**已故标记改"名字旁竖线"**(用户反馈"夫妻一存一殁不能整框变色"):取消整框灰底/虚线,改 `.ct-gone` 给已故者**名字 span**描竖线(竖排 underline 落字侧;本人与配偶各自判定);实测混合夫妻 S010 孙鸿林框内 孙鸿林/于氏/王氏 有线、刘氏(在世)无线。③ 传统谱图加 **🔄 刷新**(重拉 persons+关系边后重画)。浏览器实测零报错。
- **2026-06-30 v0.35.0**：传统谱图加 **在世/已故区分**(用户要求"先方案再做",经 AskUserQuestion 定"已故=灰底")——**已故=浅灰底(#d6deea)、在世=白底、未知=虚线框**(按本人 `alive`);直系标记从"绿底"改 **绿边框**(与生死底色共存)。底色按本族本人状态(配偶单独状态暂不分,待用户定)。图例补"灰底=已故·白底=在世·虚线=未知"。浏览器实测 64 框中 26 已故灰/37 在世白/1 未知虚线、零报错。
- **2026-06-30 v0.34.0**：传统谱图按用户反馈改 **竖排紧凑版**——名字**竖排**、卡片**只留名字+性别色**(去字辈/生卒/"配"字等冗余)、**男蓝女粉**(本人与配偶都按性别上色)、**默认"适应整页"**(整树缩放到一屏,`classicZoom=null`;框高改 DOM 实测、逐代行高、canvas transform+wrap 收缩正确滚动)。图宽 5716→**~1460px**。探针 14 项仍全过(同代间距 38px≥框宽 26px 无重叠);浏览器实测竖排/性别色/适应整页(60%)/couple 配偶色(孙雪英粉·王洪光蓝)零报错。
- **2026-06-30 v0.33.0**：家族树新增 **📜 传统谱图** 模式(`tree-classic.js`,与原 Mermaid 自动树图并存、默认传统谱图):手绘族谱挂图式分代排版——夫妻同框(配偶列框内)、直角折线连父子/兄弟、左侧世代+字辈栏、绿框=本谱直系、家族下拉(默认孙氏)、缩放+打印存PDF、无父子连接者列「待接续」附录。布局=`genOf` 分代行(强制子行>父行防重叠)+ 叶子计数 tidy 横排。**验证**:.mjs 探针对真实库(200人/98孙氏→63框/2根/9世)断言 14 项全过(关键:同代框水平间距 ≥152px 无重叠、父子链无环、连线无逆向);浏览器实测(默认渲染/点框→详情/模式切换/家族切换/缩放,零报错);**跨模型评审**(cursor-agent GPT-5.5)提 4 处并全修:软删配偶泄漏、母系叶子误入附录、零节点家族不显附录、同姓配偶在框又在附录重复(codex 因环境网络不可用未参与;Claude 多 lens 工作流复核为净)。
