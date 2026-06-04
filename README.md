# Cloud Mail

基于 Cloudflare Workers 的自托管邮箱系统。本仓库是面向实际自用场景维护的 Cloud Mail 分支，在上游 v3.0.0 基础上补充了性能优化、安全加固、验证码中心、维护中心和自动部署流程。

> 当前项目重点：稳定接收邮件、低成本运行、管理员易维护、验证码读取更快。

## 功能概览

### 邮箱基础能力

- 多域名、多邮箱地址管理。
- 收件箱、已发送、草稿箱、星标邮件、全部邮件。
- 邮件发送、回复、抄送、密送、附件和内嵌图片。
- Resend 发信状态回调，默认要求 webhook 签名校验；旧部署可显式开启未签名兼容。
- 可选 Cloudflare Email Routing 发信绑定。
- 可选 R2 附件存储；未绑定 R2 时可按当前配置走兼容路径。

### 验证码中心

- 独立验证码中心页面，支持“我的验证码”和“全站验证码”。
- 点击验证码卡片可直接复制验证码。
- 右上角“详情”可跳转到邮件详情页。
- 默认使用本地规则识别常见验证码，不需要开启 Workers AI，不产生 AI 费用。
- AI 只作为可选兜底：本地规则识别不到且后台开启 AI 兜底时才会调用。
- 打开验证码中心时会对最近邮件做轻量回填，兼容旧邮件。

### 管理员能力

- 用户管理、邮箱管理、角色权限控制。
- 注册密钥、权限分配、用户状态、发信次数限制。
- 全部邮件检索、批量删除和邮件详情查看。
- 分析页：用户、邮件、收发趋势等图表。
- 系统设置：站点标题、登录页、公告、黑名单、转发、Turnstile、人机验证等。

### 维护中心

- D1 / KV / R2 / AI / 发信绑定状态检查。
- 数据库字段、索引、搜索表健康检查。
- 安全修复入口：补齐 schema、补齐索引、重建搜索表。
- 针对大数据量场景增加索引和搜索辅助表，减少列表查询压力。

### 性能与安全改造

- 邮件列表接口瘦身，列表不再返回完整正文。
- 新增邮件详情按需加载，点开邮件才取正文。
- 搜索表 `email_search` 和组合索引优化 D1 查询。
- 附件匹配改为 Map，减少重复遍历。
- 设置、权限、角色等短缓存。
- 前端 Vite 分包：Element Plus、ECharts、Dexie、Vue vendor 独立 chunk。
- Worker CORS 默认收紧，可通过 `cors_origins` 显式放行额外来源。
- 公告和邮件 HTML 预览做基础安全清洗。
- public 批量导入改为参数绑定，避免字符串拼接 SQL。

## 技术栈

| 模块 | 技术 |
| --- | --- |
| 运行平台 | Cloudflare Workers |
| 后端框架 | Hono |
| 数据库 | Cloudflare D1 + Drizzle ORM |
| 缓存 | Cloudflare KV |
| 文件存储 | Cloudflare R2，可选 |
| 前端 | Vue 3 + Vite |
| UI | Element Plus |
| 图表 | ECharts |
| 邮件解析 | postal-mime |
| 发信 | Resend / Cloudflare Email，可选 |

## 目录结构

```text
cloud-mail
├─ mail-worker/              # Cloudflare Worker 后端
│  ├─ src/api/               # API 路由
│  ├─ src/email/             # 邮件接收处理
│  ├─ src/entity/            # D1 表结构与 ORM
│  ├─ src/init/              # 初始化与兼容迁移
│  ├─ src/security/          # 登录、鉴权、权限
│  ├─ src/service/           # 业务服务
│  ├─ src/utils/             # 工具函数
│  ├─ test/                  # Worker 单元测试
│  ├─ wrangler.toml          # 本地/生产部署配置
│  └─ wrangler-action.toml   # GitHub Actions 部署模板
├─ mail-vue/                 # Vue 前端
│  ├─ src/views/             # 页面
│  ├─ src/request/           # API 请求封装
│  ├─ src/perm/              # 前端权限路由
│  ├─ src/store/             # Pinia 状态
│  └─ vite.config.js         # 构建与分包配置
├─ doc/                      # 审计、路线、截图等文档
├─ scripts/                  # Cloudflare Workers Git 构建/部署辅助脚本
├─ .github/workflows/        # GitHub Actions 部署
├─ wrangler.jsonc            # Cloudflare Workers Git 根目录部署配置
└─ README.md
```

