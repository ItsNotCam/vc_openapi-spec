"use server";

import { getRetriever } from "@/lib/retriever";
import { formatQueryResult, formatDocResult, type SearchResult } from "@/lib/formatters";

export async function searchEndpoints(query: string, api?: string, limit = 10): Promise<SearchResult[]> {
	const results = await getRetriever().searchEndpoints(query, api, undefined, undefined, limit);
	return results.map(formatQueryResult);
}

export async function searchSchemas(query: string, api?: string, limit = 10): Promise<SearchResult[]> {
	const results = await getRetriever().searchSchemas(query, api, limit);
	return results.map(formatQueryResult);
}

export async function getEndpoint(method: string, path: string, api?: string): Promise<SearchResult | null> {
	const result = await getRetriever().getEndpoint(path, method, api);
	if (!result) return null;
	return formatDocResult(result);
}

export async function listEndpoints(api: string): Promise<SearchResult[]> {
	const docs = await getRetriever().listEndpoints(api);
	return docs.map(formatDocResult);
}
