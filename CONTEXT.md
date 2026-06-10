# Cloud Mail 项目维护上下文

更新时间：2026-06-04

这份文档用于长期放在项目根目录，帮助后续维护者快速理解 Cloud Mail 的项目边界、架构、核心流程、部署方式和改动约束。它不是一次性会话交接文档；具体历史交接请参考本地未跟踪或另存的 handoff 文档。

## 1. 项目定位

Cloud Mail 是一个基于 Cloudflare Workers 的自托管邮件系统，包含：

- `mail-worker`：Cloudflare Worker 后端，承载 API、收信、发信、定时任务和静态资源分发。
- `mail-vue`：Vue 3 前端，提供邮箱、管理后台、验证码中心和维护中心。
- `scripts` / `.github`：Workers Git、GitHub Actions 和部署辅助脚本。

目标：

- 稳定、低成本地运行个人或小团队邮箱。
- 提供多域名收信、发信、用户/邮箱/权限管理。
- 提供快速读取验证码的用户体验。
- 提供管理员维护中心，方便检查 D1/KV/R2/AI/发信绑定、schema、索引和搜索表。

非目标：

- 不做复杂 SaaS 平台。
- 不默认依赖 AI；AI 只作为验证码识别可选兜底。
- 不为了理论风险做大规模架构重写。
- 不默认实施可能拒收正常邮件的收信大小限制。

## 2. 仓库与部署决策

当前项目已从原 fork 发展为独立项目。

- 主远端：`git@github.com:deeeeeeeeap/cloud-mail-deeeeeeeeap.git`
- 旧 fork 远端：`git@github.com:deeeeeeeeap/cloud-mail.git`
- 当前主分支：`main`
- 原 `upstream` 路线已废弃；不要继续按上游 fork 同步方式维护。

Cloudflare 项目切换 GitHub 仓库本身不会导致数据丢失。真正需要避免的是部署时误绑定到新的空 D1/KV/R2。

## 3. 顶层目录地图

```text
.
├── .github/                 GitHub Actions 和 issue 模板
├── doc/                     项目文档和演示素材
├── mail-worker/             Worker 后端
│   ├── src/
│   │   ├── api/             API 路由
│   │   ├── email/           Cloudflare Email Routing 收信入口
│   │   ├── entity/          Drizzle ORM 表定义
│   │   ├── init/            D1 初始化和迁移补齐
│   │   ├── security/        鉴权和权限中间件
│   │   ├── service/         业务服务
│   │   └── utils/           工具函数
│   └── test/                Vitest 后端测试
├── mail-vue/                Vue 3 前端
│   ├── src/
│   │   ├── axios/           HTTP 封装
│   │   ├── components/      通用组件
│   │   ├── layout/          应用布局
│   │   ├── perm/            前端权限和动态路由
│   │   ├── request/         API client
│   │   ├── router/          Vue Router
│   │   ├── store/           Pinia store
│   │   └── views/           页面
│   └── vite.config.js       前端构建配置
├── scripts/                 Cloudflare 构建/部署脚本
├── wrangler.jsonc           根目录 Workers Git 配置
├── README.md                用户向 README
└── CONTEXT.md               本维护上下文
```

## 4. 后端架构

### 4.1 Worker 入口

- `mail-worker/src/index.js`
  - `/api/*` 请求会剥离 `/api` 前缀后交给 Hono app。
  - `/attachments/*` 和 `/static/*` 走对象响应。
  - 其他路径交给 `env.assets.fetch(req)`，承载前端 SPA。
  - `email` export 处理 Cloudflare Email Routing 收信。
  - `scheduled` export 处理定时任务。

### 4.2 Hono 与路由注册

- `mail-worker/src/hono/hono.js`
  - 创建 Hono app。
  - 统一 CORS。
  - 统一错误响应。
- `mail-worker/src/hono/webs.js`
  - 引入安全中间件。
  - 注册所有 `api/*` 模块。

### 4.3 鉴权与权限

- `mail-worker/src/security/security.js`
  - 排除公开接口：登录、注册、初始化、网站配置、webhook、public token 等。
  - `/public/*` 使用公共 token。
  - 其他接口使用 `Authorization` 中的 JWT。
  - 登录态存放在 KV，支持多 token。
  - 特权接口需要匹配权限 key；管理员邮箱拥有 `*` 权限。

