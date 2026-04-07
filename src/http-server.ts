import http from "node:http";
import express from "express";
import cors from "cors";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
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

      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        res.status(401).json({ error: "Missing or invalid Authorization header" });
        return;
      }
      if (authHeader.slice(7) !== options.apiKey) {
        res.status(403).json({ error: "Invalid API key" });
        return;
      }
      next();
    });
  }

  // Session tracking for SSE connections
  const sessions = new Map<string, { server: McpServer; transport: SSEServerTransport }>();

  // Health check
  app.get("/health", (_req, res) => {
    const result: Record<string, unknown> = {
      status: "ok",
      version: "0.1.30",
      transport: "sse",
      active_sessions: sessions.size,
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

  // SSE endpoint — one server+transport per connection
  app.get("/sse", async (req, res) => {
    const server = serverFactory();
    const transport = new SSEServerTransport("/messages", res);
    const sessionId = transport.sessionId;

    sessions.set(sessionId, { server, transport });

    // Clean up on disconnect
    req.on("close", () => {
      sessions.delete(sessionId);
    });

    await server.connect(transport);
  });

  // Message endpoint for SSE clients
  app.post("/messages", async (req, res) => {
    const sessionId = req.query.sessionId as string;
    const session = sessions.get(sessionId);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    await session.transport.handlePostMessage(req, res);
  });

  // Auth hot-reload endpoint
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
