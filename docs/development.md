# 本地开发手册

本文说明如何在本机运行、迁移和验证 Personal Hub。线上资源的创建与发布见 [deployment.md](./deployment.md)。当前 `wrangler.jsonc` 中的 D1 UUID 是本地开发占位值，不能直接用于远程部署。

## 1. 环境要求

- Node.js 22.13+（22.x）或 Node.js 24+，以及 npm。
- 项目依赖中的 Wrangler 4.x；统一通过 `npx wrangler` 或 npm scripts 调用，避免全局版本漂移。
- 只有操作远程 Cloudflare 资源时才需要 Cloudflare 账号和 `npx wrangler login`。
- Windows PowerShell 是本文命令的默认终端。

首次安装：

```powershell
npm ci
npx wrangler --version
```

当前项目的主要绑定是：

| 绑定 | 本地资源 | 用途 |
| --- | --- | --- |
| `DB` | `personal-hub-local` | D1 业务数据、凭据摘要和会话 |
| `MEDIA` | `personal-hub-media-local` | R2 图片对象 |
| `ASSETS` | Vite 构建资源 | React SPA |
| `LOGIN_RATE_LIMITER` | namespace `1001` | 登录请求入口限流（成功和失败均计数） |

本地 D1 与 R2 默认由开发运行时模拟并持久化到 `.wrangler/`。它们不需要先在 Cloudflare 创建真实资源，也不会自动连接 staging 或 production。

## 2. 本地秘密 `.dev.vars`

在项目根目录创建 `.dev.vars`：

```dotenv
ADMIN_LOGIN_SECRET=使用独立的高强度随机值
AUTH_PEPPER=使用另一份独立的高强度随机值
```

可以分别执行下面的命令生成两个值：

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

`ADMIN_LOGIN_SECRET` 是网页登录密钥；`AUTH_PEPPER` 用于 Agent Key 和 Session 的 HMAC 摘要。两者不得相同，也不能使用 staging 或 production 的值。

