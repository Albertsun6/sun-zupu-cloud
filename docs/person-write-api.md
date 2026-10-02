# 写人接口(第一版)

给主人的聊天助手用的**写入**接口。调用方是服务器到服务器,不是浏览器。

线上正式域:`https://sun-zupu-cloud.pages.dev`  
预览域:Cloudflare Pages 给分支部署的 `*.pages.dev`(见对应 PR)。

第一版只做:**新建人物、同名查重/confirm、部分改字段、挂/改父子边、软删/彻底删、按网页格式写 history**。  
配偶和存照片是第二版,端点已留好,现在会明确拒绝(不是静默成功)。

只读查询仍是 [`docs/person-api.md`](person-api.md) 的 `GET /api/person`,用另一枚令牌。

## 鉴权

写接口请求头必须带:

```
Authorization: Bearer <PERSON_WRITE_TOKEN>
```

- 令牌从 Cloudflare 环境变量 `PERSON_WRITE_TOKEN` 读取,用 SHA-256 后的常数时间比较(与只读同一套 `requireServiceToken`)。
- **没配写令牌、没带令牌、令牌不对、拿只读 `PERSON_API_TOKEN` 来写:一律 HTTP 401**,JSON `{"error":"未授权"}`(fail-closed,文案相同,避免探测「配没配」)。
- 只读 `GET /api/person` **不认**写令牌,仍只认 `PERSON_API_TOKEN`。两枚令牌不要混用。
- 不开放 CORS。

生成令牌示例:

```bash
openssl rand -hex 32
```

## 所需环境变量

都在 Cloudflare Pages → Settings → Environment variables。第一版建议**先只配 Preview**,确认真实写入脚本跑干净后再考虑 Production。

| 变量 | 类型 | 值从哪来 |
|---|---|---|
| `PERSON_WRITE_TOKEN` | **Secret**(加密) | 自己用 `openssl rand -hex 32` 生成,只告诉聊天助手。**与 `PERSON_API_TOKEN` 必须不同** |
| `SUPABASE_URL` | 普通变量即可 | 与查人接口相同(项目里多半已有) |
| `SUPABASE_SERVICE_ROLE` | **Secret**(加密) | 与查人/纪要/用户管理同名,沿用即可 |

配完 Preview 变量后,当时那次预览部署多半还是旧环境,需要 **Retry deployment** 或再推一个提交,新变量才会进运行中的函数。

**预览连的是正式库。**没配写令牌时写接口全拒,这是保护;配上之后预览上的写入就是真写入。先用 `probes/person-write-live.mjs` 带明显测试姓名跑,脚本末尾会彻底删掉测试人。

## 端点一览

| 方法 | 路径 | 作用 | 第一版 |
|---|---|---|---|
| `POST` | `/api/person` | 新建人物(可顺带 `father_id`) | 做 |
| `PATCH` | `/api/person?id=` | 部分改字段(可顺带改父) | 做 |
| `POST` | `/api/person/relation` | 给已有人挂/改/清空父子边 | 做(`type=father`) |
| `DELETE` | `/api/person?id=` | 软删进回收站;`?purge=1` 彻底删 | 做(给清理/对齐网页删除) |
| `GET` | `/api/person` | 只读查人 | 原接口,行为不变 |
| `POST` | `/api/person/photo` | 存照片 | **第二版**,现回 501 |
| `POST` | `/api/person/relation` + `type=spouse` | 配偶 | **第二版**,现回 400 |

只开放上表方法。不要用 PUT。

## 字段(与网页 FORM_KEYS 对齐)

可写字段(新建/PATCH):

`name`(必填) `char_gen` `alias` `sex` `birth` `birth_lunar` `birth_time` `death` `death_lunar` `birth_place` `burial` `alive` `occupation` `company` `residence` `contact` `address` `deeds` `source` `status` `note`

