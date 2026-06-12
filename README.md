<div align="center">

<img src="doc/demo/logo.png" alt="Cloud Mail" width="96" />

# Cloud Mail

**基于 Cloudflare Workers 的自托管邮箱系统**

一个 Worker 承载前后端 · 数据归自己所有 · 不开 AI 也能用的验证码中心 · 内置维护后台

<p>
  <img alt="Cloudflare Workers" src="https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white" />
  <img alt="Hono" src="https://img.shields.io/badge/Hono-Backend-E36002?logo=hono&logoColor=white" />
  <img alt="Vue 3" src="https://img.shields.io/badge/Vue_3-Frontend-4FC08D?logo=vuedotjs&logoColor=white" />
  <img alt="D1" src="https://img.shields.io/badge/D1-Database-F38020?logo=cloudflare&logoColor=white" />
  <img alt="Node" src="https://img.shields.io/badge/Node.js-22-5FA04E?logo=nodedotjs&logoColor=white" />
  <img alt="License" src="https://img.shields.io/badge/License-MIT-blue" />
</p>

[简体中文](README.md) · [English](README-en.md)

</div>

---

适合个人、小团队或临时邮箱场景长期自用。本仓库作为独立项目维护，不再依赖 GitHub fork 同步；持续优化方向：**稳定收发、低成本运行、数据可维护、验证码读取更快**。

## 📸 界面预览

| 收件箱 | 邮件详情 |
| :---: | :---: |
| ![收件箱](doc/demo/demo1.png) | ![邮件详情](doc/demo/demo2.png) |
| **分析页** | **用户管理** |
| ![分析页](doc/demo/demo3.png) | ![用户管理](doc/demo/demo4.png) |

## ✨ 项目特点

- 🧩 **一体化部署** — 一个 Cloudflare Worker 同时承载后端 API 和 Vue 前端静态资源。
- 🔒 **数据归自己所有** — 邮件、用户、设置保存在自己的 D1 / KV / R2 资源里。
- 💸 **低成本验证码中心** — 默认本地规则识别验证码，不开 AI 也能正常使用。
- 🛠️ **维护中心内置** — 一键检查 D1/KV/R2/AI/发信绑定，补齐字段、索引和搜索表。
- 🚀 **面向真实部署优化** — Workers Git、GitHub Actions、本地 Wrangler 三种部署路径。
- 🛡️ **安全默认值更稳** — Webhook 签名、CORS 收紧、HTML 清洗、附件鉴权开箱即用。

## 🗂️ 功能概览

### 邮箱基础能力

- 多域名、多邮箱地址管理；收件箱、已发送、草稿箱、星标、全部邮件。
- 发送、回复、抄送、密送、附件和内嵌图片。
- Resend 发信状态回调，默认要求 webhook 签名校验；旧部署可显式开启未签名兼容。
- 可选 Cloudflare Email Routing 发信绑定；可选 R2 附件存储。

### 验证码中心

- 独立页面，支持「我的验证码」和「全站验证码」（管理员）。
- 点击验证码卡片直接复制，右上角「详情」跳转邮件详情。
- 默认本地规则识别常见验证码（多语言标签、上下文打分、负面上下文过滤），**不需要开启 Workers AI，不产生 AI 费用**。
- AI 只作可选兜底：本地规则识别不到且后台开启 AI 兜底时才会调用。
- 打开验证码中心时对最近邮件做轻量回填，兼容旧邮件。

### 管理员能力

- 用户、邮箱、角色权限管理；注册密钥、用户状态、发信次数限制。
- 全部邮件检索、批量删除、邮件详情查看。
- 分析页：用户、邮件、收发趋势等图表。
- 系统设置：站点标题、登录页、公告、黑名单、转发、Turnstile 人机验证等。

### 维护中心

- D1 / KV / R2 / AI / 发信绑定状态检查。
- 数据库字段、索引、搜索表健康检查与幂等修复（补齐结构、补齐索引、重建搜索表）。
- 验证码维护：重新扫描、清理误判、清理过期。

### 性能与安全

