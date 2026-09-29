<!-- 本文件由 /zupu-spec-sync 维护:每次功能/数据契约变更后自动更新对应小节 + 下面的"最近更新/版本"。
     手工编辑也可,但请保持小节结构稳定(skill 按二级/三级标题定位)。 -->

# 关系图谱（zupu-cloud）· 功能与需求规格

| | |
|---|---|
| **产品名** | 关系图谱（品牌固定常量 `APP_NAME`；本质=人物关系图谱，由《孙氏族谱》东北一脉演化而来，已泛化为不限一族一姓的属性图工具，仍能当家谱用） |
| **当前版本** | v0.49.0 |
| **最近更新** | 2026-07-09 |
| **技术栈** | 纯静态 vanilla JS（无构建、纯 ESM + CDN）+ Cloudflare Pages + Supabase(Postgres/Auth/Storage) + CF Pages Functions(代理 AI / 录音转写 / 用户管理) |
| **前端文件** | `app.js`(核心:state/helpers/render*/CRUD/详情/编辑/boot+权限门禁,~1300行)、`tools-dates-import-ai.js`(日期规范化+表格导入+AI批量)、`tools-spouse.js`(配偶 blob 转边)、`tree-classic.js`(传统谱图挂图渲染)、`minutes.js`(纪要:录音/转写/AI整理,v0.41;v0.42 分段长录音+崩溃恢复)、`users.js`(用户管理,admin,v0.41)、`db.js`(数据层)、`calendar.js`(万年历)。**模块加载顺序**:db→app→calendar→tools-*→tree-classic→minutes→users(均在 app 之后,app 末尾把核心符号挂 window 供其裸引用)。改版本必须同步改 `index.html` 全部 `?v=`。 |
| **线上** | https://sun-zupu-cloud.pages.dev |
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
  - **📜 传统谱图**（`tree-classic.js`，v0.34.0 改为**竖排紧凑版**）：仿手绘族谱——**名字竖排**(writing-mode vertical-rl)、**按世代分层成行**、一框=一位父系成员、**配偶在本人下方同框**(嫁入者不单独成框、**无"配"字**)、**男蓝女粉**按性别上色(本人+配偶都上色)、**已故=该人名字外加"牌位"框**(细框+浅灰底 `.ct-gone`;**本人与配偶各自判定**,夫妻一存一殁只标殁者,**不动整框颜色**;缩到一页也清晰——面积填色比细线/竖线耐缩)、**直角折线**连父子/兄弟、左侧**世代栏**、**绿边框**=`DIRECT_LINE` 直系。**版面=古式镜像,自右向左读**(v0.43.0 起;v0.44.0 父框改回**居中于子女中点**):整图水平镜像(`mx = maxX - rawX`)→ **同辈长在右、幼在左**;**同父子女排序=性别绝对优先(男先女后,`sibCmp` 不掺世代)→出生年(长幼)→手排号→ID**(v0.44.0;原 sortKey 世代在先,锚点异常的姐妹会插到兄弟前);根排序 `rootKey=genOf??1`(无锚点新始祖视为最老,防断片抢最右长房位,v0.43.0)。**卡片不显字辈/生卒等冗余信息**(只名字+性别色+已故牌位框)。**名字悬浮提示**(`#ctTip`):移到任一名字上显示该人主要信息(姓名/性别/字辈/世代/生卒/在世/籍居/配偶/职业事迹);点某名字开该人详情(配偶名亦然)。**默认"适应整页"**,另有 **🔄 刷新**、**⛶ 全屏**(浏览器全屏 API 作用于 `#treeBox`,进出全屏按新视口重算适应整页)、＋/−/适应整页/100% + **🖨 打印/存 PDF**(横向)。家族下拉默认**孙氏**。**无父子连接的本族成员**:像 `孙景发`(连通断片)那样,作为普通浮框接在各自 `genOf` 世代行的**行末(镜像后=最左端)**(与主树该世代同行对齐,留一点空隙,**无上连线**;外观同连通节点、**无独立面板/标签/虚线**),补上父亲后自动连线归位主树。(v0.39 曾试"独立面板"被否;v0.40 行末在右,v0.43 镜像后在左)
  - **🌳 自动树图**（`renderTree`）：原 Mermaid `graph TD`，懒加载，离线/失败回退文字。
- 布局算法（纯前端,L3 派生不落库）：节点=父系同姓血脉且与本族有父/母子连接者;纵=`genOf` 世代行,但强制「子行>父行」(防 genOf 偶发不一致致父子同行重叠);横=叶子计数 tidy(叶子顺序排、内部节点居中于子女)——保证同代框水平间距 ≥1 列(无重叠,已用真实库探针证实)。**框高 DOM 实测**(竖排内容高随名字/配偶字数),逐代行高取本代最高框。配偶取 `state.spouseOf` 中**非节点且未软删**者。**适应整页** = `min(可视宽/图宽, 可视高/图高)`,canvas `transform:scale` + wrap 收缩到缩放后尺寸(保证滚动条按缩放后算)。
- 关键文件/函数：`tree-classic.js`(`renderClassicTree/buildClassicForest`)、`app.js`(`renderTreeView` 调度 + 模式开关)、`renderTree`(Mermaid)。`DIRECT_LINE`、`genOf/surnameOfSelf/familiesOf/charGenFor/lineagesList` 经 window 复用。