## Cloudflare 资源

部署前需要准备：

1. Cloudflare Workers。
2. D1 数据库，绑定名必须是 `db`。
3. KV Namespace，绑定名必须是 `kv`。
4. R2 Bucket，可选，绑定名建议 `r2`。
5. Workers AI，可选，绑定名 `ai`。不开启也不影响本地验证码识别。
6. 自定义域名和邮箱域名 DNS / Email Routing。

## 重要环境变量

不要把真实密钥提交到仓库。生产环境建议放在 Cloudflare 变量或 GitHub Secrets / Variables。

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `domain` / `DOMAIN` | 是 | 邮箱域名 JSON 数组，例如 `["example.com"]` |
| `admin` / `ADMIN` | 是 | 管理员邮箱 |
| `jwt_secret` / `JWT_SECRET` | 是 | 登录 token 密钥，建议使用随机 UUID 或更长随机串 |
| `D1_DATABASE_NAME` | 是 | D1 数据库名，默认 `mail` |
| `D1_DATABASE_ID` | 是 | D1 数据库 ID |
| `KV_NAMESPACE_ID` | 是 | KV Namespace ID |
| `CUSTOM_DOMAIN` | 推荐 | Worker 自定义域名 |
| `R2_BUCKET_NAME` | 可选 | 附件对象存储桶 |
| `CORS_ORIGINS` | 可选 | 额外跨域来源 JSON 数组字符串 |
| `RESEND_WEBHOOK_SECRET` | 可选 | Resend webhook 签名密钥 |
| `RESEND_WEBHOOK_ALLOW_UNSIGNED` | 可选 | 仅兼容旧部署时填 `true`；未配置 `RESEND_WEBHOOK_SECRET` 时默认拒绝 webhook |
| `AI_MODEL` | 可选 | Workers AI 兜底识别模型 |
| `ANALYSIS_CACHE` | 可选 | 分析页缓存开关 |
| `CF_EMAIL` | 可选 | 是否启用 Cloudflare Email 发信绑定 |

## 本地开发

建议使用 Node.js 22 和 pnpm。

```powershell
# 后端依赖
cd mail-worker
corepack pnpm install

# 前端依赖
cd ../mail-vue
corepack pnpm install
```

启动前端：

```powershell
cd mail-vue
corepack pnpm dev
```

启动 Worker：

```powershell
cd mail-worker
corepack pnpm dev
```

前端开发环境默认请求 `http://127.0.0.1:8787/api`，对应 `mail-vue/.env.dev`。

## 构建与测试

```powershell
# Worker 测试
cd mail-worker
corepack pnpm vitest run

# 前端构建，产物输出到 mail-worker/dist
cd ../mail-vue
corepack pnpm build
```

当前推荐的发布前检查：

```powershell
cd mail-worker
corepack pnpm vitest run

cd ../mail-vue
corepack pnpm build
```

## 部署

### 方式一：Cloudflare 直接部署

`mail-worker/wrangler.toml` 中配置了：

- Worker 入口：`src/index.js`
- 静态资源目录：`./dist`
- 构建命令：`pnpm --prefix ../mail-vue install && pnpm --prefix ../mail-vue run build`

部署命令：

```powershell
cd mail-worker
corepack pnpm wrangler deploy
```

首次部署后访问初始化接口：

```text
https://你的域名/api/init/你的 jwt_secret
```

