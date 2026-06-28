# 谱系 · 人物关系图谱(Cloudflare Pages + Supabase)

前后端分离的「人物 + 人际关系 + 关系图谱」应用(由家族族谱演化而来,仍能做家谱,但不限一族一姓):**静态前端**(Cloudflare Pages 托管)+ **Supabase**(Postgres 存数据 / Auth 管登录 / Storage 存照片)。各自**邮箱+密码**登录;**editor 可编辑、viewer 只读**;未登录看不到任何数据(RLS 把门)。

架构为属性图三层:**L1 人(节点,纯个人属性)/ L2 关系(独立边表)/ L3 派生(家族/世代/字辈/树/图谱)**。

> 仓库**只含代码**,不含任何家谱数据或密钥(数据在 Supabase)。`config.js` 里的 anon key 是公开安全的;**service_role 密钥永不入库**。

## 文件
```
index.html app.js db.js config.js style.css   ← 静态前端(CF Pages 根目录)
supabase/  schema.sql policies.sql functions.sql  ← 在 Supabase SQL Editor 里跑
scripts/   migrate.mjs                          ← 一次性数据迁移(本地跑)
```
- `db.js`:数据访问层,用 supabase-js 复刻原本地版的 REST 行为(登录/角色、照片 Storage、历史撤销、导出 CSV/GEDCOM/分享HTML/JSON 全在客户端)。

---

## 部署步骤(一次)

### 1. Supabase(建项目 + 跑 SQL + 开登录 + 建桶 + 邀请家人)
1. https://supabase.com 新建项目,**Region 选 Singapore / Tokyo**(离国内近些)。
2. SQL Editor 依次整段运行:`supabase/schema.sql` → `policies.sql` → `functions.sql`。
3. Authentication → Providers → **Email 开启**;Authentication → Settings → **关闭 "Allow new users to sign up"**(只邀请、不自助注册)。
4. Authentication → Users → **Add user**:给每位家人建邮箱+密码(勾 auto-confirm)。给每人设角色:编辑 user → **app_metadata** 填 `{"role":"editor"}`(可编辑)或 `{"role":"viewer"}`(只读)。
5. Storage → 确认有名为 `photos` 的**公开**桶(policies.sql 已自动建);原谱影像放在桶内 **`yuanpu`** 文件夹(Supabase 文件夹用拼音,前端已对齐 `yuanpu/p1..p4.jpg`)。
6. Settings → API 抄下 **Project URL** 和 **anon public key**。

### 2. 填配置 + 发到 GitHub
1. 把上一步的 URL / anon key 填进 `config.js`。
2. `git add -A && git commit -m "set config" && git push`(本仓库)。

### 3. Cloudflare Pages(连 GitHub 自动部署)
1. https://dash.cloudflare.com → Workers & Pages → Create → Pages → **Connect to Git** → 选本仓库。
2. 构建设置:Framework preset = **None**;Build command = **留空**(纯静态);Build output directory = **/**(仓库根)。
3. Save & Deploy → 得到 `https://<项目>.pages.dev`。**不需要**配置 Cloudflare Access。

### 4. 一次性导入现有数据(66 人 + 家史 + 4 张原谱)
在本地仓库:
```bash
SUPABASE_URL=https://xxxx.supabase.co \
SUPABASE_SERVICE_ROLE=eyJ...service_role... \
node scripts/migrate.mjs <导出JSON路径> "<含 p1..p4.jpg 的原谱目录>"
```
> service_role key 在 Supabase → Settings → API(标着 secret 那个)。**只在本地命令行用一次,绝不写进任何文件或提交。**

### 5. 验证
- 浏览器打开 `pages.dev`:出现登录框 → 用编辑账号登录 → 能看人/改人/传照片;用只读账号登录 → 看得到、改不了。
- 负向探针(证明 RLS 把门):不登录、仅 anon key `curl` 读 `…/rest/v1/persons` 应返回**空数组/401**(不是数据)。

---

## 安全与边界
- **anon key 公开安全**:未登录 RLS 拒绝一切读写;仓库公开亦可(本默认私有,稳妥)。
- **service_role 铁律**:能绕过所有 RLS——绝不进前端/仓库/日志;万一泄露,Supabase → Settings → API **立即 reset**。
- **照片**:`photos` 为公开桶(图片 URL 可直接访问,对象名用 uuid 不可枚举);文字数据仍受 RLS 保护。要更严可改私有桶 + 签名URL(db.js 的 `photoUrl` 留了切换点)。
- **大陆访问**:CF Pages 与 Supabase 是境外基建,大陆**常能用但不保证稳定**,且无 ICP 备案。要保证稳定需自有域名 + 备案(另起方案)。**建议定期点"备份JSON"留底**,数据不被锁死。
- **备份/恢复**:备份 = 点"备份JSON"下载;恢复 = 操作历史页"上传JSON恢复"(覆盖全部,先备份)。Supabase 平台另有自动备份。
