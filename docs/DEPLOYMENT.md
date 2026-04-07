# NotebookLM MCP Server — Remote Deployment Guide

# NotebookLM MCP 服务器 — 远程部署指南

---

## Architecture Overview / 架构概览

```
┌─────────────────────┐     ┌─────────────────────┐
│  Claude CLI          │     │  Gemini CLI          │
│  (local machine)     │     │  (local machine)     │
└────────┬────────────┘     └────────┬────────────┘
         │ SSE                       │ SSE
         └───────────┬───────────────┘
                     ▼
          ┌─────────────────────┐
          │  NotebookLM MCP     │
          │  (Zeabur / Docker)  │
          │                     │
          │  GET  /sse          │ ← SSE transport
          │  POST /messages     │ ← MCP messages
          │  GET  /health       │ ← Health check
          │  POST /auth/update  │ ← Token hot-reload
          └─────────┬───────────┘
                    │ HTTPS
                    ▼
          ┌─────────────────────┐
          │  Google NotebookLM  │
          │  batchexecute RPC   │
          └─────────────────────┘
```

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
| `NOTEBOOKLM_CSRF_TOKEN` | No / 否 | Auto-extracted on first use / 首次使用时自动提取 |
| `NOTEBOOKLM_SESSION_ID` | No / 否 | Auto-extracted on first use / 首次使用时自动提取 |

---

## 4. Deploy to Zeabur / 部署到 Zeabur

### Option A: From GitHub / 从 GitHub 部署

1. Push code to GitHub / 推送代码到 GitHub
2. Go to [Zeabur Dashboard](https://dash.zeabur.com) → Create project / 创建项目
3. Add service → Deploy from GitHub repo / 添加服务 → 从 GitHub 仓库部署
4. Set environment variables / 设置环境变量:
   - `NOTEBOOKLM_COOKIES` = your cookie string
   - `MCP_API_KEY` = a strong random string / 一个强随机字符串
5. Zeabur auto-detects the Dockerfile and deploys / Zeabur 自动检测 Dockerfile 并部署
6. Bind a domain (e.g., `notebooklm-mcp.zeabur.app`) / 绑定域名

### Option B: Docker / Docker 部署

```bash
# Build image / 构建镜像
npm run build
docker build -t notebooklm-mcp .

# Run / 运行
docker run -d \
  -p 3000:3000 \
  -e NOTEBOOKLM_COOKIES="SID=xxx; HSID=xxx; SSID=xxx; APISID=xxx; SAPISID=xxx" \
  -e MCP_API_KEY="your-secret-key" \
  notebooklm-mcp
```

### Option C: Run directly / 直接运行

```bash
npm run build

# With env vars / 带环境变量
NOTEBOOKLM_COOKIES="SID=xxx; ..." \
MCP_API_KEY="your-secret-key" \
node dist/cli.js serve-remote --port 3000
```

---

## 5. Verify Deployment / 验证部署

```bash
# Health check / 健康检查
curl https://your-app.zeabur.app/health
# → {"status":"ok","version":"0.1.30","transport":"sse","active_sessions":0}

# Deep health check (includes token status) / 深度健康检查（含 token 状态）
curl https://your-app.zeabur.app/health?deep=true
# → {"status":"ok",...,"auth":{"age_hours":2,"valid":true}}
```

---

## 6. Client Configuration / 客户端配置

### Claude CLI

Edit `~/.claude.json` (or Claude Code settings):

编辑 `~/.claude.json`（或 Claude Code 设置）：

```json
{
  "mcpServers": {
    "notebooklm": {
      "type": "sse",
      "url": "https://your-app.zeabur.app/sse",
      "headers": {
        "Authorization": "Bearer YOUR_MCP_API_KEY"
      }
    }
  }
}
```

### Gemini CLI

Edit `~/.gemini/settings.json`:

编辑 `~/.gemini/settings.json`：

```json
{
  "mcpServers": {
    "notebooklm": {
      "type": "sse",
      "url": "https://your-app.zeabur.app/sse",
      "headers": {
        "Authorization": "Bearer YOUR_MCP_API_KEY"
      }
    }
  }
}
```

After configuration, both CLIs can use all 33 tools, including `sync_conversation` for syncing chat history to NotebookLM.

配置后，两个 CLI 均可使用全部 33 个工具，包括 `sync_conversation` 将对话历史同步到 NotebookLM。

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
# → {"status":"ok","message":"Auth tokens updated and client reset","cookie_count":12}
```

The server immediately starts using the new cookies. All existing SSE connections continue working.

服务器立即使用新 cookies。所有现有 SSE 连接继续工作。

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
| `/sse` | GET | API Key | SSE transport for MCP clients / MCP 客户端的 SSE 传输 |
| `/messages` | POST | API Key | Message handler for SSE sessions / SSE 会话的消息处理 |
| `/auth/update` | POST | API Key | Hot-reload auth tokens / 热更新认证 token |

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

### SSE connection drops / SSE 连接断开

**Cause / 原因:** Load balancer timeout or network interruption / 负载均衡超时或网络中断

MCP clients auto-reconnect. If using a reverse proxy, set timeout > 300s.

MCP 客户端会自动重连。如使用反向代理，设置超时 > 300 秒。

### 401 / 403 on endpoints / 端点返回 401 / 403

**Cause / 原因:** Missing or wrong API key / API 密钥缺失或错误

Ensure `Authorization: Bearer <key>` header matches `MCP_API_KEY` env var.

确保 `Authorization: Bearer <key>` 请求头与 `MCP_API_KEY` 环境变量一致。

### Docker build fails / Docker 构建失败

Ensure `dist/` exists before building the image / 构建镜像前确保 `dist/` 目录存在:

```bash
npm run build
docker build -t notebooklm-mcp .
```

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
