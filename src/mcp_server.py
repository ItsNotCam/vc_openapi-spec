"""
MCP server exposing OpenAPI retrieval tools to Claude.

Tools exposed:
  - search_endpoints  — semantic search over API endpoints
  - search_schemas    — semantic search over data schemas
  - get_endpoint      — exact lookup by path + method
  - list_apis         — list all ingested API names
  - ingest_spec       — ingest a spec from file or URL at runtime

Start with:
    python main.py serve                        # stdio (local Claude Code subprocess)
    python main.py serve --transport http       # HTTP (remote / homelab)
    python main.py serve --transport http --port 3000 --host 0.0.0.0

HTTP transport — add to Claude's MCP config:
    {
      "mcpServers": {
        "openapi": {
          "type": "http",
          "url": "https://mcp.home.itsnotcam.dev/openapi"
        }
      }
    }

Stdio transport — add to Claude's MCP config:
    {
      "mcpServers": {
        "openapi": {
          "command": "python",
          "args": ["/path/to/main.py", "serve"]
        }
      }
    }
"""

from __future__ import annotations

import contextlib
import json
import os
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Optional

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import Tool, TextContent

from .retriever import Retriever

app = Server("openapi-chroma")
_retriever: Optional[Retriever] = None

SPECS_DIR = Path(__file__).resolve().parent.parent / "specs"
_SIZE_WARN_BYTES = 10 * 1024 * 1024  # 10 MB

# Auth tokens (set via env or .env)
_ADMIN_TOKEN = os.getenv("MCP_ADMIN_TOKEN", "")
_READ_TOKEN = os.getenv("MCP_READ_TOKEN", "")
_WRITE_TOOLS = {"ingest_spec", "delete_api"}


def _get_retriever() -> Retriever:
    global _retriever
    if _retriever is None:
        _retriever = Retriever()
    return _retriever


def _discover_specs() -> list[dict]:
    """Scan SPECS_DIR for .yaml/.json files and return Swagger UI url entries."""
    if not SPECS_DIR.is_dir():
        return []
    specs = []
    for f in sorted(SPECS_DIR.iterdir()):
        if f.suffix not in (".yaml", ".yml", ".json"):
            continue
        name = f.stem
        size = f.stat().st_size
        if size > _SIZE_WARN_BYTES:
            mb = size // (1024 * 1024)
            label = f"{name} ({mb} MB \u26a0\ufe0f WILL FREEZE BROWSER)"
        elif size > 1024 * 1024:
            mb = round(size / (1024 * 1024), 1)
            label = f"{name} ({mb} MB)"
        else:
            kb = round(size / 1024)
            label = f"{name} ({kb} KB)"
        specs.append({"url": f"/openapi/specs/{f.name}", "name": label})
    return specs


