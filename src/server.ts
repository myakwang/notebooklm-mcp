import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools/index.js";
import { gdocsTools } from "./tools/gdocs.js";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "notebooklm",
    version: "0.2.0",
  });

  registerTools(server, [...gdocsTools], () => null as any, {});

  return server;
}
