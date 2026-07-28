import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const DEFAULT_MCP_HTTP_PORT = 8847;
export const MCP_HTTP_HOST = "127.0.0.1";
export const MCP_SERVICE_NAME = "hooks";

export function isHttpMode(args: string[]): boolean {
  return args.includes("--http") || process.env.MCP_HTTP === "1";
}

export function resolveMcpHttpPort(args: string[]): number {
  const portIdx = args.indexOf("--port");
  if (portIdx >= 0 && args[portIdx + 1]) {
    return Number(args[portIdx + 1]);
  }
  const envPort = process.env.MCP_HTTP_PORT;
  if (envPort) return Number(envPort);
  return DEFAULT_MCP_HTTP_PORT;
}

export function healthPayload(name: string = MCP_SERVICE_NAME): { status: string; name: string } {
  return { status: "ok", name };
}

export async function handleMcpRequest(
  req: Request,
  buildServer: () => McpServer,
): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  const server = buildServer();
  await server.connect(transport);
  return transport.handleRequest(req);
}

/**
 * Route one request for the MCP HTTP server.
 *
 * The Hooks `/v1` data API reads and destroys hook event history, so it is only
 * mounted when the operator opts in with `hooks mcp --http --api`. Without that
 * flag `/v1/*` is indistinguishable from any other unknown path.
 */
export async function handleMcpHttpRequest(
  req: Request,
  options: { name: string; buildServer: () => McpServer; api?: boolean },
): Promise<Response> {
  const { name, buildServer, api = false } = options;
  const url = new URL(req.url);
  if (url.pathname === "/health" && req.method === "GET") {
    return Response.json(healthPayload(name));
  }
  if (api && url.pathname.startsWith("/v1/")) {
    const { handleHooksApiRequest } = await import("../server/api.js");
    return handleHooksApiRequest(req, { name });
  }
  if (url.pathname === "/mcp") {
    return handleMcpRequest(req, buildServer);
  }
  return new Response("Not Found", { status: 404 });
}

export function startMcpHttpServer(options: {
  name: string;
  port: number;
  buildServer: () => McpServer;
  api?: boolean;
}): ReturnType<typeof Bun.serve> {
  const { name, port, buildServer, api = false } = options;

  const server = Bun.serve({
    hostname: MCP_HTTP_HOST,
    port,
    fetch(req) {
      return handleMcpHttpRequest(req, { name, buildServer, api });
    },
  });

  console.error(`${name}-mcp HTTP listening on http://${MCP_HTTP_HOST}:${port}/mcp`);
  if (api) {
    console.error(`${name} /v1 data API enabled on http://${MCP_HTTP_HOST}:${port}/v1 (requires HASNA_HOOKS_API_SERVER_KEY)`);
  }
  return server;
}
