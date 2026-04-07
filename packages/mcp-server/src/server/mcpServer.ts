import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import config from "@greg/shared/core/config";
import Retriever from "@greg/shared/core/retriever";
import type { QueryResult } from "@greg/shared";

// ---------------------------------------------------------------------------
// MCP Server Setup
// ---------------------------------------------------------------------------

let retriever: Retriever | null = null;
let cachedApiList: string | null = null;

function getRetriever(): Retriever {
	if (!retriever) {
		retriever = new Retriever();
	}
	return retriever;
}

async function getIndexedApisSuffix(): Promise<string> {
	if (cachedApiList === null) {
		const apis = await getRetriever().listApis();
		cachedApiList = apis.length > 0
			? ` Currently indexed: ${apis.map((a) => a.name).join(", ")}.`
			: "";
	}
	return cachedApiList;
}

// ---------------------------------------------------------------------------
// Session state (tool call cap + dedup)
// ---------------------------------------------------------------------------

const SESSION_TIMEOUT_MS = 60_000;
let searchCallCount = 0;
let lastSearchTime = 0;
const returnedIds = new Set<string>();

function resetSessionIfStale(): void {
	if (Date.now() - lastSearchTime > SESSION_TIMEOUT_MS) {
		searchCallCount = 0;
		returnedIds.clear();
	}
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export function createMcpServer(): Server {
	const server = new Server(
		{ name: "greg", version: "0.1.0" },
		{ capabilities: { tools: {} } },
	);

	// ------------------------------------------------------------------
	// Tool definitions
	// ------------------------------------------------------------------

	server.setRequestHandler(ListToolsRequestSchema, async () => {
		const apiSuffix = await getIndexedApisSuffix();

		return {
			tools: [
				{
					name: "search",
					description:
						"Search indexed OpenAPI specs. Returns endpoints by default, or schemas with type='schema'. Medium detail is usually enough to write code." +
						apiSuffix,
					inputSchema: {
						type: "object" as const,
						properties: {
							query: { type: "string", description: "What to search for" },
							type: { type: "string", enum: ["endpoint", "schema"], description: "endpoint (default) or schema", default: "endpoint" },
							api: { type: "string", description: "Filter to specific API" },
							method: { type: "string", description: "HTTP method filter" },
							tag: { type: "string", description: "Filter by tag" },
							n: { type: "integer", description: "Max results (default: 2)", default: 2 },
							maxDistance: { type: "number", description: "Max distance threshold (default: 0.5, lower = stricter)", default: 0.5 },
							detail: { type: "string", enum: ["compact", "medium", "full"], description: "compact (browse), medium (default, code-ready), full (raw spec)", default: "medium" },
						},
						required: ["query"],
					},
				},
				{
					name: "get_endpoint",
					description: "Get full raw spec for an endpoint by method+path. Only needed when search results lack detail.",
					inputSchema: {
						type: "object" as const,
						properties: {
							path: { type: "string", description: "Endpoint path (e.g. /payments/create)" },
							method: { type: "string", description: "HTTP method (e.g. POST)" },
							api: { type: "string", description: "API name" },
						},
						required: ["path", "method"],
					},
				},
				{
					name: "list_apis",
					description: "List all ingested API specs.",
					inputSchema: { type: "object" as const, properties: {}, required: [] },
				},
				{
					name: "list_endpoints",
					description: "List all endpoints for an API.",
					inputSchema: {
						type: "object" as const,
						properties: {
							api: { type: "string", description: "API name (e.g. 'proxmox')" },
							verbose: { type: "boolean", description: "Full details (default: false)", default: false },
						},
						required: ["api"],
					},
				},
				{
					name: "ingest_spec",
					description: "Ingest an OpenAPI spec from file path or URL.",
					inputSchema: {
						type: "object" as const,
						properties: {
							source: { type: "string", description: "File path or URL to spec (YAML/JSON)" },
							api_name: { type: "string", description: "Short API name (e.g. 'stripe')" },
						},
						required: ["source", "api_name"],
					},
				},
				{
					name: "delete_api",
					description: "Remove all documents for an API.",
					inputSchema: {
						type: "object" as const,
						properties: {
							api_name: { type: "string", description: "API name to delete" },
						},
						required: ["api_name"],
					},
				},
			],
		};
	});

	// ------------------------------------------------------------------
	// Tool execution
	// ------------------------------------------------------------------

	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const { name, arguments: args } = request.params;
		const r = getRetriever();

		switch (name) {
			case "search": {
				// ── Session gate ──────────────────────────────────
				resetSessionIfStale();
				const cap = config.MAX_TOOL_CALLS_PER_SESSION;
				if (searchCallCount >= cap) {
					return {
						content: [{
							type: "text",
							text: `Search limit reached (${cap} calls this session). Review the results you already have before searching again. The counter resets after 60 s of inactivity.`,
						}],
					};
				}
				searchCallCount++;
				lastSearchTime = Date.now();

				// ── Execute search ────────────────────────────────
				const query = args?.query as string;
				const type = (args?.type as string) ?? "endpoint";
				const n = Number(args?.n ?? 2);
				const maxDistance = args?.maxDistance != null ? Number(args.maxDistance) : undefined;
				const detail = ((args?.detail as string) ?? "medium") as "compact" | "medium" | "full";

				const results = type === "schema"
					? await r.searchSchemas(query, args?.api as string | undefined, n, maxDistance)
					: await r.searchEndpoints(query, args?.api as string | undefined, args?.method as string | undefined, args?.tag as string | undefined, n, maxDistance);

				// ── Dedup against session ─────────────────────────
				const newResults: QueryResult[] = [];
				const dupCount = { value: 0 };
				for (const res of results) {
					if (returnedIds.has(res.id)) {
						dupCount.value++;
					} else {
						newResults.push(res);
						returnedIds.add(res.id);
					}
				}

				if (results.length > 0 && newResults.length === 0) {
					return {
						content: [{
							type: "text",
							text: `All ${results.length} results for "${query}" were already returned in this session. Try a more specific query or use get_endpoint for full details on a known endpoint.`,
						}],
					};
				}

				const dupNote = dupCount.value > 0 ? `(${dupCount.value} duplicate result${dupCount.value > 1 ? "s" : ""} filtered)\n` : "";
				return { content: [{ type: "text", text: dupNote + formatResults(newResults, query, detail) }] };
			}

			case "get_endpoint": {
				const result = await r.getEndpoint(
					args?.path as string,
					args?.method as string,
					args?.api as string | undefined,
				);
				if (!result) {
					return { content: [{ type: "text", text: "Endpoint not found." }] };
				}
				const displayText = result.metadata.full_text ?? result.text;
				return { content: [{ type: "text", text: displayText }] };
			}

			case "list_apis": {
				const apis = await r.listApis();
				if (apis.length === 0) {
					return { content: [{ type: "text", text: "No APIs ingested yet." }] };
				}
				const lines = apis.map((a) => `- ${a.name} (${a.endpoints} endpoints, ${a.schemas} schemas)`);
				return { content: [{ type: "text", text: `Indexed APIs:\n${lines.join("\n")}` }] };
			}

			case "list_endpoints": {
				const apiName = args?.api as string;
				const verbose = args?.verbose === true;
				const endpoints = await r.listEndpoints(apiName);
				if (endpoints.length === 0) {
					return { content: [{ type: "text", text: `No endpoints found for API '${apiName}'.` }] };
				}
				const sorted = endpoints.sort((a, b) => {
					const pa = a.metadata.path ?? "";
					const pb = b.metadata.path ?? "";
					if (pa !== pb) return pa.localeCompare(pb);
					return (a.metadata.method ?? "").localeCompare(b.metadata.method ?? "");
				});
				if (verbose) {
					const lines = sorted.map((ep) => ep.metadata.full_text ?? ep.text);
					return { content: [{ type: "text", text: lines.join("\n\n---\n\n") }] };
				}
				const lines = sorted.map((ep) => {
					const m = ep.metadata.method ?? "?";
					const p = ep.metadata.path ?? "?";
					const summary = ep.text.split("\n")[1] ?? "";
					return summary ? `${m} ${p} - ${summary}` : `${m} ${p}`;
				});
				return { content: [{ type: "text", text: `${apiName} (${lines.length} endpoints):\n${lines.join("\n")}` }] };
			}

			case "ingest_spec": {
				const summary = await r.ingest(
					args?.source as string,
					args?.api_name as string,
				);
				cachedApiList = null;
				return {
					content: [{
						type: "text",
						text: `Ingested API '${summary.api}': ${summary.endpointsIngested} endpoints, ${summary.schemasIngested} schemas (${summary.total} total documents).`,
					}],
				};
			}

			case "delete_api": {
				const apiName = args?.api_name as string;
				await r.deleteApi(apiName);
				cachedApiList = null;
				return { content: [{ type: "text", text: `Deleted all documents for API '${apiName}'.` }] };
			}

			default:
				return { content: [{ type: "text", text: `Unknown tool: ${name}` }] };
		}
	});

	return server;
}