### 2.3 关系图（`renderGraph`，ECharts 力导向，懒加载）
- 节点=人(绿在世/灰已故/黄未知，大小随度数)，边=关系(按类型上色、有向箭头、连线显称谓)；拖拽/缩放/悬停高亮；点节点→详情。
- **🎯 局部圈**：选中心(可搜)+跳数 1/2/3，BFS N 跳子图。
- **🔗 最短关系链**：选 A↔B，无向 BFS 最短路，高亮路径+文字列出。
- **图例点选筛选**：点关系类型显隐(影响图/局部圈/关系链)。
- **>500 人护栏(v0.49,A0-2)**:无中心人物、也没在查关系链时,人数 >500 不直接画全图(力导向会卡住页面)——显示引导页(用局部圈)+「仍要渲染全图」按钮(`state.graphForceFull`,会话内记住);局部圈/关系链不受影响;护栏态下图例清空(筛类型解不开按人数判的护栏)。
- 关键函数：`renderGraph/bfsPath/fillGraphControls`，`state.graphCenter/graphHops/pathA/pathB/graphTypesOff/graphForceFull`。

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
| **AI 批量添加** | 粘文字/选文件(txt/csv/tsv/md/json ≤3MB)→DeepSeek 识别成草稿→编辑/勾跳过→全部新建或匹配现有；识别时双 AI(DeepSeek+GLM)拆日期、标冲突/闰月歧义。**v0.49**:AI 零结果时**显式提示**(不再与"无需 AI"零区别;文案不指认双模型——Dual 以主模型为骨架,主模型挂则 GLM 结果也进不来;缺年份的按原文保留,完整农历仍由万年历本地换算);"GLM 未参与"提示改按真信号 `_glmOff` 且每次调用前重置;创建后带配偶原文者(只数**创建成功**的)→引导去「数据体检⑧配偶待整理」转真人+边,此时不自动关弹窗 | `/api/ai-parse` | ✅ |
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

### 2.11 纪要（`minutes.js`，v0.41；长录音 v0.42，权限门:`canMinutes`)— NotebookLM 式录音笔记
- **访问控制**：标签仅当 `role=admin 或 perms 含 minutes` 时展示;无权者连菜单都看不到(RLS + CF 函数各自再校验,非仅前端隐藏)。
- **列表/新建**:列表显 标题/会议时间(`meeting_at` 备注)/状态/时长/创建人;新建填 标题+会议时间+备注。
- **录音(v0.42 长录音,扛数小时)**:① 浏览器麦克风 `MediaRecorder`(单声道、计时、停止;**低码率 `audioBitsPerSecond:32000`** 压体积;**格式优先 mp4/AAC,回退 webm/opus,都不支持才 Web Audio 采 PCM 编码 WAV-16k**;5h 安全上限自动停);录音**边录边分段即传**(`mr.start(180000)` 每 3 分钟一片 → `seg-url` 签名直传私有桶作**崩溃兜底**),**停止时前端把内存里同源分片拼成整场单文件**上传,attach 后清理分片。② 上传已有音频(mp3/m4a/wav/aac…)。③ **崩溃恢复**:录到一半页面崩了(有分片台账、无整场文件)→ 详情显「恢复并保存整场」→ `seg-list` 下载分片按序重拼上传(**时长 v0.49 起优先浏览器解码真实值** `_blobDuration`,webm 无时长头用 currentTime 跳转惯用法、8s 超时;解不出才回退 段数×180 高估——高估偏向 >2h 关分人更安全)。**录音期间持屏幕唤醒锁(v0.49,A1-2)**:`navigator.wakeLock` 防手机息屏断录,切回页面自动重持,停止即释放,不支持的浏览器静默跳过(iOS Safari ≥16.4 支持)。录音存**私有桶 `recordings`**(单文件上限 200MB),经 CF 签名上传 URL 直传,**永久保留**。
- **转写**(阿里 Fun-ASR 异步):点「开始转写」→ 提交 → 前端轮询(关页面/刷新可据持久状态续轮)→ 完成显示**带时间戳 + 说话人分离**的分段(点段跳播放音频)。**说话人分离按时长开关(v0.42)**:`duration_sec≤2h` 开分离;`>2h` 关分离(Fun-ASR 开分离仅 ≤2h,关分离可 ≤12h)→ 只出文字、详情提示"未做说话人分离"。
- **说话人改名(v0.47)**:转写里点某段的**说话人标签**→ 弹框起真名 → 存 `minutes.speaker_names`({"0":"孙德龙"}),**同一编号全场同步显示**;真名也注入后续 AI 整理输入(摘要说"孙德龙"而非"说话人0")。**🤖 AI 猜说话人**:`guess-speakers` 让 DeepSeek 仅据对话内容(谁被喊名/自报身份)推测,返回建议+依据、**不自动写**,逐条「采纳」才落库。名字前端/后端/DB 三处均封顶 40 字、DB CHECK 约束(对象+≤2000 字)防超长名撑爆 AI prompt。
- **AI 整理(v0.47 长转写不再截断)**:摘要/任务/脑图对超 12000 字转写自动 **map-reduce**——按段边界切 ≤10000 字/块 → 逐块 map → 合并 reduce(任务用 JS 去重、键含 owner);块数封顶 8(约 5-6h),超出注明"仅前 8 段"。≤12000 字仍单次调用(无行为变化)。
- **AI 整理**(DeepSeek):**摘要**(结构化,可标"谁第几分钟说")/ **任务**(JSON 清单)/ **脑图**(mermaid `mindmap`,复用 mermaid 懒加载渲染)。
- 关键文件/函数:`minutes.js`(`renderMinutes/openMinuteDetail/startRecording/pickMime/mimeExt/makeWavRecorder/stopRecording/uploadAndAttach/recoverRecording/doTranscribe/startPolling/genAI/drawMindmap` + **v0.47 `speakerName/renameSpeaker/guessSpeakers/openSpeakerGuess`**)、`window.MINUTES`(db.js:含 `segUpload/segList` + **v0.47 `guessSpeakers`**)、`functions/api/minutes.js`(见 §4.1)。

