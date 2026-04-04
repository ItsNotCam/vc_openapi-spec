# Known Issues

## Critical — Axios Supply Chain Attack (March 2026)

Axios versions **1.14.1** and **0.30.4** were compromised in a supply chain attack (attributed to Sapphire Sleet / North Korean state actor). A malicious dependency (`plain-crypto-js`) deployed a cross-platform RAT via postinstall hook.

**Mitigation applied**: `axios` is pinned to exact version `1.14.0` (no caret/tilde) in `package.json`. Do NOT upgrade to 1.14.1 until the axios team confirms the situation is resolved.

Consider migrating to native `fetch` (built into Bun) as a longer-term alternative.

Sources: Microsoft Security Blog, Google Cloud Blog, The Hacker News, CSA Singapore advisory.

## Minor

1. **ChromaDB JS client version**: The `chromadb` npm package (v1.10.5) used here is the older JS client. ChromaDB has a newer v3.x client (`chromadb-client`) that may have API differences. The current implementation works but you may want to evaluate upgrading.

2. **Sentence-transformers fallback**: The Python version supported `sentence-transformers` as a local embedding fallback. The TypeScript version only supports Ollama embeddings. If no Ollama URL is set, it defaults to `http://localhost:11434` which requires Ollama running locally.

3. **MCP HTTP transport**: The HTTP transport uses `WebStandardStreamableHTTPServerTransport` in stateless mode. For production use with multiple concurrent clients, consider adding session management.

4. **Swagger UI React types**: The `swagger-ui-react` package doesn't ship TypeScript declarations. A manual `.d.ts` file is included at `ui/src/swagger-ui-react.d.ts` — update if you use additional Swagger UI props.

5. **Frontend spec discovery**: The frontend `fetchSpecs` function parses an HTML directory listing from `/openapi/specs/`. A cleaner approach would be a dedicated REST endpoint returning the spec list as JSON. The backend already has `discoverSpecs()` — could expose it at `/openapi/specs/list`.

6. **Auth middleware body parsing**: The auth middleware reads the JSON body to check for write tools on read-only tokens. With the switch to `WebStandardStreamableHTTPServerTransport`, the body read in middleware may consume the request body before the MCP handler sees it. This needs testing with actual MCP requests in production auth mode.

## Not Ported

- The Python `proxmox_enriched.yaml` (168KB generated file) was removed since it's a build artifact. Re-generate it by running `bun run scripts/proxmoxEnrich.ts` with access to the Proxmox API.
