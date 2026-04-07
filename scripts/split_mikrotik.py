#!/usr/bin/env python3
"""
Split the MikroTik mega-spec into domain-grouped sub-specs.
Each output is a valid OpenAPI spec with only relevant paths + components.

Usage: python3 scripts/split_mikrotik.py
Output: specs/mikrotik-*.json
"""

import json
from pathlib import Path
from collections import defaultdict

INPUT = Path("specs/mikrotik.json")
OUT_DIR = Path("specs")

# Group top-level path prefixes into chunks
CHUNKS = [
    ("interface", {"/interface"}),
    ("ip",        {"/ip"}),
    ("routing",   {"/routing"}),
    ("system",    {"/system", "/tool", "/console", "/log", "/task", "/safe-mode",
                   "/terminal", "/environment", "/beep", "/convert", "/delay",
                   "/deserialize", "/do", "/error", "/execute", "/find", "/for",
                   "/foreach", "/special-login", "/tr069-client"}),
    ("network",   {"/ipv6", "/iot", "/mpls", "/ppp", "/port", "/snmp", "/radius"}),
    ("misc",      {"/dude", "/caps-man", "/user-manager", "/certificate", "/lora",
                   "/disk", "/user", "/queue", "/container", "/file"}),
]

def first_segment(path: str) -> str:
    parts = path.strip("/").split("/")
    return "/" + parts[0] if parts else "/"

def main():
    print(f"Loading {INPUT} ...")
    with open(INPUT) as f:
        spec = json.load(f)

    all_paths = spec.get("paths", {})
    components = spec.get("components", spec.get("definitions", {}))

    # Build prefix → chunk name mapping
    prefix_to_chunk: dict[str, str] = {}
    for chunk_name, prefixes in CHUNKS:
        for p in prefixes:
            prefix_to_chunk[p] = chunk_name

    # Assign each path to a chunk
    chunk_paths: dict[str, dict] = defaultdict(dict)
    unassigned = []
    for path, item in all_paths.items():
        seg = first_segment(path)
        chunk = prefix_to_chunk.get(seg)
        if chunk:
            chunk_paths[chunk][path] = item
        else:
            unassigned.append(path)

    if unassigned:
        print(f"  {len(unassigned)} unassigned paths → adding to misc")
        for path in unassigned:
            chunk_paths["misc"][path] = all_paths[path]

    # Write each chunk
    base = {k: v for k, v in spec.items() if k not in ("paths", "components", "definitions")}

    for chunk_name, _ in CHUNKS:
        paths = chunk_paths.get(chunk_name, {})
        if not paths:
            print(f"  [skip] mikrotik-{chunk_name}: no paths")
            continue

        out_spec = {**base, "paths": paths}
        if "components" in spec:
            out_spec["components"] = components
        elif "definitions" in spec:
            out_spec["definitions"] = components

        out_path = OUT_DIR / f"mikrotik-{chunk_name}.json"
        with open(out_path, "w") as f:
            json.dump(out_spec, f)

        size_kb = out_path.stat().st_size // 1024
        print(f"  wrote mikrotik-{chunk_name}.json  ({len(paths)} paths, {size_kb} KB)")

    print("Done.")

if __name__ == "__main__":
    main()