- 邮件列表接口瘦身，正文按需加载；`email_search` 搜索表 + 组合索引优化 D1 查询。
- 设置、权限、角色短缓存；附件匹配 Map 化。
- 前端 Vite 分包：Element Plus、ECharts、Dexie、Vue vendor 独立 chunk；TinyMCE、Turnstile 按需加载。
- Worker CORS 默认收紧（`cors_origins` 显式放行）；公告和邮件 HTML 基础安全清洗；public 接口参数绑定防注入。

## 🧰 技术栈

| 模块 | 技术 |
| --- | --- |
| 运行平台 | Cloudflare Workers |
| 后端框架 | Hono |
| 数据库 | Cloudflare D1 + Drizzle ORM |
| 缓存 | Cloudflare KV |
| 文件存储 | Cloudflare R2（可选） |
| 前端 | Vue 3 + Vite + Element Plus |
| 图表 | ECharts |
| 邮件解析 | postal-mime |
| 发信 | Resend / Cloudflare Email（可选） |

## 🚀 快速开始

### 准备 Cloudflare 资源

| 资源 | 必需 | 绑定名 |
| --- | :---: | --- |
| Workers | ✅ | — |
| D1 数据库 | ✅ | `db` |
| KV Namespace | ✅ | `kv` |
| R2 Bucket | 可选 | `r2` |
| Workers AI | 可选 | `ai` |
| 自定义域名 + 邮箱域名 DNS / Email Routing | ✅ | — |

> 💡 从旧仓库或旧 Worker 切换过来时，继续绑定原来的 `D1_DATABASE_ID`、`KV_NAMESPACE_ID`、`R2_BUCKET_NAME`，数据不会因为换仓库而丢失。真正要避免的是部署时误绑定到新的空 D1 / KV。

### 重要环境变量

敏感值放 Cloudflare Workers Secrets 或 GitHub Secrets，不要提交到仓库。

| 变量 | 必填 | 说明 |
| --- | :---: | --- |
| `domain` / `DOMAIN` | ✅ | 邮箱域名 JSON 数组，例如 `["example.com"]` |
| `admin` / `ADMIN` | ✅ | 管理员邮箱 |
| `jwt_secret` / `JWT_SECRET` | ✅ | 登录 token 密钥，建议随机 UUID 或更长随机串 |
| `D1_DATABASE_NAME` | ✅ | D1 数据库名，默认 `mail` |
| `D1_DATABASE_ID` | ✅ | D1 数据库 ID |
| `KV_NAMESPACE_ID` | ✅ | KV Namespace ID |
| `CUSTOM_DOMAIN` | 推荐 | Worker 自定义域名 |
| `R2_BUCKET_NAME` | 可选 | 附件对象存储桶 |
| `CORS_ORIGINS` | 可选 | 额外跨域来源 JSON 数组字符串 |
| `RESEND_WEBHOOK_SECRET` | 推荐 | Resend webhook 签名密钥 |
| `RESEND_WEBHOOK_ALLOW_UNSIGNED` | 可选 | 仅兼容旧部署时填 `true` |
| `AI_MODEL` | 可选 | Workers AI 兜底识别模型 |
| `ANALYSIS_CACHE` | 可选 | 分析页缓存开关 |
| `CF_EMAIL` | 可选 | 是否启用 Cloudflare Email 发信绑定 |

### 部署方式

<details>
<summary><b>方式一：Cloudflare Workers Git 集成（推荐）</b></summary>

在 Cloudflare Dashboard 连接 GitHub 仓库，部署命令使用仓库提供的脚本：

```text
node scripts/cloudflare-workers-git-deploy.mjs
```

如果 Cloudflare 项目根目录设置成了 `mail-worker`，改为：

```text
node ../scripts/cloudflare-workers-git-deploy.mjs
```

脚本会先显式构建 `mail-worker/dist`，再生成临时 wrangler 配置，用环境变量显式写入 D1 / KV / R2 绑定，然后部署。建议配置的构建变量：