// ---------------------------------------------------------------------------
// Server entry point
// ---------------------------------------------------------------------------

export const WRITE_TOOLS = new Set(["ingest_spec", "delete_api"]);

export async function runStdioServer(): Promise<void> {
	const server = createMcpServer();
	const transport = new StdioServerTransport();
	await server.connect(transport);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function formatResults(results: QueryResult[], query: string, detail: "compact" | "medium" | "full" = "medium"): string {
	if (results.length === 0) {
		return (
			`No results found for "${query}" (0 results within distance threshold).\n` +
			`This likely means the API is not indexed — use list_apis to check what's available.\n` +
			`Do not retry with different search terms unless you've confirmed the API exists.`
		);
	}

	const lines: string[] = [];
	let hasLowConfidence = false;

	for (let i = 0; i < results.length; i++) {
		if (i > 0) lines.push("---");
		const res = results[i];
		const meta = res.metadata;
		const dist = res.distance ?? 0;
		const header = meta.method && meta.path
			? `[${i + 1}] ${meta.method} ${meta.path}  (${meta.api ?? "?"}, d=${dist.toFixed(2)})`
			: `[${i + 1}] ${meta.name ?? "?"}  (${meta.api ?? "?"}, d=${dist.toFixed(2)})`;
		lines.push(header);

		switch (detail) {
			case "compact": break;
			case "full": lines.push(meta.full_text ?? res.text); break;
			default: lines.push(meta.medium_text ?? meta.full_text ?? res.text); break;
		}

		// Append warnings from ingestion metadata (skip for compact)
		if (detail !== "compact" && meta.warnings) {
			for (const w of meta.warnings.split("|")) {
				if (w.trim()) lines.push(`⚠️ ${w.trim()}`);
			}
		}

		if (dist > 0.4) hasLowConfidence = true;
	}

	if (hasLowConfidence) {
		lines.push("---");
		lines.push("⚠️ Some results have high distance (>0.4) — confidence is low. Verify these match your intent before using.");
	}

	return lines.join("\n");
}
