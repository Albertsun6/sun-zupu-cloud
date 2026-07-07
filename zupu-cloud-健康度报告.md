# zupu-cloud(关系图谱)— 项目健康度报告

> 评估日期:2026-07-07 ｜ 方法:/project-health(L0 治理 · L1 门禁 · L2 趋势 · L3 AI 4-lens + GPT-5.5 异构终审)
> 目标仓库:`族谱/zupu-cloud` @ v0.44.0(7545cbd)｜ 技术栈:零构建 vanilla JS + Supabase + CF Pages(无 package.json 属有意设计)｜ 评估窗口:12 个月(83 commits)
> 阈值档位:**活跃开发的个人/家族项目**(治理项按此校准,非企业标准)

## 健康画像(分层,非单一分数)

```
L0 治理   ●●●○○   0 secret✓ 0 TODO✓ 3作者✓;但 无CI·无分支保护 ——多窗AI并行下是真风险
L1 门禁   ●●●●○   重复率2.67%(优);esc/错误处理纪律一致;死代码与单函数CC无工具覆盖(见边界)
L2 债震中 ●●●●○   app.js 是历史震中(74rev×1311行)但 git 证实 v0.32 拆分后已止血(此后仅3次×1-2行)
L3 软维度 ●●●●○   分层真实成立、新模块守约;但 CF函数复制漂移已出真实缺口 + 1条已修坑复发
```

**一句话总评:架构底子是健康的(声明的分层被 grep 实证遵守、新功能没有腐化它),真正的问题集中在两处:① 复制粘贴维护的 6 个 CF Function 已经产生真实的安全/功能漂移;② 全靠"默契"没有任何自动门禁,同类坑已出现第一次复发。**

## 维度评分

| 维度 | 分 | 依据 |
|---|---|---|
| D0 仓库治理 | 3 | 0 secret(config.js anon key=有意公开+RLS)、3 作者;**无 CI、分支 unprotected**(探针实测);license/SECURITY 缺但私有家族项目影响低 |
| D1 架构合理性 | 4 | 分层实证成立(除 db.js 全前端 0 处直连 supabase);CF 函数 6 份拷贝已漂移(见 P2);~~db→app 反向依赖~~(异构终审证伪,撤销) |
| D2 规范·精简 | 4 | jscpd 2.67%(≤3% 优);minutes/users 与既有约定一致、esc 纪律到位;单函数 CC 未测(无 eslint) |
| D3 目录结构 | 4 | 根 10 JS 平铺靠命名可导航;隐患:前后端同名对(minutes.js×2)、根目录接近拆 js/ 阈值 |
| D4 冗余·死代码 | 4 | knip 不可用(无 package.json);L3 实测**死导出面**:app.js 导出 102 符号仅 18 被消费、tools-dates 52 仅 3;CF 函数模板×6 份 |
| D5 解耦 | 4 | db.js api() 接缝干净且全员遵守(反向 state 引用=0);app.js"历史上帝模块已止血";**genOf 双实现**(app.js:73 vs db.js:457)是最大分叉风险 |
| D6 技术架构(债分布) | 4 | 震中唯一且已证止血:v0.33 新功能 app.js 仅占 6%、v0.41 仅 2%——新债正确落在新模块 |
| D7 历史教训 | 3 | 有留档机制(FEATURES §5)且新表 minutes 的 RLS/私有桶纪律证明教训被吸收;**但出现一次真实复发**(见 P1)+ 2 处文档漂移 + 1 条新债(P3) |

## 问题清单(按严重度)

### 🔴 P1(HIGH·复发·功能已断)admin 无法恢复备份 — `supabase/functions.sql:15`
`import_full` 仍硬编码 `<> 'editor'` 即拒;v0.41 改用 admin 超集角色(你的主账号=admin,`bootstrap-admin.sql:9`)后,前端能看到「上传JSON恢复」按钮、点了却被 RPC 拒。**这正是 2026-07-01 在 `relationships.sql:62` 修过并写了注释警示的同一类坑,复发了。** 全仓扫描确认这是最后一处内联 `'editor'` 判定。
→ 修法(一行):`if not public.can_write() then raise ...`;跑完用 admin 账号实测一次恢复。