### 2.12 用户管理（`users.js`，v0.41，权限门:`isAdmin`)— 完整自助
- **访问控制**:标签仅 admin 可见。
- 用户表(邮箱/角色/纪要权限/状态/最近登录)+ 操作:**新建用户**(邮箱+初始密码+角色+纪要开关)、**改角色**(admin/editor/viewer 下拉)、**纪要权限开关**、**重置密码**、**停用/启用**、**删除**。
- 前端只发语义意图(setRole/setPerms…),实际经 `functions/api/admin-users.js`(service_role 调 GoTrue Admin API)执行;含**白名单/防自我锁死/防删空最后一名 admin**(见 §4.1)。改完提示对方需重新登录生效。
- 关键文件/函数:`users.js`(`renderUsers/userTable/openUserCreate/openResetPw`)、`window.ADMIN`(db.js)。

---

## 3. 数据契约

### 3.1 表（11 张业务表）
`persons`(节点，id=TEXT `S###`)、`relationships`(边)、`relationship_types`(类型字典，预置 9 类)、`marriages`(自由文本婚姻，与 spouse 边并存)、`media`(相册)、`narratives`(家史)、`verify`(待核实)、`transcription`(p1-4 誊录)、`meta`(单行 jsonb 谱头)、`history`(留痕)、**`minutes`**(纪要,v0.41:`title/meeting_at/note/status/audio_path/audio_mime/audio_size/duration_sec/asr_task_id/asr_error/transcript/transcript_json(分段jsonb)/summary/tasks(jsonb)/mindmap/created_by/created_by_email`;**v0.42 加 `diarized`(本次转写是否带说话人分离)/`segment_count`(边录边传的分段数,单调不回退)**;**v0.47 加 `speaker_names`(jsonb:说话人编号→真名,用户可改的普通列、不进守卫,DB CHECK 限对象+≤2000字)**;触发器强制作者+守卫受控列,见 §3.5)、**`minute_segments`**(v0.42 分段台账,崩溃兜底:`minute_id/seq/object_path/size`,`unique(minute_id,seq)`,`on delete cascade`;仅 CF service_role 写,`can_minutes()` 可读)。字段细节见 `supabase/schema.sql` + `relationships.sql` + `minutes.sql` + `minutes-v042.sql` + `minutes-v047.sql`。

### 3.2 退役列（只停用，绝不 DROP）
`gen`(降级为可选世代锚点) `kind` `mother` `rank` `relation_type` `father_note` `spouse`(详情页只读"原始记载") `father_id`。仍在 `EDITABLE`/CSV 列，`updatePerson` 是部分 patch → 零丢失、可回滚。**新功能不写这些列。**

### 3.3 `db.js` REST shim 路由（`api(method,path,body)`）
GET `/api/{meta,persons,trash,narratives,verify,transcription,history,backups,auth}`、`/api/persons/{id}/{marriages,media}`；POST `/api/persons`、`/api/verify`、`/api/import/json`(→`import_full` RPC)、`/api/persons/{id}/{marriages,media,restore}`、`/api/history/{id}/undo`；PUT `/api/{marriages,media,verify}/{id}`、`/api/meta`、`/api/narratives/{key}`、`/api/persons/{id}`；DELETE `/api/persons/{id}/purge`、`/api/{marriages,media,verify}/{id}`、`/api/persons/{id}`(软删)。
**关系 CRUD 不走 shim，走 `window.REL`。**
**留痕 fail-loud(v0.49,B2-5)**:`logHist` 失败(注意 supabase-js v2 对 RLS 拒/网络失败是 **resolve `{error}` 不抛异常**,必须查返回值)→ 发 `zupu:hist-fail` 事件(db.js 不碰 DOM),app.js 监听显示红色提示条「改动已保存,但这一步无法撤销」——此前是静默 warn(且因误用 try/catch 从未触发过)。

### 3.4 `window.*` 导出面
`sb`(client)、`SBAUTH`(登录/角色/改密)、`photoUrl`(公开桶直链，留私有桶切换点)、`api`(REST shim)、**`CFN(path,body,opts)`(v0.49,B1-3:CF 函数统一入口,自带 JWT、支持 `opts.signal` 超时中断——工具模块调 `/api/*` 一律经它,禁止手写 fetch;非 JSON 响应报"CF 函数未部署/本地预览无代理"诊断)**、**`UNDOABLE`(可撤销操作集单一真源,v0.46 起 db.js 定义、app.js 引用)**、`REL`(types/all/of/add/update/del)、`DEDUP`(sameName/merge)、`EXPORT`(json/csv/gedcom/shareHtml)、`allocIds(n)`(批量导入预分配 ID)、`LUNARCONV`(万年历)、**`MINUTES`**(纪要:list/get/create/update/del + uploadAudio/playUrl/transcribe/pollStatus/ai + **v0.42 `segUpload/segList`**(边录边传分片 + 崩溃恢复列段)+ **v0.47 `guessSpeakers`**(AI 猜说话人建议,不落库),元数据走 PostgREST、录音/转写/AI 走 CF 函数;**`del` v0.45 改走 CF `delete` action**:service_role 清空 `minutes/<id>/` 前缀全部音频对象+分片台账→删行,删后 `logHist` 留痕——原客户端硬删不清桶致音频孤儿、违反留痕约定)、**`ADMIN`**(用户管理:listUsers/createUser/setRole/setPerms/resetPassword/disable/enable/del,均带 JWT 调 `/api/admin-users`)。
**跨模块 DOM 事件契约**:`zupu:hist-fail`(db.js 发、app.js 收,detail={summary};见 §3.3)——新增跨模块事件须在此登记。

