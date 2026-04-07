import { Command } from "commander";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { runAuthFlow, runFileImport, showTokens } from "./auth.js";
import { runBrowserAuthFlow } from "./browser-auth.js";

const program = new Command();

program
  .name("notebooklm-mcp")
  .description("MCP server for Google NotebookLM")
  .version("0.1.30");

program
  .command("serve")
  .description("Start the MCP server (stdio transport)")
  .option("--debug", "Enable debug logging")
  .option("--query-timeout <ms>", "Query timeout in milliseconds", "120000")
  .action(async (opts) => {
    const queryTimeout = parseInt(opts.queryTimeout, 10);
    const server = createServer(queryTimeout);
    const transport = new StdioServerTransport();
    await server.connect(transport);
  });

program
  .command("serve-remote")
  .description("Start the MCP server with HTTP/SSE transport for remote access")
  .option("--port <port>", "HTTP port to listen on", "3000")
  .option("--api-key <key>", "API key for authentication (or set MCP_API_KEY env var)")
  .option("--query-timeout <ms>", "Query timeout in milliseconds", "120000")
  .action(async (opts) => {
    const port = parseInt(process.env.PORT || opts.port, 10);
    const apiKey = opts.apiKey || process.env.MCP_API_KEY;
    const queryTimeout = parseInt(opts.queryTimeout, 10);

    if (!apiKey) {
      console.warn("WARNING: No API key set. Server is publicly accessible. Set --api-key or MCP_API_KEY.");
    }

    const { createHttpServer } = await import("./http-server.js");
    const httpServer = createHttpServer(
      () => createServer(queryTimeout),
      { port, apiKey },
    );

    httpServer.listen(port, () => {
      console.log(`NotebookLM MCP server listening on port ${port}`);
      console.log(`Transport: SSE`);
      console.log(`SSE endpoint: http://0.0.0.0:${port}/sse`);
      console.log(`Health: http://0.0.0.0:${port}/health`);
      console.log(`Auth update: POST http://0.0.0.0:${port}/auth/update`);
    });
  });

program
  .command("auth")
  .description("Authenticate with NotebookLM (automated Chrome integration)")
  .option("--manual", "Use manual cookie copy-paste instead")
  .option("--file <path>", "Import cookies from a file instead")
  .option("--show-tokens", "Show cached token info (no secrets)")
  .action(async (opts) => {
    if (opts.showTokens) {
      showTokens();
      return;
    }

    if (opts.file) {
      await runFileImport(opts.file);
      return;
    }

    if (opts.manual) {
      await runAuthFlow();
      return;
    }

    try {
      await runBrowserAuthFlow();
    } catch (error) {
      console.error(`\n⚠️ Smart Authentication failed: ${(error as Error).message}`);
      console.error("Falling back to manual authentication flow...\n");
      await runAuthFlow();
    }
  });

// Default command: serve (for npx compatibility)
if (process.argv.length <= 2) {
  process.argv.push("serve");
}

program.parse();
