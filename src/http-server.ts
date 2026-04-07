import http from "node:http";
import crypto from "node:crypto";
import express from "express";
import cors from "cors";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadTokensFromCache, updateTokensFromJson } from "./auth.js";
import { resetClient } from "./server.js";

export interface HttpServerOptions {
  port: number;
  apiKey?: string;
}

export function createHttpServer(
  serverFactory: () => McpServer,
  options: HttpServerOptions,
): http.Server {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "10mb" }));

  // API key auth middleware (skip for /health)
  if (options.apiKey) {
    app.use((req, res, next) => {
      if (req.path === "/health" || (req.path === "/auth" && req.method === "GET")) return next();

      // Support both: Authorization header and ?secret-key= query param
      const authHeader = req.headers.authorization;
      const queryKey = req.query["secret-key"] as string | undefined;
      const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : queryKey;

      if (!token || token !== options.apiKey) {
        res.status(401).json({ error: "Invalid or missing API key" });
        return;
      }
      next();
    });
  }

  // ─── Session tracking ──────────────────────────────────

  // SSE sessions
  const sseSessions = new Map<string, { server: McpServer; transport: SSEServerTransport }>();

  // Streamable HTTP sessions
  const httpSessions = new Map<string, { server: McpServer; transport: StreamableHTTPServerTransport }>();

  // ─── Health check ──────────────────────────────────────

  app.get("/health", (_req, res) => {
    const result: Record<string, unknown> = {
      status: "ok",
      version: "0.1.30",
      transport: "sse+streamable-http",
      active_sessions: sseSessions.size + httpSessions.size,
    };

    if (_req.query.deep === "true") {
      const cached = loadTokensFromCache();
      if (cached) {
        const ageHours = Math.round((Date.now() / 1000 - cached.extracted_at) / 3600);
        result.auth = { age_hours: ageHours, valid: true };
      } else {
        result.auth = { valid: false };
      }
    }

    res.json(result);
  });

  // ─── Streamable HTTP transport (/mcp) ──────────────────

  app.post("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId && httpSessions.has(sessionId)) {
      const session = httpSessions.get(sessionId)!;
      await session.transport.handleRequest(req, res, req.body);
      return;
    }

    if (sessionId) {
      // Stale session — tell client to reconnect
      res.status(404).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Session not found. Please reconnect." },
        id: null,
      });
      return;
    }

    // New session (no session ID = initialize request)
    const server = serverFactory();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => {
        httpSessions.set(id, { server, transport });
      },
    });

    transport.onclose = () => {
      for (const [id, entry] of httpSessions.entries()) {
        if (entry.transport === transport) {
          httpSessions.delete(id);
          break;
        }
      }
    };

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.get("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !httpSessions.has(sessionId)) {
      res.status(400).json({ error: "Invalid or missing session ID" });
      return;
    }
    const session = httpSessions.get(sessionId)!;
    await session.transport.handleRequest(req, res);
  });

  app.delete("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !httpSessions.has(sessionId)) {
      res.status(400).json({ error: "Invalid or missing session ID" });
      return;
    }
    const session = httpSessions.get(sessionId)!;
    await session.transport.handleRequest(req, res);
    httpSessions.delete(sessionId);
  });

  // ─── SSE transport (GET /sse, POST /messages) ─────────

  app.get("/sse", async (req, res) => {
    const server = serverFactory();
    const transport = new SSEServerTransport("/messages", res);
    const sessionId = transport.sessionId;

    sseSessions.set(sessionId, { server, transport });

    req.on("close", () => {
      sseSessions.delete(sessionId);
    });

    await server.connect(transport);
  });

  app.post("/messages", async (req, res) => {
    const sessionId = req.query.sessionId as string;
    const session = sseSessions.get(sessionId);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    await session.transport.handlePostMessage(req, res);
  });

  // ─── Auth web UI ───────────────────────────────────────

  app.get("/auth", (_req, res) => {
    res.type("html").send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>NotebookLM MCP — Auth</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh;display:flex;align-items:center;justify-content:center}
.card{background:#1e293b;border-radius:12px;padding:32px;max-width:560px;width:100%}
h1{font-size:1.4rem;margin-bottom:8px}
p{color:#94a3b8;font-size:.9rem;margin-bottom:16px;line-height:1.5}
.steps{background:#0f172a;border-radius:8px;padding:16px;margin-bottom:16px;font-size:.85rem;line-height:1.8}
.steps code{background:#334155;padding:2px 6px;border-radius:4px;font-size:.8rem}
textarea{width:100%;height:100px;background:#0f172a;border:1px solid #334155;border-radius:8px;color:#e2e8f0;padding:12px;font-family:monospace;font-size:.85rem;resize:vertical;margin-bottom:12px}
textarea:focus{outline:none;border-color:#3b82f6}
button{background:#3b82f6;color:#fff;border:none;padding:10px 24px;border-radius:8px;font-size:.9rem;cursor:pointer;width:100%}
button:hover{background:#2563eb}
button:disabled{background:#334155;cursor:not-allowed}
.msg{margin-top:12px;padding:12px;border-radius:8px;font-size:.85rem;display:none}
.msg.ok{display:block;background:#064e3b;color:#6ee7b7}
.msg.err{display:block;background:#7f1d1d;color:#fca5a5}
.status{text-align:center;color:#94a3b8;font-size:.8rem;margin-top:16px}
</style></head><body>
<div class="card">
<h1>NotebookLM MCP Auth</h1>
<p>Paste your Google cookies below to authenticate the MCP server.</p>
<div class="steps">
<strong>How to get cookies:</strong><br>
1. Open <code>notebooklm.google.com</code> in Chrome<br>
2. Press <code>F12</code> → Network tab<br>
3. Filter: <code>batchexecute</code><br>
4. Click any request → Headers → copy <code>cookie:</code> value
</div>
<textarea id="cookies" placeholder="Paste cookie string here...&#10;SID=xxx; HSID=xxx; SSID=xxx; APISID=xxx; SAPISID=xxx; ..."></textarea>
<button id="btn" onclick="submit()">Update Auth Tokens</button>
<div id="msg" class="msg"></div>
<div class="status">Tokens are saved on the server. No restart needed.</div>
</div>
<script>
async function submit(){
  const btn=document.getElementById('btn');
  const msg=document.getElementById('msg');
  const raw=document.getElementById('cookies').value.trim();
  if(!raw){msg.className='msg err';msg.textContent='Paste cookies first.';return}
  const cookies={};
  raw.split(';').forEach(p=>{const i=p.indexOf('=');if(i>0)cookies[p.slice(0,i).trim()]=p.slice(i+1).trim()});
  const required=['SID','HSID','SSID','APISID','SAPISID'];
  const missing=required.filter(k=>!cookies[k]);
  if(missing.length){msg.className='msg err';msg.textContent='Missing: '+missing.join(', ');return}
  btn.disabled=true;btn.textContent='Updating...';msg.style.display='none';
  try{
    const r=await fetch('/auth/update'+location.search,{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({cookies,csrf_token:'',session_id:'',extracted_at:Date.now()/1000})
    });
    const d=await r.json();
    if(r.ok){msg.className='msg ok';msg.textContent='Done! '+d.cookie_count+' cookies saved. Server is ready.'}
    else{msg.className='msg err';msg.textContent=d.error||'Failed'}
  }catch(e){msg.className='msg err';msg.textContent=String(e)}
  btn.disabled=false;btn.textContent='Update Auth Tokens';
}
</script></body></html>`);
  });

  // ─── Auth hot-reload ──────────────────────────────────

  app.post("/auth/update", (req, res) => {
    try {
      const body = req.body;
      if (!body || !body.cookies) {
        res.status(400).json({ error: "Request body must include 'cookies' object" });
        return;
      }

      updateTokensFromJson(body);
      resetClient();

      res.json({
        status: "ok",
        message: "Auth tokens updated and client reset",
        cookie_count: Object.keys(body.cookies).length,
      });
    } catch (e) {
      res.status(400).json({ error: String(e) });
    }
  });

  return http.createServer(app);
}
