# 查人接口 `GET /api/person`

给主人的聊天助手用的**只读**查询。调用方是服务器到服务器,不是浏览器。写入见 [`docs/person-write-api.md`](person-write-api.md)(另一枚 `PERSON_WRITE_TOKEN`,读令牌不能写)。

线上正式域:`https://sun-zupu-cloud.pages.dev`  
预览域:Cloudflare Pages 给分支部署的 `*.pages.dev`(见对应 PR)。

## 鉴权

请求头必须带:

```
Authorization: Bearer <PERSON_API_TOKEN>
```

- 令牌从 Cloudflare 环境变量 `PERSON_API_TOKEN` 读取,用 SHA-256 后的常数时间比较。
- **没配令牌、没带令牌、令牌不对:一律 HTTP 401**,JSON `{"error":"未授权"}`(fail-closed,三种情况同文案)。
- 不开放 CORS,浏览器跨域调用会被同源策略挡住;请在助手后端用 curl/fetch 调。

生成令牌示例:

```bash
openssl rand -hex 32
```

## 参数

| 参数 | 说明 |
|---|---|
| `id` | 人物稳定 ID,精确查一人(只允许 `A-Za-z0-9._-`,最长 64) |
| `name` | 姓名。先精确匹配 `name` 或 `alias`;没有精确命中再按子串模糊匹配 |

`id` 与 `name` 同时给时**只认 id**。两个都不给 → 400。

## 所需环境变量

都在 Cloudflare Pages → Settings → Environment variables。本接口建议**只配 Preview**,不要动 Production。

| 变量 | 类型 | 值从哪来 |
|---|---|---|
| `PERSON_API_TOKEN` | **Secret**(加密) | 自己用 `openssl rand -hex 32` 生成,只告诉聊天助手 |
| `SUPABASE_URL` | 普通变量即可 | Supabase → Project Settings → API → Project URL(形如 `https://xxxx.supabase.co`) |
| `SUPABASE_SERVICE_ROLE` | **Secret**(加密) | 同页 **`service_role` secret**(不是 anon)。项目里已有同名变量,沿用这个名字 |

配完 Preview 变量后,预览部署当时多半还是旧环境,需要 **Retry deployment** 或再推一个提交,新变量才会进运行中的函数。

## 返回字段(成功、单人)

顶层:`match` = `id` | `exact` | `fuzzy`;`person` = 下面这些。

**会返回(族谱类):**

`id` `name` `alias` `sex` `generation`(按父子/母子边推算,与页面 `genOf` 同算法) `char_gen`  
`birth` `birth_lunar` `birth_time` `birth_place` `death` `death_lunar` `alive`  
`rank` `relation_type` `kind` `occupation` `company` `residence` `burial`  
`deeds` `source` `status` `note` `father_note`  
`parents.father` / `parents.mother`(各带 `id`+`name`;没有边时母亲可能只有旧文本名、`id` 为 `null`)  
`spouses[]` `children[]`(子女另带 `sex`)  
`photo_url` `photos[]` `photo_expires_in`

**故意不返回:**

- `contact`(联系方式)
- `address`(住址)
- 电话 / 证件(表里目前没有这类列)
- `father_id`(已退役,父母以 `relationships` 的 father/mother 边为准)
- 软删记录(`deleted=1`)
- 原始 Storage 对象 key(只给签名后的可打开地址)

`residence`(居住地/迁徙)算族谱记载,会返回;它不是 `address`。

## 照片

- 桶名 `photos`(现网是公开桶,对象名 uuid 不可枚举)。
- 本接口**不返回永久公链**,而是用 service role 调 Storage `object/sign`,签发**1 小时**(3600 秒)有效的签名 URL。
- 选签名而不是接口代理图片:助手可直接把链接丢进聊天;CF 函数不用扛图流量;以后若按 ADR 把桶改私有,同一套签名仍然可用。
- 没有照片:`photo_url` 为 `null`,`photos` 为 `[]`,`photo_expires_in` 为 `null`。
- 签名失败(桶/key 问题)也按没有照片处理,不让整次查询失败。

## 调用示例

```bash
# 按姓名
curl -sS -H "Authorization: Bearer $PERSON_API_TOKEN" \
  "https://sun-zupu-cloud.pages.dev/api/person?name=$(printf %s '孙甲' | jq -sRr @uri)"

# 按 id(重名时用这个)
curl -sS -H "Authorization: Bearer $PERSON_API_TOKEN" \
  "https://sun-zupu-cloud.pages.dev/api/person?id=S004"
```

把域名换成预览地址即可打预览。没配令牌时上面两条都会 401,这是预期。

## 返回样例(假数据,仅作格式说明)

成功单人:

```json
{
  "match": "exact",
  "person": {
    "id": "S001",
    "name": "孙甲",
    "alias": "甲公",
    "sex": "男",
    "generation": 1,
    "char_gen": "德",
    "birth": "1901",
    "birth_lunar": "",
    "birth_time": "",
    "birth_place": "",
    "death": "",
    "death_lunar": "",
    "alive": "",
    "rank": "",
    "relation_type": "",
    "kind": "本族",
    "occupation": "务农",
    "company": "",
    "residence": "吉林",
    "burial": "",
    "deeds": "",
    "source": "",
    "status": "",
    "note": "始迁祖",
    "father_note": "",
    "parents": { "father": null, "mother": null },
    "spouses": [],
    "children": [{ "id": "S002", "name": "孙乙", "sex": "男" }],
    "photo_url": "https://xxxx.supabase.co/storage/v1/object/sign/photos/people/S001/a.jpg?token=…",
    "photos": ["https://xxxx.supabase.co/storage/v1/object/sign/photos/people/S001/a.jpg?token=…"],
    "photo_expires_in": 3600
  }
}
```

重名候选(请再按 `id` 查一次):

```json
{
  "match": "ambiguous",
  "count": 2,
  "candidates": [
    { "id": "S002", "name": "孙乙", "alias": "", "sex": "男", "generation": 2, "char_gen": "永", "birth": "1930", "alive": "", "father": { "id": "S001", "name": "孙甲" }, "has_photo": false },
    { "id": "S003", "name": "孙乙", "alias": "", "sex": "女", "generation": 2, "char_gen": "永", "birth": "1932", "alive": "是", "father": { "id": "S001", "name": "孙甲" }, "has_photo": false }
  ]
}
```

查无此人:

```json
{ "error": "未找到此人", "query": { "name": "没有这个人" } }
```
