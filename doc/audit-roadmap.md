# Cloud Mail 审计与扩展路线

## 已纳入第一阶段

- 依赖安全：升级 Worker 与前端直接依赖，清理 `pnpm audit --prod` 中的高危与关键告警来源。
- Worker 安全：默认收紧跨域访问，仅允许同源或 `cors_origins` 中显式配置的来源。
- Webhook 安全：`/webhooks` 支持可选 `resend_webhook_secret` 验签；未配置时保持旧行为兼容。
- 数据安全：批量导入用户改为 D1 参数绑定，避免字符串拼接 SQL。
- 参数校验：补充公开导入列表、导入数量、邮箱、密码和公开邮件分页边界校验。
- 前端展示安全：公告与邮件 HTML 预览增加最小清洗，移除脚本、事件属性和危险 URL。
- 构建性能：前端配置 vendor 分包，降低单个业务 chunk 体积。

## 建议后续扩展

- 后台操作审计日志：记录管理员对用户、角色、设置、邮件的关键操作。
- D1 备份/恢复入口：增加只读导出、恢复前校验和恢复确认流程。
- 健康检查接口：诊断 D1、KV、R2、AI、发信服务的绑定与连通性。
- 部署前配置自检：在 GitHub Actions 中校验 `DOMAIN`、`JWT_SECRET`、D1/KV/R2 绑定与可选 webhook secret。
- Webhook 投递日志：记录 Resend webhook 类型、签名结果、邮件状态更新结果。
- CI 安全门禁：新增依赖审计、Worker 测试、前端构建作为 PR/推送检查。

## 保留的重构方向

- 将 `email-service.js` 按查询、发送、附件、清理职责继续拆分。
- 将 `sys-setting`、`user`、`email-scroll` 等大组件拆成 composable 与子组件。
- 将 D1 初始化脚本进一步整理为版本化迁移清单，降低后续上游同步冲突。
