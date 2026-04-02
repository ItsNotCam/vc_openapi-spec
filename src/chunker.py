"""
Converts parsed OpenAPI data into rich text documents for ChromaDB.

Each document is a (id, text, metadata) tuple. The text is deliberately
verbose — it includes parameter descriptions, response shapes, and schema
property details — so the embedding captures semantic meaning, not just names.
"""

from __future__ import annotations

import json
from typing import Any


Document = tuple[str, str, dict]  # (id, text, metadata)


def endpoint_to_document(endpoint: dict, api_name: str) -> Document:
    """Convert an endpoint dict (from parser.extract_endpoints) to a Document."""
    method = endpoint["method"]
    path = endpoint["path"]
    doc_id = f"{api_name}:endpoint:{method}:{path}"

    lines: list[str] = [
        f"{method} {path}",
    ]
    if endpoint.get("summary"):
        lines.append(f"Summary: {endpoint['summary']}")
    if endpoint.get("tags"):
        lines.append(f"Tags: {', '.join(endpoint['tags'])}")
    if endpoint.get("description"):
        lines.append(f"Description: {endpoint['description']}")
    if endpoint.get("operation_id"):
        lines.append(f"Operation ID: {endpoint['operation_id']}")

    # Parameters
    params = endpoint.get("parameters") or []
    if params:
        lines.append("Parameters:")
        for p in params:
            if not isinstance(p, dict):
                continue
            name = p.get("name", "?")
            location = p.get("in", "")
            required = "required" if p.get("required") else "optional"
            schema = p.get("schema", {}) or {}
            ptype = schema.get("type", p.get("type", ""))
            desc = p.get("description", schema.get("description", ""))
            line = f"  - {name} ({location}, {required})"
            if ptype:
                line += f": {ptype}"
            if desc:
                line += f" — {desc}"
            lines.append(line)

    # Request body
    req_body = endpoint.get("request_body")
    if req_body and isinstance(req_body, dict):
        lines.append("Request Body:")
        desc = req_body.get("description", "")
        if desc:
            lines.append(f"  {desc}")
        content = req_body.get("content", {})
        for media_type, media_obj in content.items():
            if not isinstance(media_obj, dict):
                continue
            schema = media_obj.get("schema", {})
            lines.append(f"  ({media_type}): {_schema_summary(schema)}")

    # Responses
    responses = endpoint.get("responses") or {}
    if responses:
        lines.append("Responses:")
        for status, resp in responses.items():
            if not isinstance(resp, dict):
                continue
            desc = resp.get("description", "")
            content = resp.get("content", {})
            schema_str = ""
            full_schema_str = ""
            for _, media_obj in content.items():
                if isinstance(media_obj, dict):
                    schema = media_obj.get("schema", {})
                    schema_str = _schema_summary(schema)
                    full_schema_str = _full_schema_str(schema)
                    break
            line = f"  {status}: {desc}"
            if schema_str:
                line += f" — {schema_str}"
            lines.append(line)
            if full_schema_str and full_schema_str != schema_str:
                lines.append(f"    Schema: {full_schema_str}")

    text = "\n".join(lines)
    metadata: dict = {
        "type": "endpoint",
        "method": method,
        "path": path,
        "api": api_name,
    }
    if endpoint.get("operation_id"):
        metadata["operation_id"] = endpoint["operation_id"]
    if endpoint.get("tags"):
        # ChromaDB metadata values must be str/int/float/bool — join tags
        metadata["tags"] = ", ".join(endpoint["tags"])

    # Store full (untruncated) response schema for exact get_endpoint lookups
    for status, resp in responses.items():
        if str(status).startswith("2") and isinstance(resp, dict):
            for _, media_obj in (resp.get("content") or {}).items():
                if isinstance(media_obj, dict):
                    full_schema = _full_schema_str(media_obj.get("schema", {}))
                    if full_schema:
                        metadata["response_schema"] = full_schema
                break
            break

    return doc_id, text, metadata


def schema_to_document(schema: dict, api_name: str) -> Document:
    """Convert a schema dict (from parser.extract_schemas) to a Document."""
    name = schema["name"]
    doc_id = f"{api_name}:schema:{name}"

    lines: list[str] = [f"Schema: {name}"]
    if schema.get("description"):
        lines.append(f"Description: {schema['description']}")
    if schema.get("schema_type"):
        lines.append(f"Type: {schema['schema_type']}")
    if schema.get("enum"):
        lines.append(f"Enum values: {', '.join(str(v) for v in schema['enum'])}")

    props = schema.get("properties") or {}
    required_set = set(schema.get("required") or [])
    if props:
        lines.append("Properties:")
        for prop_name, prop_schema in props.items():
            if not isinstance(prop_schema, dict):
                continue
            req = "required" if prop_name in required_set else "optional"
            ptype = prop_schema.get("type", "")
            desc = prop_schema.get("description", "")
            enum = prop_schema.get("enum")
            line = f"  - {prop_name} ({ptype}, {req})"
            if desc:
                line += f": {desc}"
            if enum:
                line += f" — one of: {', '.join(str(v) for v in enum)}"
            lines.append(line)

    text = "\n".join(lines)
    metadata: dict = {
        "type": "schema",
        "name": name,
        "api": api_name,
    }
    return doc_id, text, metadata


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _full_schema_str(schema: Any) -> str:
    """Produce a complete schema string with all fields and types (no truncation)."""
    if not isinstance(schema, dict):
        return ""
    stype = schema.get("type", "")
    if stype == "array":
        return f"array of {_full_schema_str(schema.get('items', {}))}"
    if stype == "object" or schema.get("properties"):
        props = schema.get("properties", {})
        if not props:
            return "object"
        parts = [f"{k}: {_full_schema_str(v)}" for k, v in props.items()]
        return "{ " + ", ".join(parts) + " }"
    if stype:
        return stype
    for combiner in ("allOf", "oneOf", "anyOf"):
        parts = schema.get(combiner)
        if parts:
            summaries = [_full_schema_str(p) for p in parts if isinstance(p, dict)]
            return f"{combiner}({', '.join(s for s in summaries if s)})"
    return ""


def _schema_summary(schema: Any, depth: int = 0) -> str:
    """Produce a compact one-line summary of a JSON schema."""
    if not isinstance(schema, dict) or depth > 2:
        return ""

    stype = schema.get("type", "")
    if stype == "array":
        items = schema.get("items", {})
        return f"array of {_schema_summary(items, depth + 1)}"
    if stype == "object" or schema.get("properties"):
        props = schema.get("properties", {})
        if not props:
            return "object"
        keys = list(props.keys())
        preview = ", ".join(keys[:6])
        suffix = ", ..." if len(keys) > 6 else ""
        return f"{{ {preview}{suffix} }}"
    if stype:
        return stype
    # Inline allOf/oneOf/anyOf
    for combiner in ("allOf", "oneOf", "anyOf"):
        parts = schema.get(combiner)
        if parts:
            summaries = [_schema_summary(p, depth + 1) for p in parts if isinstance(p, dict)]
            return f"{combiner}({', '.join(s for s in summaries if s)})"
    return json.dumps(schema)[:80]
