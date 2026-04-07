import { Command } from "commander";
import { createServer } from "./server.js";

const program = new Command();

program
  .name("notebooklm-mcp")
  .description("MCP server for syncing conversations to Google Docs → NotebookLM")
  .version("0.2.0");

program
  .command("serve")
  .description("Start the MCP server (stdio transport)")
  .action(async () => {
    const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
    const server = createServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
  });

program
  .command("serve-remote")
  .description("Start the MCP server with HTTP/SSE transport for remote access")
  .option("--port <port>", "HTTP port to listen on", "3000")
  .option("--api-key <key>", "API key for authentication (or set MCP_API_KEY env var)")
  .action(async (opts) => {
    const port = parseInt(process.env.PORT || opts.port, 10);
    const apiKey = opts.apiKey || process.env.MCP_API_KEY;

    if (!apiKey) {
      console.warn("WARNING: No API key set. Server is publicly accessible. Set --api-key or MCP_API_KEY.");
    }

    const { createHttpServer } = await import("./http-server.js");
    const httpServer = createHttpServer(
      () => createServer(),
      { port, apiKey },
    );

    httpServer.listen(port, () => {
      console.log(`NotebookLM MCP server listening on port ${port}`);
      console.log(`Transport: Streamable HTTP + SSE`);
      console.log(`Endpoint: http://0.0.0.0:${port}/mcp`);
      console.log(`Health: http://0.0.0.0:${port}/health`);
    });
  });

// Default command: serve (for npx compatibility)
if (process.argv.length <= 2) {
  process.argv.push("serve");
}

program.parse();
