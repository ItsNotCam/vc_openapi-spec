#!/usr/bin/env python3
"""
Convert a Postman Collection v2.1 JSON file to an OpenAPI 3.0 YAML spec.

Usage:
    python scripts/postman_to_openapi.py collection.json -o specs/api.yaml --title "My API"
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any
from urllib.parse import urlparse, parse_qs

import yaml


def convert(collection: dict, title: str | None = None) -> dict:
    """Convert a Postman Collection v2.1 dict to an OpenAPI 3.0 dict."""
    info = collection.get("info", {})
    spec_title = title or info.get("name", "Converted API")

    paths: dict = {}
    _walk_items(collection.get("item", []), paths, tag_stack=[])

    return {
        "openapi": "3.0.0",
        "info": {
            "title": spec_title,
            "description": info.get("description", ""),
            "version": "1.0.0",
        },
        "paths": paths,
    }


def _walk_items(items: list, paths: dict, tag_stack: list[str]) -> None:
    """Recursively walk Postman items (folders + requests)."""
    for item in items:
        if "item" in item:
            # It's a folder — use its name as a tag
            _walk_items(item["item"], paths, tag_stack + [item.get("name", "")])
        elif "request" in item:
            _process_request(item, paths, tag_stack)


def _process_request(item: dict, paths: dict, tag_stack: list[str]) -> None:
    """Convert a single Postman request to an OpenAPI path operation."""
    req = item["request"]
    if isinstance(req, str):
        return  # Some collections have string-only requests

    method = req.get("method", "GET").lower()
    url = req.get("url", {})
    if isinstance(url, str):
        path = _url_to_path(url)
        query_params = []
    else:
        path = _build_path(url)
        query_params = url.get("query", []) or []

    if not path:
        return

    operation: dict = {}

    # Summary from item name
    name = item.get("name", "")
    if name:
        operation["summary"] = name

    # Description
    desc = req.get("description", "")
    if isinstance(desc, dict):
        desc = desc.get("content", "")
    if desc:
        operation["description"] = desc

    # Tags from folder hierarchy
    tags = [t for t in tag_stack if t]
    if tags:
        operation["tags"] = tags

    # Parameters: path params + query params + headers
    params = []

    # Path parameters (from {variable} in path)
    for match in re.finditer(r"\{(\w+)\}", path):
        params.append({
            "name": match.group(1),
            "in": "path",
            "required": True,
            "schema": {"type": "string"},
        })

    # Query parameters
    for qp in query_params:
        if not isinstance(qp, dict):
            continue
        if qp.get("disabled"):
            continue
        param: dict = {
            "name": qp.get("key", ""),
            "in": "query",
            "required": False,
            "schema": {"type": "string"},
        }
        if qp.get("description"):
            param["description"] = qp["description"]
        if qp.get("value"):
            param["schema"]["example"] = qp["value"]
        params.append(param)

    # Headers (skip common auth/content-type headers)
    skip_headers = {"authorization", "content-type", "accept", "user-agent", "postman-token"}
    for header in req.get("header", []) or []:
        if not isinstance(header, dict):
            continue
        if header.get("disabled"):
            continue
        hname = header.get("key", "")
        if hname.lower() in skip_headers:
            continue
        param = {
            "name": hname,
            "in": "header",
            "required": False,
            "schema": {"type": "string"},
        }
        if header.get("description"):
            param["description"] = header["description"]
        params.append(param)

    if params:
        operation["parameters"] = params

    # Request body
    body = req.get("body")
    if body and isinstance(body, dict) and method in ("post", "put", "patch", "delete"):
        request_body = _build_request_body(body)
        if request_body:
            operation["requestBody"] = request_body

    # Default response
    operation["responses"] = {"200": {"description": "Successful response"}}

    # Add to paths
    if path not in paths:
        paths[path] = {}
    paths[path][method] = operation


def _build_path(url_obj: dict) -> str:
    """Build an OpenAPI path from a Postman URL object."""
    path_parts = url_obj.get("path", [])
    if not path_parts:
        raw = url_obj.get("raw", "")
        return _url_to_path(raw)

    segments = []
    for part in path_parts:
        if isinstance(part, str):
            # Convert Postman :param to OpenAPI {param}
            if part.startswith(":"):
                segments.append(f"{{{part[1:]}}}")
            # Convert {{variable}} to {variable}
            elif part.startswith("{{") and part.endswith("}}"):
                segments.append(f"{{{part[2:-2]}}}")
            else:
                segments.append(part)
    return "/" + "/".join(segments) if segments else "/"


def _url_to_path(raw: str) -> str:
    """Extract path from a raw URL string."""
    # Remove protocol + host
    raw = re.sub(r"^\{\{[^}]+\}\}", "", raw)  # Remove {{baseUrl}} prefix
    raw = re.sub(r"^https?://[^/]+", "", raw)
    # Convert :param to {param}
    raw = re.sub(r":(\w+)", r"{\1}", raw)
    # Convert {{var}} to {var}
    raw = re.sub(r"\{\{(\w+)\}\}", r"{\1}", raw)
    # Strip query string
    raw = raw.split("?")[0]
    if not raw.startswith("/"):
        raw = "/" + raw
    return raw


def _build_request_body(body: dict) -> dict | None:
    """Convert a Postman body to an OpenAPI requestBody."""
    mode = body.get("mode", "")

    if mode == "raw":
        raw = body.get("raw", "")
        options = body.get("options", {})
        lang = options.get("raw", {}).get("language", "json")

        if lang == "json" and raw.strip():
            try:
                example = json.loads(raw)
                schema = _infer_schema(example)
                return {
                    "content": {
                        "application/json": {
                            "schema": schema,
                            "example": example,
                        }
                    }
                }
            except json.JSONDecodeError:
                pass
        return {
            "content": {"application/json": {"schema": {"type": "object"}}}
        }

    if mode == "urlencoded":
        props = {}
        for param in body.get("urlencoded", []) or []:
            if not isinstance(param, dict):
                continue
            props[param.get("key", "")] = {"type": "string"}
            if param.get("description"):
                props[param["key"]]["description"] = param["description"]
        return {
            "content": {
                "application/x-www-form-urlencoded": {
                    "schema": {"type": "object", "properties": props} if props else {"type": "object"}
                }
            }
        }

    if mode == "formdata":
        props = {}
        for param in body.get("formdata", []) or []:
            if not isinstance(param, dict):
                continue
            key = param.get("key", "")
            if param.get("type") == "file":
                props[key] = {"type": "string", "format": "binary"}
            else:
                props[key] = {"type": "string"}
            if param.get("description"):
                props[key]["description"] = param["description"]
        return {
            "content": {
                "multipart/form-data": {
                    "schema": {"type": "object", "properties": props} if props else {"type": "object"}
                }
            }
        }

    return None


def _infer_schema(value: Any) -> dict:
    """Infer a JSON Schema from an example value."""
    if value is None:
        return {"type": "string", "nullable": True}
    if isinstance(value, bool):
        return {"type": "boolean"}
    if isinstance(value, int):
        return {"type": "integer"}
    if isinstance(value, float):
        return {"type": "number"}
    if isinstance(value, str):
        return {"type": "string"}
    if isinstance(value, list):
        if value:
            return {"type": "array", "items": _infer_schema(value[0])}
        return {"type": "array", "items": {}}
    if isinstance(value, dict):
        props = {k: _infer_schema(v) for k, v in value.items()}
        return {"type": "object", "properties": props}
    return {"type": "string"}


def main() -> None:
    parser = argparse.ArgumentParser(description="Convert Postman Collection v2.1 to OpenAPI 3.0")
    parser.add_argument("input", help="Path to Postman Collection JSON file")
    parser.add_argument("-o", "--output", help="Output YAML file path (default: stdout)")
    parser.add_argument("--title", help="API title (default: collection name)")
    args = parser.parse_args()

    with open(args.input) as f:
        collection = json.load(f)

    spec = convert(collection, title=args.title)

    if args.output:
        output = Path(args.output)
        output.parent.mkdir(parents=True, exist_ok=True)
        with open(output, "w") as f:
            yaml.dump(spec, f, default_flow_style=False, sort_keys=False, allow_unicode=True, width=120)
        paths = len(spec.get("paths", {}))
        ops = sum(len(v) for v in spec.get("paths", {}).values())
        print(f"Wrote {ops} operations across {paths} paths to {output}")
    else:
        yaml.dump(spec, sys.stdout, default_flow_style=False, sort_keys=False, allow_unicode=True, width=120)


if __name__ == "__main__":
    main()
