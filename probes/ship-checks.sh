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

# 2) CF 函数错误脱敏:响应里不得回传上游 body/模型原始输出(raw: 字段);_shared 豁免
HITS=$(grep -rn 'raw:' functions/api/*.js 2>/dev/null | grep -v '_shared.js' || true)
[ -z "$HITS" ] && ok "CF 函数无 raw: 回传" || bad "CF 函数把模型原始输出回传给客户端:
$HITS"

# 3) 前端 Supabase I/O 只准出现在 db.js(config.js 是常量)
HITS=$(grep -n 'sb\.from\|sb\.auth\|sb\.storage\|sb\.rpc' ./*.js 2>/dev/null | grep -v '^./db.js' || true)
[ -z "$HITS" ] && ok "前端 Supabase 调用全部收口在 db.js" || bad "db.js 之外出现 Supabase 直连:
$HITS"

# 4) 版本双改:APP_VERSION 与 index.html 全部 ?v= 一致
V=$(grep -o 'APP_VERSION = "v[0-9.]*"' app.js | grep -o '[0-9.]*' | head -1)
NTAG=$(grep -c "?v=$V" index.html || true)
NALL=$(grep -c '\.js?v=' index.html || true)
[ -n "$V" ] && [ "$NTAG" = "$NALL" ] && ok "版本一致:v$V(?v= 命中 $NTAG/$NALL)" || bad "版本双改没做全:APP_VERSION=v$V 但 ?v=$V 命中 $NTAG/$NALL(见 CLAUDE.md 改版本必做)"

# 5) SQL 运行顺序文档一致:CLAUDE.md 必须提到 minutes.sql(防再照过期清单重建库)
grep -qE 'minutes\.sql|relationships,minutes' CLAUDE.md && ok "CLAUDE.md SQL 清单含 minutes(全写或花括号缩写)" || bad "CLAUDE.md SQL 运行清单过期(缺 minutes.sql;以 FEATURES §4.2 为准)"

# 6) 退役列写入(软项):除已记档的 3 处(db.js 合并/彻删迁移 father_id、tools-spouse 清 spouse)外不应新增
HITS=$(grep -n 'father_id:\|kind:\|mother:\|rank:\|relation_type:' ./*.js 2>/dev/null | grep -v '^./db.js' | grep -v '^./tools-spouse.js' | grep -v 'father_note\|//' || true)
[ -z "$HITS" ] && ok "无新增退役列写入" || warn "疑似退役列写入(核对是否合规):
$HITS"

# 7) CF 函数 SB 常量单份(只在 _shared.js;config.js 是前端那份)
HITS=$(grep -rln 'SB_ANON *=' functions/api/*.js 2>/dev/null | grep -v '_shared.js' || true)
[ -z "$HITS" ] && ok "CF 函数 Supabase 常量单份(_shared.js)" || bad "CF 函数仍有内联 SB 常量:
$HITS"

say ""
if [ "$FAIL" = "0" ]; then say "=== ship-checks: ALL PASS ✓ ==="; else say "=== ship-checks: 有 FAIL,先修再发版 ==="; exit 1; fi
