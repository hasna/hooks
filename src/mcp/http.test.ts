import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHooksServer } from "./server.js";
import { handleMcpRequest, resolveMcpHttpPort, DEFAULT_MCP_HTTP_PORT } from "./http.js";

describe("hooks MCP HTTP transport", () => {
  let httpServer: ReturnType<typeof Bun.serve>;
  let port: number;

  beforeAll(() => {
    httpServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/health" && req.method === "GET") {
          return Response.json({ status: "ok", name: "hooks" });
        }
        if (url.pathname === "/mcp") {
          return handleMcpRequest(req, createHooksServer);
        }
        return new Response("Not Found", { status: 404 });
      },
    });
    port = httpServer.port!;
  });

  afterAll(() => {
    httpServer.stop();
  });

  test("default port is 8847", () => {
    expect(DEFAULT_MCP_HTTP_PORT).toBe(8847);
    expect(resolveMcpHttpPort([])).toBe(8847);
    expect(resolveMcpHttpPort(["--port", "9001"])).toBe(9001);
  });

  test("GET /health returns 200", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", name: "hooks" });
  });

  test("MCP initialize + list tools over Streamable HTTP", async () => {
    const client = new Client({ name: "hooks-http-test", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`),
    );
    await client.connect(transport);
    const result = await client.listTools();
    expect(result.tools.some((t) => t.name === "hooks_list")).toBe(true);
    await client.close();
  });

  test("serves multiple concurrent clients from one process", async () => {
    const clients = await Promise.all(
      [1, 2, 3].map(async () => {
        const client = new Client({ name: "hooks-http-concurrent", version: "0.0.0" });
        const transport = new StreamableHTTPClientTransport(
          new URL(`http://127.0.0.1:${port}/mcp`),
        );
        await client.connect(transport);
        const result = await client.listTools();
        await client.close();
        return result;
      }),
    );
    for (const result of clients) {
      expect(Array.isArray(result.tools)).toBe(true);
    }
  });
});
