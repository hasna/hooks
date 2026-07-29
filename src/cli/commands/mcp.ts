import type { Command } from "commander";

export function registerMcpCommand(program: Command): void {
program
  .command("mcp")
  .option("-s, --stdio", "Use stdio transport (one process per agent)", false)
  .option("--sse", "Use legacy SSE transport (port 39427)", false)
  .option("--http", "Use Streamable HTTP transport (explicit; this is also the default)", false)
  .option("-p, --port <port>", "Port for HTTP/SSE transport (defaults to 8847 for HTTP, 39427 for SSE)")
  .description("Start MCP server for AI agent integration (default: shared Streamable HTTP)")
  .action(async (options: { stdio: boolean; sse: boolean; http: boolean; port?: string }) => {
    if (options.stdio) {
      const { startStdioServer } = await import("../mcp/server.js");
      await startStdioServer();
    } else if (options.sse) {
      const { startSSEServer } = await import("../mcp/server.js");
      await startSSEServer(options.port ? parseInt(options.port) : 39427);
    } else {
      // Default: shared Streamable HTTP server (one process per MCP, many agents).
      const { createHooksServer } = await import("../mcp/server.js");
      const { resolveMcpHttpPort, startMcpHttpServer } = await import("../mcp/http.js");
      const args = options.port ? ["--port", options.port] : [];
      startMcpHttpServer({ name: "hooks", port: resolveMcpHttpPort(args), buildServer: createHooksServer });
    }
  });
registerEventsCommands(program, { source: "hooks" });

}
