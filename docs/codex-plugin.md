# Codex Personal Hub 插件

2026-10-06 最新部署版本 `8249497a-b24f-4e53-8767-6f819754ed38`：归档直接删除全部关联待办；已备份并清理历史隐藏待办 32 条，原始记录保留。清除已完成只执行一次业务 DELETE，确认弹窗不再查询数量。移除列表和计数中的归档隐藏检查、网页版重复刷新，缓存按角色区分的静态文档编码，保留 MCP 客户端兼容格式。线上和真实 Codex 面板核对通过，详见[本次发布记录](releases/2026-10-06-archive-task-simplification.md)。

2026-10-05：远程面板和三项 CPU 优化已部署到现有 Worker，版本 `dcd7aab6-c65c-4a59-a75b-24f7cc98638a`，线上 SDK/OAuth/面板资源/图标/授权撤销检查通过。插件包已验证并保存为个人账户的私有插件。2026-10-06 已在真实 Codex 对话中完成总管 OAuth 登录，加载 35 个 MCP 工具，成功读取身份并打开侧面板；首屏显示 7 条真实记录、来源筛选、历史版本和总管管理入口。全局侧边栏图标位置及引用带入仍需单独验收。详见[发布记录](releases/2026-10-05-codex-panel-performance.md)。

## 实现

2026-10-06 已随一键清除功能部署，Worker 版本 `e7004b0b-a189-4848-abcd-2ea4edbf622d`：待办默认改为未完成，显式排除归档关联项；增加来源筛选和标题搜索；夜间 hover 背景改用主题变量；面板使用宿主高度及四边安全留白并处理短窗口，宽屏列表限制为最多 440px；面板标志统一为已选收纳盒。MCP 初始化与入口工具均提供明暗自包含 SVG，避免独立图像的 `currentColor` 与外链加载依赖。网页版及面板均加入清除已完成待办，数据库或网络失败时保留列表、恢复按钮、不自动重试。183 项测试、typecheck、lint、构建和浏览器检查通过。真实 Codex 面板已验证 3 项未完成待办，以及显示 2 项已完成待办的确认弹窗；验证后取消，未删除真实待办。全局侧边栏图标刷新及宿主外层浮动输入框关系仍未独立验收。详见[发布记录](releases/2026-10-06-completed-task-cleanup.md)。

插件源目录为 `plugins/personal-hub`，采用 Agent Plugins 1.0，包括根 `plugin.json`、远程 `mcp.json`、`hub` 技能与图标。连接现有 `/mcp`，保留 Worker、D1、R2、OAuth 和身份体系，不新增数据库迁移。