async def _swagger_ui(request):
    from starlette.responses import HTMLResponse

    specs = _discover_specs()
    urls_json = json.dumps(specs)
    html = f"""<!DOCTYPE html>
<html>
<head>
    <title>API Specs</title>
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
    <style>
    #ai-search {{
        background: #1b1b1b;
        padding: 12px 20px;
        display: flex;
        gap: 8px;
        align-items: center;
        flex-wrap: wrap;
        border-bottom: 1px solid #333;
        position: sticky;
        top: 0;
        z-index: 1000;
    }}
    #ai-search input[type="text"] {{
        flex: 1;
        min-width: 200px;
        padding: 8px 12px;
        border: 1px solid #555;
        border-radius: 4px;
        background: #2b2b2b;
        color: #e0e0e0;
        font-size: 14px;
    }}
    #ai-search input[type="text"]::placeholder {{ color: #888; }}
    #ai-search input[type="text"]:focus {{ outline: none; border-color: #89bf04; }}
    #ai-search button {{
        padding: 8px 16px;
        border: none;
        border-radius: 4px;
        background: #89bf04;
        color: #1b1b1b;
        font-weight: bold;
        cursor: pointer;
        font-size: 14px;
    }}
    #ai-search button:hover {{ background: #9bd015; }}
    #ai-search .label {{ color: #89bf04; font-weight: bold; font-size: 13px; white-space: nowrap; }}
    #search-results {{
        max-height: 0;
        overflow: hidden;
        transition: max-height 0.3s ease;
        background: #1e1e1e;
    }}
    #search-results.open {{ max-height: 80vh; overflow-y: auto; }}
    .sr-item {{
        padding: 12px 20px;
        border-bottom: 1px solid #2a2a2a;
        cursor: pointer;
    }}
    .sr-item:hover {{ background: #252525; }}
    .sr-header {{
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 4px;
    }}
    .sr-method {{
        font-weight: bold;
        font-size: 12px;
        padding: 2px 8px;
        border-radius: 3px;
        color: #fff;
        text-transform: uppercase;
    }}
    .sr-method.get {{ background: #61affe; }}
    .sr-method.post {{ background: #49cc90; }}
    .sr-method.put {{ background: #fca130; }}
    .sr-method.patch {{ background: #50e3c2; }}
    .sr-method.delete {{ background: #f93e3e; }}
    .sr-path {{ font-family: monospace; color: #e0e0e0; font-size: 14px; }}
    .sr-api {{ color: #888; font-size: 12px; margin-left: auto; }}
    .sr-tags {{ color: #aaa; font-size: 12px; }}
    .sr-desc {{
        color: #999;
        font-size: 13px;
        margin-top: 4px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 800px;
    }}
    .sr-dist {{ color: #666; font-size: 11px; }}
    .sr-close {{
        text-align: center;
        padding: 6px;
        color: #888;
        cursor: pointer;
        font-size: 12px;
    }}
    .sr-close:hover {{ color: #e0e0e0; }}
    .sr-empty {{ padding: 20px; color: #888; text-align: center; }}
    .sr-loading {{ padding: 20px; color: #89bf04; text-align: center; }}
    </style>
</head>
<body>
    <div id="ai-search">
        <span class="label">AI Search</span>
        <input type="text" id="search-input" placeholder="Describe what you're looking for... (e.g. 'list all devices', 'authenticate user')" />
        <button onclick="doSearch()">Search</button>
    </div>
    <div id="search-results"></div>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-standalone-preset.js"></script>
    <script>
    const swaggerUI = SwaggerUIBundle({{
        urls: {urls_json},
        dom_id: '#swagger-ui',
        presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
        layout: "StandaloneLayout"
    }});

    const searchInput = document.getElementById('search-input');
    const resultsDiv = document.getElementById('search-results');

    searchInput.addEventListener('keydown', e => {{ if (e.key === 'Enter') doSearch(); }});

    async function doSearch() {{
        const q = searchInput.value.trim();
        if (!q) return;
        resultsDiv.innerHTML = '<div class="sr-loading">Searching...</div>';
        resultsDiv.classList.add('open');
        try {{
            const token = document.cookie.match(/token=([^;]+)/)?.[1] || '';
            const headers = {{}};
            if (token) headers['Authorization'] = 'Bearer ' + token;
            const resp = await fetch('/openapi/search?q=' + encodeURIComponent(q) + '&n=15', {{ headers }});
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            const items = await resp.json();
            if (!items.length) {{
                resultsDiv.innerHTML = '<div class="sr-empty">No results found.</div>';
                return;
            }}
            let html = items.map(r => `
                <div class="sr-item" onclick='jumpTo(${{JSON.stringify(JSON.stringify(r))}})'>
                    <div class="sr-header">
                        <span class="sr-method ${{r.method.toLowerCase()}}">${{r.method}}</span>
                        <span class="sr-path">${{r.path}}</span>
                        <span class="sr-api">${{r.api}}</span>
                        <span class="sr-dist">${{r.distance}}</span>
                    </div>
                    <div class="sr-tags">${{r.tags}}</div>
                    <div class="sr-desc">${{r.text.split('\\n').slice(0, 3).join(' | ')}}</div>
                </div>
            `).join('');
            html += '<div class="sr-close" onclick="closeResults()">Close results</div>';
            resultsDiv.innerHTML = html;
        }} catch (err) {{
            resultsDiv.innerHTML = '<div class="sr-empty">Search failed: ' + err.message + '</div>';
        }}
    }}

    function closeResults() {{
        resultsDiv.classList.remove('open');
    }}

    function jumpTo(jsonStr) {{
        const r = JSON.parse(jsonStr);
        closeResults();

        // Swagger UI builds operation element IDs as: operations-TAG-OPERATIONID
        // where tag and operationId have non-alphanumeric chars replaced
        function sanitize(s) {{ return s.replace(/[^a-zA-Z0-9_]/g, '_'); }}

        function findAndExpand() {{
            // Strategy 1: match by operations-TAG-OPERATIONID
            if (r.operation_id && r.tag) {{
                const elId = 'operations-' + sanitize(r.tag) + '-' + sanitize(r.operation_id);
                const el = document.getElementById(elId);
                if (el) {{ expandAndScroll(el); return; }}
            }}

            // Strategy 2: find the opblock by matching method + path in the DOM text
            const method = r.method.toLowerCase();
            const opblocks = document.querySelectorAll('.opblock-' + method);
            for (const block of opblocks) {{
                const pathEl = block.querySelector('.opblock-summary-path, .opblock-summary-path__deprecated');
                if (pathEl) {{
                    const pathText = pathEl.textContent.trim().replace(/\\s+/g, '');
                    if (pathText === r.path || pathText.endsWith(r.path)) {{
                        expandAndScroll(block);
                        return;
                    }}
                }}
            }}

            // Strategy 3: broader search by path substring
            const allBlocks = document.querySelectorAll('.opblock');
            for (const block of allBlocks) {{
                if (block.textContent.includes(r.path)) {{
                    expandAndScroll(block);
                    return;
                }}
            }}
        }}

        function expandAndScroll(el) {{
            // Expand if collapsed
            const summary = el.querySelector('.opblock-summary');
            const isCollapsed = !el.classList.contains('is-open');
            if (isCollapsed && summary) summary.click();
            // Scroll into view
            setTimeout(() => el.scrollIntoView({{ behavior: 'smooth', block: 'start' }}), 100);
        }}

        // Find the spec URL for this API and switch to it
        const specs = {urls_json};
        const currentSelect = document.querySelector('.topbar select');
        const currentUrl = currentSelect ? currentSelect.value : '';
        const match = specs.find(s => s.name.toLowerCase().startsWith(r.api.toLowerCase()));

        if (match && currentUrl !== match.url) {{
            // Need to switch spec first
            if (currentSelect) {{
                for (let opt of currentSelect.options) {{
                    if (opt.value === match.url) {{
                        currentSelect.value = match.url;
                        currentSelect.dispatchEvent(new Event('change'));
                        break;
                    }}
                }}
            }}
            // Poll for the spec to finish loading, then find the operation
            let attempts = 0;
            const poll = setInterval(() => {{
                attempts++;
                const opblocks = document.querySelectorAll('.opblock');
                if (opblocks.length > 0 || attempts > 30) {{
                    clearInterval(poll);
                    setTimeout(findAndExpand, 300);
                }}
            }}, 200);
        }} else {{
            // Already on the right spec
            findAndExpand();
        }}
    }}
    </script>
</body>
</html>"""
    return HTMLResponse(html)


