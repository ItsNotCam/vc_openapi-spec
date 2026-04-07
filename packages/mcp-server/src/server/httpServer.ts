import { Hono } from "hono";
import { cors } from "hono/cors";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import config from "@greg/shared/core/config";
import { createMcpServer, WRITE_TOOLS } from "./mcpServer";

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function isAuthEnabled(): boolean {
	return config.NODE_ENV === "production" && !!(config.MCP_ADMIN_TOKEN || config.MCP_READ_TOKEN);
}

function getRole(authHeader: string | undefined): "admin" | "read" | null {
	if (!isAuthEnabled()) return "admin";

	const token = authHeader?.startsWith("Bearer ")
		? authHeader.slice(7).trim()
		: "";

	if (config.MCP_ADMIN_TOKEN && token === config.MCP_ADMIN_TOKEN) return "admin";
	if (config.MCP_READ_TOKEN && token === config.MCP_READ_TOKEN) return "read";
	return null;
}

// ---------------------------------------------------------------------------
// HTTP Server (MCP transport only)
// ---------------------------------------------------------------------------

export async function runHttpServer(host: string, port: number): Promise<void> {
	const app = new Hono();

	app.use("*", cors({ origin: "*" }));

	app.use("*", async (c, next) => {
		const start = Date.now();
		await next();
		console.log(`[http] ${c.req.method} ${c.req.path} ${c.res.status} ${Date.now() - start}ms`);
	});

	// Auth guard for MCP endpoint
	app.use("/openapi/*", async (c, next) => {
		const role = getRole(c.req.header("authorization"));
		if (role === null) {
			return c.json({ error: "unauthorized" }, 401);
		}

		// Block write tools for read-only tokens
		if (role === "read" && c.req.method === "POST" && c.req.path.replace(/\/+$/, "") === "/openapi") {
			try {
				const body = await c.req.json();
				if (body?.method === "tools/call") {
					const toolName = body?.params?.name ?? "";
					if (WRITE_TOOLS.has(toolName)) {
						return c.json({ error: `read-only token cannot call '${toolName}'` }, 403);
					}
				}
			} catch {
				// Not JSON — let it through
			}
		}

		await next();
	});

	// MCP HTTP transport
	app.all("/openapi", async (c) => {
		const mcpServer = createMcpServer();
		const transport = new WebStandardStreamableHTTPServerTransport({
			sessionIdGenerator: undefined,
		});
		await mcpServer.connect(transport);
		return await transport.handleRequest(c.req.raw);
	});

	Bun.serve({
		fetch: app.fetch,
		hostname: host,
		port,
		idleTimeout: 255,
	});

	console.log(`[mcp] HTTP server listening on http://${host}:${port}/openapi`);
}