另可带控制字段:`confirm` `father_id` `idempotency_key` `id`(仅新建时可选) `purge`(仅删除)。

**不写退役列:** `gen` `kind` `mother` `rank` `relation_type` `father_note` `spouse` `father_id`(人物表那一列)。请求里的 `father_id` 只表示「挂父子边」,落 `relationships` 的 `type=father`(from=父, to=子),与网页 `reconcileFatherEdge` 相同。

校验:

| 项 | 规则 |
|---|---|
| 姓名 | 新建必填,最长 64 |
| `sex` | 空 / `男` / `女` |
| `alive` | 空 / `是` / `否`;新建未给时默认 `是`(与 `db.js createPerson` 兜底一致) |
| `status` | 空 / `确认` / `存疑` / `待考` / `待补` |
| 其它 | 必须是字符串;短字段 32–200 字,`deeds`/`note` 最长 4000 |
| `id` | 可选;不给则按网页 `nextId`:`S` + 全表已有 `字母+数字` 编号的最大值 + 1,至少三位数 |
| 请求体 | 必须是 JSON 对象,最大 64KB |

成功响应**不回** `contact`/`address`(与只读接口一致);这两列可以写入。

## 查重

新建前按网页 `DEDUP.sameName`:在世(`deleted=0`)里**精确匹配 `name`**。

有同名且请求没带 `confirm=true` → **HTTP 409**,返回候选,不建人。调用方可以:

1. 带 `confirm=true` 再 POST,强制新建(同名可能是不同人);
2. 改用 `PATCH /api/person?id=` 更新某个已有 id。

## 幂等

网络重试避免重复新建:请求头 `Idempotency-Key` 或 JSON 字段 `idempotency_key`(8–128 位,`A-Za-z0-9._:-`)。

同一把钥匙的成功新建会在 history.summary 里留下 `[聊天助手][idem:钥匙] …`。再收到同一把钥匙,直接回上次那个人,`idempotent: true`,不再 insert。

PATCH / 挂关系也认这把钥匙(只回放同 action + 同一人)。钥匙请按「一次用户意图」生成,不要全局复用。

## 历史与撤销

每次成功写入都按网页 `logHist` 插 `history` 行:

- `action` / `entity` / `entity_id` / `before` / `after` / `undone=0` 与 `db.js` 相同,所以网页「操作历史」的撤销按钮认得出:
  - 新建人物 → `create:person` → 撤销=移入回收站
  - 改字段 → `update:person` → 撤销=按 `before` 还原 `EDITABLE` 字段
  - 挂父 → `create:relationship`,`entity_id`=边的数字 id → 撤销=按 id 删边
  - 改父(先删旧边) → `delete:relationship`,带 `before` 整行 → 撤销=重建旧边
  - 软删 → `delete:person` → 撤销=从回收站恢复
  - 彻底删 → `purge:person` → 撤销=只重建人物基本信息(与网页同样的能力边界)
- `summary` 前缀 `[聊天助手]`(有幂等钥匙时是 `[聊天助手][idem:钥匙]`),网页说明列能直接看见来源。
- `ts` 用北京时间 `YYYY-MM-DD HH:MM:SS`(网页是浏览器本地时间,撤销不看 ts)。

history 自己插入失败时,**主数据仍算成功**,响应带 `warning`,与网页留痕 fail-loud 同一取舍。

## 调用示例