async def _search_api(request):
    """REST endpoint wrapping semantic search for the Swagger UI."""
    from starlette.responses import JSONResponse

    q = request.query_params.get("q", "").strip()
    if not q:
        return JSONResponse({"error": "missing ?q= parameter"}, status_code=400)

    api = request.query_params.get("api") or None
    n = min(int(request.query_params.get("n", "10")), 50)

    retriever = _get_retriever()
    results = retriever.search_endpoints(query=q, api=api, n=n)

    items = []
    for r in results:
        meta = r["metadata"]
        tags = meta.get("tags", "")
        first_tag = tags.split(",")[0].strip() if tags else ""
        items.append({
            "method": meta.get("method", ""),
            "path": meta.get("path", ""),
            "api": meta.get("api", ""),
            "operation_id": meta.get("operation_id", ""),
            "tag": first_tag,
            "tags": tags,
            "distance": round(r.get("distance", 0), 4),
            "text": meta.get("full_text") or r.get("text", ""),
        })

    return JSONResponse(items)


# ---------------------------------------------------------------------------
# Tool definitions
# ---------------------------------------------------------------------------

@app.list_tools()
async def list_tools() -> list[Tool]:
    return [
        Tool(
            name="search_endpoints",
            description=(
                "Semantic search over ingested OpenAPI endpoints. "
                "Use this to find endpoints related to a task or feature."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Natural language description of what you're looking for"},
                    "api": {"type": "string", "description": "Optional: filter to a specific API name"},
                    "method": {"type": "string", "description": "Optional: filter by HTTP method (GET, POST, PUT, DELETE, ...)"},
                    "tag": {"type": "string", "description": "Optional: filter by tag (substring match)"},
                    "n": {"type": "integer", "description": "Number of results to return (default: 5)", "default": 5},
                },
                "required": ["query"],
            },
        ),
        Tool(
            name="search_schemas",
            description=(
                "Semantic search over ingested OpenAPI data schemas. "
                "Use this to understand the shape of request/response objects."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Natural language description of the schema you're looking for"},
                    "api": {"type": "string", "description": "Optional: filter to a specific API name"},
                    "n": {"type": "integer", "description": "Number of results to return (default: 5)", "default": 5},
                },
                "required": ["query"],
            },
        ),
        Tool(
            name="get_endpoint",
            description="Exact lookup of a specific endpoint by HTTP method and path.",
            inputSchema={
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "The endpoint path, e.g. /payments/create"},
                    "method": {"type": "string", "description": "The HTTP method, e.g. POST"},
                    "api": {"type": "string", "description": "Optional: restrict to a specific API name"},
                },
                "required": ["path", "method"],
            },
        ),
        Tool(
            name="list_apis",
            description="List all API specs that have been ingested into the knowledge base.",
            inputSchema={"type": "object", "properties": {}, "required": []},
        ),
        Tool(
            name="list_endpoints",
            description="List all endpoints for a given API. Returns method, path, summary, and tags for every endpoint.",
            inputSchema={
                "type": "object",
                "properties": {
                    "api": {"type": "string", "description": "The API name to list endpoints for (e.g. 'proxmox')"},
                },
                "required": ["api"],
            },
        ),
        Tool(
            name="ingest_spec",
            description=(
                "Ingest an OpenAPI spec from a file path or URL into the knowledge base. "
                "Use this when the user wants to add a new API."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "source": {"type": "string", "description": "File path or URL to the OpenAPI spec (YAML or JSON)"},
                    "api_name": {"type": "string", "description": "Short name to identify this API (e.g. 'stripe', 'github')"},
                },
                "required": ["source", "api_name"],
            },
        ),
        Tool(
            name="delete_api",
            description="Remove all documents for a given API from the knowledge base.",
            inputSchema={
                "type": "object",
                "properties": {
                    "api_name": {"type": "string", "description": "The API name to delete (e.g. 'proxmox')"},
                },
                "required": ["api_name"],
            },
        ),
    ]


