# 部署、迁移与恢复手册

本文是 Personal Hub 的 staging 与 production 运维流程。它描述待执行步骤，不表示任何 Cloudflare Worker、D1 数据库或 R2 桶已经创建或部署。

## 1. 环境模型

使用三个互相隔离的环境：

| 环境 | Worker | D1 | R2 | 用途 |
| --- | --- | --- | --- | --- |
| 本地顶层配置 | 本机 Vite/Workerd | `personal-hub-local` 模拟库 | `personal-hub-media-local` 模拟桶 | 开发与测试 |
| `staging` | `personal-hub-staging` | `personal-hub-staging` | `personal-hub-media-staging` | 远程验收 |
| `production` | `personal-hub-production` | `personal-hub-production` | `personal-hub-media-production` | 正式服务 |

staging 和 production 不能共享 D1、R2、管理员密钥、HMAC pepper 或登录限流 namespace。D1/R2 等绑定和 `vars` 在 Wrangler 环境中不会自动继承，必须在每个环境完整声明。[Wrangler Environments](https://developers.cloudflare.com/workers/wrangler/environments/)

## 2. 发布前准备

```powershell
npm ci
npx wrangler --version
npx wrangler login
npx wrangler whoami
```

要求 Wrangler 4.x。确认 `whoami` 显示的是计划承载该服务的 Cloudflare 账号，再创建资源。

发布前还应准备：

- staging 与 production 的最终 HTTPS Origin。
- 每个环境独立的 `ADMIN_LOGIN_SECRET` 和 `AUTH_PEPPER`。
- 唯一的登录限流 `namespace_id`；它必须是正整数字符串。同一账号内复用 namespace 会共享计数器。
- D1 与 R2 的备份目录或独立备份存储。

## 3. 创建真实 D1 与 R2

创建 staging：

```powershell
npx wrangler d1 create personal-hub-staging
npx wrangler r2 bucket create personal-hub-media-staging
```

创建 production：

```powershell
npx wrangler d1 create personal-hub-production
npx wrangler r2 bucket create personal-hub-media-production
```

记录两条 `d1 create` 输出中的 `database_id`。R2 绑定使用桶名，不使用数据库式 UUID。桶保持私有，不启用 `r2.dev` 公共访问或公开自定义域；图片统一通过 Worker 的 `/api/v1/media/:id` 鉴权读取。

用只读命令核对资源：

```powershell
npx wrangler d1 info personal-hub-staging
npx wrangler d1 info personal-hub-production
npx wrangler r2 bucket info personal-hub-media-staging
npx wrangler r2 bucket info personal-hub-media-production
```

## 4. 把真实资源写入 `wrangler.jsonc`

保留现有顶层本地配置，并在 `env` 中加入完整的 staging 与 production 配置。下面是需要合入的结构；将两个 UUID、两个 Origin 和 namespace 示例值替换为真实值：

```jsonc
{
  // 现有顶层本地配置保持不变
  "env": {
    "staging": {
      "secrets": {
        "required": ["ADMIN_LOGIN_SECRET", "AUTH_PEPPER"]
      },
      "d1_databases": [
        {
          "binding": "DB",
          "database_name": "personal-hub-staging",
          "database_id": "<STAGING_D1_DATABASE_ID>",
          "migrations_dir": "migrations"
        }
      ],
      "r2_buckets": [
        {
          "binding": "MEDIA",
          "bucket_name": "personal-hub-media-staging"
        }
      ],
      "ratelimits": [
        {
          "name": "LOGIN_RATE_LIMITER",
          "namespace_id": "1101",
          "simple": { "limit": 10, "period": 60 }
        }
      ],
      "vars": {
        "APP_ORIGIN": "https://<STAGING_HOST>",
        "SESSION_TTL_SECONDS": "604800"
      }
    },
    "production": {
      "secrets": {
        "required": ["ADMIN_LOGIN_SECRET", "AUTH_PEPPER"]
      },
      "d1_databases": [
        {
          "binding": "DB",
          "database_name": "personal-hub-production",
          "database_id": "<PRODUCTION_D1_DATABASE_ID>",
          "migrations_dir": "migrations"
        }
      ],
      "r2_buckets": [
        {
          "binding": "MEDIA",
          "bucket_name": "personal-hub-media-production"
        }
      ],
      "ratelimits": [
        {
          "name": "LOGIN_RATE_LIMITER",
          "namespace_id": "1201",
          "simple": { "limit": 10, "period": 60 }
        }
      ],
      "vars": {
        "APP_ORIGIN": "https://<PRODUCTION_HOST>",
        "SESSION_TTL_SECONDS": "604800"
      }
    }
  }
}
```

`1101`、`1201` 只是示例；应选择当前 Cloudflare 账号中未用于其他限流逻辑的正整数。顶层本地配置已经通过 `secrets.required` 声明两个秘密；命名环境不会继承该字段，因此 staging 与 production 也要像示例一样分别声明。该字段只保存必须存在的名称，不保存值。若后续在环境里增加任何非继承绑定，也要分别补齐 staging 与 production。

修改配置后执行：

```powershell
npm run types
npm run typecheck
npm run lint
npm test
npm run build
```

不要把 `00000000-0000-0000-0000-000000000000` 部署到远程环境，也不要把 production UUID 填进顶层本地绑定。

## 5. 配置远程秘密

`secrets.required` 已同时要求两个值，因此首次配置用一次 bulk 请求写入一组完整秘密。下面的变量只在当前 PowerShell 进程短暂存在；从密码管理器粘贴，命令结束后立即清除变量：

```powershell
$stagingAdminSecret = Read-Host "Staging ADMIN_LOGIN_SECRET" -MaskInput
$stagingAuthPepper = Read-Host "Staging AUTH_PEPPER" -MaskInput
@{ ADMIN_LOGIN_SECRET = $stagingAdminSecret; AUTH_PEPPER = $stagingAuthPepper } | ConvertTo-Json -Compress | npx wrangler secret bulk --env staging
Remove-Variable stagingAdminSecret, stagingAuthPepper

$productionAdminSecret = Read-Host "Production ADMIN_LOGIN_SECRET" -MaskInput
$productionAuthPepper = Read-Host "Production AUTH_PEPPER" -MaskInput
@{ ADMIN_LOGIN_SECRET = $productionAdminSecret; AUTH_PEPPER = $productionAuthPepper } | ConvertTo-Json -Compress | npx wrangler secret bulk --env production
Remove-Variable productionAdminSecret, productionAuthPepper
```

检查名称是否存在：

```powershell
npx wrangler secret list --env staging
npx wrangler secret list --env production
```

Wrangler 不会在 `secret list` 中回显秘密值。远程 secret 写入会改变目标 Worker 状态，因此只在账号、环境和 Worker 名确认无误后执行。不要把秘密放进命令参数、PowerShell 历史、临时仓库文件或 Git。Cloudflare 的现行行为见 [Workers Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)。

`AUTH_PEPPER` 不能随意轮换：现有 Agent Key 和管理员 Session 摘要依赖它。若必须轮换，需要先实现双 pepper 验证或一次性撤销并重签全部凭据；仅替换 Secret 会让所有现有凭据立即失效。

## 6. 初次部署 staging

先在远程 staging 库执行迁移：

```powershell
npx wrangler d1 migrations list DB --env staging --remote
npm run db:migrate:staging
npx wrangler d1 execute DB --env staging --remote --command "PRAGMA foreign_key_check;"
```

然后用受保护脚本构建并部署 staging：

```powershell
npm run deploy:staging
```

`scripts/deploy.mjs` 会为构建与部署设置同一个 `staging` 环境。通用 `npm run deploy` 会故意失败；不要绕过守卫直接运行 `wrangler deploy`，也不要采用“先无环境构建，再给 Wrangler 添加环境”的组合。Vite 插件会在构建时生成已经扁平化的部署配置。[Cloudflare Vite 环境选择](https://developers.cloudflare.com/workers/vite-plugin/reference/cloudflare-environments/)

初次发布完成后执行第 8 节的 staging 验收。所有高风险路径通过后才进入 production。

## 7. Production 发布顺序

### 7.1 首次发布

1. 确认 production D1、R2、Origin、限流 namespace 和两个 Secret 均独立且正确。
2. 运行完整的本地类型检查、lint、测试与构建。
3. 在 staging 运行同一提交，完成第 8 节验收。
4. 对 production 执行远程迁移。
5. 使用受保护的 production 脚本构建并部署。
6. 完成 production 只读检查，再做最小写入检查。

迁移和发布命令：

```powershell
npx wrangler d1 migrations list DB --env production --remote
npm run db:migrate:production
npx wrangler d1 execute DB --env production --remote --command "PRAGMA foreign_key_check;"

npm run deploy:production
```

`db:migrate:staging` 和 `db:migrate:production` 会先用与部署相同的配置守卫核对远程环境，再使用该环境中的 `DB` 绑定并显式带 `--remote`；不要使用已经移除的通用远程迁移脚本。执行前仍要用上面的 `migrations list` 核对目标环境和待执行文件。

### 7.2 后续版本

数据库与代码按以下规则演进：

1. 发布前创建 D1 导出和同一恢复点的 R2 副本。
2. 先在 staging 应用迁移、部署代码并验收。
3. production 先应用向后兼容的扩展迁移，再部署依赖新结构的代码。
4. 删除列、重命名和数据清理分到后续版本；先让新旧代码都能工作，再移除旧结构。
5. 每次迁移前先运行 `migrations list`，逐项核对环境名以及 `DB` 绑定解析出的数据库名。

D1 会跟踪已执行的迁移，并在单个失败迁移时回滚该迁移。仍需采用扩展—迁移数据—切换代码—清理的多阶段方式，避免运行中的旧 Worker 与新结构冲突。

## 8. 部署后 smoke checks

### 8.1 无凭据检查

- 首页返回 200、HTML 和安全响应头，前端资源无 404。
- `/api`、`/api/docs`、任意 `/api/v1/media/<不存在ID>` 在无凭据时返回 401，不泄露正文、对象键或堆栈。
- 随机 `/api/...` 路径在无凭据时仍返回 JSON 401；携带有效凭据后返回 JSON 404，均不能被 SPA fallback 改成 HTML 200。
- R2 桶没有公开 `r2.dev` URL；对象不能绕过 Worker 读取。

PowerShell 示例：

```powershell
$baseUrl = "https://<TARGET_HOST>"
Invoke-WebRequest -Uri "$baseUrl/" -Method Get
try { Invoke-WebRequest -Uri "$baseUrl/api" -Method Get } catch { $_.Exception.Response.StatusCode.value__ }
try { Invoke-WebRequest -Uri "$baseUrl/api/v1/media/not-found" -Method Get } catch { $_.Exception.Response.StatusCode.value__ }
```

### 8.2 管理员检查

在浏览器中验证：

1. 错误密钥失败并受到限流；正确密钥建立 Secure、HttpOnly、SameSite=Strict 的 Session。
2. 创建一个专用 smoke Agent，复制只显示一次的明文 Key。
3. 切换 Agent 的信息流、清单、报告布局；刷新后仍保持。
4. 创建条目，标记完成，再恢复；已读、归档和待办状态不被连带修改。
5. 上传小型 PNG，正文显示图片并能放大。
6. 退出后管理接口和图片立即不能通过旧 Session 读取。

### 8.3 Agent 权限检查

使用临时环境变量保存 smoke Key：

```powershell
$env:PERSONAL_HUB_AGENT_KEY = Read-Host "Smoke Agent Key"
$headers = @{ Authorization = "Bearer $env:PERSONAL_HUB_AGENT_KEY" }
Invoke-RestMethod -Uri "$baseUrl/api" -Headers $headers
Invoke-RestMethod -Uri "$baseUrl/api/v1/agent" -Headers $headers
Invoke-RestMethod -Uri "$baseUrl/api/v1/agent/entries" -Headers $headers
Remove-Item Env:PERSONAL_HUB_AGENT_KEY
```

还要验证普通 Agent 不能调用 `/manager` 或 `/admin`；总管能跨 Agent 读取和追加，但不能签发密钥、删除 Agent 或永久删除条目；已完成和归档内容仍出现在机器默认读取结果中。

完成后删除 smoke 条目/Agent，或明确保留为测试数据；不要把 smoke Key 保存到文档或 CI 日志。

### 8.4 数据与日志检查

```powershell
npx wrangler d1 execute <TARGET_DATABASE_NAME> --env <staging或production> --remote --command "PRAGMA foreign_key_check;"
npx wrangler d1 execute <TARGET_DATABASE_NAME> --env <staging或production> --remote --command "SELECT COUNT(*) AS agents FROM agents; SELECT COUNT(*) AS entries FROM entries; SELECT COUNT(*) AS attachments FROM attachments;"
npx wrangler tail --env <staging或production>
```

检查无未处理异常、秘密或 Bearer Key 日志。`wrangler tail` 完成观察后用 Ctrl+C 退出。

## 9. D1 与 R2 联合备份

D1 保存附件元数据，R2 保存图片字节，两者必须以同一个恢复点备份。只备份 D1 会得到缺图；只备份 R2 会失去对象与业务记录的对应关系。

### 9.1 建立一致性窗口

当前设计没有全局维护开关。执行完整备份前：

1. 暂停所有外部 Agent 调度，并在管理页停用 Agent。
2. 停止管理员写操作，等待正在进行的上传和删除结束。
3. 记录 UTC 时间、Worker 版本、D1 数据库 ID 和 R2 桶名。
4. 在无写入窗口内先复制 R2，再导出 D1；若期间出现写入，丢弃本次备份并重做。

### 9.2 导出 D1

```powershell
New-Item -ItemType Directory -Force -Path "E:\backups\personal-hub\2026-09-18T120000Z" | Out-Null
npx wrangler d1 export DB --env production --remote --output "E:\backups\personal-hub\2026-09-18T120000Z\d1.sql"
Get-FileHash "E:\backups\personal-hub\2026-09-18T120000Z\d1.sql" -Algorithm SHA256
```

导出 SQL 可用于长期、离线恢复。D1 还自动提供 Time Travel，production 存储后端可按时间或 bookmark 原地恢复；它适合短期数据库回退，不能代替 R2 副本和长期联合备份。[D1 导入与导出](https://developers.cloudflare.com/d1/best-practices/import-export-data/) · [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)

### 9.3 复制 R2

Wrangler 适合单对象操作；整桶备份使用 Cloudflare 官方文档支持的 S3 兼容工具，例如 rclone。为 production 桶创建仅限该桶的读凭据，配置私有 R2 remote 后执行：

```powershell
rclone copy "r2:personal-hub-media-production" "E:\backups\personal-hub\2026-09-18T120000Z\r2" --progress
rclone size "r2:personal-hub-media-production"
rclone size "E:\backups\personal-hub\2026-09-18T120000Z\r2"
```

使用 `copy`，避免误用会删除目标多余文件的 `sync`。访问密钥只保存到受控的凭据存储，不进入仓库。R2 endpoint 与 rclone 配置方法见 [Cloudflare R2 rclone 示例](https://developers.cloudflare.com/r2/examples/rclone/)。

备份目录还应保存一份操作清单：备份时间、环境、Git commit/Worker version、D1 UUID、R2 桶名、SQL SHA-256、R2 对象数量和总字节数。完成校验后再恢复 Agent 调度。

## 10. 恢复演练与正式恢复

恢复优先创建新 D1 和新 R2 桶，再切换绑定。这样不会覆盖当前资源，并可在切换前验证。先在 staging 演练完整流程。

### 10.1 创建恢复目标

```powershell
npx wrangler d1 create personal-hub-restore-20260918
npx wrangler r2 bucket create personal-hub-media-restore-20260918
```

记录新 D1 UUID。恢复目标应为空，不要先执行项目迁移再导入完整 D1 导出，否则可能发生表或数据冲突。

### 10.2 恢复 R2 和 D1

```powershell
rclone copy "E:\backups\personal-hub\2026-09-18T120000Z\r2" "r2:personal-hub-media-restore-20260918" --progress
npx wrangler d1 execute personal-hub-restore-20260918 --remote --file "E:\backups\personal-hub\2026-09-18T120000Z\d1.sql"
```

核对：

```powershell
npx wrangler d1 execute personal-hub-restore-20260918 --remote --command "PRAGMA foreign_key_check;"
npx wrangler d1 execute personal-hub-restore-20260918 --remote --command "SELECT COUNT(*) AS agents FROM agents; SELECT COUNT(*) AS entries FROM entries; SELECT COUNT(*) AS attachments FROM attachments;"
rclone size "r2:personal-hub-media-restore-20260918"
```

抽样核对附件元数据中的 `object_key` 在恢复桶内存在。生产切换前，应将恢复资源先绑定到独立的恢复/验收 Worker，完成登录、条目、历史版本和图片读取检查。

### 10.3 切换与回退

1. 再次暂停写入。
2. 把目标环境的 `DB.database_id` 和 `MEDIA.bucket_name` 改为恢复资源。
3. 根据目标环境运行 `npm run deploy:staging` 或 `npm run deploy:production`，由守卫脚本重新构建并部署。
4. 执行第 8 节 smoke checks。
5. 保留旧 D1、旧 R2 和原配置，直到观察期结束；不要立即删除。

若验证失败，把配置恢复到旧 D1 UUID 和旧 R2 桶名，重新构建部署。切换期间产生的新写入不会自动合并到旧资源，因此维护窗口必须持续到决定接受或回退。

### 10.4 仅回退 D1

只有确认 R2 对象无需回退时，才使用 Time Travel 原地恢复 D1：

```powershell
npx wrangler d1 time-travel info DB --env production --timestamp "<RFC3339_UTC_TIME>"
npx wrangler d1 time-travel restore DB --env production --bookmark "<BOOKMARK>"
```

恢复是覆盖性操作，会中断在途查询。执行前先记录当前 bookmark 和手工导出，以便撤销错误恢复。若目标时间附近包含附件上传或 Agent 清理，必须同时使用对应时间点的 R2 备份，不能只回退数据库。

## 11. 发布记录

每次发布至少记录：

- Git commit 与构建时间。
- Wrangler 版本和实际执行的 `deploy:staging` 或 `deploy:production` 脚本。
- Worker version/deployment ID。
- 目标 D1 UUID、R2 桶名和已执行迁移。
- 备份清单位置。
- staging 与 production smoke checks 结果。
- 回退所需的旧 Worker version、旧绑定和 D1 bookmark。

这些记录不得包含管理员密钥、AUTH pepper、Agent Key、Session Token 或 R2 Secret Access Key。