重要权限入口：

- `maintenance:query`：查看维护中心。
- `maintenance:repair`：执行维护修复。
- `all-email:query`：查看全站邮件和全站验证码。
- `setting:query` / `setting:set`：系统设置查看和修改。

### 4.4 主要服务

- `email-service.js`：邮件列表、详情、发送、删除、收信落库、全站邮件。
- `account-service.js`：邮箱账户管理。
- `user-service.js`：用户、角色、发送计数、删除/恢复。
- `login-service.js`：注册、登录、登出、Turnstile、注册密钥。
- `setting-service.js`：系统设置读取、缓存、更新、网站公开配置。
- `att-service.js`：附件保存、鉴权下载、内嵌图片处理、对象清理。
- `code-service.js`：验证码中心列表、近期本地回填。
- `ai-service.js`：验证码本地规则识别和可选 AI 兜底。
- `maintenance-service.js`：健康检查、schema/索引/搜索表修复、验证码维护。
- `email-search-service.js`：全站搜索表查询和同步。
- `resend-service.js`：Resend webhook 处理和签名校验。
- `analysis-service.js`：统计和图表缓存。

## 5. 前端架构

### 5.1 应用入口

- `mail-vue/src/main.js`
  - 创建 Vue app。
  - 初始化 Pinia、i18n、router、权限指令。
  - 调用 `init()` 后挂载。

- `mail-vue/src/init/init.js`
  - 读取网站配置。
  - 设置语言和标题。
  - 如果有 token，拉取登录用户信息。
  - 根据用户权限动态注册管理路由。

### 5.2 路由与权限

- `mail-vue/src/router/index.js`
  - 固定路由：收件箱、邮件详情、个人设置、收藏、验证码中心、登录、404。
  - 登录守卫：未登录跳转 `/login`。
  - 首次进入登录页时预加载背景。

- `mail-vue/src/perm/perm.js`
  - `v-perm` 控制按钮/菜单显示。
  - `permsToRouter()` 根据权限动态注入管理页面。

### 5.3 主要页面

- `views/email`：用户收件箱。
- `views/content`：邮件详情。
- `views/code-center`：用户验证码中心；管理员可切换全站验证码。
- `views/maintenance`：管理员维护中心。
- `views/sys-setting`：系统设置，大页面，改动需谨慎。
- `views/all-email`：全站邮件。
- `views/user`：用户管理，大页面，改动需谨慎。
- `views/analysis`：统计分析，大页面，改动需谨慎。

## 6. 核心业务流程

### 6.1 收信流程

入口：`mail-worker/src/email/email.js`

流程：

1. 从 `settingService.query()` 读取系统设置。
2. 如果收信关闭，拒收。
3. 使用 `postal-mime` 解析原始邮件。
4. 应用黑名单规则。
5. 按收件地址查找 account。
6. 检查角色域名权限和禁收发件人规则。
7. 保存邮件为 `SAVING` 状态。
8. 保存附件和内嵌图片。
9. 完成收信状态。
10. 使用本地规则提取验证码；必要且配置开启时再走 AI 兜底。
11. 按设置转发到 Telegram 或其他邮箱。

注意：

- 不要默认新增拒收逻辑，避免误拒正常邮件。
- 验证码识别应优先本地规则，AI 只作可选兜底。

### 6.2 发信流程

入口：`mail-worker/src/service/email-service.js`

发信支持：

- Resend。
- Cloudflare Email。
- 站内邮件。

主要检查：

- 系统是否允许发信。
- 用户角色是否允许发信。
- 发信额度是否满足。
- 发件 account 是否属于当前用户。
- 发件域名是否允许。
- 附件数量和格式处理。

### 6.3 验证码中心

后端：

- `mail-worker/src/service/ai-service.js`
  - 本地验证码规则。
  - 多语言标签、上下文打分、负面上下文过滤。
- `mail-worker/src/service/code-service.js`
  - 列表查询。
  - 近期邮件轻量回填。
  - 过期状态计算。
- `mail-worker/src/service/maintenance-service.js`
  - 扫描、清理误判、清理过期验证码。

前端：

- `mail-vue/src/views/code-center/index.vue`
  - 点击验证码卡片直接复制。
  - “详情”按钮打开邮件详情。
  - 普通用户看自己的验证码。
  - 有 `all-email:query` 权限可查看全站验证码。