- `D1_DATABASE_NAME`（默认 `mail`）、`D1_DATABASE_ID`、`KV_NAMESPACE_ID`
- `R2_BUCKET_NAME`、`CUSTOM_DOMAIN`、`NAME`（默认 `cloud-mail`）均可选
- `CF_EMAIL` 填 `true` 时启用 Cloudflare Email 发信绑定
- `CLOUD_MAIL_WRANGLER_VERSION` 可选，默认 `4.92.0`

已有生产数据时，**务必确认三项指向旧资源**：

```text
D1_DATABASE_ID=原来的 D1 ID
KV_NAMESPACE_ID=原来的 KV ID
R2_BUCKET_NAME=原来的 R2 桶名（可选）
```

本地只验证不部署：

```powershell
$env:CLOUD_MAIL_DEPLOY_DRY_RUN='true'
node scripts/cloudflare-workers-git-deploy.mjs
```

> ⚠️ 如果 Cloudflare 自动创建了类似 `Add Cloudflare Workers configuration` 的 PR，并把项目识别成 `Framework: static` / `Output Directory: mail-vue`，**不要合并**。那会把前端源码当静态资源上传，导致 Worker 后端和 D1 / KV 绑定全部失效。应使用本仓库根目录的 `wrangler.jsonc`。

</details>

<details>
<summary><b>方式二：本地 Wrangler 直接部署</b></summary>

`mail-worker/wrangler.toml` 已配置 Worker 入口（`src/index.js`）、静态资源目录（`./dist`）和构建命令。

```powershell
cd mail-worker
corepack pnpm wrangler deploy
```

首次部署后用 POST 初始化数据库（不要把 `jwt_secret` 放在 URL 里）：

```bash
curl -X POST -H "X-Cloud-Mail-Init-Secret: 你的 jwt_secret" https://你的域名/api/init
```

初始化完成后进入后台配置域名、管理员、Resend、公告、验证码识别等。

</details>

<details>
<summary><b>方式三：GitHub Actions 自动部署</b></summary>

仓库包含 `.github/workflows/deploy-cloudflare.yml`，推送 `main` 且改动相关路径时触发。

建议配置以下 Secrets / Variables：

`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`、`CUSTOM_DOMAIN`、`DOMAIN`、`ADMIN`、`JWT_SECRET`、`D1_DATABASE_NAME`、`D1_DATABASE_ID`、`KV_NAMESPACE_ID`，以及可选的 `R2_BUCKET_NAME`、`RESEND_WEBHOOK_SECRET`（推荐）、`RESEND_WEBHOOK_ALLOW_UNSIGNED`、`CORS_ORIGINS`。

工作流自动完成：安装依赖 → 生成 `wrangler-action.toml` → 检查/填充 D1、KV 绑定 → 构建前端并部署 → 通过 `POST /api/init` 初始化数据库。

</details>

### ✅ 首次部署检查清单

1. 构建日志中没有 `Framework: Static` / `Output Directory: mail-vue` / `Create wrangler.jsonc` 等误识别提示。
2. Wrangler 输出的绑定里能看到 `env.db`、`env.kv`、`env.assets`。
3. 已配置 `domain`、`admin`、`jwt_secret` 等运行时变量，敏感值使用 Secrets。
4. 执行 `curl -X POST -H "X-Cloud-Mail-Init-Secret: 你的 jwt_secret" https://你的域名/api/init` 返回 `success`。
5. 登录后台 → 维护中心，检查 D1 / KV / R2 / AI / 发信绑定状态。
6. 如提示缺字段、缺索引或缺搜索表，按顺序执行「补齐数据库结构」「补齐索引」「重建搜索表」。
7. 进入系统设置，配置域名、管理员、Resend、公告、验证码识别等业务选项。

<details>
<summary><b>从旧 Cloudflare 项目切到本仓库</b></summary>

1. 先在 Cloudflare Dashboard 记录当前 D1、KV、R2 绑定信息。
2. 新 GitHub 连接使用 `node scripts/cloudflare-workers-git-deploy.mjs` 作为部署命令。
3. 构建变量里填回旧资源 ID，不要留空让 Wrangler 自动创建新资源。
4. 部署完成后进入维护中心，确认 `db`、`kv`、`assets`、`r2` 状态正常。
5. 如页面显示缺字段或缺索引，按维护中心提示执行幂等修复。
6. 确认收件箱、验证码中心、附件预览、发信设置都正常后，再清理旧仓库连接。