初始化完成后进入后台设置域名、管理员、Resend、公告、验证码识别等配置。

### 方式二：Cloudflare Workers Git 集成

如果你在 Cloudflare Dashboard 里直接连接 GitHub 仓库，推荐使用仓库提供的部署脚本作为部署命令：

```text
node scripts/cloudflare-workers-git-deploy.mjs
```

如果 Cloudflare 项目根目录设置成了 `mail-worker`，部署命令改为：

```text
node ../scripts/cloudflare-workers-git-deploy.mjs
```

这个脚本会生成临时 `.wrangler/cloud-mail.generated.wrangler.jsonc`，用环境变量显式写入 D1 / KV / R2 绑定，然后调用 Wrangler 部署。建议在 Cloudflare 项目的构建变量中配置：

- `D1_DATABASE_NAME`，默认 `mail`
- `D1_DATABASE_ID`
- `KV_NAMESPACE_ID`
- `R2_BUCKET_NAME`，可选
- `CUSTOM_DOMAIN`，可选
- `NAME`，可选，默认 `cloud-mail`
- `CF_EMAIL`，可选，填 `true` 时启用 Cloudflare Email 发信绑定
- `CLOUD_MAIL_WRANGLER_VERSION`，可选，默认 `4.92.0`

本地只验证不部署时，可以临时设置：

```powershell
$env:CLOUD_MAIL_DEPLOY_DRY_RUN='true'
node scripts/cloudflare-workers-git-deploy.mjs
```

如果继续使用默认部署命令：

```text
npx wrangler deploy
```

仓库根目录的 `wrangler.jsonc` 也会负责：

- 指向真正的 Worker 入口：`mail-worker/src/index.js`。
- 构建前端并输出到 `mail-worker/dist`。
- 声明必须存在的绑定名：D1 `db`、KV `kv`、Assets `assets`、Workers AI `ai`。

如果 Cloudflare 自动创建了类似 `Add Cloudflare Workers configuration` 的 PR，并把项目识别成 `Framework: static` / `Output Directory: mail-vue`，不要直接合并那份自动配置。那会把 `mail-vue` 源码目录当静态资源上传，导致 Worker 后端、D1 和 KV 绑定都不可用。应使用本仓库根目录的 `wrangler.jsonc`，或把自动 PR 中的 `wrangler.jsonc` 替换成这里的配置。

已手动创建 D1 / KV 且希望绑定到指定资源时，可以三选一：

1. 推荐使用上面的 `cloudflare-workers-git-deploy.mjs`，通过环境变量注入，不把资源 ID 写进仓库。
2. 使用 GitHub Actions 方式，通过 `D1_DATABASE_ID` 和 `KV_NAMESPACE_ID` 注入。
3. 在自己的私有 fork 中给根目录 `wrangler.jsonc` 补上 `database_id` 和 `id`。

### 方式三：GitHub Actions 自动部署

仓库包含 `.github/workflows/deploy-cloudflare.yml`。推送 `main` 且改动 `mail-worker/**`、`mail-vue/**`、`scripts/**`、根目录 `wrangler.jsonc` 或部署 workflow 时会触发部署。

建议配置以下 Secrets / Variables：

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `CUSTOM_DOMAIN`
- `DOMAIN`
- `ADMIN`
- `JWT_SECRET`
- `D1_DATABASE_NAME`
- `D1_DATABASE_ID`
- `KV_NAMESPACE_ID`
- `R2_BUCKET_NAME`，可选
- `RESEND_WEBHOOK_SECRET`，推荐配置
- `RESEND_WEBHOOK_ALLOW_UNSIGNED`，可选，仅兼容旧部署时设置为 `true`
- `CORS_ORIGINS`，可选

工作流会自动：

1. 安装 Worker 依赖。
2. 生成 `wrangler-action.toml`。
3. 检查或填充 D1 / KV 绑定。
4. 构建前端并部署 Worker。
5. 调用 `/api/init/{JWT_SECRET}` 初始化数据库。