# ---------------------------------------------------------------------------
# Tool execution
# ---------------------------------------------------------------------------

@app.call_tool()
async def call_tool(name: str, arguments: dict) -> list[TextContent]:
    import traceback
    try:
        r = _get_retriever()
    except Exception:
        traceback.print_exc()
        raise

    if name == "search_endpoints":
        results = r.search_endpoints(
            query=arguments["query"],
            api=arguments.get("api"),
            method=arguments.get("method"),
            tag=arguments.get("tag"),
            n=int(arguments.get("n", 5)),
        )
        return [TextContent(type="text", text=_format_results(results))]

    elif name == "search_schemas":
        results = r.search_schemas(
            query=arguments["query"],
            api=arguments.get("api"),
            n=int(arguments.get("n", 5)),
        )
        return [TextContent(type="text", text=_format_results(results))]

    elif name == "get_endpoint":
        result = r.get_endpoint(
            path=arguments["path"],
            method=arguments["method"],
            api=arguments.get("api"),
        )
        if result is None:
            return [TextContent(type="text", text="Endpoint not found.")]
        display_text = result.get("metadata", {}).get("full_text") or result["text"]
        return [TextContent(type="text", text=display_text)]

    elif name == "list_apis":
        apis = r.list_apis()
        if not apis:
            return [TextContent(type="text", text="No APIs ingested yet.")]
        return [TextContent(type="text", text="Ingested APIs:\n" + "\n".join(f"- {a}" for a in apis))]

    elif name == "list_endpoints":
        api_name = arguments["api"]
        endpoints = r.list_endpoints(api_name)
        if not endpoints:
            return [TextContent(type="text", text=f"No endpoints found for API '{api_name}'.")]
        lines = []
        for ep in sorted(endpoints, key=lambda d: (d["metadata"].get("path", ""), d["metadata"].get("method", ""))):
            m = ep["metadata"]
            display = m.get("full_text") or ep["text"]
            lines.append(display)
        return [TextContent(type="text", text="\n\n---\n\n".join(lines))]

    elif name == "ingest_spec":
        summary = r.ingest(arguments["source"], arguments["api_name"])
        return [TextContent(
            type="text",
            text=(
                f"Ingested API '{summary['api']}': "
                f"{summary['endpoints_ingested']} endpoints, "
                f"{summary['schemas_ingested']} schemas "
                f"({summary['total']} total documents)."
            ),
        )]

    elif name == "delete_api":
        api_name = arguments["api_name"]
        r.delete_api(api_name)
        return [TextContent(type="text", text=f"Deleted all documents for API '{api_name}'.")]

    return [TextContent(type="text", text=f"Unknown tool: {name}")]


