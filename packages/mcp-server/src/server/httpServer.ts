import fs from "fs";
import path from "path";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import config from "../core/config";
import { createMcpServer, WRITE_TOOLS } from "./mcpServer";
import Retriever from "../core/retriever";
import { handleChat, GREG_PROMPT, VERBOSE_PROMPT, CURT_PROMPT } from "./chat";

const SPECS_DIR = process.env.SPECS_DIR ?? path.resolve(import.meta.dir, "..", "..", "..", "..", "specs");
const SIZE_WARN_BYTES = 10 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Spec Discovery
// ---------------------------------------------------------------------------

interface SpecEntry {
	url: string;
	name: string;
}

function discoverSpecs(): SpecEntry[] {
	if (!fs.existsSync(SPECS_DIR)) return [];

	const entries = fs.readdirSync(SPECS_DIR).sort();
	const specs: SpecEntry[] = [];

	for (const filename of entries) {
		const ext = path.extname(filename);
		if (![".yaml", ".yml", ".json"].includes(ext)) continue;

		const name = path.basename(filename, ext);
		const filePath = path.join(SPECS_DIR, filename);
		const size = fs.statSync(filePath).size;

		let label: string;
		if (size > SIZE_WARN_BYTES) {
			const mb = Math.floor(size / (1024 * 1024));
			label = `${name} (${mb} MB - large)`;
		} else if (size > 1024 * 1024) {
			const mb = (size / (1024 * 1024)).toFixed(1);
			label = `${name} (${mb} MB)`;
		} else {
			const kb = Math.round(size / 1024);
			label = `${name} (${kb} KB)`;
		}

		specs.push({ url: `/openapi/specs/${filename}`, name: label });
	}

	return specs;
}

async function saveSpecFile(apiName: string, content: string, ext: string): Promise<void> {
	if (!fs.existsSync(SPECS_DIR)) fs.mkdirSync(SPECS_DIR, { recursive: true });
	const filePath = path.join(SPECS_DIR, `${apiName}${ext}`);
	await fs.promises.writeFile(filePath, content, "utf-8");
	console.log(`[specs] saved ${filePath}`);
}

// ---------------------------------------------------------------------------
// Auto-ingest on startup
// ---------------------------------------------------------------------------

async function autoIngestSpecs(retriever: Retriever): Promise<void> {
	if (!fs.existsSync(SPECS_DIR)) return;

	const indexed = new Set((await retriever.listApis()).map((a) => a.name));
	const entries = fs.readdirSync(SPECS_DIR).sort();

	for (const filename of entries) {
		const ext = path.extname(filename);
		if (![".yaml", ".yml", ".json"].includes(ext)) continue;

		const apiName = path.basename(filename, ext);
		if (indexed.has(apiName)) continue;

		const filePath = path.join(SPECS_DIR, filename);
		console.log(`[auto-ingest] ingesting ${filename} as '${apiName}' ...`);
		try {
			const summary = await retriever.ingest(filePath, apiName, (e) => {
				if (e.phase === "embedding" || e.phase === "storing") {
					if (e.done === e.total || (e.done ?? 0) % 500 === 0) {
						console.log(`[auto-ingest] ${apiName}: ${e.phase} ${e.done}/${e.total}`);
					}
				} else {
					console.log(`[auto-ingest] ${apiName}: ${e.message}`);
				}
			}, { skipDelete: true });
			console.log(`[auto-ingest] ${apiName}: done — ${summary.endpointsIngested} endpoints, ${summary.schemasIngested} schemas`);
		} catch (err) {
			console.error(`[auto-ingest] failed to ingest ${filename}:`, err instanceof Error ? err.message : err);
		}
	}
}

// ---------------------------------------------------------------------------
// Auth Middleware
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
// HTTP Server
// ---------------------------------------------------------------------------

