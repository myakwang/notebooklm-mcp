# NotebookLM MCP Server — Remote Deployment Guide

# NotebookLM MCP 服务器 — 远程部署指南

---

## Architecture Overview / 架构概览

```
┌─────────────────────┐  ┌─────────────────────┐  ┌─────────────────────┐
│  Claude.ai           │  │  Claude Code (CLI)   │  │  Gemini CLI          │
│  (web)               │  │  (local machine)     │  │  (local machine)     │
└────────┬────────────┘  └────────┬────────────┘  └────────┬────────────┘
         │ Streamable HTTP        │ Streamable HTTP        │ Streamable HTTP
         └────────────────────────┼────────────────────────┘
                                  ▼
                    ┌──────────────────────────┐
                    │  NotebookLM MCP Server   │
                    │  (Zeabur / Docker)        │
                    │                          │
                    │  POST/GET/DELETE /mcp     │ ← Streamable HTTP (recommended)
                    │  GET  /sse               │ ← SSE (legacy)
                    │  POST /messages           │ ← SSE messages
                    │  GET  /health             │ ← Health check
                    │  POST /auth/update        │ ← Token hot-reload
                    └─────────┬────────────────┘
                              │ HTTPS
                              ▼
                    ┌──────────────────────────┐
                    │  Google NotebookLM       │
                    │  batchexecute RPC        │
                    └──────────────────────────┘
```

**Two transports supported / 支持两种传输协议：**

| Transport / 传输 | Endpoint / 端点 | Clients / 客户端 |
|---|---|---|
| **Streamable HTTP** (recommended / 推荐) | `/mcp` | Claude.ai, Claude Code, Gemini CLI |
| SSE (legacy / 旧版) | `/sse` + `/messages` | Legacy MCP clients / 旧版客户端 |

---

## 1. Prerequisites / 前置条件

### Local tools / 本地工具

- Node.js >= 18
- npm
- Google account with NotebookLM access / 可访问 NotebookLM 的 Google 账号

### Build / 构建

```bash
npm install
npm run build
```

The build outputs `dist/cli.js` — a single ESM bundle.

构建产物为 `dist/cli.js`，单个 ESM 打包文件。

---

## 2. Authentication / 认证

NotebookLM uses cookie-based authentication. Extract cookies locally, then push to the cloud server.

NotebookLM 使用基于 cookie 的认证。在本地提取 cookies，然后推送到云端服务器。

### Step 1: Extract cookies locally / 第一步：本地提取 cookies

```bash
# Automated (opens Chrome, extracts cookies automatically)
# 自动化（打开 Chrome，自动提取 cookies）
npx notebooklm-mcp auth

# Or manual (copy-paste from DevTools)
# 或手动（从 DevTools 复制粘贴）
npx notebooklm-mcp auth --manual
```

Tokens are saved to `~/.notebooklm-mcp/auth.json`.

Token 保存在 `~/.notebooklm-mcp/auth.json`。

### Step 2: Get the cookie string / 第二步：获取 cookie 字符串

```bash
npx notebooklm-mcp auth --show-tokens
```

Or read the JSON file directly for the `/auth/update` API.

或直接读取 JSON 文件用于 `/auth/update` API。

---

## 3. Environment Variables / 环境变量

| Variable / 变量 | Required / 必需 | Description / 说明 |
|---|---|---|
| `NOTEBOOKLM_COOKIES` | Yes / 是 | Google cookies string, format: `SID=xxx; HSID=xxx; SSID=xxx; APISID=xxx; SAPISID=xxx` |
| `MCP_API_KEY` | Recommended / 推荐 | API key to protect the server endpoints. Without it, the server is publicly accessible / 保护服务端点的 API 密钥。不设置则服务器公开可访问 |
| `PORT` | No / 否 | HTTP port, auto-set by cloud platforms (Zeabur, Railway). Defaults to 3000 / HTTP 端口，云平台自动设置，默认 3000 |
| `NOTEBOOKLM_CSRF_TOKEN` | No / 否 | Auto-extracted on first use / 首次使用时自动提取 |
| `NOTEBOOKLM_SESSION_ID` | No / 否 | Auto-extracted on first use / 首次使用时自动提取 |

### Generate MCP_API_KEY / 生成 MCP_API_KEY

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## 4. Deploy to Zeabur / 部署到 Zeabur

### Option A: From GitHub (Recommended) / 从 GitHub 部署（推荐）

