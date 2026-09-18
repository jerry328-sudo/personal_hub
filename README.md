# Personal Hub

Personal Hub 是一个运行在 Cloudflare Workers 上的个人信息中心。外部 Agent 通过独立密钥提交和更新信息，管理员在网页中统一查看条目、历史版本、私有图片、待办与完成状态。

## 当前状态

首版完整代码已经落地：Hono Worker API、React 管理网页、D1 初始迁移、私有 R2 附件流程以及单元/集成测试均在仓库中。当前 `wrangler.jsonc` 使用本地模拟资源和占位 D1 UUID；尚未创建或部署任何远程 Cloudflare Worker、D1 数据库或 R2 桶。

## 最短本地启动

需要 Node.js 22.13+（22.x）或 Node.js 24+。PowerShell 中执行：

```powershell
npm ci
Copy-Item .dev.vars.example .dev.vars
# 编辑 .dev.vars，为两个配置项填写不同的高强度随机值
npm run db:migrate:local
npm run dev
```

然后打开 `http://localhost:5173`，使用 `.dev.vars` 中的 `ADMIN_LOGIN_SECRET` 登录。`.dev.vars` 已被 Git 忽略；不要把真实秘密提交到仓库。

## 主要能力

- Worker 内统一鉴权：管理员 HttpOnly Session、每个普通 Agent 的独立 Bearer Key，以及可跨 Agent 管理消息的总管 Agent。
- Agent 生命周期和密钥管理：创建、轮换、撤销、停用、移除、恢复及分步清理；明文密钥只显示一次。
- 条目与版本：分页筛选、完整历史、基于 `base_version` 的并发更新、已读、归档和手动完成状态。
- 三种 Agent 页面：按日期的信息流、稳定清单和主报告；每个 Agent 独立选择布局。
- 待办：普通 Agent、总管和管理员按权限创建、更新和查看，且与条目完成状态分离。
- 私有图片：PNG/JPEG/WebP/GIF 上传到 R2，经归属鉴权后显示；正文只接受本站受保护媒体地址。
- 管理网页：全局收件箱、重要内容、归档、Agent 管理、待办、版本阅读和移动端布局。
- 外观模式：日间、夜间、随系统，选择保存在本地界面偏好中。
- 分角色 API 自动发现：认证后访问 `/api` 和 `/api/docs` 获取当前角色可调用的接口说明。

## 验证

```powershell
npm run typecheck
npm run lint
npm test
npm run build
```

真实 Worker、D1 和 R2 行为在发布前还应按部署手册先经过独立 staging 环境验证。

## 文档

- [产品与架构设计](docs/design.md)：角色权限、数据模型、接口、状态语义和安全边界。
- [项目模块与函数设计](docs/module-design.md)：目录结构、模块职责、函数契约、事务边界和测试范围。
- [本地开发手册](docs/development.md)：本地秘密、D1 迁移、运行、调试和功能检查。
- [部署与恢复手册](docs/deployment.md)：staging/production 资源、Secrets、发布、smoke checks 与 D1/R2 联合恢复。
- [交互原型](design/prototype.html) 与 [模板说明](design/README.md)：已确认的布局和交互基线。

## 目录

- `src/server`：Worker 入口、鉴权、API 和业务模块。
- `src/web`：React 页面、组件、请求封装、主题与样式。
- `src/shared`：前后端共享契约、校验、限制和 Markdown 媒体规则。
- `migrations`：D1 版本化迁移。
- `tests`：单元测试和 Workers 集成测试。

## 许可证

本项目采用 [MIT License](LICENSE)。
