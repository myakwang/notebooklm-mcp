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
      if (req.path === "/health") return next();

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
