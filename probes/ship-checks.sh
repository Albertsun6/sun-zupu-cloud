#!/usr/bin/env bash
# probes/ship-checks.sh —— 发版前静态门禁(零依赖,grep 级;/zupu-ship 清单强制项)
# 来源:2026-07-07 健康度评审固化清单。硬项 FAIL 即退出非零;软项只 WARN。
# 用法:bash probes/ship-checks.sh   (在仓库根跑)
set -uo pipefail
cd "$(dirname "$0")/.."
FAIL=0
say(){ printf '%s\n' "$*"; }
bad(){ say "❌ FAIL: $*"; FAIL=1; }
ok(){ say "✅ $*"; }
warn(){ say "⚠️  WARN: $*"; }

# 1) 角色判定禁止内联 'editor' 字面量(只准 can_write()/can_minutes();policies.sql 是助手定义处,注释行豁免)
HITS=$(grep -rn "'editor'" supabase/*.sql 2>/dev/null | grep -v '^supabase/policies.sql' | grep -v ':[0-9]*: *--' || true)
[ -z "$HITS" ] && ok "SQL 无内联 'editor' 角色字面量" || bad "SQL 内联角色字面量(改用 can_write()/can_minutes()):
$HITS"
HITS=$(grep -rn '"editor"' functions/api/*.js 2>/dev/null | grep -v '_shared.js' | grep -v 'const ROLES' || true)   # ROLES=setRole 的角色白名单定义,非门禁,豁免
[ -z "$HITS" ] && ok "CF 函数无内联角色判定(统一走 _shared)" || bad "CF 函数内联角色判定:
$HITS"

# 2) CF 函数错误脱敏:响应里不得回传上游 body/模型原始输出(raw: 字段);_shared 豁免;backup-worker 同查
HITS=$(grep -rn 'raw:' functions/api/*.js backup-worker/*.js 2>/dev/null | grep -v '_shared.js' || true)
[ -z "$HITS" ] && ok "CF 函数无 raw: 回传" || bad "CF 函数把模型原始输出回传给客户端:
$HITS"

# 3) 前端 Supabase I/O 只准出现在 db.js(config.js 是常量)
HITS=$(grep -n 'sb\.from\|sb\.auth\|sb\.storage\|sb\.rpc' ./*.js 2>/dev/null | grep -v '^./db.js' || true)
[ -z "$HITS" ] && ok "前端 Supabase 调用全部收口在 db.js" || bad "db.js 之外出现 Supabase 直连:
$HITS"

# 4) 版本双改:APP_VERSION 与 index.html 全部 ?v= 一致
#    按"出现次数"数(非行数,同一行两个标签也数得清);两侧模式对称(任何带 ?v=数字 的资源都算,不限 .js)
V=$(grep -o 'APP_VERSION = "v[0-9.]*"' app.js | grep -o '[0-9.]*' | head -1)
NTAG=$(grep -o "?v=$V\"" index.html | wc -l | tr -d ' ')
NALL=$(grep -o '?v=[0-9][0-9.]*"' index.html | wc -l | tr -d ' ')
[ -n "$V" ] && [ "$NTAG" = "$NALL" ] && [ "$NTAG" != "0" ] && ok "版本一致:v$V(?v= 命中 $NTAG/$NALL)" || bad "版本双改没做全:APP_VERSION=v$V 但 ?v=$V 命中 $NTAG/$NALL(见 CLAUDE.md 改版本必做)"

# 5) SQL 运行顺序文档一致:CLAUDE.md 必须提到 minutes.sql(防再照过期清单重建库)
grep -qE 'minutes\.sql|relationships,minutes' CLAUDE.md && ok "CLAUDE.md SQL 清单含 minutes(全写或花括号缩写)" || bad "CLAUDE.md SQL 运行清单过期(缺 minutes.sql;以 FEATURES §4.2 为准)"

# 6a) father_id 退役列写入(硬项,v0.46 起):单一真源=relationships 的 father 边;任何 .js 出现 father_id: 赋值即 FAIL
#     (v0.46 已清掉 db.js purge/merge 里仅剩的两处;tools-spouse 只清 spouse 不碰 father_id,故无白名单)
#     注:先把行内 // 注释尾巴切掉再判(awk -F'//' 取 $1),别用 grep -v '//' ——那会把任何带行尾注释的整行豁免
HITS=$(grep -n 'father_id:' ./*.js 2>/dev/null | grep -v 'father_note' | awk -F'//' '$1 ~ /father_id:/' || true)
[ -z "$HITS" ] && ok "无 father_id 退役列写入(单一真源=father 边)" || bad "father_id 已退役,禁止写(改走 relationships father 边):
$HITS"

# 6b) 其它退役列写入(软项):除已记档处(tools-spouse 清 spouse)外不应新增
HITS=$(grep -n 'kind:\|mother:\|rank:\|relation_type:' ./*.js 2>/dev/null | grep -v '^./tools-spouse.js' | grep -v 'father_note' | awk -F'//' '$1 ~ /kind:|mother:|rank:|relation_type:/' || true)
[ -z "$HITS" ] && ok "无新增其它退役列写入" || warn "疑似退役列写入(核对是否合规):
$HITS"

# 7) CF 函数 SB 常量单份(只在 _shared.js;config.js 是前端那份)
HITS=$(grep -rln 'SB_ANON *=' functions/api/*.js 2>/dev/null | grep -v '_shared.js' || true)
[ -z "$HITS" ] && ok "CF 函数 Supabase 常量单份(_shared.js)" || bad "CF 函数仍有内联 SB 常量:
$HITS"

# 8) SQL 自登记(v0.48 起):每个 supabase/*.sql 末尾必须带自己的 schema_migrations 登记行
#    (跑没跑过靠 probes/check-migrations.mjs 对线上核对;这里保证"仓库侧约定"不靠人记)
MISS=""
for f in supabase/*.sql; do
  b=$(basename "$f" .sql)
  grep -q 'schema_migrations(version)' "$f" && grep -q "'$b'" "$f" || MISS="$MISS $b"
done
[ -z "$MISS" ] && ok "SQL 全部含自登记行(迁移追踪)" || bad "这些 SQL 缺自登记行(文件末尾加 insert into public.schema_migrations(version) select '<基名>' where to_regclass('public.schema_migrations') is not null on conflict (version) do nothing;):$MISS"

say ""
if [ "$FAIL" = "0" ]; then say "=== ship-checks: ALL PASS ✓ ==="; else say "=== ship-checks: 有 FAIL,先修再发版 ==="; exit 1; fi