### 3.5 RLS（按 JWT `app_metadata`）
- **SQL 助手**(`policies.sql`,`stable`,读 JWT):`can_write()`=`role∈{editor,admin}`;`can_minutes()`=`role='admin' 或 coalesce(app_metadata.perms,'[]'::jsonb) ? 'minutes'`(`#>` 取 jsonb、coalesce 保 null-safe、含 admin)。
- 原 10 张业务表：`authenticated` 可读、**`can_write()`**(editor|admin)可写,anon 全空(故 anon key 公开安全)。Storage `photos` 桶 public 读、`can_write()` 写。
- **唯一 anon 可读例外(v0.48)**:`schema_migrations`(迁移登记表,只有 SQL 文件基名+applied_at,非敏感)对 `anon, authenticated` 放行 select——`probes/check-migrations.mjs` 无凭证即可核对"线上跑过哪些 SQL",CI 也能跑;**无任何写策略**=只有手动跑 SQL(owner/service_role)能写。
- **纪要(v0.41;v0.42 扩守卫)**:`minutes` 表 select/insert/update/delete 全门 **`can_minutes()`**;insert `with check (created_by=auth.uid())` + `minutes_set_author` 触发器(`security definer`)服务端强制 `created_by/created_by_email`(防伪造)。**受控列守卫 `minutes_guard_cols`(BEFORE INSERT OR UPDATE)**:`current_user<>'service_role'` 时把 `status/asr_*/transcript*/summary/tasks/mindmap/audio_*/duration_sec/created_*/created_at`**+v0.42 `diarized/segment_count`** 强制为安全默认(INSERT)或原值(UPDATE)→ **普通客户端经 PostgREST 只能改 `title/meeting_at/note`+v0.47 `speaker_names`**(说话人真名映射是有意放开的用户标注列,不进守卫;RLS `can_minutes()` 把门 + DB CHECK 限对象+≤2000字防滥用),状态机/转写/音频只许 CF 函数 service_role 写(防双计费/改 audio_path/伪造)。
- **分段台账 `minute_segments`(v0.42)**:RLS 仅定义 `select`=`can_minutes()`;**不定义 insert/update/delete policy** → RLS 默认拒绝普通客户端所有写(防伪造 `object_path`),分段登记只由 CF service_role 写。`seg-url` 签发前先 `getMinute` 走调用者 JWT 过 RLS;仅 `status='draft'`(录制中)收分片、`seq∈[0,200]`(挡 int4 溢出孤儿 + 存储 DoS);attach 清段用 service_role 且**只删严格属于 `minutes/<id>/` 前缀的段对象**(纵深防御)。
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
原子"导入/恢复"：`security definer` + 函数内断言 **`public.can_write()`(editor|admin;v0.45 修——曾硬编码 `<> 'editor'` 致 admin 恢复被拒)** + `TRUNCATE ... restart identity cascade`(非裸 DELETE，避 `pg_safeupdate`)→ 按序重灌。`jsonb_array_elements` 别名用 `pj`(避与变量 `p` 歧义)。persons INSERT 列清单含 `company`(v0.45 补;须与 db.js EDITABLE/CSV_COLS 同步)。
> 注:此前记录的"`reinsertPerson` 也漏 company"系过时——它迭代 `EDITABLE` 数组(自 v0.19.1 已含 company),不丢。

---

## 4. 后端 / 部署 / 安全

### 4.1 CF Pages Functions（均先校验调用者 JWT 再动作)

**公共件 `functions/api/_shared.js`(v0.45)**:门禁(`requireWrite/requireAdmin/requireMinutes`,统一含 `aud==='authenticated'` 校验)、`json/extractJson`、Supabase 常量单份、`upstreamError`(错误脱敏:绝不回传上游响应体/模型原始输出)。**规则:新 CF 函数禁止内联这些,一律 import**(ship-checks 有校验;下划线文件不被路由,esbuild 打包,零构建不破)。

| Function | 用途 | 鉴权 | 外部服务 / env |
|---|---|---|---|
| `/api/ai-parse` | 粘贴文字→识别成人物 | editor\|admin | DeepSeek `deepseek-chat`，`DEEPSEEK_API_KEY` |
| `/api/normalize-dates` | 日期规范化(规则兜底) | editor\|admin | DeepSeek，同上 |
| `/api/normalize-dates-glm` | 日期双验证 | editor\|admin | 智谱 GLM `glm-4.6`，`GLM_API_KEY`/`GLM_MODEL`/`GLM_BASE` |
| `/api/map-columns` | 表格导入 AI 推荐列映射 | editor\|admin | DeepSeek |
| **`/api/admin-users`**(v0.41) | 用户管理(list/create/setRole/setPerms/resetPassword/disable/enable/delete) | **admin** | **`SUPABASE_SERVICE_ROLE`** 调 GoTrue Admin API。`requireAdmin` 在任何 service_role 调用前;role/perms 白名单;**read-modify-write 整体 app_metadata**(不丢字段);防自我降级/禁用/删除、防删空最后一名启用 admin;错误不回传 service_role/上游 body |
| **`/api/minutes`**(v0.41;v0.42 加分段;v0.47 加猜说话人) | 纪要后端(action:upload-url/play-url/attach/transcribe/transcribe-status/ai **+ v0.42 seg-url/seg-list + v0.47 guess-speakers**) | **canMinutes**(admin 或 perms 含 minutes) | **`SUPABASE_SERVICE_ROLE`**(签发 recordings 签名 URL + 写受控列)、**`DASHSCOPE_API_KEY`+`DASHSCOPE_BASE`**(阿里 Fun-ASR 异步转写:提交 `X-DashScope-Async`、轮询 tasks、6h 签名URL、`diarization_enabled`)、`DEEPSEEK_API_KEY`(摘要/任务/脑图)。`attach` 校验路径 `validAttachPath`(本纪要文件夹、无穿越)+ 状态锁(仅 draft/uploading/uploaded/failed)防双计费。**v0.42**:`seg-url`(边录边传分片签名URL:仅 `draft` 收、`seq∈[0,200]`、路径 `minutes/<id>/seg-NNNN.<ext>` 服务端构造、登记 `minute_segments`、`segment_count` 单调不回退)、`seg-list`(崩溃恢复列段签名下载URL);`transcribe` **按 `duration_sec` 开/关说话人分离**(`>7200s` 关,`diarized` 落库);`attach` 成功后清分片对象+台账(只删本纪要前缀)。**v0.47**:`ai` 长转写自动 map-reduce(按段切 ≤10k/块、封顶 8 块);`guess-speakers`(先 `getMinute` 过 RLS,仅据对话内容让 DeepSeek 推测真名、返回建议不落库);说话人名注入 AI 前封顶 40 字 |

