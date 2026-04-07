import type { QueryResult, DocumentResult } from "#types/store";

export interface SearchResult {
	id: string;
	method: string;
	path: string;
	name: string;
	api: string;
	type: string;
	operation_id: string;
	tags: string;
	description: string;
	score: number;
	full_text: string;
	response_schema: string;
	warnings?: string;
}

function extractDescription(fullText: string): string {
	const lines = fullText.split("\n");
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		if (/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\//.test(trimmed)) continue;
		if (/^Summary:\s*/i.test(trimmed)) {
			const val = trimmed.replace(/^Summary:\s*/i, "").trim();
			if (val && !val.match(/^[a-z]+([A-Z][a-z]+)+$/)) return val;
			continue;
		}
		if (/^Tags?:\s*/i.test(trimmed)) continue;
		if (/^Description:\s*/i.test(trimmed)) {
			return trimmed.replace(/^Description:\s*/i, "").slice(0, 200);
		}
		if (trimmed.length > 10) return trimmed.slice(0, 200);
	}
	return lines.find((l) => l.trim().length > 0)?.trim().slice(0, 200) ?? "";
}

export function formatQueryResult(r: QueryResult): SearchResult {
	const m = r.metadata;
	const fullText = m.full_text ?? r.text;
	const firstTag = (m.tags ?? "").split(",")[0]?.trim() ?? "";
	return {
		id: r.id,
		method: m.method ?? "",
		path: m.path ?? "",
		name: m.name ?? "",
		api: m.api ?? "",
		type: m.type ?? "endpoint",
		operation_id: m.operation_id ?? "",
		tags: m.tags ?? "",
		description: extractDescription(fullText),
		score: Math.max(0, Math.round((1 - (r.distance ?? 0) / 2) * 100) / 100),
		full_text: fullText,
		response_schema: m.response_schema ?? "",
		warnings: m.warnings ?? "",
	};
}

export function formatDocResult(r: DocumentResult): SearchResult {
	const m = r.metadata;
	const fullText = m.full_text ?? r.text;
	return {
		id: r.id,
		method: m.method ?? "",
		path: m.path ?? "",
		name: m.name ?? "",
		api: m.api ?? "",
		type: m.type ?? "endpoint",
		operation_id: m.operation_id ?? "",
		tags: m.tags ?? "",
		description: extractDescription(fullText),
		score: 1,
		full_text: fullText,
		response_schema: m.response_schema ?? "",
		warnings: m.warnings ?? "",
	};
}

export function formatFirstTag(tags: string): string {
	return tags.split(",")[0]?.trim() ?? "";
}
