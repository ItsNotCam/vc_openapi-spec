#!/usr/bin/env python3
"""
Reconstruct an OpenAPI 3.0 YAML spec from ChromaDB endpoint/schema documents.

Usage:
    python scripts/reconstruct_spec.py darktrace
    python scripts/reconstruct_spec.py darktrace -o specs/darktrace.yaml
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

import yaml

# Add project root to path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.store import SpecStore


def parse_endpoint_text(text: str, metadata: dict) -> dict | None:
    """Parse a chunker-formatted endpoint text block back into structured data."""
    lines = text.strip().split("\n")
    if not lines:
        return None

    # First line: "GET /path"
    first = lines[0].strip()
    parts = first.split(" ", 1)
    if len(parts) != 2:
        return None
    method, path = parts[0].upper(), parts[1]

    op: dict = {
        "method": method,
        "path": path,
        "summary": "",
        "description": "",
        "operation_id": "",
        "tags": [],
        "parameters": [],
        "request_body": None,
        "responses": {},
    }

    section = None  # current section: parameters, request_body, responses
    current_response_code = None
    i = 1
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()

        if stripped.startswith("Summary: "):
            op["summary"] = stripped[len("Summary: "):]
        elif stripped.startswith("Tags: "):
            op["tags"] = [t.strip() for t in stripped[len("Tags: "):].split(",")]
        elif stripped.startswith("Description: "):
            desc_lines = [stripped[len("Description: "):]]
            # Collect continuation lines
            while i + 1 < len(lines) and not lines[i + 1].strip().startswith(("Operation ID:", "Parameters:", "Request Body:", "Responses:", "Tags:", "Summary:")):
                next_line = lines[i + 1].strip()
                if next_line.startswith("- ") and section == "parameters":
                    break
                desc_lines.append(next_line)
                i += 1
            op["description"] = "\n".join(desc_lines)
        elif stripped.startswith("Operation ID: "):
            op["operation_id"] = stripped[len("Operation ID: "):]
        elif stripped == "Parameters:":
            section = "parameters"
        elif stripped == "Request Body:":
            section = "request_body"
        elif stripped == "Responses:":
            section = "responses"
        elif section == "parameters" and stripped.startswith("- "):
            param = _parse_parameter_line(stripped)
            if param:
                op["parameters"].append(param)
        elif section == "request_body" and stripped.startswith("("):
            media_match = re.match(r"\(([^)]+)\):\s*(.*)", stripped)
            if media_match:
                media_type = media_match.group(1)
                op["request_body"] = {"media_type": media_type, "schema_hint": media_match.group(2)}
        elif section == "responses" and re.match(r"^\d{3}:", stripped):
            code_match = re.match(r"^(\d{3}):\s*(.*)", stripped)
            if code_match:
                current_response_code = code_match.group(1)
                rest = code_match.group(2)
                desc = rest
                schema_hint = ""
                if " — " in rest:
                    desc, schema_hint = rest.split(" — ", 1)
                op["responses"][current_response_code] = {
                    "description": desc.strip(),
                    "schema_hint": schema_hint.strip(),
                }
        elif section == "responses" and stripped.startswith("Schema:") and current_response_code:
            # Full schema line — stored for reference but we prefer metadata response_schema
            pass
        i += 1

    # Use metadata for richer info
    if metadata.get("operation_id"):
        op["operation_id"] = metadata["operation_id"]
    if metadata.get("tags"):
        op["tags"] = [t.strip() for t in metadata["tags"].split(",")]

    return op


def _parse_parameter_line(line: str) -> dict | None:
    """Parse '- name (location, required): type — description'."""
    m = re.match(
        r"^-\s+(\S+)\s+\((\w+),\s*(required|optional)\)(?::\s*(\S+))?(?:\s+—\s+(.*))?$",
        line,
    )
    if not m:
        return None
    return {
        "name": m.group(1),
        "in": m.group(2),
        "required": m.group(3) == "required",
        "type": m.group(4) or "string",
        "description": m.group(5) or "",
    }


def parse_response_schema_hint(hint: str) -> dict:
    """Convert a schema hint like '{ name, id, ... }' or 'array of { ... }' to a JSON Schema."""
    hint = hint.strip()
    if not hint:
        return {}
    if hint.startswith("array of "):
        inner = parse_response_schema_hint(hint[len("array of "):])
        return {"type": "array", "items": inner} if inner else {"type": "array"}
    if hint.startswith("{") and hint.endswith("}"):
        inner = hint[1:-1].strip()
        if not inner:
            return {"type": "object"}
        props = {}
        for part in _split_schema_fields(inner):
            part = part.strip().rstrip(",")
            if not part or part == "...":
                continue
            if ": " in part:
                k, v = part.split(": ", 1)
                props[k.strip()] = _type_to_schema(v.strip())
            else:
                props[part.strip()] = {"type": "string"}
        return {"type": "object", "properties": props} if props else {"type": "object"}
    return _type_to_schema(hint)


def _split_schema_fields(s: str) -> list[str]:
    """Split schema fields respecting nested braces."""
    parts = []
    depth = 0
    current = ""
    for ch in s:
        if ch in "{[":
            depth += 1
            current += ch
        elif ch in "}]":
            depth -= 1
            current += ch
        elif ch == "," and depth == 0:
            parts.append(current)
            current = ""
        else:
            current += ch
    if current.strip():
        parts.append(current)
    return parts


def _type_to_schema(t: str) -> dict:
    """Convert a type string to a JSON Schema snippet."""
    t = t.strip()
    if t in ("string", "integer", "number", "boolean"):
        return {"type": t}
    if t.startswith("array of "):
        inner = _type_to_schema(t[len("array of "):])
        return {"type": "array", "items": inner}
    if t.startswith("{"):
        return parse_response_schema_hint(t)
    if t == "object":
        return {"type": "object"}
    return {"type": "string"}


def build_openapi(api_name: str, endpoints: list[dict]) -> dict:
    """Build an OpenAPI 3.0 spec dict from parsed endpoints."""
    paths: dict = {}
    for ep in endpoints:
        path = ep["path"]
        method = ep["method"].lower()

        operation: dict = {}
        if ep.get("summary"):
            operation["summary"] = ep["summary"]
        if ep.get("description"):
            operation["description"] = ep["description"]
        if ep.get("operation_id"):
            operation["operationId"] = ep["operation_id"]
        if ep.get("tags"):
            operation["tags"] = ep["tags"]

        if ep.get("parameters"):
            params = []
            for p in ep["parameters"]:
                param: dict = {
                    "name": p["name"],
                    "in": p["in"],
                    "required": p["required"],
                    "schema": {"type": p.get("type", "string")},
                }
                if p.get("description"):
                    param["description"] = p["description"]
                params.append(param)
            operation["parameters"] = params

        if ep.get("request_body"):
            rb = ep["request_body"]
            media_type = rb.get("media_type", "application/json")
            schema = parse_response_schema_hint(rb.get("schema_hint", ""))
            operation["requestBody"] = {
                "content": {media_type: {"schema": schema} if schema else {}},
            }

        if ep.get("responses"):
            responses = {}
            for code, resp_info in ep["responses"].items():
                resp: dict = {"description": resp_info.get("description", "")}
                schema_hint = resp_info.get("schema_hint", "")
                # Prefer full response_schema from metadata if this is 2xx
                full_schema = ep.get("_response_schema") if code.startswith("2") else None
                if full_schema:
                    schema = parse_response_schema_hint(full_schema)
                elif schema_hint:
                    schema = parse_response_schema_hint(schema_hint)
                else:
                    schema = None
                if schema:
                    resp["content"] = {"application/json": {"schema": schema}}
                responses[code] = resp
            operation["responses"] = responses
        else:
            operation["responses"] = {"200": {"description": "Successful response"}}

        if path not in paths:
            paths[path] = {}
        paths[path][method] = operation

    return {
        "openapi": "3.0.0",
        "info": {
            "title": f"{api_name} API",
            "description": f"Reconstructed from ChromaDB ingested data for {api_name}.",
            "version": "1.0.0",
        },
        "paths": paths,
    }


def _split_search_results(text: str) -> list[str]:
    """Split MCP search_endpoints output into individual endpoint blocks."""
    blocks = re.split(r"\n---\n", text)
    result = []
    for block in blocks:
        block = block.strip()
        # Strip the "[N] METHOD /path  (api: ..., distance: ...)" header line
        lines = block.split("\n")
        if lines and re.match(r"^\[\d+\]", lines[0]):
            block = "\n".join(lines[1:]).strip()
        if block:
            result.append(block)
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Reconstruct OpenAPI spec from ChromaDB")
    parser.add_argument("api", help="API name (used for spec title)")
    parser.add_argument("-o", "--output", help="Output YAML file path (default: specs/<api>.yaml)")
    parser.add_argument("-f", "--from-file", help="Parse from a text dump file instead of connecting to ChromaDB")
    args = parser.parse_args()

    output = Path(args.output) if args.output else Path(__file__).resolve().parent.parent / "specs" / f"{args.api}.yaml"

    endpoints = []

    if args.from_file:
        # Parse from a text dump (e.g. MCP search_endpoints output)
        text = Path(args.from_file).read_text()
        blocks = _split_search_results(text)
        for block in blocks:
            ep = parse_endpoint_text(block, {})
            if ep:
                endpoints.append(ep)
    else:
        store = SpecStore()
        docs = store.get_all(args.api)
        if not docs:
            print(f"No documents found for API '{args.api}'")
            sys.exit(1)
        for doc in docs:
            meta = doc["metadata"]
            if meta.get("type") != "endpoint":
                continue
            ep = parse_endpoint_text(doc["text"], meta)
            if ep:
                if meta.get("response_schema"):
                    ep["_response_schema"] = meta["response_schema"]
                endpoints.append(ep)

    if not endpoints:
        print(f"No endpoints found for API '{args.api}'")
        sys.exit(1)

    spec = build_openapi(args.api, endpoints)

    output.parent.mkdir(parents=True, exist_ok=True)
    with open(output, "w") as f:
        yaml.dump(spec, f, default_flow_style=False, sort_keys=False, allow_unicode=True, width=120)

    print(f"Wrote {len(endpoints)} endpoints to {output}")


if __name__ == "__main__":
    main()