```bash
# 新建(无同名)
curl -sS -A "Mozilla/5.0" \
  -H "Authorization: Bearer $PERSON_WRITE_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: demo-create-0001" \
  -d '{"name":"孙例","sex":"男","occupation":"务农"}' \
  "$BASE/api/person"

# 同名时强制新建
curl -sS -A "Mozilla/5.0" \
  -H "Authorization: Bearer $PERSON_WRITE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"孙例","confirm":true}' \
  "$BASE/api/person"

# 部分更新 + 挂父
curl -sS -A "Mozilla/5.0" -X PATCH \
  -H "Authorization: Bearer $PERSON_WRITE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"note":"助手补记","father_id":"S001"}' \
  "$BASE/api/person?id=S099"

# 只改父子边(father_id 空字符串=清空)
curl -sS -A "Mozilla/5.0" \
  -H "Authorization: Bearer $PERSON_WRITE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"father","child_id":"S099","father_id":"S001"}' \
  "$BASE/api/person/relation"

# 软删 / 彻底删
curl -sS -A "Mozilla/5.0" -X DELETE \
  -H "Authorization: Bearer $PERSON_WRITE_TOKEN" \
  "$BASE/api/person?id=S099"
curl -sS -A "Mozilla/5.0" -X DELETE \
  -H "Authorization: Bearer $PERSON_WRITE_TOKEN" \
  "$BASE/api/person?id=S099&purge=1"
```

探测请带浏览器 User-Agent。Cloudflare 会拦默认 python-urllib 一类 UA(错误 1010)。

## 返回样例(假数据,仅作格式说明)

新建成功:

```json
{
  "ok": true,
  "action": "created",
  "idempotent": false,
  "person": {
    "id": "S099",
    "name": "孙例",
    "alias": "",
    "sex": "男",
    "char_gen": "",
    "birth": "",
    "birth_lunar": "",
    "birth_time": "",
    "death": "",
    "death_lunar": "",
    "birth_place": "",
    "burial": "",
    "alive": "是",
    "occupation": "务农",
    "company": "",
    "residence": "",
    "deeds": "",
    "source": "",
    "status": "",
    "note": ""
  },
  "father": null,
  "history_ids": [1201]
}
```

同名未确认:

```json
{
  "error": "存在同名人物，未新建",
  "code": "duplicate_name",
  "count": 1,
  "candidates": [
    { "id": "S099", "name": "孙例", "alias": "", "sex": "男", "char_gen": "", "birth": "", "alive": "是", "father": { "id": "S001", "name": "孙甲" } }
  ],
  "hint": "带 confirm=true 强制新建，或改用 PATCH /api/person?id= 更新已有人"
}
```

挂父成功:

```json
{
  "ok": true,
  "action": "father_set",
  "idempotent": false,
  "child_id": "S099",
  "father_id": "S001",
  "previous_father_id": null,
  "changed": true,
  "history_ids": [1204]
}
```

## 错误码

| HTTP | `code` | 何时 |
|---|---|---|
| 401 | (无,`error=未授权`) | 没配/没带/错写令牌,或拿读令牌来写 |
| 400 | `validation` | 缺字段、类型/枚举/长度不对 |
| 400 | `retired_field` | 试图写退役列 |
| 400 | `unsupported_relation` | `type` 不是 `father`(含第二版的 spouse) |
| 400 | `method_not_allowed` | 方法不对 |
| 404 | `not_found` / `father_not_found` | 人或父亲不存在/已在回收站 |
| 409 | `duplicate_name` | 同名未 confirm |
| 409 | `id_exists` / `id_conflict` | 指定 id 已占用,或自动取号撞上 |
| 413 | `payload_too_large` | 请求体 > 64KB |
| 501 | `not_implemented` | `POST /api/person/photo` |
| 503 | (无) | 未配 `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE` |
| 502 | (无) | 上游 Supabase 失败(不回传上游响应体) |

## 真实写入测试(不进 CI)

配好 Preview 的 `PERSON_WRITE_TOKEN` 并重新部署之后:

```bash
PERSON_WRITE_BASE="https://<预览>.pages.dev" \
PERSON_WRITE_TOKEN="…" \
PERSON_API_TOKEN="…" \
node probes/person-write-live.mjs
```

脚本会用「测试勿用-时间戳」建两人、测查重、挂父子、改字段、用只读 GET 核对,最后**彻底删除**测试人。详见脚本开头注释。不要对正式数据手跑,也不要把令牌写进仓库。