export async function runHttpServer(host: string, port: number): Promise<void> {
	const app = new Hono();
	const retriever = new Retriever();

	// ── CORS ──────────────────────────────────────────────────────
	app.use("*", cors({ origin: "*" }));

	// ── Request logging ──────────────────────────────────────────
	app.use("*", async (c, next) => {
		const start = Date.now();
		await next();
		const ms = Date.now() - start;
		const status = c.res.status;
		console.log(`[http] ${c.req.method} ${c.req.path} ${status} ${ms}ms`);
	});

	// ── Auth middleware ────────────────────────────────────────────
	app.use("/openapi/*", async (c, next) => {
		const role = getRole(c.req.header("authorization"));
		if (role === null) {
			return c.json({ error: "unauthorized" }, 401);
		}

		// Block write tools for read-only tokens via MCP
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
				// Not JSON or parse error — let it through to MCP handler
			}
		}

		c.set("role" as never, role as never);
		await next();
	});

	// ── Static spec files ─────────────────────────────────────────
	if (fs.existsSync(SPECS_DIR)) {
		app.use("/openapi/specs/*", serveStatic({ root: SPECS_DIR, rewriteRequestPath: (p) => p.replace("/openapi/specs", "") }));
	}

	// ── REST: search ──────────────────────────────────────────────
	app.get("/openapi/search", async (c) => {
		try {
			const q = c.req.query("q")?.trim();
			if (!q) {
				return c.json({ error: "missing ?q= parameter" }, 400);
			}

			const api = c.req.query("api") || undefined;
			const n = Math.min(Number(c.req.query("n") ?? 5), 50);

			const results = await retriever.searchEndpoints(q, api, undefined, undefined, n);

			const items = results.map((r) => {
				const meta = r.metadata;
				const tags = meta.tags ?? "";
				const firstTag = tags.split(",")[0]?.trim() ?? "";
				return {
					method: meta.method ?? "",
					path: meta.path ?? "",
					api: meta.api ?? "",
					operation_id: meta.operation_id ?? "",
					tag: firstTag,
					tags,
					distance: Math.round((r.distance ?? 0) * 10000) / 10000,
					text: meta.full_text ?? r.text,
				};
			});

			return c.json(items);
		} catch (err) {
			console.error("[api] search error:", err);
			return c.json({ error: err instanceof Error ? err.message : "search failed" }, 500);
		}
	});

	// ── REST: list APIs ───────────────────────────────────────────
	app.get("/openapi/apis", async (c) => {
		try {
			const apis = await retriever.listApis();
			return c.json(apis);
		} catch (err) {
			console.error("[api] list apis error:", err);
			return c.json({ error: err instanceof Error ? err.message : "list failed" }, 500);
		}
	});

	// ── REST: delete API ──────────────────────────────────────────
	app.delete("/openapi/apis/:name", async (c) => {
		const role = c.get("role" as never) as string;
		if (role !== "admin") {
			return c.json({ error: "admin role required" }, 403);
		}
		const name = c.req.param("name");
		await retriever.deleteApi(name);
		return c.json({ deleted: name });
	});

	// ── REST: ingest from URL/path (SSE progress) ───────────────
	app.post("/openapi/ingest", async (c) => {
		const role = c.get("role" as never) as string;
		if (role !== "admin") return c.json({ error: "admin role required" }, 403);
		const body = await c.req.json<{ source: string; api_name: string }>();
		if (!body.source || !body.api_name) return c.json({ error: "missing source or api_name" }, 400);

		const { readable, writable } = new TransformStream();
		const writer = writable.getWriter();
		const enc = new TextEncoder();
		const send = (obj: Record<string, unknown>) => writer.write(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));

		(async () => {
			try {
				// Save raw spec file for Swagger UI if source is a file
				if (!body.source.startsWith("http")) {
					try {
						const raw = await fs.promises.readFile(path.resolve(body.source), "utf-8");
						const ext = path.extname(body.source) || ".yaml";
						await saveSpecFile(body.api_name, raw, ext);
					} catch {}
				} else {
					try {
						const res = await fetch(body.source);
						if (res.ok) {
							const raw = await res.text();
							const ext = body.source.match(/\.(json|ya?ml)/i)?.[0] ?? ".yaml";
							await saveSpecFile(body.api_name, raw, ext);
						}
					} catch {}
				}
				const summary = await retriever.ingest(body.source, body.api_name, (e) => send(e));
				send({ phase: "complete", summary });
			} catch (err) {
				console.error("[api] ingest error:", err);
				send({ phase: "error", message: err instanceof Error ? err.message : "ingest failed" });
			} finally {
				writer.close();
			}
		})();

		return new Response(readable, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" } });
	});

	// ── REST: ingest from raw content (SSE progress) ─────────────
	app.post("/openapi/ingest/upload", async (c) => {
		const role = c.get("role" as never) as string;
		if (role !== "admin") return c.json({ error: "admin role required" }, 403);
		const body = await c.req.json<{ content: string; format: "yaml" | "json"; api_name: string }>();
		if (!body.content || !body.format || !body.api_name) return c.json({ error: "missing content, format, or api_name" }, 400);

		const { readable, writable } = new TransformStream();
		const writer = writable.getWriter();
		const enc = new TextEncoder();
		const send = (obj: Record<string, unknown>) => writer.write(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));

		(async () => {
			try {
				const ext = body.format === "json" ? ".json" : ".yaml";
				await saveSpecFile(body.api_name, body.content, ext);
				const summary = await retriever.ingestContent(body.content, body.format, body.api_name, (e) => send(e));
				send({ phase: "complete", summary });
			} catch (err) {
				console.error("[api] ingest/upload error:", err);
				send({ phase: "error", message: err instanceof Error ? err.message : "ingest failed" });
			} finally {
				writer.close();
			}
		})();

		return new Response(readable, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" } });
	});

	// ── REST: list spec files ─────────────────────────────────────
	app.get("/openapi/spec-files", async (c) => {
		return c.json(discoverSpecs());
	});

	// ── Swagger UI docs ───────────────────────────────────────────
	app.get("/openapi/docs/:apiName", async (c) => {
		const apiName = c.req.param("apiName");
		const specs = discoverSpecs();
		const spec = specs.find((s) => s.name.startsWith(apiName));
		// Try all common extensions if not found in discovered specs
		let specUrl = spec?.url ?? "";
		if (!specUrl) {
			for (const ext of [".yaml", ".yml", ".json"]) {
				const testPath = path.join(SPECS_DIR, `${apiName}${ext}`);
				if (fs.existsSync(testPath)) {
					specUrl = `/openapi/specs/${apiName}${ext}`;
					break;
				}
			}
			if (!specUrl) specUrl = `/openapi/specs/${apiName}.yaml`;
		}
		const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"/><title>${apiName} — greg</title>
<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css"/>
<style>
/* -- shared -- */
.swagger-ui .topbar{display:none}
.swagger-ui{font-family:-apple-system,"Segoe UI",sans-serif}
.swagger-ui .opblock-section-header{box-shadow:none!important}
.swagger-ui .responses-inner{background:transparent!important}
</style>
<style id="theme-dark">
:root{color-scheme:dark}
body{margin:0;background:#0D0D10;color:#E4E4E7}
.swagger-ui{background:#0D0D10;color:#E4E4E7}
.swagger-ui .info .title,.swagger-ui .opblock-tag{color:#E4E4E7}
.swagger-ui .info p,.swagger-ui .info li,.swagger-ui .info table,.swagger-ui p,.swagger-ui label,.swagger-ui .parameter__name,.swagger-ui .parameter__type,.swagger-ui table thead tr th,.swagger-ui table thead tr td,.swagger-ui .response-col_status,.swagger-ui .response-col_description,.swagger-ui .model-title,.swagger-ui .model,.swagger-ui .renderedMarkdown p{color:#B0B0BA}
.swagger-ui .opblock .opblock-summary-description,.swagger-ui .opblock-description-wrapper p{color:#B0B0BA}
.swagger-ui .scheme-container,.swagger-ui .loading-container{background:#131317}
.swagger-ui select,.swagger-ui input[type=text],.swagger-ui textarea{background:#131317;color:#E4E4E7;border-color:rgba(255,255,255,0.12)}
.swagger-ui .btn{background:#131317;color:#E4E4E7;border-color:rgba(255,255,255,0.12)}
.swagger-ui .btn:hover{background:#19191F}
.swagger-ui .opblock{background:#131317;border-color:rgba(255,255,255,0.06)}
.swagger-ui .opblock .opblock-summary{border-color:rgba(255,255,255,0.06)}
.swagger-ui .opblock-body pre.microlight,.swagger-ui .highlight-code>.microlight{background:#0D0D10!important;color:#E4E4E7;border-radius:4px}
.swagger-ui .opblock-body pre span{color:#E4E4E7!important}
.swagger-ui .responses-wrapper,.swagger-ui .response-col_description__inner,.swagger-ui .parameters-col_description{color:#B0B0BA}
.swagger-ui section.models{border-color:rgba(255,255,255,0.06)}
.swagger-ui section.models .model-container{background:#131317;border-color:rgba(255,255,255,0.06)}
.swagger-ui .model-box{background:#131317}
.swagger-ui .opblock-tag{border-bottom-color:rgba(255,255,255,0.06)}
.swagger-ui .opblock.opblock-get{background:rgba(52,211,153,0.04);border-color:rgba(52,211,153,0.15)}
.swagger-ui .opblock.opblock-get .opblock-summary{border-color:rgba(52,211,153,0.15)}
.swagger-ui .opblock.opblock-post{background:rgba(96,165,250,0.04);border-color:rgba(96,165,250,0.15)}
.swagger-ui .opblock.opblock-post .opblock-summary{border-color:rgba(96,165,250,0.15)}
.swagger-ui .opblock.opblock-put{background:rgba(251,191,36,0.04);border-color:rgba(251,191,36,0.15)}
.swagger-ui .opblock.opblock-put .opblock-summary{border-color:rgba(251,191,36,0.15)}
.swagger-ui .opblock.opblock-delete{background:rgba(248,113,113,0.04);border-color:rgba(248,113,113,0.15)}
.swagger-ui .opblock.opblock-delete .opblock-summary{border-color:rgba(248,113,113,0.15)}
.swagger-ui .opblock.opblock-patch{background:rgba(192,132,252,0.04);border-color:rgba(192,132,252,0.15)}
.swagger-ui .opblock.opblock-patch .opblock-summary{border-color:rgba(192,132,252,0.15)}
.swagger-ui .tab li{color:#B0B0BA}
.swagger-ui .tab li.active{color:#E4E4E7}
.swagger-ui .response-content-type.controls-accept-header select{background:#131317;color:#E4E4E7}
.swagger-ui .model-toggle::after{filter:invert(1)}
.swagger-ui svg.arrow,.swagger-ui button.model-box-control svg,.swagger-ui .expand-operation svg{fill:#B0B0BA!important}
.swagger-ui .opblock-summary-control svg{fill:#E4E4E7!important}
.swagger-ui svg:not([fill="none"]){fill:#B0B0BA}
.swagger-ui a.nostyle,.swagger-ui a.nostyle:visited{color:#818CF8}
.swagger-ui .opblock-section-header{background:#19191F!important;border-color:rgba(255,255,255,0.06)!important}
.swagger-ui .opblock-section-header h4,.swagger-ui .opblock-section-header>label,.swagger-ui .opblock-section-header .btn{color:#B0B0BA!important}
.swagger-ui .opblock-body .opblock-section-header label,.swagger-ui .response-controls{color:#B0B0BA!important}
.swagger-ui .responses-header td.col_header{color:#B0B0BA!important}
.swagger-ui .opblock .opblock-section-header{background:#19191F!important}
.swagger-ui table.headers td{color:#B0B0BA}
.swagger-ui .response-col_links{color:#B0B0BA}
.swagger-ui .parameters-col_description input,.swagger-ui .parameters-col_description select{background:#131317;color:#E4E4E7;border-color:rgba(255,255,255,0.12)}
.swagger-ui .opblock-body h4,.swagger-ui .opblock-body h5,.swagger-ui .responses-inner h4,.swagger-ui .responses-inner h5{color:#B0B0BA}
.swagger-ui .opblock-summary-method{color:#fff}
.swagger-ui .opblock-summary-path,.swagger-ui .opblock-summary-path a{color:#E4E4E7}
.swagger-ui .markdown h1,.swagger-ui .markdown h2,.swagger-ui .markdown h3,.swagger-ui .markdown h4,.swagger-ui .markdown h5{color:#E4E4E7}
.swagger-ui .prop-type{color:#818CF8}
.swagger-ui .prop-format{color:#4E4E58}
.swagger-ui .parameter__name.required span{color:#F87171}
.swagger-ui .parameter__name.required::after{color:#F87171}
</style>
<style id="theme-light">
:root{color-scheme:light}
body{margin:0;background:#FFFFFF;color:#18181B}
.swagger-ui{background:#FFFFFF;color:#18181B}
.swagger-ui .info .title,.swagger-ui .opblock-tag{color:#18181B}
.swagger-ui .info p,.swagger-ui .info li,.swagger-ui .info table,.swagger-ui p,.swagger-ui label,.swagger-ui .parameter__name,.swagger-ui .parameter__type,.swagger-ui table thead tr th,.swagger-ui table thead tr td,.swagger-ui .response-col_status,.swagger-ui .response-col_description,.swagger-ui .model-title,.swagger-ui .model,.swagger-ui .renderedMarkdown p{color:#52525B}
.swagger-ui .opblock .opblock-summary-description,.swagger-ui .opblock-description-wrapper p{color:#52525B}
.swagger-ui .scheme-container,.swagger-ui .loading-container{background:#F4F4F5}
.swagger-ui select,.swagger-ui input[type=text],.swagger-ui textarea{background:#FFFFFF;color:#18181B;border-color:rgba(0,0,0,0.15)}
.swagger-ui .btn{background:#F4F4F5;color:#18181B;border-color:rgba(0,0,0,0.12)}
.swagger-ui .btn:hover{background:#E8E8EC}
.swagger-ui .opblock{border-color:rgba(0,0,0,0.08)}
.swagger-ui .opblock .opblock-summary{border-color:rgba(0,0,0,0.08)}
.swagger-ui .opblock-body pre.microlight,.swagger-ui .highlight-code>.microlight{background:#F4F4F5!important;color:#18181B;border-radius:4px}
.swagger-ui .opblock-body pre span{color:#18181B!important}
.swagger-ui section.models{border-color:rgba(0,0,0,0.08)}
.swagger-ui section.models .model-container{border-color:rgba(0,0,0,0.08)}
.swagger-ui .opblock-tag{border-bottom-color:rgba(0,0,0,0.08)}
.swagger-ui .opblock-section-header{background:#F4F4F5!important;border-color:rgba(0,0,0,0.08)!important}
.swagger-ui .opblock-section-header h4,.swagger-ui .opblock-section-header>label,.swagger-ui .opblock-section-header .btn{color:#52525B!important}
.swagger-ui .opblock .opblock-section-header{background:#F4F4F5!important}
.swagger-ui .opblock-body h4,.swagger-ui .opblock-body h5,.swagger-ui .responses-inner h4,.swagger-ui .responses-inner h5{color:#52525B}
.swagger-ui .opblock-summary-path,.swagger-ui .opblock-summary-path a{color:#18181B}
.swagger-ui .markdown h1,.swagger-ui .markdown h2,.swagger-ui .markdown h3,.swagger-ui .markdown h4,.swagger-ui .markdown h5{color:#18181B}
.swagger-ui a.nostyle,.swagger-ui a.nostyle:visited{color:#6366F1}
.swagger-ui .prop-type{color:#6366F1}
.swagger-ui .prop-format{color:#A1A1AA}
.swagger-ui .parameter__name.required span{color:#DC2626}
.swagger-ui .parameter__name.required::after{color:#DC2626}
.swagger-ui .parameters-col_description input,.swagger-ui .parameters-col_description select{background:#FFFFFF;color:#18181B;border-color:rgba(0,0,0,0.15)}
</style>
<script>
(function(){
  var t=new URLSearchParams(location.search).get("theme")||"dark";
  document.getElementById("theme-"+(t==="light"?"dark":"light")).disabled=true;
})();
</script>
</head><body><div id="swagger-ui"></div>
<script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>
function scrollToEndpoint(method,epath){
  if(!method||!epath)return;
  var target=method.toLowerCase();
  // Clear any previous highlight
  document.querySelectorAll(".opblock").forEach(function(b){b.style.outline="";});
  // First expand all collapsed tag sections so operations are in the DOM
  document.querySelectorAll(".opblock-tag-section").forEach(function(sec){
    if(!sec.querySelector(".opblock")||sec.querySelector(".opblock").offsetParent===null){
      var tagBtn=sec.querySelector(".opblock-tag");
      if(tagBtn)tagBtn.click();
    }
  });
  // Wait for DOM to update after expanding tags
  setTimeout(function(){
    var blocks=document.querySelectorAll(".opblock");
    for(var i=0;i<blocks.length;i++){
      var b=blocks[i];
      var pathEl=b.querySelector(".opblock-summary-path a,.opblock-summary-path span,.opblock-summary-path");
      var methEl=b.querySelector(".opblock-summary-method");
      if(!pathEl||!methEl)continue;
      var bPath=(pathEl.textContent||"").trim();
      var bMeth=(methEl.textContent||"").trim().toLowerCase();
      if(bMeth===target&&bPath===epath){
        // Expand the operation
        if(!b.classList.contains("is-open")){
          var ctrl=b.querySelector("button.opblock-summary-control")||b.querySelector(".opblock-summary");
          if(ctrl)ctrl.click();
        }
        setTimeout(function(){
          b.scrollIntoView({behavior:"smooth",block:"start"});
          b.style.outline="2px solid #818CF8";
          setTimeout(function(){b.style.outline="";},3000);
        },300);
        return;
      }
    }
  },200);
}
window.addEventListener("message",function(ev){
  if(ev.data&&ev.data.type==="scrollToEndpoint"){
    scrollToEndpoint(ev.data.method,ev.data.path);
  }
});
SwaggerUIBundle({url:"${specUrl}",dom_id:"#swagger-ui",deepLinking:true,filter:true,presets:[SwaggerUIBundle.presets.apis],layout:"BaseLayout",
onComplete:function(){
  var p=new URLSearchParams(location.search);
  scrollToEndpoint(p.get("method"),p.get("path"));
}});
</script>
</body></html>`;
		return c.html(html);
	});

	// ── Frontend API routes (/api/*) ──────────────────────────────

	app.use("/api/*", async (c, next) => {
		const role = getRole(c.req.header("authorization"));
		if (role === null) {
			return c.json({ error: "unauthorized" }, 401);
		}
		c.set("role" as never, role as never);
		await next();
	});

	app.post("/api/search/endpoints", async (c) => {
		try {
			const body = await c.req.json<{ query: string; api?: string; limit?: number }>();
			if (!body.query?.trim()) return c.json({ error: "missing query" }, 400);
			const results = await retriever.searchEndpoints(body.query, body.api, undefined, undefined, body.limit ?? 5);
			return c.json(results.map(formatSearchResult));
		} catch (err) {
			console.error("[api] search/endpoints error:", err);
			return c.json({ error: err instanceof Error ? err.message : "search failed" }, 500);
		}
	});

	app.post("/api/search/schemas", async (c) => {
		try {
			const body = await c.req.json<{ query: string; api?: string; limit?: number }>();
			if (!body.query?.trim()) return c.json({ error: "missing query" }, 400);
			const results = await retriever.searchSchemas(body.query, body.api, body.limit ?? 5);
			return c.json(results.map(formatSearchResult));
		} catch (err) {
			console.error("[api] search/schemas error:", err);
			return c.json({ error: err instanceof Error ? err.message : "search failed" }, 500);
		}
	});

	app.get("/api/endpoint", async (c) => {
		try {
			const method = c.req.query("method");
			const epath = c.req.query("path");
			const api = c.req.query("api");
			if (!method || !epath) return c.json({ error: "missing method or path" }, 400);
			const result = await retriever.getEndpoint(epath, method, api || undefined);
			if (!result) return c.json({ error: "not found" }, 404);
			return c.json(formatDocResult(result));
		} catch (err) {
			console.error("[api] endpoint error:", err);
			return c.json({ error: err instanceof Error ? err.message : "lookup failed" }, 500);
		}
	});

	app.get("/api/apis", async (c) => {
		try {
			const apis = await retriever.listApis();
			c.header("Cache-Control", "public, max-age=86400");
			return c.json(apis);
		} catch (err) {
			console.error("[api] list apis error:", err);
			return c.json({ error: err instanceof Error ? err.message : "list failed" }, 500);
		}
	});

	app.get("/api/endpoints", async (c) => {
		try {
			const api = c.req.query("api");
			if (!api) return c.json({ error: "missing ?api= parameter" }, 400);
			const eps = await retriever.listEndpoints(api);
			return c.json(eps.map(formatDocResult));
		} catch (err) {
			console.error("[api] list endpoints error:", err);
			return c.json({ error: err instanceof Error ? err.message : "list failed" }, 500);
		}
	});

	app.get("/api/prompts", (c) => {
		return c.json({ greg: GREG_PROMPT, verbose: VERBOSE_PROMPT, curt: CURT_PROMPT });
	});

	app.get("/api/models", async (c) => {
		const models: Array<{ id: string; name: string; provider: string }> = [];
		// Anthropic models
		models.push(
			{ id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5 (fastest)", provider: "anthropic" },
			{ id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4 (balanced)", provider: "anthropic" },
			{ id: "claude-opus-4-20250514", name: "Claude Opus 4 (overkill)", provider: "anthropic" },
		);
		// Ollama models
		if (config.OLLAMA_URL) {
			try {
				const res = await fetch(`${config.OLLAMA_URL}/api/tags`);
				if (res.ok) {
					const data = await res.json() as { models: Array<{ name: string }> };
					for (const m of data.models ?? []) {
						// Skip embedding models
						if (/embed|bge-|nomic-embed/i.test(m.name)) continue;
						models.push({ id: m.name, name: m.name, provider: "ollama" });
					}
				}
			} catch {}
		}
		return c.json(models);
	});

	let lastGifUrl: string | null = null;
	app.get("/api/greeting-gif", async (c) => {
		if (!config.GIPHY_API_KEY) return c.json({ url: null });
		try {
			const queries = ["cat hello", "cat wave", "cat excited", "cat greeting", "cat sup", "cat computer", "anime hello wave", "cartoon greeting funny"];
			// Try up to 3 times to get a fresh gif
			for (let attempt = 0; attempt < 3; attempt++) {
				const q = encodeURIComponent(queries[Math.floor(Math.random() * queries.length)]);
				const offset = attempt; // offset 0, 1, 2 across retries for variety
				const res = await fetch(`https://api.giphy.com/v1/stickers/search?api_key=${config.GIPHY_API_KEY}&q=${q}&limit=5&offset=${offset}&rating=g&lang=en`);
				const data = await res.json() as { data: Array<{ images: { original: { url: string } } }> };
				const match = data.data?.find((g) => g.images?.original?.url && g.images.original.url !== lastGifUrl);
				if (match?.images?.original?.url) {
					lastGifUrl = match.images.original.url;
					return c.json({ url: lastGifUrl });
				}
			}
			return c.json({ url: null });
		} catch {
			return c.json({ url: null });
		}
	});

	app.get("/api/suggestions", async (c) => {
		const ALL_SUGGESTIONS = [
			"what APIs are indexed",
			"how do I authenticate",
			"show me endpoints for creating a resource",
			"what can I monitor or query",
			"how do I list all available nodes",
			"what endpoints return paginated results",
			"how do I delete a resource",
			"show me search or filter endpoints",
			"what does the health check endpoint look like",
			"how do I update an existing resource",
			"what webhooks or events are available",
			"show me endpoints that require admin permissions",
			"how do I get logs or audit history",
			"what are the rate limits",
			"show me bulk operation endpoints",
			"how do I get status of a running job",
			"what schemas or models are defined",
			"how do I upload or attach a file",
			"show me endpoints for user management",
			"what does the API return on error",
		];

		// Pick 4 random suggestions without repeating
		const picked: string[] = [];
		const pool = [...ALL_SUGGESTIONS];
		while (picked.length < 4 && pool.length > 0) {
			const i = Math.floor(Math.random() * pool.length);
			picked.push(pool.splice(i, 1)[0]);
		}

		return c.json({ suggestions: picked });
	});

	app.post("/api/chat", async (c) => {
		return handleChat(c, retriever);
	});

	app.post("/api/chat/title", async (c) => {
		try {
			const { prompt } = await c.req.json<{ prompt: string }>();
			if (!prompt?.trim()) return c.json({ title: "New chat" });

			const sysMsg = "Summarize the user's message into a short chat title (max 6 words). Return ONLY the title, nothing else.";
			let title: string | null = null;

			// Try Ollama first (uses small/fast summary model)
			if (config.OLLAMA_URL) {
				try {
					const res = await fetch(`${config.OLLAMA_URL}/api/chat`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							model: config.OLLAMA_CHAT_SUMMARY_MODEL,
							messages: [{ role: "system", content: sysMsg }, { role: "user", content: prompt }],
							stream: false,
						}),
					});
					if (res.ok) {
						const data = await res.json() as { message?: { content?: string } };
						title = data.message?.content?.trim() || null;
					}
				} catch {}
			}

			// Fall back to Anthropic
			if (!title && config.ANTHROPIC_API_KEY) {
				try {
					const { default: Anthropic } = await import("@anthropic-ai/sdk");
					const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
					const msg = await client.messages.create({
						model: "claude-haiku-4-5-20251001",
						max_tokens: 30,
						system: sysMsg,
						messages: [{ role: "user", content: prompt }],
					});
					const block = msg.content[0];
					if (block.type === "text") title = block.text.trim();
				} catch {}
			}

			return c.json({ title: title || prompt.slice(0, 50) });
		} catch {
			return c.json({ title: "New chat" });
		}
	});

	// ── MCP HTTP transport ────────────────────────────────────────
	app.all("/openapi", async (c) => {
		const mcpServer = createMcpServer();
		const transport = new WebStandardStreamableHTTPServerTransport({
			sessionIdGenerator: undefined,
		});
		await mcpServer.connect(transport);
		const response = await transport.handleRequest(c.req.raw);
		return response;
	});

	// ── Start server ──────────────────────────────────────────────
	if (config.NODE_ENV === "production" && !config.MCP_ADMIN_TOKEN && !config.MCP_READ_TOKEN) {
		console.error("[auth] FATAL: NODE_ENV=production but no auth tokens set. Set MCP_ADMIN_TOKEN and/or MCP_READ_TOKEN in .env, or use NODE_ENV=development.");
		process.exit(1);
	}

	if (isAuthEnabled()) {
		console.log(`[auth] token auth enabled — admin: ${config.MCP_ADMIN_TOKEN ? "set" : "unset"}, read: ${config.MCP_READ_TOKEN ? "set" : "unset"}`);
	} else {
		console.log("[auth] auth disabled (NODE_ENV != production)");
	}

	console.log(`[server] listening on ${host}:${port}`);

	Bun.serve({
		fetch: app.fetch,
		hostname: host,
		port,
		idleTimeout: 255, // max — embedding large specs can take minutes
	});

	// Auto-ingest specs on disk that aren't yet indexed (non-blocking)
	autoIngestSpecs(retriever);
}

// ---------------------------------------------------------------------------
// Helpers for /api/* routes
// ---------------------------------------------------------------------------

function extractDescription(fullText: string): string {
	const lines = fullText.split("\n");
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		if (/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\//.test(trimmed)) continue;
		if (/^Summary:\s*/i.test(trimmed)) {
			const val = trimmed.replace(/^Summary:\s*/i, "").trim();
			if (val && !val.match(/^[a-z]+([A-Z][a-z]+)+$/)) return val;
			continue;
		}
		if (/^Tags?:\s*/i.test(trimmed)) continue;
		if (/^Description:\s*/i.test(trimmed)) {
			return trimmed.replace(/^Description:\s*/i, "").slice(0, 200);
		}
		if (trimmed.length > 10) return trimmed.slice(0, 200);
	}
	return lines.find((l) => l.trim().length > 0)?.trim().slice(0, 200) ?? "";
}

function formatSearchResult(r: { id: string; text: string; metadata: Record<string, string>; distance: number }) {
	const m = r.metadata;
	return {
		id: r.id,
		method: m.method ?? "",
		path: m.path ?? "",
		name: m.name ?? "",
		api: m.api ?? "",
		type: m.type ?? "",
		operation_id: m.operation_id ?? "",
		tags: m.tags ?? "",
		description: extractDescription(m.full_text ?? r.text),
		score: Math.max(0, Math.round((1 - (r.distance ?? 0) / 2) * 100) / 100),
		full_text: m.full_text ?? r.text,
		response_schema: m.response_schema ?? "",
	};
}

function formatDocResult(r: { id: string; text: string; metadata: Record<string, string> }) {
	const m = r.metadata;
	return {
		id: r.id,
		method: m.method ?? "",
		path: m.path ?? "",
		name: m.name ?? "",
		api: m.api ?? "",
		type: m.type ?? "",
		operation_id: m.operation_id ?? "",
		tags: m.tags ?? "",
		description: extractDescription(m.full_text ?? r.text),
		full_text: m.full_text ?? r.text,
		response_schema: m.response_schema ?? "",
	};
}