新增工具 `open_hub_panel` 与资源 `ui://personal-hub/panel-v1.html`。工具提供 `global` / `thread` 入口；资源仅支持并优先使用 `fullscreen`（Codex 对话旁的面板）。首屏使用入口工具的返回数据，不重复调用入口。具体注册依据[官方 Extensions 文档](https://developers.openai.com/plugins/build/extensions)与[协议规范](https://github.com/openai/mcp-extensions/blob/main/docs/spec.md)。宿主中的实际入口位置需要在发布连接后验证。

`src/panel` 复用已确认的模板风格，使用 React、MCP Apps 1.7.5 和 OpenAI MCP Extensions 0.1.0。锁定 SDK 版本，统一 Zod 副本，避免 iframe 禁止 `unsafe-eval` 时出现不同 Zod 副本的 JIT 行为。面板构建为约 876 KB 的自包含 HTML，发布到同一 Worker 的静态资源；MCP 通过 `ASSETS` binding 读取并返回它，不再把 HTML 嵌进 Worker 脚本。只缓存已读取的公共代码字符串；身份、响应和私有数据不缓存。没有外部脚本、样式、字体请求或前端直连 API。

入口在 `_meta.personalHub` 中返回经授权的来源、首批条目摘要和第一条正文；模型只看到简短打开结果。业务读取和操作全部通过 `app.callServerTool`，使用宿主已有的 MCP 授权。前端不接触 Agent Key、OAuth token、Cookie 或管理员密钥。

## 交互

- 收件箱 / 归档：来源筛选、正文搜索、未读和重要筛选、游标分页。
- 条目：版本阅读、当前版本已读、完成 / 恢复、归档 / 恢复；阅读历史版本不会暗中标记新版本已读。
- 来源：报告遵循 `main_entry_id`；清单点击展开；信息流在条目进入视口后读取正文。布局更改持久化到原来源设置。
- 待办：创建、完成、分页和确认删除。条目关联待办保留原来源，不依赖禁用的表单控件提交值。
- 管理：按当前权限显示来源启停；不允许在面板直接停用自身总管连接。
- 引用：保存明确的 ID 和历史版本，预览 / 复制后通过 `ui/update-model-context` 附到当前对话。不会发送消息，也不覆盖已有草稿。宿主移除引用时同步面板状态；重挂载时重新读取受授权的引用快照。
- 私有图片：只接受本站媒体路径，通过 `get_image` 读取受保护内容，拒绝外部图片。
- 窄面板：列表与详情切换、独立滚动、固定引用托盘；跟随宿主明暗主题。

服务端每个请求和操作重新验证身份。UI 权限还会考虑 OAuth scope；普通 / 只读身份和仅 read 的总管连接不会出现超出范围的写入按钮。附上引用前会再次读取所选历史版本，撤销密钥后不能继续取得私有内容。

## 构建和验证

```powershell
npm ci
npm run typecheck
npm run lint
npm test
npm run build
npm run plugin:package
```

`build:panel` 生成 Git 忽略的 `public/plugin/panel.html`；`predev`、`prebuild`、`pretest` 与正式部署脚本都会先构建它，并由 Vite 复制到 `dist/client/plugin/panel.html`。`ASSETS` 使用规范化路径 `/plugin/panel`，资源读取会检查标记，防止缺失构建时误返回网页 SPA。插件归档位于 Git 忽略的 `artifacts/personal-hub-0.1.0.tar.gz`，只有一个插件根目录。`plugin.json` 和 `mcp.json` 已通过官方 1.0 JSON Schema 校验，包内已检查凭据及越界路径。

工具输入 schema 在模块中复用，纯 JSON Schema 缓存在 WeakMap 中，SDK validator 复用；工具列表和回调仍按每次请求的身份、角色、scope 和可用 OAuth 服务重新创建。通过 SDK 公开 `tools/list` handler 返回目录，保留入口的 `icons`，并由 SDK 完整校验输入一次。不会缓存身份或省略撤销检查。侧边栏采用已确认的 20px 单色收纳盒图标，插件提供对应的 48px 明暗图标。

验证结果：类型检查、lint、构建及 16 个测试文件中的 175 项测试通过。新增检查覆盖入口元数据、自包含资源、隐藏的首屏正文、来源隔离、只读 OAuth scope、密钥撤销、静态工具目录的角色与 scope 隔离、默认值与输入校验、以及 Markdown 图片的大输入和语法边界。

Markdown 图片检查由前后端共享的扫描器实现，普通 inline 图片走轻量路径；无图片或标签未闭合时早退，复杂输入使用预先索引的边界，避免失败正则反复扫描。字符实体、转义和参考式图片都会进入本站地址及归属检查。对复杂代码示例、重复引用定义和不确定语法，继续校验可能的图片，可能比渲染器检查更多地址；遇到这类内容宜采用明确的 inline 图片或 fenced code。没有引入完整 Markdown AST/tokenizer 到 Worker。

`npm run panel:preview` 在 `127.0.0.1:4175` 提供独立 SDK 测试宿主，仅使用模拟数据。`npm run panel:check` 需要可用 Playwright；可通过 `PANEL_PLAYWRIGHT_MODULE` 指向已有安装。检查分页、历史引用、保留草稿、宿主移除引用、关联待办、归档恢复、三种布局、主报告、1496 / 620 / 390px、夜间主题及只读按钮。面板在禁止网络请求和 `unsafe-eval` 的 CSP 下通过检查，页面运行错误为零。截图位于 `artifacts/panel-preview`。

测试宿主验证的是正式 SDK 桥接流程及浏览器交互，不等同于插件已在真实 Codex 宿主安装并运行。该项验收必须在部署、创建私有插件和完成连接后执行。

## 发布与连接

确认发布后，使用 `npm run deploy:production` 部署同一 Worker，不重复创建资源或更换密钥。线上验证 MCP 工具 / 资源发现、鉴权和 `open_hub_panel` 的首屏结果。

已验证归档已经保存为个人账户的私有插件；创建回执位于 Git 忽略的 `.wrangler/plugin-receipts/personal-hub.json`，保留插件与 release ID 供后续更新。在正式安装 / 连接流程中，总管使用现有 Key 在 Personal Hub OAuth 页面授权，勾选 `hub:admin`，按需勾选 `offline_access`。也可通过管理员登录后选择现有总管身份。只有 `hub:read` 的旧授权仍会显示只读面板，应重新授权所需范围。

最后在实际 Codex 中打开全局与对话面板，检查入口位置、真实条目、来源布局以及引用是否显示在当前聊天的草稿上下文中。未完成该步骤前，不把 SDK 测试宿主截图当作真实 Codex 安装验收。

### 连接故障排查

插件技能能被识别不等于 MCP 已授权。2026-10-06 的实际故障日志为 `personal-hub is not logged in` / `Auth required`：安装成功，但 MCP 初始化被鉴权拒绝。补齐登录后，当前对话立即收到工具目录，`get_identity` 确认 `manager` 和 `hub:read`、`hub:write`、`hub:admin`、`offline_access`，`open_hub_panel` 打开真实侧面板；验收截图保存在 Git 忽略的 `artifacts/connection/hub-connected.png`。

本次 Codex 内置浏览器提交授权表单时，POST 被浏览器拦截为 `net::ERR_BLOCKED_BY_CLIENT`，页面停留不代表授权成功。改用 Codex 0.160.1 的无浏览器 PKCE 登录完成连接，由 Codex 自行交换并保存 OAuth 凭据。命令行可能无法按名称找到通过远程目录安装的插件服务器；可为登录命令临时指定同名 URL，不必在用户配置中新增第二个服务器：

```powershell
codex -c 'mcp_servers.personal-hub.url="https://personal-hub.echem.ai/mcp"' mcp login personal-hub --no-browser --scopes hub:read,hub:write,hub:admin,offline_access
```

只在用户自己的 Hub 授权页填写现有总管密钥；无浏览器模式将完整回调 URL 交回该登录进程。不要把密钥或回调代码提交到聊天、插件包或 Git。若用户明确授权自动连接并指定本地密钥文件，可在正常 OAuth 流程中只读取所需变量、验证目标域名与请求范围，且避免输出凭据。本次修复未更换密钥、发布插件新版本或重新部署 Worker。