### 4.2 部署 / 版本
- `git push` → CF Pages 自动构建(Framework=None，输出=仓库根)。
- **改版本必做(双改)**：`app.js` 的 `APP_VERSION` + `index.html` 所有 `?v=x.y.z`(否则 CF/浏览器缓存旧码)。
- Supabase 建表/改库：按序整段跑 `supabase/{migrations-registry,schema,policies,functions,relationships,minutes,minutes-v042,minutes-v047}.sql`(均幂等;**`migrations-registry.sql` 排第一(v0.48)**——先建 `schema_migrations` 登记表,后续每份 SQL 末尾的自登记行才落得下(ship-checks 第 8 项强制每份 SQL 带自登记;登记表未建时自登记静默跳过);`minutes*.sql` 用到 `policies.sql` 的 `can_minutes()`,故在其后;`minutes-v042.sql` 在 `minutes.sql` 之后——加 `minute_segments` 表、`minutes.diarized/segment_count` 列、重定义受控列守卫、`recordings` 桶上限提到 200MB;`minutes-v047.sql` 加 `minutes.speaker_names` 列 + CHECK 约束)。**线上漏跑核对(v0.48)**:`node probes/check-migrations.mjs`(anon 读登记表 vs 仓库 `supabase/*.sql` 基名,缺哪份报哪份;防再发生漏跑 minutes-v042/047→400 那类事故)。
- **CI(v0.48)**:`.github/workflows/ci.yml`——push main / PR 自动跑 `probes/ship-checks.sh` + `node --check` 全部 js/mjs + 提醒性 check-migrations(`continue-on-error`,新 SQL 合入到用户跑它之间黄着提醒)。**定位=事后兜底**:push 时 CF Pages 并行部署,CI 红≠拦住上线;发版前硬门禁仍是本地 ship-checks(/zupu-ship 清单)。Node 固定 24(仓库 .js 无 package.json 用 ESM,靠 ≥22.7 模块语法自动探测)。
- **`_redirects`(v0.48)**:CF Pages 把仓库根全部静态供网(schema.sql/probes 曾实测可公网下载)——非前端文件(`supabase/ probes/ backup-worker/ scripts/ docs/ .github/` 与根部 md/.gitignore)一律 302 回首页;**新增非前端目录记得补一行**。
- **CF Pages 环境变量(v0.41 新增)**:`SUPABASE_SERVICE_ROLE`(service_role key,admin-users + minutes 必需)、`DASHSCOPE_API_KEY`(阿里百炼)、`DASHSCOPE_BASE`(按 key 归属区:境内 `https://dashscope.aliyuncs.com` / 国际 `https://dashscope-intl.aliyuncs.com`)。
- **Supabase Auth 关闭公开注册**(否则有人自助注册绕过 admin 建号)。**引导首个 admin**:跑 `supabase/bootstrap-admin.sql`(改 email),之后网页「用户管理」自助。改 `app_metadata` 后该用户需重新登录生效。

### 4.3 安全模型
- anon key 公开安全(RLS 把门)；**service_role 铁律：绝不进前端/仓库/日志**。v0.41 起 service_role 仅用于两个**已先做 JWT 权限校验**的 CF 函数(`/api/admin-users` requireAdmin、`/api/minutes` requireMinutes),用于建/改用户与写纪要受控列/签发录音签名 URL;前端永不持有。**v0.48 增一处持有点:独立备份 Worker `zupu-backup` 的 secret**(同级信任;只读库写 R2,任何路径都不把数据/密钥回给调用方,见 §4.4)。**reset service_role 后要同步更新两处**:CF Pages env + 备份 Worker secret。
- **三级角色 + 功能位**:`role`∈{admin,editor,viewer}(admin⊇editor);`perms`(目前 `minutes`)与角色正交。受限标签前端隐藏只是 UX,**真门禁在 RLS + CF 函数**(详链:§3.5 / §4.1)。
- AI key 仅存 CF 环境变量，错误响应不回传第三方响应体(防 key 泄露)。
- 敏感字段 contact/address：分享模式 / 分享版 HTML / 脱敏导出里隐去，history diff 打码（注意 §3.5 的 history 库内未脱敏待办）。
- 大陆访问:CF+Supabase 境外基建，常能用但不保证稳、无 ICP → **v0.48 起有每日自动异地备份(§4.4)兜底**,手动"备份 JSON"仍可随时导。