1. Push code to GitHub / 推送代码到 GitHub
2. Go to [Zeabur Dashboard](https://dash.zeabur.com) → Create project / 创建项目
3. Add service → Deploy from GitHub repo / 添加服务 → 从 GitHub 仓库部署
4. Set environment variables / 设置环境变量:
   - `NOTEBOOKLM_COOKIES` = your cookie string (or push later via `/auth/update`)
   - `MCP_API_KEY` = generated random string / 生成的随机字符串
5. Zeabur auto-detects the Dockerfile (multi-stage build, includes TypeScript compilation) / Zeabur 自动检测 Dockerfile（多阶段构建，包含 TypeScript 编译）
6. Bind a domain (e.g., `notebooklm-mcp.zeabur.app`) / 绑定域名

### Option B: Docker / Docker 部署

```bash
# Build image (multi-stage: compiles TypeScript inside Docker)
# 构建镜像（多阶段：在 Docker 内编译 TypeScript）
docker build -t notebooklm-mcp .

# Run / 运行
docker run -d \
  -p 3000:3000 \
  -e PORT=3000 \
  -e NOTEBOOKLM_COOKIES="SID=xxx; HSID=xxx; SSID=xxx; APISID=xxx; SAPISID=xxx" \
  -e MCP_API_KEY="your-secret-key" \
  notebooklm-mcp
```

### Option C: Run directly / 直接运行

```bash
npm install && npm run build

NOTEBOOKLM_COOKIES="SID=xxx; ..." \
MCP_API_KEY="your-secret-key" \
node dist/cli.js serve-remote --port 3000
```

---

## 5. Verify Deployment / 验证部署

```bash
# Health check / 健康检查
curl https://your-app.zeabur.app/health
# → {"status":"ok","version":"0.1.30","transport":"sse+streamable-http","active_sessions":0}

# Deep health check (includes token status) / 深度健康检查（含 token 状态）
curl https://your-app.zeabur.app/health?deep=true
# → {"status":"ok",...,"auth":{"age_hours":2,"valid":true}}
```

---

## 6. Client Configuration / 客户端配置

### Claude.ai (Web)

Add as MCP Connector in Claude.ai settings. Connection string format:

在 Claude.ai 设置中添加 MCP Connector。连接串格式：

```
https://your-app.zeabur.app/mcp?secret-key=YOUR_MCP_API_KEY
```

### Claude Code (CLI)

Edit `~/.claude/.mcp.json` (global MCP config):

编辑 `~/.claude/.mcp.json`（全局 MCP 配置）：

```json
{
  "mcpServers": {
    "notebooklm": {
      "url": "https://your-app.zeabur.app/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_MCP_API_KEY"
      }
    }
  }
}
```

### Gemini CLI

Edit `~/.gemini/settings.json`, add to `mcpServers`:

编辑 `~/.gemini/settings.json`，在 `mcpServers` 中添加：

```json
{
  "mcpServers": {
    "notebooklm": {
      "url": "https://your-app.zeabur.app/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_MCP_API_KEY"
      }
    }
  }
}
```

After configuration, all clients can use all 33 tools. Restart the CLI after configuration changes.

配置后所有客户端均可使用全部 33 个工具。修改配置后需重启 CLI。

---

## 7. Token Refresh / Token 刷新

Google cookies expire periodically (hours to days). The server provides a hot-reload endpoint — no restart needed.

Google cookies 会定期过期（数小时到数天）。服务器提供热更新端点，无需重启。

### Method: Hot Reload / 方法：热更新

```bash
# 1. Refresh cookies locally / 本地刷新 cookies
npx notebooklm-mcp auth

# 2. Push to cloud server / 推送到云端服务器
curl -X POST https://your-app.zeabur.app/auth/update \
  -H "Authorization: Bearer YOUR_MCP_API_KEY" \
  -H "Content-Type: application/json" \
  -d @~/.notebooklm-mcp/auth.json
# → {"status":"ok","message":"Auth tokens updated and client reset","cookie_count":23}
```

The server immediately starts using the new cookies. All existing connections continue working.

服务器立即使用新 cookies。所有现有连接继续工作。

### Check token age / 检查 token 年龄

```bash
curl https://your-app.zeabur.app/health?deep=true
# auth.age_hours > 24 → consider refreshing
# auth.age_hours > 24 → 建议刷新
```

---

## 8. API Endpoints / API 端点

| Endpoint / 端点 | Method | Auth / 认证 | Description / 说明 |
|---|---|---|---|
| `/health` | GET | No / 否 | Health check, add `?deep=true` for token status / 健康检查，加 `?deep=true` 查看 token 状态 |
| `/mcp` | POST, GET, DELETE | API Key | Streamable HTTP transport (recommended) / Streamable HTTP 传输（推荐） |
| `/sse` | GET | API Key | SSE transport (legacy) / SSE 传输（旧版） |
| `/messages` | POST | API Key | Message handler for SSE sessions / SSE 会话的消息处理 |
| `/auth/update` | POST | API Key | Hot-reload auth tokens / 热更新认证 token |

**Auth methods / 认证方式：** API key can be passed via `Authorization: Bearer <key>` header or `?secret-key=<key>` query parameter.

API 密钥可通过 `Authorization: Bearer <key>` 请求头或 `?secret-key=<key>` 查询参数传递。

---

## 9. Available Tools (33) / 可用工具（33 个）

### Conversation Sync / 对话同步 (NEW / 新增)

| Tool | Description / 说明 |
|---|---|
| `sync_conversation` | Sync a conversation transcript as a formatted text source / 将对话记录作为格式化文本源同步到笔记本 |

**Example / 示例:**

```json
{
  "notebook_id": "nb-12345",
  "title": "Claude session — API design review",
  "source_client": "claude-cli",
  "messages": [
    { "role": "user", "content": "How should we structure the auth module?" },
    { "role": "assistant", "content": "I recommend splitting into three layers..." }
  ]
}
```

### Notebook Management / 笔记本管理 (6)

`notebook_list`, `notebook_create`, `notebook_get`, `notebook_describe`, `notebook_rename`, `notebook_delete`

### Source Management / 数据源管理 (8)

`source_describe`, `source_get_content`, `notebook_add_url`, `notebook_add_text`, `notebook_add_drive`, `source_list_drive`, `source_sync_drive`, `source_delete`

### Query & Chat / 查询与对话 (2)

`notebook_query`, `chat_configure`

### Research / 研究 (3)

`research_start`, `research_status`, `research_import`

### Studio Content / Studio 内容生成 (11)

`audio_overview_create`, `video_overview_create`, `infographic_create`, `slide_deck_create`, `report_create`, `flashcards_create`, `quiz_create`, `data_table_create`, `mind_map_create`, `studio_status`, `studio_delete`

### Authentication / 认证 (2)

`refresh_auth`, `save_auth_tokens`

---

## 10. Troubleshooting / 常见问题

### "Couldn't reach the MCP server" in Claude.ai

**Cause / 原因:** Server not yet deployed, wrong URL, or build in progress / 服务器未部署、URL 错误或正在构建中

```bash
# Verify server is running / 验证服务器是否运行
curl https://your-app.zeabur.app/health

# Test Streamable HTTP endpoint / 测试 Streamable HTTP 端点
curl -X POST "https://your-app.zeabur.app/mcp?secret-key=YOUR_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}},"id":1}'
```

### Server starts but tools fail / 服务器启动但工具调用失败

**Cause / 原因:** Cookies expired or invalid / Cookies 过期或无效

```bash
# Check / 检查
curl https://your-app.zeabur.app/health?deep=true

# Fix: refresh and push / 修复：刷新并推送
npx notebooklm-mcp auth
curl -X POST https://your-app.zeabur.app/auth/update \
  -H "Authorization: Bearer YOUR_MCP_API_KEY" \
  -H "Content-Type: application/json" \
  -d @~/.notebooklm-mcp/auth.json
```

### 502 Bad Gateway on Zeabur / Zeabur 返回 502

**Cause / 原因:** Server not listening on the platform-assigned `PORT` / 服务器未监听平台分配的 `PORT`

The server reads `PORT` from environment automatically. Zeabur sets this. If running Docker locally, pass `-e PORT=3000`.

服务器自动读取环境变量 `PORT`。Zeabur 会自动设置。本地 Docker 运行时需传 `-e PORT=3000`。

### 401 / 403 on endpoints / 端点返回 401 / 403

**Cause / 原因:** Missing or wrong API key / API 密钥缺失或错误

API key can be passed two ways / API 密钥支持两种方式：
- Header: `Authorization: Bearer <key>`
- Query: `?secret-key=<key>`

### Docker build fails / Docker 构建失败

The Dockerfile uses multi-stage build — no need to pre-build `dist/` locally. Just run:

Dockerfile 使用多阶段构建，无需本地预先构建 `dist/`。直接运行：

```bash
docker build -t notebooklm-mcp .
```

### MCP server not showing in Claude Code / Claude Code 看不到 MCP 服务器

Claude Code uses `~/.claude/.mcp.json` for MCP server config (not `~/.claude.json` or `settings.json`). Use `url` field with Streamable HTTP endpoint (`/mcp`), not SSE.

Claude Code 使用 `~/.claude/.mcp.json` 配置 MCP 服务器（不是 `~/.claude.json` 或 `settings.json`）。使用 `url` 字段指向 Streamable HTTP 端点（`/mcp`），而非 SSE。

---

## 11. Security Notes / 安全说明

- **Always set `MCP_API_KEY`** in production. Without it, anyone can access your NotebookLM data.
- **生产环境务必设置 `MCP_API_KEY`**。不设置则任何人可访问你的 NotebookLM 数据。
- The `/health` endpoint is public by design (for monitoring). It does not expose sensitive data.
- `/health` 端点设计为公开（用于监控），不暴露敏感数据。
- Cookies are stored in `~/.notebooklm-mcp/auth.json` with `0600` permissions.
- Cookies 以 `0600` 权限存储在 `~/.notebooklm-mcp/auth.json`。
- Never commit cookies or API keys to version control.
- 切勿将 cookies 或 API 密钥提交到版本控制。
- When using `?secret-key=` in URLs, the key may appear in server access logs. Use `Authorization` header for higher security.
- 使用 `?secret-key=` 时，密钥可能出现在服务器访问日志中。更高安全性建议使用 `Authorization` 请求头。