</details>

## 🧑‍💻 本地开发

建议使用 Node.js 22 和 pnpm。

```powershell
# 安装依赖
cd mail-worker && corepack pnpm install
cd ../mail-vue && corepack pnpm install

# 启动 Worker（http://127.0.0.1:8787）
cd mail-worker && corepack pnpm dev

# 启动前端（默认请求 http://127.0.0.1:8787/api）
cd mail-vue && corepack pnpm dev
```

发布前检查：

```powershell
# Worker 测试
cd mail-worker && corepack pnpm vitest run

# 前端构建（产物输出到 mail-worker/dist）
cd ../mail-vue && corepack pnpm build
```

## 🔍 验证码识别说明

识别分两层：

1. **本地规则（默认，免费）** — 多语言标签匹配 + 上下文打分 + 负面上下文过滤，覆盖常见数字 / 字母数字验证码、表格布局 HTML 邮件、繁简中文等。
2. **AI 兜底（可选）** — 仅在后台开启后，对本地规则识别不到的复杂邮件调用 Workers AI。

希望尽量省钱就保持「AI 兜底识别」关闭，验证码中心仍会正常工作。

## 🧯 常用排障

<details>
<summary><b>维护中心提示缺索引</b></summary>

进入维护中心点击「补齐索引」。如果仍然提示，确认当前 Worker 绑定的是正确的 D1 数据库。

</details>

<details>
<summary><b>验证码中心为空</b></summary>

- 确认邮件已经进入收件箱。
- 筛选是否为「未过期」：超过 15 分钟的验证码需要切到「全部」。
- 确认邮件正文中有可识别的验证码。新版本会在打开验证码中心时回填最近 2 天的旧邮件。

</details>

<details>
<summary><b>Cloudflare 构建提示 pnpm lockfile mismatch</b></summary>

`package.json` 的依赖或 overrides 和 `pnpm-lock.yaml` 不一致。进入对应目录执行：

```powershell
corepack pnpm install --no-frozen-lockfile
```

然后提交更新后的 lockfile。

</details>

<details>
<summary><b>Workers Git 部署后 D1 / KV 绑定不上</b></summary>

构建日志若出现以下特征，说明 Cloudflare 自动生成了错误的静态站点配置：

- `Detected Project Settings` 显示 `Framework: Static`；
- `Output Directory: mail-vue`；
- 日志里写着 `Create wrangler.jsonc`；
- 上传列表里出现 `/src/views/...`、`/package.json` 等前端源码文件。

处理：不要合并 Cloudflare bot 生成的 `wrangler.jsonc` PR；使用仓库根目录的 `wrangler.jsonc` 重新部署；已合并过的把 `"directory": "mail-vue"` 替换为本仓库根目录配置；重新部署后进维护中心检查绑定。

</details>

<details>
<summary><b>换仓库后像是数据没了</b></summary>

通常不是数据被删，而是 Worker 绑定到了新的 D1 / KV。检查当前 Worker 绑定：

- D1 绑定名必须是 `db`，ID 是旧 D1 的 ID；
- KV 绑定名必须是 `kv`，ID 是旧 KV 的 ID；
- R2 绑定名建议是 `r2`，桶名是旧桶名。

修正绑定后重新部署，原数据会重新显示。

</details>

<details>
<summary><b>D1 报 no such column</b></summary>

D1 schema 未初始化或旧数据库缺字段。访问初始化接口，或在维护中心执行「补齐数据库结构」。

</details>

## 📁 目录结构

<details>
<summary>展开查看</summary>

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
├─ scripts/                  # Workers Git 构建/部署辅助脚本
├─ .github/workflows/        # GitHub Actions 部署
├─ wrangler.jsonc            # Workers Git 根目录部署配置
└─ README.md
```

</details>

## 📄 许可证

本项目沿用 [MIT License](LICENSE)。

## 🙏 致谢

基于 Cloud Mail 上游项目改造，结合自用部署、安全审计、性能优化和管理体验需求持续维护。
