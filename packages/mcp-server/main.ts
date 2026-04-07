#!/usr/bin/env bun

import { Command } from "commander";
import config from "@greg/shared/core/config";
import Retriever from "@greg/shared/core/retriever";
import { runStdioServer } from "./src/server/mcpServer";
import { runHttpServer } from "./src/server/httpServer";

const program = new Command();

program
	.name("greg")
	.description("greg — OpenAPI semantic search + chat")
	.version("0.1.0");

// ---------------------------------------------------------------------------
// ingest
// ---------------------------------------------------------------------------

program
	.command("ingest")
	.description("Ingest an OpenAPI spec into ChromaDB")
	.argument("<source>", "File path or URL to the OpenAPI spec")
	.requiredOption("--api <name>", "Short name for this API (e.g. stripe)")
	.action(async (source: string, opts: { api: string }) => {
		const r = new Retriever();
		console.log(`Ingesting '${source}' as API '${opts.api}' ...`);
		const summary = await r.ingest(source, opts.api);
		console.log(
			`Done. Ingested ${summary.endpointsIngested} endpoints ` +
			`and ${summary.schemasIngested} schemas ` +
			`(${summary.total} total documents).`
		);
	});

// ---------------------------------------------------------------------------
// query
// ---------------------------------------------------------------------------

program
	.command("query")
	.description("Semantic search over ingested endpoints")
	.argument("<query>", "Natural language query")
	.option("--api <name>", "Filter to a specific API name")
	.option("--method <method>", "Filter by HTTP method (GET, POST, ...)")
	.option("--tag <tag>", "Filter by tag (substring match)")
	.option("-n <count>", "Number of results", "5")
	.action(async (query: string, opts: { api?: string; method?: string; tag?: string; n: string }) => {
		const r = new Retriever();
		const results = await r.searchEndpoints(
			query,
			opts.api,
			opts.method,
			opts.tag,
			parseInt(opts.n, 10),
		);

		if (results.length === 0) {
			console.log("No results found.");
			return;
		}

		for (let i = 0; i < results.length; i++) {
			const res = results[i];
			const meta = res.metadata;
			const dist = res.distance ?? 0;
			console.log(`\n─── Result ${i + 1}  (distance: ${dist.toFixed(4)}) ─────────────────────────`);
			console.log(`  ${meta.method ?? ""} ${meta.path ?? meta.name ?? ""}`);
			console.log(res.text);
		}
	});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

program
	.command("list")
	.description("List all ingested APIs")
	.action(async () => {
		const r = new Retriever();
		const apis = await r.listApis();
		if (apis.length === 0) {
			console.log("No APIs ingested yet.");
		} else {
			console.log("Indexed APIs:");
			for (const api of apis) {
				console.log(`  - ${api.name} (${api.endpoints} endpoints, ${api.schemas} schemas)`);
			}
		}
	});

// ---------------------------------------------------------------------------
// serve
// ---------------------------------------------------------------------------

program
	.command("serve")
	.description("Start the MCP server")
	.option("--port <port>", "Port (default: PORT env or 3000)")
	.option("--host <host>", "Bind host (default: HOST env or 0.0.0.0)")
	.option("--transport <mode>", "Transport mode: stdio or http", "stdio")
	.action(async (opts: { port?: string; host?: string; transport: string }) => {
		if (opts.transport === "stdio") {
			await runStdioServer();
		} else if (opts.transport === "http") {
			const port = opts.port ? parseInt(opts.port, 10) : config.PORT;
			const host = opts.host ?? config.HOST;
			await runHttpServer(host, port);
		} else {
			console.error(`Unknown transport: '${opts.transport}'. Choose 'stdio' or 'http'.`);
			process.exit(1);
		}
	});

program.parse();