维护原则：

- 用真实误判/漏判样本驱动规则调整。
- 每次只调整一类规则。
- 新增或修改规则要补最小测试。
- 避免把营销邮件、订单号、物流号、日期、版本号误判为验证码。

### 6.4 维护中心

后端：`mail-worker/src/service/maintenance-service.js`  
前端：`mail-vue/src/views/maintenance/index.vue`

能力：

- 检查 D1、KV、R2、Cloudflare Email 绑定。
- 检查 email 表关键字段。
- 检查关键索引。
- 检查 `email_search` 表和索引。
- 修复 schema。
- 修复索引。
- 重建搜索表。
- 重新扫描验证码。
- 清理误判验证码。
- 清理过期验证码。

注意：

- 维护修复是生产数据相关操作，线上执行前需要明确目的。
- 不要把维护中心扩展成复杂监控平台，保持低成本和可维护。

### 6.5 设置缓存

后端：`mail-worker/src/service/setting-service.js`

关键点：

- 设置存储在 D1 的 `setting` 表。
- KV 存放设置缓存。
- KV 为空时应能从 D1 恢复并写回 KV。
- 只有 D1 也没有 setting 行时才应报 `Database not initialized`。

这是最近一次线上 `Database not initialized` 问题的根因修复点，后续不要回退。

## 7. Cloudflare 绑定和变量

常用绑定名：

- D1：`db`
- KV：`kv`
- R2：`r2`，可选
- Workers AI：`ai`，可选
- Cloudflare Email：`email`，可选
- Assets：`assets`

重要变量：

```text
domain / DOMAIN
admin / ADMIN
jwt_secret / JWT_SECRET
D1_DATABASE_NAME
D1_DATABASE_ID
KV_NAMESPACE_ID
CUSTOM_DOMAIN
R2_BUCKET_NAME
CORS_ORIGINS
RESEND_WEBHOOK_SECRET
RESEND_WEBHOOK_ALLOW_UNSIGNED
AI_MODEL
ANALYSIS_CACHE
CF_EMAIL
```

原则：

- 不要把真实 token、secret、cookie、私钥提交到仓库。
- 不要把真实生产 D1/KV/R2 资源 ID 写进公共配置。
- 生产资源通过 Cloudflare 变量、GitHub Secrets/Variables 或本地私有配置注入。
- 换仓库部署时必须继续绑定原 D1/KV/R2，否则会表现为“数据没了”。
- `RESEND_WEBHOOK_SECRET` 推荐配置；兼容旧未签名 webhook 才设置 `RESEND_WEBHOOK_ALLOW_UNSIGNED=true`。

## 8. 部署方式

### 8.1 Workers Git

根目录 `wrangler.jsonc` 用于 Cloudflare Workers Git 识别项目：

- Worker 入口：`mail-worker/src/index.js`
- 前端构建产物目录：`mail-worker/dist`
- 构建命令调用 `scripts/cloudflare-workers-git-build.mjs`

构建脚本做三件事：

1. 安装 `mail-worker` 依赖。
2. 安装 `mail-vue` 依赖。
3. 执行 `mail-vue` 构建，并输出到 Worker 静态资源目录。

### 8.2 GitHub Actions

工作流：

```text
.github/workflows/deploy-cloudflare.yml
```

用途：

- push 到 `main` 且相关路径变化时触发部署。
- 也支持手动 `workflow_dispatch`。
- 从 GitHub Secrets/Variables 读取 Cloudflare 和项目配置。
- 可自动查找或创建 D1/KV。
- 部署后调用 `/api/init/:jwt_secret` 初始化数据库。

注意：

- 工作流日志中不要打印 secret。
- 如需更严格日志卫生，后续可隐藏自动创建时输出的资源标识。

## 9. 本地验证命令

后端测试：

```powershell
cd mail-worker
corepack pnpm vitest run
```

重点测试：

```powershell
cd mail-worker
corepack pnpm vitest run test/setting-service.spec.js
corepack pnpm vitest run test/code-service.spec.js
corepack pnpm vitest run test/maintenance-service.spec.js
corepack pnpm vitest run test/attachment-access.spec.js
```

前端构建：

```powershell
cd mail-vue
corepack pnpm run build
```

Git 检查：

```powershell
git status --short --branch
git diff --stat
git diff
git diff --check
```

