# zupu-backup —— 每日自动异地备份(Cloudflare Worker → R2)

关系图谱的全量**数据 JSON**(persons/relationships/marriages/media 元数据/narratives/纪要文本…共 12 张表)每天自动拓一份到 Cloudflare R2 私有桶。不再只靠"人记得点导出"。录音音频不在此备份(在 Supabase 私有桶,另有平台侧备份)。

## 安全模型
- `service_role` 只在本 Worker 的 secret 里(与现有 Pages Functions 同级信任),**绝不入前端/仓库**。
- Worker **只把数据写进 R2,永不把数据回给任何调用方**:cron 无返回;`/run` 手动触发也只回 `{ok, key, 各表行数}`,不回数据体。即便 `BACKUP_TOKEN` 泄露,攻击者最多触发几次多余备份(写进你自己的私有 R2),拿不到数据。
- R2 桶必须**私有**(默认即私有,别开公开访问)。

## 部署(二选一)

### A. Cloudflare 后台(无需装 CLI)
1. **建 R2 桶**:CF 后台 → R2 → Create bucket,名字 `zupu-backups`(保持私有)。
2. **建 Worker**:Workers & Pages → Create → Worker,名字 `zupu-backup`,把 `worker.js` 全文粘进编辑器,Deploy。
3. **绑定 R2**:该 Worker → Settings → Bindings → Add → R2 bucket,Variable name 填 `BACKUP_BUCKET`,选桶 `zupu-backups`。
4. **加 secret**:该 Worker → Settings → Variables and Secrets →
   - `SUPABASE_URL`(Secret)= 你的 Supabase Project URL(与 Pages 里那份同一个)。
   - `SUPABASE_SERVICE_ROLE`(Secret)= 你的 Supabase service_role key(与 Pages 里那份同一个)。
   - `BACKUP_TOKEN`(Secret)= 自己随便定一串长随机字符串(仅用于 `/run` 手动测试)。
5. **加 cron**:该 Worker → Settings → Triggers → Cron Triggers → Add → `0 19 * * *`(每日北京 03:00)。
6. **测一次**:浏览器/命令行 `POST https://zupu-backup.<你的子域>.workers.dev/run` 带头 `x-backup-token: <BACKUP_TOKEN>`,应回 `{ok:true, key:"backup-YYYY-MM-DD.json", counts:{...}}`;去 R2 桶里能看到该文件。

### B. wrangler CLI
```
npx wrangler r2 bucket create zupu-backups
cd backup-worker && npx wrangler deploy
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_ROLE
npx wrangler secret put BACKUP_TOKEN
```
cron 与 R2 绑定已在 `wrangler.toml`。

## 恢复
从 R2 下载某天的 `backup-YYYY-MM-DD.json`,即一份完整数据快照,可据此重建库(结构同 app 的「备份 JSON」导出)。**文件名按北京日期**(每天北京 03:00 生成的那份就叫当天的日期)。

## 说明
- 每日一份、同日重跑覆盖当天;不自动删旧档(JSON 每份约几百 KB,累积多年仍远小于 R2 免费 10GB)。想要过期清理可在 R2 桶设 lifecycle 规则。
- **没有主动告警**:cron 失败只进 CF 的 Worker 日志,不会通知任何人(空库/key 贴错已有哨兵拒写,但 key 失效=停更)。**建议每月去 R2 桶看一眼最新文件的日期和大小**;在 Supabase reset 过 service_role 后,记得同步更新本 Worker 的 secret。
- **免费档上限**:Workers Free 单次调用最多 50 个子请求(每千行一个 + R2 写一个;当前全库 ~13 个,余量大)。若多年后 history 累积到数万行逼近上限,升级付费档或再拆分即可——到时备份会整体报错,不会静默截断。
