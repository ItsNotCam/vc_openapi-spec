"""
ChromaDB client wrapper.

Manages a single `openapi_specs` collection. Documents are upserted with
deterministic IDs so re-ingesting the same spec updates rather than duplicates.

Connection is configured via environment variables (see .env.example):

  CHROMA_HOST        — if set, uses HttpClient instead of PersistentClient
  CHROMA_PORT        — port for HttpClient (default: 8000)
  CHROMA_SSL         — "true" to enable SSL for HttpClient (default: false)
  CHROMA_AUTH_TOKEN  — bearer token for authenticated ChromaDB servers
  CHROMA_DB_PATH     — local path for PersistentClient (default: .chroma_db/)
  CHROMA_COLLECTION  — collection name (default: openapi_specs)
  OLLAMA_URL         — if set, uses Ollama for embeddings (e.g. https://ai.home.itsnotcam.dev)
  OLLAMA_MODEL       — Ollama embedding model (default: mxbai-embed-large)
  EMBEDDING_MODEL    — sentence-transformers model, used only if OLLAMA_URL is not set (default: all-MiniLM-L6-v2)
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

import httpx
import chromadb
from chromadb import EmbeddingFunction, Embeddings
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent / ".env")

# Defaults (overridden by env vars)
DEFAULT_DB_PATH = str(Path(__file__).parent.parent / ".chroma_db")
COLLECTION_NAME = "openapi_specs"


class _OllamaEmbeddingFunction(EmbeddingFunction):
    def __init__(self, url: str, model: str):
        self._url = url.rstrip("/") + "/api/embed"
        self._model = model

    def __call__(self, input: list[str], batch_size: int = 16) -> Embeddings:
        # nomic-embed-text supports 8192 tokens (~32k chars), truncate to be safe
        texts = [t[:8000] for t in input]
        embeddings = []
        for i in range(0, len(texts), batch_size):
            batch = texts[i:i + batch_size]
            response = httpx.post(
                self._url,
                json={"model": self._model, "input": batch},
                timeout=120,
            )
            response.raise_for_status()
            embeddings.extend(response.json()["embeddings"])
        return embeddings


def _build_embedding_function():
    ollama_url = os.getenv("OLLAMA_URL")
    if ollama_url:
        model = os.getenv("OLLAMA_MODEL", "mxbai-embed-large")
        print(f"[embeddings] using Ollama  url={ollama_url}  model={model}")
        return _OllamaEmbeddingFunction(url=ollama_url, model=model)
    model = os.getenv("EMBEDDING_MODEL", "all-MiniLM-L6-v2")
    print(f"[embeddings] using sentence-transformers  model={model}")
    from chromadb.utils.embedding_functions import SentenceTransformerEmbeddingFunction
    return SentenceTransformerEmbeddingFunction(model_name=model)


def _build_client() -> chromadb.ClientAPI:
    host = os.getenv("CHROMA_HOST")
    if host:
        port = int(os.getenv("CHROMA_PORT", "8000"))
        ssl = os.getenv("CHROMA_SSL", "false").lower() == "true"
        token = os.getenv("CHROMA_AUTH_TOKEN")
        settings = chromadb.Settings()
        if token:
            settings = chromadb.Settings(
                chroma_client_auth_provider="chromadb.auth.token_authn.TokenAuthClientProvider",
                chroma_client_auth_credentials=token,
            )
        return chromadb.HttpClient(host=host, port=port, ssl=ssl, settings=settings)
    return chromadb.PersistentClient(path=os.getenv("CHROMA_DB_PATH", DEFAULT_DB_PATH))


class SpecStore:
    def __init__(self):
        self._client = _build_client()
        ef = _build_embedding_function()
        collection_name = os.getenv("CHROMA_COLLECTION", COLLECTION_NAME)
        self._collection = self._client.get_or_create_collection(
            name=collection_name,
            embedding_function=ef,
            metadata={"hnsw:space": "cosine"},
        )

    # ------------------------------------------------------------------
    # Ingest
    # ------------------------------------------------------------------

    def upsert(self, documents: list[tuple[str, str, dict]]) -> int:
        """Upsert a list of (id, text, metadata) documents. Returns count."""
        if not documents:
            return 0
        ids, texts, metadatas = zip(*documents)
        self._collection.upsert(
            ids=list(ids),
            documents=list(texts),
            metadatas=list(metadatas),
        )
        return len(ids)

    def delete_api(self, api_name: str) -> None:
        """Remove all documents for a given API."""
        results = self._collection.get(where={"api": api_name}, include=[])
        ids = results.get("ids", [])
        if ids:
            self._collection.delete(ids=ids)

    # ------------------------------------------------------------------
    # Query
    # ------------------------------------------------------------------

    def query(
        self,
        query_text: str,
        n_results: int = 5,
        where: Optional[dict] = None,
    ) -> list[dict]:
        """Semantic search. Returns list of result dicts with id, text, metadata, distance."""
        kwargs: dict = {"query_texts": [query_text], "n_results": n_results, "include": ["documents", "metadatas", "distances"]}
        if where:
            kwargs["where"] = where

        results = self._collection.query(**kwargs)
        output = []
        ids = results.get("ids", [[]])[0]
        docs = results.get("documents", [[]])[0]
        metas = results.get("metadatas", [[]])[0]
        dists = results.get("distances", [[]])[0]
        for doc_id, text, meta, dist in zip(ids, docs, metas, dists):
            output.append({"id": doc_id, "text": text, "metadata": meta, "distance": dist})
        return output

    def get_by_id(self, doc_id: str) -> Optional[dict]:
        """Exact lookup by document ID."""
        results = self._collection.get(ids=[doc_id], include=["documents", "metadatas"])
        ids = results.get("ids", [])
        if not ids:
            return None
        return {
            "id": ids[0],
            "text": results["documents"][0],
            "metadata": results["metadatas"][0],
        }

    # ------------------------------------------------------------------
    # Metadata
    # ------------------------------------------------------------------

    def list_apis(self) -> list[str]:
        """Return sorted list of all ingested API names."""
        results = self._collection.get(include=["metadatas"])
        apis = {m.get("api", "") for m in results.get("metadatas", []) if m.get("api")}
        return sorted(apis)

    def count(self) -> int:
        return self._collection.count()