## 10. 改动流程建议

每轮只做一个小目标。开始前先写清：

```text
Goal:
Why this goal:
Included items:
Excluded items:
Verification plan:
```

执行顺序：

1. 查看 `git status`，确认未跟踪和未提交文件。
2. 阅读相关文件，不要凭记忆改。
3. 小范围改动。
4. 跑相关测试或构建。
5. 查看 `git diff --stat`、`git diff`、`git diff --check`。
6. 确认没有提交 dist、临时文件、secret 或无关改动。
7. 用户要求时再 commit + push。

## 11. 当前应优先关注的维护点

1. 线上 `Database not initialized` 是否持续恢复。
2. Cloudflare Workers Git 是否稳定识别为 Worker + Assets，而不是静态站点。
3. 维护中心线上是否仍有缺字段、缺索引、缺搜索表警告。
4. 验证码中心是否存在真实误判/漏判样本。
5. 附件鉴权、搜索正文截断、自动生成密码可做回归验证。
6. 项目配置文件需保持模板化和安全卫生，不要泄露真实资源。

## 12. 明确暂缓或不要主动做的事项

- 不主动实施收信大小限制。
- 不主动把 `/oss/*` 不存在改成 404，除非重新确认。
- 不主动把验证码识别改成必须 AI。
- 不主动做大规模前端组件拆分。
- 不主动做完整 SaaS 化、复杂审计日志或复杂监控平台。
- 不提交 `dist` 构建产物，除非目标明确要求。
- 不提交 handoff、临时计划、备份等未确认文件。

## 13. 后续适合拆的小任务

- 配置模板化和敏感信息卫生检查。
- 维护中心线上复核。
- 验证码真实样本规则优化。
- 附件鉴权回归测试。
- 搜索正文截断回归测试。
- 自动生成密码路径说明和回归。
- D1 备份/恢复轻量入口。
- Webhook 投递日志轻量查看。
- 部署前配置自检。

## 14. 保功能瘦身维护原则

当前瘦身方向是降低首屏负担和静态资源体积，不是删功能。

必须保留：

- 写信窗口、回复、转发、草稿、附件。
- TinyMCE `emoticons` / emoji。
- Turnstile 注册验证和添加邮箱验证。
- PWA 基础 manifest 和图标体验。
- Cloudflare D1/KV/R2/Email/Assets 等绑定和变量名。

已确认的低风险方向：

- 写信窗口按需加载，未点击写信前不加载 `layout/write`。
- TinyMCE 脚本按需加载，未打开写信窗口前不请求 `/tinymce/tinymce.min.js`。
- Turnstile loader 和 Cloudflare challenge 脚本均按需加载，只在注册/添加邮箱触发人机验证时请求。
- `dexie` / 草稿存储不进入首屏 HTML `modulepreload`。
- `mail-vue/public/tinymce` 只能清理未在编辑器配置中使用的插件、旧 UI skin、runtime 不需要的 `.d.ts`；不要删除 `plugins/emoticons`。

2026-06-05 本地 mock 浏览器回归结果：

- 收件箱首屏未请求 `/tinymce/`、Turnstile、Google Fonts、`dexie`、`db-` chunk。
- 点击写信后才加载 TinyMCE，`emoticons` 插件和 emoji 按钮存在。
- 写信正文可包含 emoji，附件可加入草稿；关闭保存草稿后，草稿箱可重新打开并恢复主题、正文和附件。
- 邮件详情页回复、转发均能打开写信窗口并带入原邮件内容。
- 注册和添加邮箱均在提交触发验证时才加载 `turnstile-loader` 与 Cloudflare challenge 脚本。

瘦身验证清单：

```powershell
cd mail-vue
corepack pnpm run build
```

构建后检查：

- `mail-worker/dist/index.html` 不应出现 `dexie`、`db-`、`tinymce`、`turnstile`、`fonts.googleapis` 的首屏加载项。
- `mail-worker/dist/tinymce/plugins/emoticons` 必须存在。
- 手动回归写信、emoji、附件、保存草稿、打开草稿、回复、转发、注册/添加邮箱验证。

提交前检查：

```powershell
git status --short
git diff --stat
git diff --check
```

不要提交：

- `mail-worker/dist`
- `CONTEXT.md`
- `cloud-mail-handoff.md`
- 临时报告、备份和本地 scratch 文档
