# OAuth 网页回调修复

2026-10-06 已发布至现有 Personal Hub Worker。当前版本 `29f4a6fb-9a1d-4a72-ae07-8ef73e78d55a`，前一版本 `8249497a-b24f-4e53-8767-6f819754ed38`。使用 `npm run deploy:production`，Wrangler 4.134.0。插件包、私有插件身份、连接配置和现有凭据未变。

## 原因与修改

授权页原来的 `form-action 'self'` 在 Chrome 中也约束表单 POST 后的重定向。OAuth 请求能够到达 Hub，但服务器返回的跨来源回调会被浏览器阻止，用户仍停在授权页。此前无浏览器登录绕过了页面策略，没有修复它。

`src/server/mcp/oauth.ts` 现在仅为授权页额外放行 `parseAuthRequest` 已校验的回调来源，包含当前端口。策略从 URL 的规范化 origin 生成，不加入用户表单中的地址、通配符、回调查询参数或路径。仍保留原有脚本禁用、禁止嵌入、同源 POST、绑定 consent、一次性代码、PKCE、scope 和身份检查。授权管理页继续使用 `form-action 'self'`。

不新增 Worker 请求、D1 查询或后台任务；每次授权页仅增加一次 URL origin 解析。没有执行手动备份、数据库导出、迁移或业务记录写入。

## 验证

- typecheck、lint、完整 17 文件 / 187 项测试、构建及 `git diff --check` 通过。
- 集成测试覆盖 HTTPS、本机 IP 与 localhost 回调的允许/拒绝重定向，未注册地址拒绝，以及授权管理页保持同源策略。
- Browser plugin 不可用，使用已有 Playwright 和本机 Chrome，无新增依赖。浏览器回归直接加载源码中的 HTML 响应函数，使用模拟 consent：旧版本提交后回调被拦，修复后允许与拒绝均回调成功；HTTPS 回调正常，未允许来源仍被拦，管理页保持原有限制。
- 线上真实授权页返回正确 CSP。Chrome 点击拒绝后，经真实生产 POST 收到 `access_denied` 回调，state 匹配。线上允许按钮的 POST 以模拟 302 响应验证浏览器回跳，未创建真实 grant，也未替换当前 Codex OAuth 凭据。
- 线上首页 200，未授权管理 API 401。没有 `form-action` 错误或页面脚本异常；原严格 CSP 对 Cloudflare 注入统计脚本的拦截日志仍存在，与回跳无关。
- 截图和临时脚本保存在仓库外的当前可视化目录。真实新设备上使用总管密钥的完整授权仍须用户操作验证。

部署后需要从 Codex 重新发起连接，打开新的授权页。已有页面仍持有旧 CSP 或已消费的 consent；不要反复使用它。