### 4.4 自动异地备份（v0.48,独立 Worker `backup-worker/`）
- **每日 cron(UTC 19:00=北京 03:00)** 用 service_role 只读全库 12 表(§3.1 业务表+history+纪要文本;录音音频不备,在 Supabase 私有桶另有平台备份)→ 拼一份 JSON → 写 **R2 私有桶 `zupu-backups`**,文件名 `backup-<北京日期>.json`,同日重跑覆盖当天,不自动删旧档。
- **保真三保险**:分页按各表主键 `order`(无 ORDER BY 的 limit/offset 跨请求行序不稳,>1000 行的 history 会静默丢/重行)、只以空页终止(不假设服务器 Max Rows=1000)、**空库哨兵**(persons 0 行拒写——anon key 贴错会被 RLS 滤成空结果而非报错)。
- **只写不回传**:cron 无返回;`/run` 手动触发需 `BACKUP_TOKEN` 且只回 `{ok,key,counts}` 不回数据体——token 泄露最多被人多触发几次备份,拿不到数据。
- **无主动告警**(接受的残留):失败只进 CF Worker 日志;建议每月看一眼 R2 最新文件日期/大小。免费档 50 子请求/调用,当前 ~13 个,history 累积数万行后会整体报错(不静默截断)。部署/恢复步骤见 `backup-worker/README.md`。

---

## 5. 已知开放项 / 待办

- 🔒 **隐私(用户暂缓)**：history 库内 PII 对 viewer 可读；照片公开桶 — 待用户定策略。
- 👥 **用户管理并发 TOCTOU(接受的低风险,v0.41)**:防"删空最后一名 admin" + `setRole/setPerms` 用请求开始时的快照,两个 admin 极端并发互删/同改同一用户存在竞态窗口。家族 1–3 admin 场景实际风险极低;彻底消除需 DB `security definer` RPC + advisory lock/事务 compare-and-swap(规模需要再做)。两轮跨模型评审(GPT-5.5+codex)均标此为唯一残留 Medium。
- 🎙 **纪要待验证(部署后实测)**:① 开说话人分离时阿里 Fun-ASR 单文件上限约 **2h**(v0.42 已按 `duration_sec>2h` 自动关分离,关分离可 ≤12h),仍需真机确认 2h+ 长录音提交/落库正常;② webm/opus 是否被 Fun-ASR 接受为**上线实测项**(v0.42 录音优先 mp4、回退 webm/opus,若 webm 不收需真机验并调格式偏好);③ `DASHSCOPE_BASE` 须与 key 归属区一致(境内/国际),否则提交/轮询失败;④ 转写中文人名/方言准确率需真实样本验,必要时切讯飞(备选,需 HMAC);⑤ **v0.42 分段兜底/恢复**:模拟录音中途关页 → 详情「恢复并保存整场」能重拼上传;`segment_count=lt.` 单调 PATCH、`seq∈[0,200]` 门、`status='draft'` 门为服务端行为,需真机/DB 侧确认(逻辑探针已过,但 PostgREST 过滤器与 Fun-ASR 长音频为实测项);⑥ **v0.47 说话人改名需先在 Supabase 跑 `minutes-v047.sql`**(否则写 `speaker_names` 会 400,同 v0.42 漏跑教训);点标签改名→全场同步、AI 猜名→逐条采纳、长转写(>12000字)map-reduce 摘要不丢后半场——均为部署后实测项;map-reduce 对 5h 会议 ≤9 次串行 DeepSeek 调用,需真机确认无 Cloudflare/浏览器超时。
- ~~🧩 company 列未贯通~~ **已修(v0.45)**:import_full 补列;reinsertPerson 经查本就不漏(用 EDITABLE)。
- 🚀 **导入根治**：`import_persons` 批量 RPC(服务端算号+逐行 history+atomic) 替代现"预分配号段+并发池"止血(Wave 1)。
- 🪟 **window 导出面收缩(backlog,健康度评审 P6)**:app.js 导出 102 符号仅 18 被消费、tools-dates 52 仅 3——收缩到实际消费集+注明消费方;tools-dates 4 处手写 fetch 收口到 db.js `_fn`。
- 📈 **上万人扩展**(Wave 2，看规模是否成真)：ECharts 全图护栏、名册虚拟滚动、服务端搜索/分页、万级图换 WebGL。
- ~~🔤 GEDCOM 姓氏硬编码"孙"~~ **已修(v0.45)**:改按父系顶祖姓拆(无父边者用本人首字;单字姓近似)。`mergePersons` 仍迁 legacy `father_id`(应只动边);同类还有 `purgePerson` 断子女旧链也写 father_id(db.js,一并留待"father_id 只读冻结"小改)。
- 🔒 **隐私暂缓项已立 ADR**:`docs/adr/0001` 记录触发条件——**账号发给家族外/半信任成员前**必须先做 history 列级脱敏 + 照片私有桶。
- 详细 backlog 见 `../待做功能清单.md`；考证类待办见系统内"待核实"/"数据体检"。

---

## 变更记录（由 /zupu-spec-sync 追加）