### 🟠 P2(MED·安全漂移)6 个 CF Function 复制粘贴已出真实缺口 — `functions/api/*`
- 4 个 AI 函数(ai-parse/normalize-dates/-glm/map-columns)缺 `aud==='authenticated'` 校验(admin-users:32、minutes:29 有);
- `ai-parse.js:72`、`normalize-dates.js:51` 把 DeepSeek 上游错误体回传客户端,**违反 FEATURES §4.3 写明的不变量**;异构终审补充:`ai-parse.js:76`、`normalize-dates.js:79` 的 `raw:` 也回传模型原始输出,同属应统一的错误策略;
- SB_URL/SB_ANON 硬编码 7 份(轮换 anon key 要改 7 处)。
→ 修法:抽 `functions/api/_shared.js`(下划线文件 CF Pages 不路由、支持相对 import,零构建不破):`requireRole()` + `json()` + 统一"错误不回传上游内容"包装,6 函数改引用。约 1-2 小时,一次消灭三类漂移。

### 🟠 P3(MED·新债)纪要删除违反"留痕+可撤销"约定 — `db.js:392`
`MINUTES.del` 直接硬删、无 history、不可撤销,且不清理 recordings 私有桶音频 → 永久孤儿对象。对照 `purgePerson`(db.js:116-127)删前存快照+清桶的正确做法。
→ 修法:删除走 CF 函数(service_role 先清 `minutes/<id>/` 前缀再删行,复用 attach 的前缀守卫)+ logHist 快照。

### 🟠 P4(MED·分叉风险)世代推算双实现 — `app.js:73-86` vs `db.js:456-472`
页面显示走 app.js `genOf`,CSV/分享HTML/GEDCOM 走 db.js `buildGenOf`(注释自认"复刻")。语义今天一致,但 v0.44 刚做过世代重编号迁移——以后只改一侧,备份/导出与页面会**静默分叉**,无测试能发现。
→ 修法(最低成本):写 parity 探针(.mjs 对真实库断言两实现全员一致)进 /zupu-ship 清单;两函数头互写"改我必同步对方"。

### 🟠 P5(MED·文档漂移)CLAUDE.md SQL 清单过期 — `CLAUDE.md:22`
只列 4 个 SQL,漏 minutes.sql/minutes-v042.sql;照它重建库会得到**RLS 未启用的 minutes 表**(建表在 schema.sql:117,enable RLS 在 minutes.sql:71)。FEATURES §4.2 是对的——改 CLAUDE.md 指向它;根治:schema.sql 建表处就地 `enable row level security`。
另两处文档漂移:FEATURES §3.8/§5 说 reinsertPerson 漏 company(**过时**,EDITABLE 自 v0.19.1 已含);import_full 的 persons INSERT **确实**仍漏 company(functions.sql:31,39)。

### 🟡 P6(LOW,列出备查)
- window 死导出面:102 导出/18 被消费、52/3——契约不可见+静默覆盖风险,值得收缩(异构终审判定不进 top3,列 backlog)
- app.js 3 处裸懒调用 tools 符号无守卫(app.js:577,579,707;1258 有守卫是对的)
- state 私有键未声明(`_classicZoomEff/_users/_spBusy`);CF 前端调用两套约定(db.js `_fn` vs tools-dates 4 处手写 fetch)
- GEDCOM 姓氏仍硬编码"孙"(db.js:490)——产品已泛化多姓,错位在扩大;可复用 surnameOfSelf
- mergePersons/purgePersons 仍写退役列 father_id(db.js:290,118;后者未记档)
- 已知且你明确暂缓:history 表 PII 对 viewer 可读、照片公开桶(未恶化;建议升格为带触发条件的 ADR:"账号发给半信任成员前必须先做")

