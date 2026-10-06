# Codex Hub 面板与 CPU 优化发布

2026-10-05 经用户授权完成三项优化、验证，再发布到现有 `personal-hub-production`。域名为 `https://personal-hub.echem.ai`，版本 `dcd7aab6-c65c-4a59-a75b-24f7cc98638a`。未执行数据库迁移、密钥轮换或计划升级。

## 改动

- 复用静态 MCP 输入 schema 与 SDK validator，WeakMap 只缓存 JSON Schema。角色、scope、身份、回调和工具目录仍按请求隔离，保留实时身份复核；SDK 完整校验输入一次。
- 通过 SDK 公开 discovery handler 返回入口图标；采用已确认的单色收纳盒 SVG，插件包含 48px 明暗图标，侧边栏入口为 20px currentColor 图标。
- 自包含面板由 `public/plugin/panel.html` 构建并发布到同一 Worker 的静态资源。MCP 通过 ASSETS binding 读取，仅缓存公共代码字符串，避免将约 876 KB HTML 嵌入 Worker 脚本。
- Markdown 图片检查改为共享扫描器：普通 inline 图片有轻量路径；无图或未闭合标签早退，复杂边界预先索引。保留本站地址、归属和 100 张图片上限；不确定语法会继续核验候选地址。

最终生产构建 Worker 脚本约 2.16 MB，相比原 2.98 MB 减少约 28%。Wrangler 上传 2105.34 KiB，gzip 467.31 KiB，启动耗时 48 ms；面板 HTML 是独立静态资源。这些指标分别描述代码大小与启动，不是每请求 CPU。

本机 Node CPU 对照中，官方 Client 初始化、工具发现和关闭从约 1.52 ms 降到 0.18 ms，35 个工具的参数说明与元数据除新增图标外一致。这是本机相对性能证据，不代表线上总体 CPU 已下降同样比例。

## 验证

- TypeScript、ESLint、完整构建、git diff whitespace 检查通过。
- 16 个测试文件，175 项测试通过，包括权限、来源隔离、版本冲突、授权撤销、MCP 输入行为和最大尺寸 Markdown 输入。
- 46 个 CommonMark/GFM 对照案例没有漏掉真实渲染的图片；复杂语法存在保守的额外检查。
- 严格 CSP 下的面板浏览器检查通过：分页、历史引用、草稿保留、宿主移除引用、待办、归档恢复、来源布局、主报告、窄屏及明暗主题，页面错误为零。
- 插件 manifest/MCP 配置通过 Agent Plugins 1.0 schema；包内和更改及构建内容未检出真实配置凭据。
- 线上首页与静态资源、侧边栏 SVG、OAuth discovery、PKCE、官方 SDK handshake、35 个工具、global/thread 入口、面板资源与首屏数据检查通过。
- 临时验证 OAuth grant 已撤销；撤销后同 token 读取资源返回 401，验证 session 已退出。

公网 HTML 可能附加 Cloudflare 的浏览器脚本，因此公网页面校验保留完整面板代码前缀；MCP 资源与本次构建 HTML 做精确比对并通过。

插件归档位于 `artifacts/personal-hub-0.1.0.tar.gz`，已保存为个人账户的 PRIVATE 插件；创建回执保存在 Git 忽略的 `.wrangler/plugin-receipts/personal-hub.json`。真实 Codex 的安装、授权、入口位置及引用附件显示仍需在连接后验收。大图片 Base64 转换和正文重复序列化留在下一阶段，不据本次结果宣称所有 CPU 超时已消除。
