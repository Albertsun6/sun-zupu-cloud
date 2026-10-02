# 写人接口

给主人的聊天助手用的**写入**接口。调用方是服务器到服务器,不是浏览器。

线上正式域:`https://sun-zupu-cloud.pages.dev`  
预览域:Cloudflare Pages 给分支部署的 `*.pages.dev`(见对应 PR)。**真实写入脚本请优先用分支别名地址**,不要用会随每次部署变掉的 hash 预览。

只读查询仍是 [`docs/person-api.md`](person-api.md) 的 `GET /api/person`,用另一枚令牌。

第一版:新建 / 查重 / 部分更新 / 父子边 / 软删·彻底删 / history。  
第二版:配偶边、存/删照片。写响应里的 `father` / `spouses` **一律从 `relationships` 现查**,不读退役列 `father_id` / `spouse`。

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

都在 Cloudflare Pages → Settings → Environment variables。建议先配 **Preview**,确认 `probes/person-write-live.mjs` 跑干净后再考虑 Production。

| 变量 | 类型 | 值从哪来 |
|---|---|---|
| `PERSON_WRITE_TOKEN` | **Secret**(加密) | 自己用 `openssl rand -hex 32` 生成,只告诉聊天助手。**与 `PERSON_API_TOKEN` 必须不同** |
| `SUPABASE_URL` | 普通变量即可 | 与查人接口相同(项目里多半已有) |
| `SUPABASE_SERVICE_ROLE` | **Secret**(加密) | 与查人/纪要/用户管理同名,沿用即可 |

配完 Preview 变量后,当时那次预览部署多半还是旧环境,需要 **Retry deployment** 或再推一个提交,新变量才会进运行中的函数。

**预览连的是正式库。**配上写令牌之后预览上的写入就是真写入。

## 端点一览

| 方法 | 路径 | 作用 |
|---|---|---|
| `POST` | `/api/person` | 新建人物(可顺带 `father_id` / `spouse_id`) |
| `PATCH` | `/api/person?id=` | 部分改字段(可顺带改父 / 加一条配偶边) |
| `POST` | `/api/person/relation` | `type=father` 挂/改/清空父子;`type=spouse` 挂/解除配偶 |
| `POST` | `/api/person/photo` | 存照片(`data` base64 或 `url` https 二选一) |
| `DELETE` | `/api/person/photo?media_id=` | 删照片行(对齐网页,文件留着以便撤销);`purge=1` 连桶一起删 |
| `DELETE` | `/api/person?id=` | 软删;`?purge=1` 彻底删(先清桶里的照片) |
| `GET` | `/api/person` | 只读查人,行为不变 |

只开放上表方法。不要用 PUT。探测请带浏览器 User-Agent。Cloudflare 会拦默认 python-urllib 一类 UA(错误 1010)。

## 字段(与网页 FORM_KEYS 对齐)

可写字段(新建/PATCH):

`name`(必填) `char_gen` `alias` `sex` `birth` `birth_lunar` `birth_time` `death` `death_lunar` `birth_place` `burial` `alive` `occupation` `company` `residence` `contact` `address` `deeds` `source` `status` `note`

另可带控制字段:`confirm` `father_id` `spouse_id` `idempotency_key` `id`(仅新建时可选) `purge`。

**不写退役列:** `gen` `kind` `mother` `rank` `relation_type` `father_note` `spouse` `father_id`(人物表那一列)。请求里的 `father_id` / `spouse_id` 只表示挂边。

| 项 | 规则 |
|---|---|
| 姓名 | 新建必填,最长 64 |
| `sex` | 空 / `男` / `女` |
| `alive` | 空 / `是` / `否`;新建未给时默认 `是` |
| `status` | 空 / `确认` / `存疑` / `待考` / `待补` |
| 其它字段 | 必须是字符串;短字段 32–200 字,`deeds`/`note` 最长 4000 |
| `id` | 可选;不给则按网页 `nextId` |
| 普通请求体 | JSON 对象,最大 **64KB** |
| 照片请求体 | 单独放宽到 **16MB**(对应网页 12MB 原图的 base64) |