### 首次部署检查清单

首次部署建议按这个顺序确认：

1. Cloudflare 构建日志中没有 `Framework: Static` / `Output Directory: mail-vue` / `Create wrangler.jsonc` 这类误识别提示。
2. Wrangler 输出的绑定里能看到 `env.db`、`env.kv`、`env.assets`。
3. 已在 Cloudflare Worker 变量/密钥中配置 `domain`、`admin`、`jwt_secret` 等运行时变量。
4. 访问 `https://你的域名/api/init/你的 jwt_secret`，返回 `success`。
5. 登录后台，进入维护中心，检查 D1 / KV / R2 / AI / 发信绑定状态。
6. 如提示缺字段、缺索引或缺搜索表，按顺序执行“补齐数据库结构”“补齐索引”“重建搜索表”。
7. 进入系统设置，配置域名、管理员、Resend、公告、验证码识别等业务选项。

## 数据库与维护

首次初始化或从旧版本同步后，建议进入“维护中心”检查：

- 数据库结构是否完整。
- 关键索引是否存在。
- `email_search` 搜索表是否存在。
- 搜索表行数是否与邮件数量匹配。

如果维护中心显示警告，可以按顺序使用：

1. 补齐数据库结构。
2. 补齐索引。
3. 重建搜索表。

这些操作是幂等修复，不会删除真实邮件、用户或附件。

## 验证码识别说明

本项目当前分两层识别：

1. 本地规则：默认启用，免费，适合常见数字验证码、短 token、带 `code` / `verification` / `验证码` 等提示的邮件。
2. AI 兜底：可选，仅在后台开启后使用，用于本地规则无法识别的复杂邮件。

如果你希望尽量省钱，保持“AI 兜底识别”关闭即可。验证码中心仍会使用本地规则。

## 常用排障

### 维护中心提示缺索引

进入维护中心点击“补齐索引”。如果仍然提示，确认当前 Worker 绑定的是正确的 D1 数据库。

### 验证码中心为空

先确认：

- 邮件是否已经进入收件箱。
- 筛选是否为“未过期”。超过 15 分钟的验证码需要切到“全部”。
- 邮件正文中是否有可识别的验证码。

新版本会在打开验证码中心时回填最近 2 天的旧邮件。

### Cloudflare 构建提示 pnpm lockfile mismatch

说明 `package.json` 的依赖或 overrides 和 `pnpm-lock.yaml` 不一致。进入对应目录执行：

```powershell
corepack pnpm install --no-frozen-lockfile
```

然后提交更新后的 lockfile。

### Cloudflare Workers Git 部署后 D1 / KV 绑定不上

先看构建日志。如果出现以下特征：

- `Detected Project Settings` 显示 `Framework: Static`。
- `Output Directory: mail-vue`。
- 日志里写着 `Create wrangler.jsonc`。
- 上传列表里出现 `/src/views/...`、`/package.json`、`/.env.release` 等前端源码文件。

说明 Cloudflare 没有用到真正的 Worker 配置，而是自动生成了静态站点配置。处理方式：

1. 不要合并 Cloudflare bot 生成的错误 `wrangler.jsonc` PR。
2. 使用仓库根目录已有的 `wrangler.jsonc` 重新部署。
3. 如果已经合并过错误配置，把其中的 `assets.directory = "mail-vue"` 或 `"directory": "mail-vue"` 替换为本仓库根目录配置。
4. 重新部署后进入维护中心检查 D1 / KV 绑定状态。

### D1 报 no such column

通常是 D1 schema 没初始化或旧数据库缺字段。访问初始化接口或在维护中心执行“补齐数据库结构”。

## 许可证

本项目沿用 [MIT License](LICENSE)。

## 致谢

本项目基于 Cloud Mail 上游项目改造，并结合自用部署、安全审计、性能优化和管理体验需求持续维护。
