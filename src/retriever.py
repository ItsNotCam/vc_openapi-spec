"""
High-level search interface. Wraps SpecStore with convenient filtering helpers
and is the single import used by both the CLI and the MCP server.
"""

from __future__ import annotations

from typing import Optional

from .store import SpecStore


class Retriever:
    def __init__(self, store: Optional[SpecStore] = None):
        self._store = store or SpecStore()

    # ------------------------------------------------------------------
    # Ingest
    # ------------------------------------------------------------------

    def ingest(self, source: str, api_name: str) -> dict:
        """Load an OpenAPI spec and push all endpoints + schemas to ChromaDB.

        Returns a summary dict: { api, endpoints_ingested, schemas_ingested, total }.
        """
        from .parser import load_spec, extract_endpoints, extract_schemas
        from .chunker import endpoint_to_document, schema_to_document

        spec = load_spec(source)
        endpoints = extract_endpoints(spec)
        schemas = extract_schemas(spec)

        endpoint_docs = [endpoint_to_document(e, api_name) for e in endpoints]
        schema_docs = [schema_to_document(s, api_name) for s in schemas]

        self._store.delete_api(api_name)
        self._store.upsert(endpoint_docs + schema_docs)

        return {
            "api": api_name,
            "endpoints_ingested": len(endpoint_docs),
            "schemas_ingested": len(schema_docs),
            "total": len(endpoint_docs) + len(schema_docs),
        }

    # ------------------------------------------------------------------
    # Search
    # ------------------------------------------------------------------

    def search_endpoints(
        self,
        query: str,
        api: Optional[str] = None,
        method: Optional[str] = None,
        tag: Optional[str] = None,
        n: int = 5,
    ) -> list[dict]:
        """Semantic search over endpoints with optional metadata filters."""
        where = _build_where(type_="endpoint", api=api, method=method)
        results = self._store.query(query, n_results=n, where=where or None)
        # Post-filter by tag (ChromaDB doesn't support substring matching natively)
        if tag:
            tag_lower = tag.lower()
            results = [
                r for r in results
                if tag_lower in r["metadata"].get("tags", "").lower()
            ]
        return results

    def search_schemas(
        self,
        query: str,
        api: Optional[str] = None,
        n: int = 5,
    ) -> list[dict]:
        """Semantic search over schemas with optional API filter."""
        where = _build_where(type_="schema", api=api)
        return self._store.query(query, n_results=n, where=where or None)

    def get_endpoint(
        self,
        path: str,
        method: str,
        api: Optional[str] = None,
    ) -> Optional[dict]:
        """Exact lookup of a specific endpoint by path + method (+ optional api)."""
        if api:
            doc_id = f"{api}:endpoint:{method.upper()}:{path}"
            return self._store.get_by_id(doc_id)
        # Search across all apis
        where = {"$and": [{"type": "endpoint"}, {"method": method.upper()}, {"path": path}]}
        results = self._store.query(f"{method.upper()} {path}", n_results=1, where=where)
        return results[0] if results else None

    # ------------------------------------------------------------------
    # Metadata
    # ------------------------------------------------------------------

    def delete_api(self, api_name: str) -> None:
        self._store.delete_api(api_name)

    def list_apis(self) -> list[str]:
        return self._store.list_apis()

    def list_endpoints(self, api_name: str) -> list[dict]:
        """Return all endpoint documents for a given API."""
        docs = self._store.get_all(api_name)
        return [d for d in docs if d.get("metadata", {}).get("type") == "endpoint"]


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _build_where(**filters) -> dict:
    """Build a ChromaDB `where` clause from keyword filters, omitting None values."""
    clauses = []
    type_ = filters.get("type_")
    if type_:
        clauses.append({"type": type_})
    api = filters.get("api")
    if api:
        clauses.append({"api": api})
    method = filters.get("method")
    if method:
        clauses.append({"method": method.upper()})

    if not clauses:
        return {}
    if len(clauses) == 1:
        return clauses[0]
    return {"$and": clauses}