### ✅ 守住的(值得表扬)
- 「新功能不写退役列」纪律 100% 守住(grep 实证)
- minutes 新表的 RLS/受控列守卫/私有桶/service_role 纪律——**照片公开桶的旧教训在新桶上被正确规避**
- db.js 接缝被全员遵守、esc 转义纪律一致、重复率 2.67% 优

## 最该先动的 3 件事(经异构终审调序)

1. **修 P1**(一行 + grep 清扫 + admin 实测恢复)——主账号功能已断 + 复发债,ROI 最高
2. **抽 `functions/api/_shared.js` 修 P2**(统一门禁/错误脱敏/常量)——已出真实缺口的安全漂移
3. **建最小可执行门禁**:把本轮固化探针(genOf parity/角色字面量扫描/别名一致性/roundtrip)沉淀进 repo `probes/` 并强制进 /zupu-ship 清单;GitHub 开分支保护 + MINUTES.del 补留痕(P3)——无 CI 的多窗 AI 并行开发,靠"默契"已经漏过一次(P1),需要机器把门

## 固化清单(教训 → 自执行规则)

| 发现 | 固化动作 | 可机器检查? |
|---|---|---|
| P1 角色内联字面量 | `grep -rn "'editor'" supabase/ functions/` 进 ship 探针,非 can_write/can_minutes 即 FAIL | 是 |
| P2 CF 函数漂移 | `_shared.js` + 规则"新 CF 函数禁止内联门禁/常量/错误拼接";curl 探针验 401/403 | 是 |
| P4 genOf 双实现 | parity 探针(app 实现 === db 实现,全员断言) | 是 |
| P5 SQL 顺序双真源 | /zupu-spec-sync 加检查项"CLAUDE.md 与 FEATURES §4.2 一致";schema.sql 建表即 enable RLS | 是 |
| 前端 I/O 只在 db.js | `grep sb\.from\|sb\.auth` 除 db.js 命中即 FAIL | 是 |
| 退役列不再写 | grep 写模式告警(father_id:/kind:/mother:...) | 是 |
| 模块契约(state 键所有权/app.js 冻结为核心+壳/拆分触发条件) | 写进 CLAUDE.md + ADR | 仅留档 |
| 隐私暂缓项 | ADR 带触发条件("viewer 账号外发前必须先做") | 仅留档 |

## 覆盖边界(诚实声明)

- **自动覆盖**:hotspots(git)、治理(shell)、重复率(jscpd)、体量/文件级复杂度(scc)
- **半自动(AI 4-lens + GPT-5.5 异构)**:架构/目录/解耦/历史教训(全部结论带 file:line,关键 2 条主 agent 亲手复核)
- **未自动覆盖**:死代码(knip 需 package.json;且 window 接缝无 import 图,装了也看不到)→ 由 L3 grep 实测"死导出面"替代;单函数圈复杂度(需 eslint `complexity` 规则,可 `npx eslint --no-eslintrc --rule '{"complexity":["warn",15]}' *.js` 临时跑)

## Metadata

- 探针:ran 4 / skipped 0 / failed 0(manifest: scratchpad/health-out/probes.json)
- L3:4 agents(4 维度)全出分,93 处文件证据
- 异构终审:cursor-agent GPT-5.5 → **Refine**(4 条:撤销 A3 事实错误 ✅ / 补漏报 raw 回传 ✅ / B2 措辞收窄 ✅ / top3 调序 ✅-partial)
- 辩论收敛:Round 1 全 accept,无人类裁决项
- 降级:无(cursor-agent 可用;git 仓库;报告写盘成功)
- 主 agent 亲手复核:P1(functions.sql:15 + relationships.sql:62 注释)、P2(ai-parse.js:72,76)、R1(db.js:477,508 局部 buildGenOf)
