import SpecStore from "./store";
import { loadSpec, parseSpecContent, extractEndpoints, extractSchemas } from "./parser";
import { endpointToDocument, schemaToDocument } from "./chunker";
import type { ApiInfo, DocumentResult, IngestSummary, QueryResult } from "#types/store";

export interface ProgressEvent {
	phase: "parsing" | "parsed" | "deleting" | "embedding" | "storing" | "done";
	message: string;
	done?: number;
	total?: number;
}

// ---------------------------------------------------------------------------
// Retriever
// ---------------------------------------------------------------------------

export default class Retriever {
	#store: SpecStore;

	constructor(store?: SpecStore) {
		this.#store = store ?? new SpecStore();
	}

	// ------------------------------------------------------------------
	// Ingest
	// ------------------------------------------------------------------

	async ingest(
		source: string,
		apiName: string,
		onProgress?: (event: ProgressEvent) => void,
	): Promise<IngestSummary> {
		onProgress?.({ phase: "parsing", message: "Loading spec..." });
		const spec = await loadSpec(source);
		const endpoints = extractEndpoints(spec);
		const schemas = extractSchemas(spec);
		onProgress?.({ phase: "parsed", message: `Found ${endpoints.length} endpoints, ${schemas.length} schemas` });

		const endpointDocs = endpoints.map((e) => endpointToDocument(e, apiName));
		const schemaDocs = schemas.map((s) => schemaToDocument(s, apiName));
		const allDocs = [...endpointDocs, ...schemaDocs];

		onProgress?.({ phase: "deleting", message: "Removing old data..." });
		await this.#store.deleteApi(apiName);

		await this.#store.upsert(allDocs, (done, total, storePhase) => {
			onProgress?.({ phase: storePhase, message: `${storePhase === "embedding" ? "Embedding" : "Storing"} ${done}/${total}`, done, total });
		});

		const summary = { api: apiName, endpointsIngested: endpointDocs.length, schemasIngested: schemaDocs.length, total: allDocs.length };
		onProgress?.({ phase: "done", message: `Done — ${summary.endpointsIngested} endpoints, ${summary.schemasIngested} schemas` });
		return summary;
	}

	async ingestContent(
		raw: string,
		format: "yaml" | "json",
		apiName: string,
		onProgress?: (event: ProgressEvent) => void,
	): Promise<IngestSummary> {
		onProgress?.({ phase: "parsing", message: "Parsing spec..." });
		const spec = await parseSpecContent(raw, format);
		const endpoints = extractEndpoints(spec);
		const schemas = extractSchemas(spec);
		onProgress?.({ phase: "parsed", message: `Found ${endpoints.length} endpoints, ${schemas.length} schemas` });

		const endpointDocs = endpoints.map((e) => endpointToDocument(e, apiName));
		const schemaDocs = schemas.map((s) => schemaToDocument(s, apiName));
		const allDocs = [...endpointDocs, ...schemaDocs];

		onProgress?.({ phase: "deleting", message: "Removing old data..." });
		await this.#store.deleteApi(apiName);

		await this.#store.upsert(allDocs, (done, total, storePhase) => {
			onProgress?.({ phase: storePhase, message: `${storePhase === "embedding" ? "Embedding" : "Storing"} ${done}/${total}`, done, total });
		});

		const summary = { api: apiName, endpointsIngested: endpointDocs.length, schemasIngested: schemaDocs.length, total: allDocs.length };
		onProgress?.({ phase: "done", message: `Done — ${summary.endpointsIngested} endpoints, ${summary.schemasIngested} schemas` });
		return summary;
	}

	// ------------------------------------------------------------------
	// Search
	// ------------------------------------------------------------------

	async searchEndpoints(
		query: string,
		api?: string,
		method?: string,
		tag?: string,
		n: number = 2,
		maxDistance: number = MAX_DISTANCE,
	): Promise<QueryResult[]> {
		const where = buildWhere({ type: "endpoint", api, method });
		let results = await this.#store.query(query, n * 3, where ?? undefined);
		results = results.filter((r) => (r.distance ?? 1) <= maxDistance);
		if (tag) {
			const tagLower = tag.toLowerCase();
			results = results.filter(
				(r) => r.metadata.tags?.toLowerCase().includes(tagLower)
			);
		}
		return results.slice(0, n);
	}

	async searchSchemas(
		query: string,
		api?: string,
		n: number = 2,
		maxDistance: number = MAX_DISTANCE,
	): Promise<QueryResult[]> {
		const where = buildWhere({ type: "schema", api });
		let results = await this.#store.query(query, n * 3, where ?? undefined);
		results = results.filter((r) => (r.distance ?? 1) <= maxDistance);
		return results.slice(0, n);
	}

	async getEndpoint(
		path: string,
		method: string,
		api?: string,
	): Promise<DocumentResult | null> {
		if (api) {
			const docId = `${api}:endpoint:${method.toUpperCase()}:${path}`;
			return this.#store.getById(docId);
		}

		const where = {
			$and: [
				{ type: "endpoint" },
				{ method: method.toUpperCase() },
				{ path },
			],
		};
		const results = await this.#store.query(`${method.toUpperCase()} ${path}`, 1, where);
		return results[0] ?? null;
	}

	// ------------------------------------------------------------------
	// Metadata
	// ------------------------------------------------------------------

	async deleteApi(apiName: string): Promise<void> {
		await this.#store.deleteApi(apiName);
	}

	async listApis(): Promise<ApiInfo[]> {
		return this.#store.listApis();
	}

	async listEndpoints(apiName: string): Promise<DocumentResult[]> {
		const docs = await this.#store.getAll(apiName);
		return docs.filter((d) => d.metadata.type === "endpoint");
	}
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_DISTANCE = 0.75;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface WhereFilters {
	type?: string;
	api?: string;
	method?: string;
}

function buildWhere(filters: WhereFilters): Record<string, unknown> | null {
	const clauses: Record<string, string>[] = [];

	if (filters.type) clauses.push({ type: filters.type });
	if (filters.api) clauses.push({ api: filters.api });
	if (filters.method) clauses.push({ method: filters.method.toUpperCase() });

	if (clauses.length === 0) return null;
	if (clauses.length === 1) return clauses[0];
	return { $and: clauses };
}