`.dev.vars` 已被 `.gitignore` 忽略。不要把秘密写入 `wrangler.jsonc`、前端环境变量、测试 fixture、日志或提交记录。`wrangler.jsonc` 已用 `secrets.required` 声明这两个名称，因此缺少配置会在本地工具中被明确报告。项目使用 `.dev.vars` 后不要再用 `.env` 提供 Worker 秘密，避免不同加载规则造成误判。Cloudflare Vite 插件会在本地开发时加载该文件，详见 [Cloudflare Vite 插件的 Secrets 文档](https://developers.cloudflare.com/workers/vite-plugin/reference/secrets/)。

## 3. 初始化本地数据库

首次运行以及拉取到新迁移后执行：

```powershell
npm run db:migrate:local
```

该脚本等价于：

```powershell
npx wrangler d1 migrations apply personal-hub-local --local
```

检查还有没有未执行的迁移：

```powershell
npx wrangler d1 migrations list personal-hub-local --local
```

检查初始表和保留的 `manual` Agent：

```powershell
npx wrangler d1 execute personal-hub-local --local --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
npx wrangler d1 execute personal-hub-local --local --command "SELECT id, name, status FROM agents ORDER BY id;"
```

本地状态默认保存在 `.wrangler/` 并跨运行保留。需要空库时，先停止开发服务，把 `.wrangler/state` 移到项目外的备份目录，再重新执行迁移；不要在开发服务运行期间直接修改底层 SQLite 文件。

## 4. 运行、构建与测试

启动完整的前端和 Worker 开发环境：

```powershell
npm run dev
```

开发服务固定使用 `http://localhost:5173`，并启用 `strictPort`；端口被占用时会直接报错，不会自动换端口。默认 `APP_ORIGIN` 与这个地址一致。

日常验证命令：

```powershell
npm run typecheck
npm run lint
npm test
npm run build
```

修改 `wrangler.jsonc` 的绑定后，再生成并检查 Worker 类型：

```powershell
npm run types
npm run typecheck
```

预览生产构建：

```powershell
npm run preview
```

预览也固定使用 `http://localhost:5173`；运行前先停止开发服务。`npm run build` 会通过 Cloudflare Vite 插件生成部署用的扁平配置；部署命令读取该输出配置。不要手工编辑 `dist` 或 `.wrangler/deploy` 中的生成文件。

## 5. 新增数据库迁移

创建迁移：

```powershell
npx wrangler d1 migrations create personal-hub-local <简短说明>
```

然后按以下顺序工作：

1. 编辑新生成的 `migrations/NNNN_*.sql`。
2. 执行 `npm run db:migrate:local`。
3. 运行类型检查、lint、测试和构建。
4. 检查关键约束与 `PRAGMA foreign_key_check`。
5. 迁移一旦进入共享或远程环境，不再修改原文件；后续修正使用新的迁移。

外键检查：

```powershell
npx wrangler d1 execute personal-hub-local --local --command "PRAGMA foreign_key_check;"
```

D1 会在 `d1_migrations` 表记录已执行文件。迁移失败时应修正新迁移并重新验证，不能在应用启动代码中隐式建表或补结构。Cloudflare 的迁移行为和命令见 [D1 Migrations](https://developers.cloudflare.com/d1/reference/migrations/)。

## 6. 本地功能检查

启动服务后至少验证：

1. 首页可打开，日间、夜间、随系统三个主题可切换并持久化。
2. 错误的管理员密钥登录失败；正确密钥登录后只收到 HttpOnly Session Cookie。
3. 新增普通 Agent 时只显示一次明文 Key；刷新页面后不再能读取明文。
4. 普通 Agent 能读写自己的条目、已完成和归档内容，不能读取其他 Agent。
5. 总管 Agent 能跨 Agent 读取和追加内容，但不能管理密钥、删除 Agent 或永久删除条目。
6. 条目完成、已读、归档和待办完成互不联动；追加版本不会清除条目完成状态。
7. PNG/JPEG/WebP/GIF 可上传并通过受保护媒体 URL 显示；未认证和跨 Agent 读取被拒绝。
8. 信息流、清单、报告三种 Agent 布局以及移动端主流程正常。

API 快速检查可使用刚创建的测试 Agent Key。不要把 Key 直接写进脚本或提交；在当前 PowerShell 会话临时设置：

```powershell
$env:PERSONAL_HUB_AGENT_KEY = Read-Host "临时测试 Agent Key"
Invoke-RestMethod -Uri "http://localhost:5173/api" -Headers @{ Authorization = "Bearer $env:PERSONAL_HUB_AGENT_KEY" }
Invoke-RestMethod -Uri "http://localhost:5173/api/v1/agent/entries" -Headers @{ Authorization = "Bearer $env:PERSONAL_HUB_AGENT_KEY" }
Remove-Item Env:PERSONAL_HUB_AGENT_KEY
```

## 7. 常见问题

- `DB` 或 `MEDIA` 为 `undefined`：检查绑定名称必须与代码完全一致，修改配置后重新运行 `npm run types`。
- 登录后写请求仍为 403：检查浏览器请求的 Origin 是否与 `APP_ORIGIN` 完全一致，包括协议和端口。
- 表不存在：执行本地迁移，而不是把建表 SQL塞进应用代码。
- 本地数据“没有清空”：这是 Wrangler 默认持久化行为，检查 `.wrangler/`；测试应使用隔离的测试存储。
- 图片正文可见但图片 404：检查附件元数据的 `object_key`、本地 R2 对象以及正文中的 `/api/v1/media/{id}` 是否一致。
- 5173 端口被占用：先停止已有的 `npm run dev` 或 `npm run preview` 进程；项目不会自动切换到其他端口。
- 发布命令被拒绝：`npm run deploy` 是故意设置的守卫入口；只使用 `npm run deploy:staging` 或 `npm run deploy:production`。不要手动组合 `CLOUDFLARE_ENV`、Vite 和 `wrangler deploy`。

## 8. 提交前检查

```powershell
npm run typecheck
npm run lint
npm test
npm run build
git diff --check
```

`git diff --check` 仅适用于已经初始化为 Git 仓库的工作目录。确认 `.dev.vars`、`.wrangler/`、`dist/`、本地导出数据库和备份图片均未进入 Git。