# ---------------------------------------------------------------------------
# Server entry point
# ---------------------------------------------------------------------------

async def run_server(port: int = 3000, host: str = "0.0.0.0", transport: str = "stdio") -> None:
    """Run the MCP server over stdio or HTTP transport."""
    if transport == "stdio":
        async with stdio_server() as (read_stream, write_stream):
            await app.run(read_stream, write_stream, app.create_initialization_options())
    elif transport == "http":
        await _run_http_server(host=host, port=port)
    else:
        raise ValueError(f"Unknown transport: {transport!r}. Choose 'stdio' or 'http'.")


async def _run_http_server(host: str, port: int) -> None:
    import uvicorn
    from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
    from starlette.applications import Starlette
    from starlette.middleware import Middleware
    from starlette.requests import Request
    from starlette.responses import Response, JSONResponse
    from starlette.routing import Mount, Route
    from starlette.staticfiles import StaticFiles
    from starlette.types import ASGIApp, Receive, Scope, Send

    session_manager = StreamableHTTPSessionManager(app=app, stateless=True)

    # ── Auth middleware ──────────────────────────────────────────────
    class TokenAuthMiddleware:
        """Bearer-token gate with admin / read roles.

        - Admin token:  full access (all MCP tools)
        - Read token:   docs, specs, and read-only MCP tools
        - No token:     401 on everything

        Tokens are read from MCP_ADMIN_TOKEN / MCP_READ_TOKEN env vars.
        If neither is set, auth is disabled (open access — for local dev).
        """

        def __init__(self, app: ASGIApp) -> None:
            self.app = app
            self.enabled = bool(_ADMIN_TOKEN or _READ_TOKEN)

        async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
            if not self.enabled or scope["type"] != "http":
                await self.app(scope, receive, send)
                return

            headers = dict(scope.get("headers", []))
            auth = headers.get(b"authorization", b"").decode()
            token = auth.removeprefix("Bearer ").strip() if auth.startswith("Bearer ") else ""

            # Determine role
            if _ADMIN_TOKEN and token == _ADMIN_TOKEN:
                role = "admin"
            elif _READ_TOKEN and token == _READ_TOKEN:
                role = "read"
            else:
                resp = JSONResponse({"error": "unauthorized"}, status_code=401)
                await resp(scope, receive, send)
                return

            # Read role: block write MCP tools
            if role == "read":
                path = scope.get("path", "")
                method = scope.get("method", "")
                if method == "POST" and path.rstrip("/").endswith("/openapi"):
                    blocked = await self._check_write_tool(scope, receive, send)
                    if blocked:
                        return

            await self.app(scope, receive, send)

        async def _check_write_tool(self, scope: Scope, receive: Receive, send: Send) -> bool:
            """Peek at the JSON-RPC body; reject if it's a write tool call."""
            body_parts = []
            while True:
                msg = await receive()
                body_parts.append(msg.get("body", b""))
                if not msg.get("more_body", False):
                    break
            body = b"".join(body_parts)

            try:
                rpc = json.loads(body)
            except (json.JSONDecodeError, UnicodeDecodeError):
                rpc = {}

            if rpc.get("method") == "tools/call":
                tool_name = rpc.get("params", {}).get("name", "")
                if tool_name in _WRITE_TOOLS:
                    resp = JSONResponse(
                        {"error": f"read-only token cannot call '{tool_name}'"},
                        status_code=403,
                    )
                    await resp(scope, receive, send)
                    return True

            # Replay the body for downstream handlers
            body_sent = False

            async def replay_receive():
                nonlocal body_sent
                if not body_sent:
                    body_sent = True
                    return {"type": "http.request", "body": body, "more_body": False}
                return await receive()

            await self.app(scope, replay_receive, send)
            return True  # we already called self.app

    # ── Routes ───────────────────────────────────────────────────────
    async def handle_mcp(scope, receive, send):
        await session_manager.handle_request(scope, receive, send)

    @contextlib.asynccontextmanager
    async def lifespan(starlette_app) -> AsyncIterator[None]:
        async with session_manager.run():
            yield

    routes = []
    if SPECS_DIR.is_dir():
        routes.append(Route("/docs", _swagger_ui))
        routes.append(Mount("/specs", StaticFiles(directory=str(SPECS_DIR)), name="specs"))
    routes.append(Route("/search", _search_api))
    routes.append(Mount("/", app=handle_mcp))

    starlette_app = Starlette(
        routes=[Mount("/openapi", routes=routes)],
        middleware=[Middleware(TokenAuthMiddleware)],
        lifespan=lifespan,
    )

    if _ADMIN_TOKEN or _READ_TOKEN:
        print("[auth] token auth enabled — admin:", "set" if _ADMIN_TOKEN else "unset",
              " read:", "set" if _READ_TOKEN else "unset")
    else:
        print("[auth] WARNING: no auth tokens set — all endpoints are open")

    config = uvicorn.Config(starlette_app, host=host, port=port, log_level="info")
    server = uvicorn.Server(config)
    await server.serve()


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _format_results(results: list[dict]) -> str:
    if not results:
        return "No results found."
    parts = []
    for i, res in enumerate(results, 1):
        meta = res["metadata"]
        dist = res.get("distance", 0)
        header = f"[{i}] {meta.get('method', '')} {meta.get('path', meta.get('name', ''))}  (api: {meta.get('api', '?')}, distance: {dist:.4f})"
        display_text = meta.get("full_text") or res["text"]
        parts.append(f"{header}\n{display_text}")
    return "\n\n---\n\n".join(parts)