成功响应**不回** `contact`/`address`。`father` / `spouses` 从当前 `relationships` 边组装。

## 查重 / 幂等

新建前按网页 `DEDUP.sameName`:在世里精确匹配 `name`。有同名且没带 `confirm=true` → **409** 候选。

`Idempotency-Key` 头或 JSON `idempotency_key`(8–128 位,`A-Za-z0-9._:-`)。同一把钥匙的成功新建会回放,不再 insert。

## 父子

对齐 `app.js` `reconcileFatherEdge` + `REL.add/del`:from=父, to=子, `type=father`, `directed=true`。空 `father_id` 表示清空。不写 `persons.father_id`。

## 配偶

对齐网页详情页 / `tools-spouse.js` 的实际写法:`window.REL.add({ type:"spouse" })`。

- 只写 `relationships`:`type=spouse`, `directed=false`, 规范序 `from_id < to_id`(与 `db.js addRelationship` 对称边相同)
- **不写**退役列 `persons.spouse`
- **不写** `marriages` 表(网页加「夫妻」关系时也不写;该表只给旧文本婚姻/导出留着)
- 一人可以有多个配偶;空 `spouse_id` 不会清掉已有配偶。解除必须 `unlink=true` 并同时给两个人的 id
- 不自动跑网页的「建议补录子女」弹窗(`maybeSuggestSpouseCoParent`)
- 可选 `note`(名分,如原配/续娶)、`start_date`(婚年)、`end_date`

```json
POST /api/person/relation
{ "type":"spouse", "person_id":"S099", "spouse_id":"S100", "note":"原配", "start_date":"1998" }

{ "type":"spouse", "person_id":"S099", "spouse_id":"S100", "unlink":true }
```

新建/PATCH 也可带 `spouse_id`,风格与 `father_id` 相同(先校验对方存在再挂边)。

## 照片

对齐 `db.js addMedia` / `refreshPrimary` / `delMedia`:

- 格式:jpeg / png / webp / gif(看文件头魔数,不信扩展名或声明的 Content-Type)
- 大小:解码后 **≤12MB**(与网页一致)
- 存盘:`photos` 桶 `people/<id>/<uuid>.<ext>`
- `media` 行:`is_primary=0`, `sort_order=999`;然后 `refreshPrimary`(没主图就把第一张升主图,并写 `persons.photo` 路径——这是网页主图镜像,不是退役列)
- `data`(原始 base64 或 `data:image/...;base64,...`)与 `url` **二选一**
- `url` 防 SSRF:只允许 https、默认 443、不带用户名密码、拒 localhost/内网/链路本地/ULa、**不跟随跳转**、10 秒超时、先看 Content-Length 再读、再用魔数校验
- 返回 1 小时签名 URL,字段名与只读接口一致:`photo_url` / `photos` / `photo_expires_in`

删除:

- `DELETE /api/person/photo?media_id=123` — 对齐网页:只删 `media` 行,桶里文件留下,history `delete:media`(entity_id=人物 id,带 before)。网页「操作历史」**可以撤销**,会把行插回去。
- `?purge=1` — 连桶一起删,给测试清理用。撤销插得回行但文件没了。

上传 history 是 `photo:person`,与网页相同,**不在 UNDOABLE 里**,网页没有「撤销上传」按钮。

彻底删除人物(`DELETE /api/person?id=&purge=1`)会先按路径清桶,再删 media / marriages / person 行(对齐 `purgePerson`)。

## 历史与撤销

| 操作 | action:entity | 网页撤销 |
|---|---|---|
| 新建人物 | `create:person` | 移入回收站 |
| 改字段 | `update:person` | 按 `before` 还原 |
| 挂父 / 挂配偶 | `create:relationship` | 按边 id 删除 |
| 改父 / 解除配偶 | `delete:relationship` + `before` | 重建旧边 |
| 软删人 | `delete:person` | 从回收站恢复 |
| 彻底删人 | `purge:person` | 只重建人物基本信息 |
| 上传照片 | `photo:person` | **不可撤**(与网页相同) |
| 删照片 | `delete:media` | 重建 media 行(文件需还在桶里) |

