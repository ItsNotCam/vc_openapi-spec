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
from collections.abc import AsyncIterator
from typing import Optional

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import Tool, TextContent

from .retriever import Retriever

app = Server("openapi-chroma")
_retriever: Optional[Retriever] = None


def _get_retriever() -> Retriever:
    global _retriever
    if _retriever is None:
        _retriever = Retriever()
    return _retriever


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
        return [TextContent(type="text", text=result["text"])]

    elif name == "list_apis":
        apis = r.list_apis()
        if not apis:
            return [TextContent(type="text", text="No APIs ingested yet.")]
        return [TextContent(type="text", text="Ingested APIs:\n" + "\n".join(f"- {a}" for a in apis))]

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
    from starlette.requests import Request
    from starlette.responses import Response
    from starlette.routing import Mount, Route

    session_manager = StreamableHTTPSessionManager(app=app, stateless=True)

    async def handle_mcp(scope, receive, send):
        await session_manager.handle_request(scope, receive, send)

    @contextlib.asynccontextmanager
    async def lifespan(starlette_app) -> AsyncIterator[None]:
        async with session_manager.run():
            yield

    starlette_app = Starlette(
        routes=[Mount("/openapi", app=handle_mcp)],
        lifespan=lifespan,
    )

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
        parts.append(f"{header}\n{res['text']}")
    return "\n\n---\n\n".join(parts)
