# 自定义域名与密钥管理发布说明

已于 2026-09-18 经用户授权发布至 https://personal-hub.echem.ai 。Worker 版本：`35c29d90-9b0e-4ac5-b1e5-da15c3e29ff9`。包含下述更新以及 SVG/ICO/Apple Touch 网站图标；既有 Secrets 未修改。

生产迁移 `0003_admin_credentials.sql` 已成功应用。迁移前 D1 Time Travel 恢复点：`00000003-00000000-000050ea-af0b5d7caa7a616592a00e599919f559`；如需恢复，应显式选择 `--env production`，并评估恢复点之后数据的影响。

线上检查：HTTPS 首页及三种图标均返回 200；匿名 Session 返回 401；原管理员密钥登录成功，Session 和 Agent 列表读取返回 200；测试会话已退出（204）。未在线更换用户密钥；更换逻辑已由发布前本地测试验证。

- production 自定义域名配置为 `personal-hub.echem.ai`，APP_ORIGIN 同步修改；发布后关闭 workers.dev 入口。Agent 调用方届时需要更新基础 URL。
- 普通和总管 Agent 均支持有限期或无限期密钥，明文仍只在签发时展示一次。
- 管理网页新增“登录与安全”。修改登录密钥必须提供当前密钥；成功后所有管理员会话失效，需要重新登录，Agent 密钥不变。

## 本次发布流程与后续注意事项

1. 确认 echem.ai 位于该 Cloudflare 账号且目标主机名可绑定 Custom Domain；保留 D1 备份。
2. 先执行生产数据库迁移，包含 `0003_admin_credentials.sql`，再发布新版 Worker。迁移默认版本为 0，兼容已有会话。
3. 新域名使用 HTTPS；验证登录、密钥轮换和 API。旧域名的 Cookie 不会迁移，需要重新登录。

在线修改不会调用 Cloudflare Secrets API，不需要重新部署。`ADMIN_LOGIN_SECRET` 作为首次设置前的引导密钥；设置后以 D1 中的 HMAC 摘要为准，旧环境值不再能登录。Cloudflare Secret 和本地 `.env.production` 不会自动改写，因此在线修改后的新密钥应自行保存到密码管理器。不要通过修改 AUTH_PEPPER 来更换登录密钥，这会影响全部 Agent 和 Session 摘要。

如果遗失新密钥，需要持有 Cloudflare 管理权限的运维人员执行数据库凭据恢复：将摘要置空、递增 revision 并撤销旧会话，之后重新使用引导密钥登录。恢复属于独立的生产操作，不能仅修改环境变量期待覆盖现有摘要。
