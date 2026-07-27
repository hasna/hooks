import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHooksServer } from "./server.js";
import { handleMcpRequest, resolveMcpHttpPort, DEFAULT_MCP_HTTP_PORT } from "./http.js";
import { handleHooksApiRequest } from "../server/api.js";

describe("hooks MCP HTTP transport", () => {
  let httpServer: ReturnType<typeof Bun.serve> | undefined;
  let port: number;

  function isAddressInUse(error: unknown): boolean {
    if (typeof error !== "object" || error === null) return false;
    return String((error as { code?: unknown }).code) === "EADDRINUSE";
  }

  function serveOnAvailablePort(
    fetch: (request: Request) => Response | Promise<Response>,
    attempts = 100,
  ): ReturnType<typeof Bun.serve> {
    let lastError: unknown;
    const basePort = 25000 + (process.pid % 20000);
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        return Bun.serve({
          hostname: "127.0.0.1",
          port: basePort + attempt,
          fetch,
        });
      } catch (error) {
        if (!isAddressInUse(error)) throw error;
        lastError = error;
      }
    }
    throw lastError;
  }

  function loopbackListenersAvailable(): boolean {
    try {
      const server = serveOnAvailablePort(() => new Response("ok"), 5);
      server.stop(true);
      return true;
    } catch {
      return false;
    }
  }

  const listenerTestsEnabled = loopbackListenersAvailable();
  const listenerTest = listenerTestsEnabled ? test : test.skip;

  beforeAll(() => {
    if (!listenerTestsEnabled) return;
    httpServer = serveOnAvailablePort(
      async (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/health" && req.method === "GET") {
          return Response.json({ status: "ok", name: "hooks" });
        }
        if (url.pathname === "/mcp") {
          return handleMcpRequest(req, createHooksServer);
        }
        if (url.pathname.startsWith("/v1/")) {
          return handleHooksApiRequest(req, { name: "hooks", env: { HASNA_HOOKS_API_KEY: "fixture-key" } });
        }
        return new Response("Not Found", { status: 404 });
      },
    );
    port = httpServer.port ?? 0;
  });

  afterAll(() => {
    httpServer?.stop(true);
  });

  test("default port is 8847", () => {
    expect(DEFAULT_MCP_HTTP_PORT).toBe(8847);
    expect(resolveMcpHttpPort([])).toBe(8847);
    expect(resolveMcpHttpPort(["--port", "9001"])).toBe(9001);
  });

  listenerTest("GET /health returns 200", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", name: "hooks" });
  });

  test("GET /v1/health returns API health without auth", async () => {
    const res = await handleHooksApiRequest(
      new Request("http://127.0.0.1/v1/health"),
      { name: "hooks", env: { HASNA_HOOKS_API_KEY: "fixture-key" } },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok", name: "hooks" });
  });

  test("/v1 data routes require bearer auth", async () => {
    const res = await handleHooksApiRequest(
      new Request("http://127.0.0.1/v1/log/events"),
      { name: "hooks", env: { HASNA_HOOKS_API_KEY: "fixture-key" } },
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  listenerTest("MCP initialize + list tools over Streamable HTTP", async () => {
    const client = new Client({ name: "hooks-http-test", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`),
    );
    await client.connect(transport);
    const result = await client.listTools();
    expect(result.tools.some((t) => t.name === "hooks_list")).toBe(true);
    await client.close();
  });

  listenerTest("serves multiple concurrent clients from one process", async () => {
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