`summary` 前缀 `[聊天助手]`。

## 调用示例

```bash
BASE="https://cursor-person-write-api-e940.sun-zupu-cloud.pages.dev"

# 挂配偶
curl -sS -A "Mozilla/5.0" \
  -H "Authorization: Bearer $PERSON_WRITE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"spouse","person_id":"S099","spouse_id":"S100"}' \
  "$BASE/api/person/relation"

# 存照片(极小 png 的 base64)
curl -sS -A "Mozilla/5.0" \
  -H "Authorization: Bearer $PERSON_WRITE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"id":"S099","data":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII="}' \
  "$BASE/api/person/photo"

# 删照片(测试清理加 purge=1)
curl -sS -A "Mozilla/5.0" -X DELETE \
  -H "Authorization: Bearer $PERSON_WRITE_TOKEN" \
  "$BASE/api/person/photo?media_id=1&purge=1"
```

## 返回样例(假数据)

PATCH 已有父边的人(只改字段,`father` 仍从边来,不会是 null):

```json
{
  "ok": true,
  "action": "updated",
  "idempotent": false,
  "person": { "id": "S342", "name": "孙例", "occupation": "教师", "alive": "是" },
  "changed": ["occupation"],
  "father": { "id": "S341", "name": "孙父" },
  "spouses": [{ "id": "S340", "name": "孙偶" }],
  "history_ids": [1302]
}
```

挂配偶:

```json
{
  "ok": true,
  "action": "spouse_set",
  "idempotent": false,
  "person_id": "S099",
  "spouse_id": "S100",
  "from_id": "S099",
  "to_id": "S100",
  "directed": false,
  "changed": true,
  "father": null,
  "spouses": [{ "id": "S100", "name": "孙偶" }],
  "history_ids": [1305]
}
```

上传照片:

```json
{
  "ok": true,
  "action": "photo_added",
  "person_id": "S099",
  "media": { "id": 88, "path": "people/S099/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png", "caption": "", "is_primary": 0 },
  "photo_url": "https://xxxx.supabase.co/storage/v1/object/sign/photos/people/S099/….png?token=…",
  "photos": ["https://xxxx.supabase.co/storage/v1/object/sign/photos/people/S099/….png?token=…"],
  "photo_expires_in": 3600,
  "history_ids": [1308]
}
```

## 错误码

| HTTP | `code` | 何时 |
|---|---|---|
| 401 | (无,`error=未授权`) | 没配/没带/错写令牌,或拿读令牌来写 |
| 400 | `validation` | 缺字段、类型/枚举/长度/图片格式不对 |
| 400 | `retired_field` | 试图写退役列 |
| 400 | `unsupported_relation` | `type` 不是 `father`/`spouse` |
| 400 | `ssrf` | 图片 URL 不是安全的 https 公网地址,或发生跳转 |
| 404 | `not_found` / `father_not_found` / `spouse_not_found` | 人或关系对象不存在/已在回收站 |
| 409 | `duplicate_name` | 同名未 confirm |
| 409 | `id_exists` / `id_conflict` | id 已占用 |
| 413 | `payload_too_large` | 普通请求 >64KB,或照片请求 >16MB |
| 502 | `photo_fetch` | 下载远程图片失败/超时 |
| 503 | (无) | 未配 `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE` |

## 真实写入测试(不进 CI)

Preview 已配 `PERSON_WRITE_TOKEN` 之后,用**分支别名**:

```bash
PERSON_WRITE_BASE="https://cursor-person-write-api-e940.sun-zupu-cloud.pages.dev" \
PERSON_WRITE_TOKEN="…" \
PERSON_API_TOKEN="…" \
node probes/person-write-live.mjs
```

脚本带浏览器 User-Agent。顺序:建两人 → 查重 → 挂父子 → 挂配偶 → 改字段 → 传 1×1 png → GET 核对并打开签名照片 → 删照片(purge)→ 解除配偶 → 彻底删除两人。history 审计记录保留。不要把令牌写进仓库。