- **2026-07-09 v0.49.0(辩论第四批收尾:7 项接受项 + 评审修复)**:落地辩论矩阵剩余接受项——**① B2-5 留痕 fail-loud**:`logHist` 失败发 `zupu:hist-fail` 事件、app.js 红条提示"这步无法撤销"(**关键修复:supabase-js v2 对 RLS 拒/网络失败 resolve `{error}` 不抛异常,原 try/catch 是死代码**,29-agent 评审 P1 实证后改查返回值);**② A0-2 关系图 >500 人护栏**(无中心/无关系链才拦,可强制渲染,`state.graphForceFull`;护栏态清图例);**③ B1-3 网络 I/O 收口**:`window.CFN` 统一 CF 函数调用(带 JWT/支持 signal/非 JSON 诊断),tools-dates 4 处手写 fetch 全部改走它;**④ B2-7 AI 全挂显式**:送 AI 零结果时预览/消息显式提示(文案不指认双模型——Dual 以主模型为骨架;完整农历仍本地换算不受影响),"GLM 未参与"改按真信号 `_glmOff` 且每次调用前重置(修粘性横幅);**⑤ B7-2 恢复时长**优先浏览器解码真实值(webm Infinity 用 currentTime 惯用法,8s 超时回退段数×180);**⑥ A1-2 录音 Wake Lock** 防息屏断录(切回自动重持);**⑦ A1-3 创建后配偶引导**(只数创建成功的,spOk)。**评审 21 发现 17 确认全修 4 驳回**,顺手修 pre-existing:map-columns/normalize-dates-glm 内联上游错误处理改走 `_shared.upstreamError`(契约);§3.4 补登 `CFN/UNDOABLE` 与事件契约。逻辑探针 9/9、浏览器冒烟(提示条/零报错)通过。
- **2026-07-09 v0.48.0(工程化三件套:自动异地备份 + CI + 迁移登记 · 外部评审 debate 第三批)**:落地 `改进建议与代码不足.md` 辩论接受的 A0-1/A0-5/B6-2——**① 自动异地备份** `backup-worker/`(独立 CF Worker,每日北京 03:00 全库 12 表 JSON→R2 私有桶 `zupu-backups`;按主键分页防丢行、空库哨兵拒写空档、北京日期命名、只写 R2 绝不回传数据;详 §4.4);**② CI** `.github/workflows/ci.yml`(push/PR 跑 ship-checks + node --check 全部 js/mjs + 提醒性 check-migrations;事后兜底定位,Node 24);**③ 迁移登记** `supabase/migrations-registry.sql`(自建 `schema_migrations`,anon 可读=全库唯一记档例外)+ **8 份既有 SQL 追加自登记行** + `probes/check-migrations.mjs`(线上 vs 仓库核对,空集≠全缺的误诊已防)+ ship-checks 第 8 项自登记门禁;SQL 运行清单改 registry 打头。**④ 顺手加固**(29-agent 对抗评审 21 确认全落修):ship-checks 修 `father_id` 行尾 `//` 注释绕过(grep -v '//' 改 awk 切注释尾)+ 版本计数对称化(按出现次数、任意资源);**`_redirects` 屏蔽非前端文件公网供网**(schema.sql/probes 曾实测可下载;健康度报告挪 `docs/`);/zupu-ship skill 同步(?v= 计数动态化、全量 node --check、纳入 ship-checks/check-migrations)。驳回 4 条(跨表快照/备份含 registry 表/GITHUB_TOKEN 权限/文件名空格)。**注:migrations-registry.sql 需用户在 Supabase SQL Editor 跑一次(操作指令 06);备份 Worker 需用户在 CF 后台部署(同指令)。**
- **2026-07-09 v0.47.0(纪要说话人改名 + AI 长转写分块 · 外部评审 debate 第二批)**:落地调研/评审的 P1——**① 说话人改名 v1**:转写里点说话人标签→起真名,存新列 `minutes.speaker_names`(jsonb,用户可写、不进守卫、RLS+DB CHECK 把门),**同编号全场同步**且真名注入后续 AI 输入;新 `guess-speakers` action + `MINUTES.guessSpeakers` 让 DeepSeek 仅据对话内容猜名、返回建议不落库、逐条采纳。**② AI 长转写 map-reduce**:摘要/任务/脑图对 >12000 字转写按段切块(≤10k/块、封顶 8 块)逐块 map + reduce,修掉旧「只吃前 12000 字、长会后半场丢失」;≤12000 字仍单次调用。新 SQL `minutes-v047.sql`(需在 Supabase 跑)。**经跨模型评审(cursor-agent GPT-5.5;codex 本轮触发用量上限缺席):修 ①`speaker_names` 无长度/类型约束→超长名逐段注入撑爆 AI prompt 挤掉正文(加 DB CHECK 对象+≤2000字、名字三处封顶 40 字、非对象当空)②tasks 分块>8 静默丢弃后段行动项(加"仅前8段"提示条)③tasks 去重键补 owner(同任务不同负责人不再误并)。prompt 注入污染 AI 结果、AI 请求无限流 定为可接受残留(可信家庭空间 + AI 产出是人工复核的草稿)。25 条逻辑探针含全部评审反例全过。**:按外部 AI 评审(38 条主张经 6 组并行探针逐条核实)修「承诺与实现不一致」——**① 撤销单一真源**:`db.js` 定义 `UNDOABLE` 并挂 `window.UNDOABLE`,`app.js` 改读同一份(此前自持第二份 Set **缺 `delete:relationship`**,致删关系后端能撤但历史列表不显示撤销按钮);**② 文案诚实化**:删关系确认由「不可恢复」改「可在操作历史里撤销」;彻底删除确认由「仍可撤销重建」改「可撤销重建**人物基本信息**,但照片/婚姻/关系边不恢复」(实际 `purge` 撤销只 `reinsertPerson`);**③ 退役列 `father_id` 彻底停写**:`purgePerson`(father 边随 person 行 `on delete cascade` 自动清,原清列冗余)、`mergePersons`(子女计数改按 `father` 边 `from=父` 统计——原按退役列统计会漏掉退役后新建的父子)两处均去除,`ship-checks.sh` 新增 `father_id:` 写入**硬门禁**(FAIL);**④ 双 AI 降级显式化**:GLM 未配置时后端 note 被前端捕获为 `_glmOff`,日期规范化预览显式提示「第二模型未启用、仅单模型识别」(此前静默退化)。纯前端+SQL 无改;12 条逻辑探针 + ship-checks 全过。**未接受**:拆 db.js 三文件(与「减少 window 接缝」自相矛盾,反驳);多条 P2/P3 分寸过重项降级 backlog。辩论矩阵见 `族谱/改进建议与代码不足.md` 文末。:按 `/project-health` 评审(探针+4 lens+GPT-5.5 异构)修复——**P1** `import_full` 角色断言 `<>'editor'`→`public.can_write()`(admin 主账号恢复通道曾断;线上 rpc 实证)+ persons INSERT 补 `company`;**P2** 抽 `functions/api/_shared.js` 统一 6 个 CF 函数的门禁(4 个 AI 函数补 `aud` 校验)/常量(7 份→2 份)/错误脱敏(堵 ai-parse/normalize-dates 上游体与 raw 模型输出回传);**P3** `MINUTES.del` 改走 CF `delete` action(service_role 清桶+台账→删行)+ logHist 留痕;**P4** 新 `probes/gen-parity.mjs`(从两侧源码原样提取执行,230 人全员一致✓)+ 双实现互指注释;**P5** CLAUDE.md SQL 清单补 minutes、schema.sql minutes 建表即 enable RLS、新「模块契约」成文;**P6 顺手** GEDCOM 姓氏改父系顶祖姓、app.js 3 处懒调用补守卫、state 私有键集中登记、`docs/adr/0001` 隐私暂缓触发条件。**新 `probes/ship-checks.sh` 8 项静态门禁**(角色字面量/raw 回传/I-O 收口/版本双改/文档一致等)进 /zupu-ship 清单,全过✓。**注:import_full 修复需在 Supabase SQL Editor 重跑 functions.sql 才生效(见 操作指令/03)。**
- **2026-07-07 v0.44.0**:① 传统谱图**父框改回"居中于子女中点"**(用户看过 v0.43"压长子"版后选居中;镜像/长右幼左/主树在断片右侧不变);② **同父子女排序改性别绝对优先**(男先女后,新 `sibCmp` 不掺世代——原 sortKey 世代在先,个别锚点异常的姐妹会插到兄弟前;用户点名"男的排前面女的排后面")。探针 10 项全过(父居中/男先女后/主树在断片右侧 等新断言)。**随行数据迁移(用户批准"按建议修正"):世代全谱重编号为单锚点纯推算**——孙希增(S219)设 gen=1 唯一始祖锚点;**41 人清空手填世代**(推算=旧+1 完全一致者)改全自动;**10 人锚点+1 保留**(鸿德/鸿柱、雪棠4姐妹、德举/乃旭/众天/晶淼——其手填与父链本就有意不一致,保留覆盖意图);14 待接续维持今晨+1 值。终态 25 个锚点、11 项抽查全对、逐条留痕可撤销。以后往上补祖先全谱自动顺延。
- **2026-07-07 v0.43.0**:传统谱图版面改**古式镜像·自右向左读**(用户按古谱习惯选定,出 ASCII 样式图批准后实施)——① `assign()` 父框从"居子女中点"改**压长子正上方**(长子 x=本支最小叶),老祖宗主干成一条竖线;② 渲染层加水平镜像 `mx=maxX-rawX` → **长在右、幼在左**、主干贴最右、**待接续镜到各世代行最左端**;同辈序逻辑(世代→性别男先→长幼→手排号→ID)不变,镜像后"先"=靠右。控件 hint 注明"古式:自右向左读,长在右"。真实库探针 8 项全过(同代零重叠/父压长子/长右幼左/待接续最左/耀·景待接续与同字辈同行/无环/单父)。**随行数据修正(非 spec,记录备查):14 位无父子连接者(鸿范/武、耀堂等4、景才等7、景发)手填世代 +1 对齐新始祖孙希增后的全谱编号,逐条留痕可撤销。**
- **2026-07-01 v0.42.0**:纪要**长录音**(扛数小时)——录音改**低码率 `audioBitsPerSecond:32000` + 3 分钟分段 timeslice 边录边传**(`seg-url` 签名直传私有桶作崩溃兜底、登记 `minute_segments` 台账),**停止时前端把内存同源分片拼成整场单文件**上传、attach 后清分片;新增**崩溃恢复**(`seg-list` 下载分片重拼,`recoverRecording`);格式优先 mp4、回退 webm/opus(webm 是否被 Fun-ASR 收为上线实测项);5h 安全上限;`recordings` 桶单文件上限提到 200MB。转写**按 `duration_sec` 开/关说话人分离**(`>2h` 关分离→只出文字、详情提示;`diarized` 落库)。新表 `minute_segments`(仅 service_role 写,RLS 默认拒客户端写)+ `minutes.diarized/segment_count` 列 + 重定义受控列守卫;新 SQL `minutes-v042.sql`。**经跨模型评审(GPT-5.5 cursor-agent + codex):修复 ①`seg-url` 无界签发+`seq` int4 溢出成不可清理孤儿对象(加 `seq∈[0,200]` 门)②`seg-url` 无状态门(仅 `draft` 收,防转写后堆垃圾)③崩溃恢复恒传 `duration=0` 致 >2h 录音错误开分人被 Fun-ASR 拒(改按段数×180 估时长);另加 `segment_count` 单调 PATCH、attach 清段前缀守卫(纵深防御)。逻辑探针含全部评审反例全过(seq 越界/int4 溢出/状态门/恢复时长/清段前缀)**。
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
