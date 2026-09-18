# 2026-09-18 首次生产部署

- 代码基线：`7be2971`，加本次生产绑定配置；业务源码未改动。
- Worker：`personal-hub-production`。
- 地址：https://personal-hub-production.wuzeyuyupeng.workers.dev
- Worker version：`c0ce6be8-5b5e-4cce-b300-df0fbd83e586`。
- Wrangler：`4.134.0`。
- D1：`personal-hub-production`，UUID `93a3fde0-6930-40a3-a983-775a707c1851`。
- R2：`personal-hub-media-production`，私有读取通过 Worker。
- 已应用迁移：`0001_initial.sql`、`0002_attachment_upload_leases.sql`。
- 发布命令：`npm run db:migrate:production`，随后 `npm run deploy:production`。

## 验证结果

- 类型检查、ESLint、57 个自动化测试和生产构建通过。
- 首页返回 HTML 200 和 CSP；无凭据的 `/api`、`/api/docs` 返回 401。
- 管理员登录生成 Secure/HttpOnly Cookie；退出后原会话返回 401。
- 普通 Agent 使用独立密钥创建条目，不能访问管理员接口。
- 管理员标记条目完成后，普通 Agent 读取仍能看到完成状态。
- 总管 Agent 可读取普通 Agent 条目，但不能调用管理员接口。
- PNG 上传至 R2 后可经管理员鉴权读取，字节完全一致；匿名读图返回 401。
- 测试 Agent、条目和图片已删除；D1 仅保留内置 manual 分区，条目和附件数量均为 0。
- 远程 `PRAGMA foreign_key_check` 无异常。
- 前端静态产物不含生产秘密值。

## 凭据与后续运维

两个随机生成的生产秘密已上传至 Cloudflare Secrets；本机备份位于项目根目录 `.env.production`，已受 `.gitignore` 保护。网页登录使用其中的 `ADMIN_LOGIN_SECRET`，`AUTH_PEPPER` 是服务端凭据验证用值。请将备份保存到密码管理器；不要上传该文件。

本次按用户请求直接发布 production；未创建 staging，未执行浏览器交互验收或备份恢复演练。首次发布前无业务数据，因此没有旧数据库恢复点。后续发布与恢复遵循 [部署手册](../deployment.md)。

## 同日修复：条目删除误报 404

用户测试发现条目实际删除后接口仍返回 404。原实现要求删除结果的 `meta.changes` 严格等于 1，级联删除历史版本时这个条件不成立。现在用 `DELETE ... RETURNING id` 判断目标条目是否成功删除，保留同一事务内的主报告引用清除与待办解绑。

- 新版本：`c2dedb03-d2a8-41c8-b739-1895cbcae37d`。
- 无数据库迁移；仅更新条目删除结果判断。
- 新增多个历史版本、主报告引用和关联待办的集成回归测试；58 个测试、类型检查和 ESLint 均通过。
- 线上复测：创建 201，读取 200，追加版本 201，管理员删除 204；删除后条目与历史读取均为 404。
- 两轮测试消息均已删除；保留用户创建的 Agent 与其他内容。
