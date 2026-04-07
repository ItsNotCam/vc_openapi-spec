import type { Endpoint, SchemaDefinition } from "#types/openapi";
import type { Document } from "#types/store";

// ---------------------------------------------------------------------------
// Endpoint → Document
// ---------------------------------------------------------------------------

export function endpointToDocument(endpoint: Endpoint, apiName: string): Document {
	const { method, path } = endpoint;
	const docId = `${apiName}:endpoint:${method}:${path}`;

	// ── Full text (stored in metadata, used for display) ───────────
	const fullLines: string[] = [`${method} ${path}`];

	if (endpoint.summary) {
		fullLines.push(`Summary: ${endpoint.summary}`);
	}
	if (endpoint.tags.length > 0) {
		fullLines.push(`Tags: ${endpoint.tags.join(", ")}`);
	}
	if (endpoint.description) {
		fullLines.push(`Description: ${endpoint.description}`);
	}
	if (endpoint.operationId) {
		fullLines.push(`Operation ID: ${endpoint.operationId}`);
	}

	const params = endpoint.parameters ?? [];
	if (params.length > 0) {
		fullLines.push("Parameters:");
		for (const p of params) {
			if (!p || typeof p !== "object") continue;
			const name = p.name ?? "?";
			const location = p.in ?? "";
			const required = p.required ? "required" : "optional";
			const schema = (p.schema ?? {}) as Record<string, unknown>;
			const ptype = (schema.type as string) ?? p.type ?? "";
			const desc = p.description ?? (schema.description as string) ?? "";
			let line = `  - ${name} (${location}, ${required})`;
			if (ptype) line += `: ${ptype}`;
			if (desc) line += ` — ${desc}`;
			fullLines.push(line);
		}
	}

	const reqBody = endpoint.requestBody;
	if (reqBody && typeof reqBody === "object") {
		fullLines.push("Request Body:");
		if (reqBody.description) {
			fullLines.push(`  ${reqBody.description}`);
		}
		const content = reqBody.content ?? {};
		for (const [mediaType, mediaObj] of Object.entries(content)) {
			if (!mediaObj || typeof mediaObj !== "object") continue;
			const schema = mediaObj.schema ?? {};
			fullLines.push(`  (${mediaType}): ${schemaSummary(schema)}`);
		}
	}

	const responses = endpoint.responses ?? {};
	if (Object.keys(responses).length > 0) {
		fullLines.push("Responses:");
		for (const [status, resp] of Object.entries(responses)) {
			if (!resp || typeof resp !== "object") continue;
			const desc = resp.description ?? "";
			const content = resp.content ?? {};
			let schemaStr = "";
			let fullSchemaStr = "";
			for (const mediaObj of Object.values(content)) {
				if (mediaObj && typeof mediaObj === "object") {
					const schema = mediaObj.schema ?? {};
					schemaStr = schemaSummary(schema);
					fullSchemaStr = fullSchemaToStr(schema);
					break;
				}
			}
			let line = `  ${status}: ${desc}`;
			if (schemaStr) line += ` — ${schemaStr}`;
			fullLines.push(line);
			if (fullSchemaStr && fullSchemaStr !== schemaStr) {
				fullLines.push(`    Schema: ${fullSchemaStr}`);
			}
		}
	}

	const fullText = fullLines.join("\n");

	// ── Embedding text (short, semantic) ──────────────────────────
	const embedParts: string[] = [`${method} ${path}`];
	// Skip summaries that just repeat the method+path (e.g. "GET /devices")
	const summaryIsRedundant = endpoint.summary &&
		/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\//i.test(endpoint.summary.trim());
	if (endpoint.summary && !summaryIsRedundant) embedParts.push(endpoint.summary);
	if (endpoint.tags.length > 0) embedParts.push(endpoint.tags.join(", "));
	if (endpoint.description) {
		// Use more description text when summary is missing or redundant
		const maxSentences = (!endpoint.summary || summaryIsRedundant) ? 3 : 1;
		const sentences = endpoint.description.split(/\.\s/).slice(0, maxSentences);
		embedParts.push(sentences.join(". ").trim());
	}
	if (params.length > 0) {
		const paramNames = params
			.filter((p): p is typeof p & { name: string } => typeof p === "object" && !!p.name)
			.map((p) => p.name);
		if (paramNames.length > 0) {
			embedParts.push(`params: ${paramNames.join(", ")}`);
		}
	}
	if (endpoint.operationId) embedParts.push(endpoint.operationId);
	if (reqBody && typeof reqBody === "object") {
		const content = reqBody.content ?? {};
		for (const mediaObj of Object.values(content)) {
			if (mediaObj?.schema?.properties) {
				embedParts.push(`body: ${Object.keys(mediaObj.schema.properties).join(", ")}`);
				break;
			}
		}
	}
	const embedText = embedParts.join("\n");

	// ── Metadata ──────────────────────────────────────────────────
	const metadata: Record<string, string> = {
		type: "endpoint",
		method,
		path,
		api: apiName,
		full_text: fullText,
	};
	if (endpoint.operationId) metadata.operation_id = endpoint.operationId;
	if (endpoint.tags.length > 0) metadata.tags = endpoint.tags.join(", ");

	// Store full response schema for exact lookups
	for (const [status, resp] of Object.entries(responses)) {
		if (String(status).startsWith("2") && resp && typeof resp === "object") {
			const content = resp.content ?? {};
			for (const mediaObj of Object.values(content)) {
				if (mediaObj && typeof mediaObj === "object") {
					const schema = fullSchemaToStr(mediaObj.schema ?? {});
					if (schema) metadata.response_schema = schema;
				}
			}
			break;
		}
	}

	// Store full request schema
	if (reqBody && typeof reqBody === "object") {
		const content = reqBody.content ?? {};
		for (const mediaObj of Object.values(content)) {
			if (mediaObj && typeof mediaObj === "object") {
				const schema = fullSchemaToStr(mediaObj.schema ?? {});
				if (schema) metadata.request_schema = schema;
				break;
			}
		}
	}

	// Pre-build compact medium_text for LLM consumption
	metadata.medium_text = buildMediumText(endpoint, metadata);

	// Store stability flag — true if explicitly deprecated or tagged/pathed as unstable/beta
	const UNSTABLE_PATTERNS = /\b(unstable|beta|experimental|preview|alpha|deprecated)\b/i;
	const isDeprecated = endpoint.deprecated === true
		|| endpoint.tags.some(t => UNSTABLE_PATTERNS.test(t))
		|| UNSTABLE_PATTERNS.test(path);
	if (isDeprecated) metadata.deprecated = "true";

	// Generate warnings for non-obvious endpoint traits
	const warnings = generateWarnings(endpoint);
	if (warnings.length > 0) metadata.warnings = warnings.join("|");

	return [docId, embedText, metadata];
}

// ---------------------------------------------------------------------------
// Schema → Document
// ---------------------------------------------------------------------------

export function schemaToDocument(schema: SchemaDefinition, apiName: string): Document {
	const { name } = schema;
	const docId = `${apiName}:schema:${name}`;

	// ── Full text (stored in metadata, used for display) ───────────
	const fullLines: string[] = [`Schema: ${name}`];
	if (schema.description) fullLines.push(`Description: ${schema.description}`);
	if (schema.schemaType) fullLines.push(`Type: ${schema.schemaType}`);
	if (schema.enum) {
		fullLines.push(`Enum values: ${schema.enum.map(String).join(", ")}`);
	}

	const props = schema.properties ?? {};
	const requiredSet = new Set(schema.required ?? []);
	if (Object.keys(props).length > 0) {
		fullLines.push("Properties:");
		for (const [propName, propSchema] of Object.entries(props)) {
			if (!propSchema || typeof propSchema !== "object") continue;
			const req = requiredSet.has(propName) ? "required" : "optional";
			const ptype = (propSchema.type as string) ?? "";
			const desc = (propSchema.description as string) ?? "";
			const enumVals = propSchema.enum as unknown[] | undefined;
			let line = `  - ${propName} (${ptype}, ${req})`;
			if (desc) line += `: ${desc}`;
			if (enumVals) line += ` — one of: ${enumVals.map(String).join(", ")}`;
			fullLines.push(line);
		}
	}

	const fullText = fullLines.join("\n");

	// ── Embedding text (short, semantic) ──────────────────────────
	const embedParts: string[] = [`Schema: ${name}`];
	if (schema.description) {
		const firstSentence = schema.description.split(". ")[0].split(".\n")[0];
		embedParts.push(firstSentence);
	}
	if (schema.schemaType) embedParts.push(`Type: ${schema.schemaType}`);
	if (schema.enum) {
		embedParts.push(`Enum: ${schema.enum.map(String).slice(0, 10).join(", ")}`);
	}
	const propNames = Object.keys(props);
	if (propNames.length > 0) {
		embedParts.push(`Properties: ${propNames.join(", ")}`);
	}
	const embedText = embedParts.join("\n");

	const metadata: Record<string, string> = {
		type: "schema",
		name,
		api: apiName,
		full_text: fullText,
	};

	return [docId, embedText, metadata];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// Build a simplified JSON-like object representing the schema shape.
// Returns a serializable object so the frontend can JSON.stringify(schema, null, 2).
function schemaToShape(schema: unknown, depth: number = 0): unknown {
	if (!schema || typeof schema !== "object" || depth > 8) return null;

	const s = schema as Record<string, unknown>;
	const stype = (s.type as string) ?? "";

	if (stype === "array") {
		const itemShape = schemaToShape(s.items, depth + 1);
		return itemShape != null ? [itemShape] : ["unknown"];
	}
	if (stype === "object" || s.properties) {
		const props = (s.properties ?? {}) as Record<string, unknown>;
		if (Object.keys(props).length === 0) return {};
		const obj: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(props)) {
			obj[k] = schemaToShape(v, depth + 1) ?? (stype || "unknown");
		}
		return obj;
	}
	if (stype) return stype;

	for (const combiner of ["allOf", "oneOf", "anyOf"] as const) {
		const parts = s[combiner] as unknown[] | undefined;
		if (parts) {
			const summaries = parts
				.filter((p): p is Record<string, unknown> => typeof p === "object" && p !== null)
				.map((p) => schemaToShape(p, depth + 1))
				.filter(Boolean);
			if (summaries.length === 1) return summaries[0];
			return { [`${combiner}`]: summaries };
		}
	}

	return null;
}

function fullSchemaToStr(schema: unknown, depth: number = 0): string {
	const shape = schemaToShape(schema, depth);
	if (shape == null) return "";
	if (typeof shape === "string") return shape;
	try {
		return JSON.stringify(shape, null, 2);
	} catch {
		return "";
	}
}

// ---------------------------------------------------------------------------
// Medium text helpers
// ---------------------------------------------------------------------------

const TYPE_ABBREV: Record<string, string> = {
	string: "str", integer: "int", boolean: "bool", number: "num", object: "obj", array: "arr",
};

function abbreviateType(t: string): string {
	const lower = t.toLowerCase();
	if (TYPE_ABBREV[lower]) return TYPE_ABBREV[lower];
	const arrMatch = lower.match(/^array\s+of\s+(.+)/);
	if (arrMatch) return `${abbreviateType(arrMatch[1])}[]`;
	return t;
}

function abbreviateSchema(fullSchemaStr: string, maxFields: number): string {
	if (!fullSchemaStr) return "";
	try {
		const parsed = JSON.parse(fullSchemaStr);
		if (typeof parsed !== "object" || parsed === null) {
			return abbreviateType(String(parsed));
		}
		return abbreviateObj(parsed, maxFields, 0);
	} catch {
		return fullSchemaStr.slice(0, 120);
	}
}

function abbreviateObj(obj: unknown, maxFields: number, depth: number): string {
	if (depth > 2) return "obj";
	if (Array.isArray(obj)) {
		const item = obj[0];
		if (item == null) return "arr";
		if (typeof item === "string") return `${abbreviateType(item)}[]`;
		return `${abbreviateObj(item, maxFields, depth + 1)}[]`;
	}
	if (typeof obj === "string") return abbreviateType(obj);
	if (typeof obj !== "object" || obj === null) return "obj";

	const entries = Object.entries(obj as Record<string, unknown>);
	if (entries.length === 0) return "obj";
	const shown = entries.slice(0, maxFields);
	const parts = shown.map(([k, v]) => `${k}:${abbreviateObj(v, maxFields, depth + 1)}`);
	const suffix = entries.length > maxFields ? `, ...+${entries.length - maxFields}` : "";
	return `{${parts.join(", ")}${suffix}}`;
}

function buildMediumText(endpoint: Endpoint, metadata: Record<string, string>): string {
	const lines: string[] = [];

	// Line 1: op + tags
	const opParts: string[] = [];
	if (endpoint.operationId) opParts.push(`op: ${endpoint.operationId}`);
	if (endpoint.tags.length > 0) opParts.push(`tags: ${endpoint.tags.join(", ")}`);
	if (opParts.length > 0) lines.push(opParts.join(" | "));

	// Line 2: summary
	if (endpoint.summary) lines.push(endpoint.summary);

	// Line 3: params
	const params = endpoint.parameters ?? [];
	if (params.length > 0) {
		const locAbbrev: Record<string, string> = { query: "q", path: "p", header: "h", cookie: "c" };
		const MAX_PARAMS = 8;
		const shown = params.slice(0, MAX_PARAMS);
		const paramParts = shown
			.filter((p): p is typeof p & { name: string } => typeof p === "object" && !!p.name)
			.map((p) => {
				const loc = locAbbrev[p.in ?? ""] ?? p.in ?? "";
				const req = p.required ? "req" : "opt";
				const schema = (p.schema ?? {}) as Record<string, unknown>;
				const ptype = abbreviateType((schema.type as string) ?? p.type ?? "");
				return `${p.name}(${loc},${req})${ptype ? `:${ptype}` : ""}`;
			});
		const suffix = params.length > MAX_PARAMS ? ` ...+${params.length - MAX_PARAMS} more` : "";
		if (paramParts.length > 0) lines.push(`params: ${paramParts.join(", ")}${suffix}`);
	}

	// Line 4: request body
	if (metadata.request_schema) {
		lines.push(`body: ${abbreviateSchema(metadata.request_schema, 10)}`);
	} else {
		const reqBody = endpoint.requestBody;
		if (reqBody && typeof reqBody === "object") {
			const content = reqBody.content ?? {};
			for (const mediaObj of Object.values(content)) {
				if (mediaObj && typeof mediaObj === "object") {
					const s = schemaSummary(mediaObj.schema ?? {});
					if (s) lines.push(`body: ${s}`);
					break;
				}
			}
		}
	}

	// Line 5: response (2xx only)
	if (metadata.response_schema) {
		lines.push(`resp: ${abbreviateSchema(metadata.response_schema, 15)}`);
	}

	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Warning generation
// ---------------------------------------------------------------------------

const STANDARD_HEADERS = new Set(["accept", "content-type", "authorization", "user-agent"]);
const PAGINATION_PARAMS = new Set(["limit", "offset", "cursor", "page", "page_size", "pagesize", "per_page", "perpage", "after", "before"]);

// Fields where the name suggests a non-numeric type but the spec says otherwise
const COUNTERINTUITIVE_TYPES: [RegExp, string, string][] = [
	[/risk|threat|severity|priority|level|score|rating/i, "string", "is numeric, not string enum"],
	[/risk|threat|severity|priority|level|score|rating/i, "integer", "is integer, not string enum"],
	[/count|total|amount|size|length|quantity/i, "string", "is stored as string, not number"],
	[/enabled|active|disabled|visible|hidden/i, "string", "is string, not boolean"],
	[/enabled|active|disabled|visible|hidden/i, "integer", "is integer, not boolean"],
	[/date|time|timestamp|created|updated|expires/i, "integer", "is epoch integer, not ISO date string"],
	[/id$/i, "integer", "is integer, not string"],
	[/port/i, "string", "is string, not integer"],
];

function generateWarnings(endpoint: Endpoint): string[] {
	const warnings: string[] = [];
	const params = endpoint.parameters ?? [];
	const schemes = endpoint.securitySchemes ?? {};
	const security = endpoint.security ?? [];

	// ── Auth warnings ─────────────────────────────────────────────
	// Check securitySchemes for non-Bearer auth
	const activeSchemeNames = new Set(security.flatMap((s) => Object.keys(s)));
	for (const [name, scheme] of Object.entries(schemes)) {
		if (!activeSchemeNames.has(name) && activeSchemeNames.size > 0) continue;
		if (scheme.type === "apiKey") {
			warnings.push(`Auth: uses ${scheme.name ?? name} ${scheme.in ?? "header"}, not Bearer token`);
		} else if (scheme.type === "oauth2") {
			const flows = scheme.flows ?? {};
			const flowNames = Object.keys(flows);
			const tokenUrl = Object.values(flows).find((f) => f.tokenUrl)?.tokenUrl;
			const detail = tokenUrl ? ` via ${tokenUrl}` : "";
			warnings.push(`Auth: OAuth 2.0 (${flowNames.join("/")}${detail}), not Bearer API key`);
		} else if (scheme.type === "http" && scheme.scheme && scheme.scheme !== "bearer") {
			warnings.push(`Auth: uses HTTP ${scheme.scheme}, not Bearer token`);
		}
	}

	// Non-standard auth headers in parameters (fallback for specs without securitySchemes)
	const headerParams = params.filter((p) => p.in === "header");
	if (activeSchemeNames.size === 0) {
		const authLikeHeaders = headerParams.filter((p) => {
			const name = (p.name ?? "").toLowerCase();
			return !STANDARD_HEADERS.has(name) && (name.includes("key") || name.includes("token") || name.includes("auth") || name.includes("secret"));
		});
		if (authLikeHeaders.length > 0) {
			warnings.push(`Auth: uses ${authLikeHeaders.map((p) => p.name).join(", ")} header, not Bearer token`);
		}
	}

	// ── Pagination warnings ───��───────────────────────────────────
	const paginationParams = params.filter((p) => PAGINATION_PARAMS.has((p.name ?? "").toLowerCase()));
	if (paginationParams.length > 0) {
		const limitParam = paginationParams.find((p) => (p.name ?? "").toLowerCase() === "limit" || (p.name ?? "").toLowerCase() === "page_size" || (p.name ?? "").toLowerCase() === "per_page");
		const schema = (limitParam?.schema ?? {}) as Record<string, unknown>;
		const maxVal = schema.maximum as number | undefined;
		const hasCursor = paginationParams.some((p) => (p.name ?? "").toLowerCase() === "cursor" || (p.name ?? "").toLowerCase() === "after");
		if (maxVal) {
			warnings.push(`Max ${maxVal} results per page${hasCursor ? ", use cursor for pagination" : ""}`);
		} else {
			warnings.push(`Pagination: uses ${paginationParams.map((p) => p.name).join("/")} parameters`);
		}
	}

	// ── Required non-standard headers ─────────────────────────────
	const requiredHeaders = headerParams.filter((p) => p.required && !STANDARD_HEADERS.has((p.name ?? "").toLowerCase()));
	if (requiredHeaders.length > 0) {
		warnings.push(`Required header${requiredHeaders.length > 1 ? "s" : ""}: ${requiredHeaders.map((p) => p.name).join(", ")}`);
	}

	// ── Rate limits ─────��─────────────────────────────────────────
	if (endpoint.rateLimits?.limit) {
		warnings.push(`Rate limit: ${endpoint.rateLimits.limit} ${endpoint.rateLimits.unit ?? "req/min"}`);
	}

	// ── Counterintuitive field types ───���──────────────────────────
	const allSchemas = collectFieldSchemas(endpoint);
	for (const [fieldName, fieldType] of allSchemas) {
		for (const [pattern, triggerType, message] of COUNTERINTUITIVE_TYPES) {
			if (pattern.test(fieldName) && fieldType === triggerType) {
				warnings.push(`${fieldName} ${message}`);
				break;
			}
		}
	}

	return warnings;
}

/** Collect [fieldName, type] pairs from request body and response schemas. */
function collectFieldSchemas(endpoint: Endpoint): [string, string][] {
	const fields: [string, string][] = [];

	function walkProperties(schema: unknown, depth: number) {
		if (!schema || typeof schema !== "object" || depth > 4) return;
		const s = schema as Record<string, unknown>;

		const props = (s.properties ?? {}) as Record<string, Record<string, unknown>>;
		for (const [name, propSchema] of Object.entries(props)) {
			if (!propSchema || typeof propSchema !== "object") continue;
			const ptype = (propSchema.type as string) ?? "";
			if (ptype) fields.push([name, ptype]);
			walkProperties(propSchema, depth + 1);
		}

		// Walk into array items
		if (s.items && typeof s.items === "object") {
			walkProperties(s.items, depth + 1);
		}
	}

	// Request body schemas
	const reqContent = endpoint.requestBody?.content ?? {};
	for (const mediaObj of Object.values(reqContent)) {
		if (mediaObj?.schema) walkProperties(mediaObj.schema, 0);
	}

	// Response schemas (2xx only)
	for (const [status, resp] of Object.entries(endpoint.responses ?? {})) {
		if (!String(status).startsWith("2")) continue;
		const content = resp?.content ?? {};
		for (const mediaObj of Object.values(content)) {
			if (mediaObj?.schema) walkProperties(mediaObj.schema, 0);
		}
	}

	return fields;
}

function schemaSummary(schema: unknown, depth: number = 0): string {
	if (!schema || typeof schema !== "object" || depth > 2) return "";

	const s = schema as Record<string, unknown>;
	const stype = (s.type as string) ?? "";

	if (stype === "array") {
		const items = s.items ?? {};
		return `array of ${schemaSummary(items, depth + 1)}`;
	}
	if (stype === "object" || s.properties) {
		const props = (s.properties ?? {}) as Record<string, unknown>;
		if (Object.keys(props).length === 0) return "object";
		const keys = Object.keys(props);
		const preview = keys.slice(0, 6).join(", ");
		const suffix = keys.length > 6 ? ", ..." : "";
		return `{ ${preview}${suffix} }`;
	}
	if (stype) return stype;

	for (const combiner of ["allOf", "oneOf", "anyOf"] as const) {
		const parts = s[combiner] as unknown[] | undefined;
		if (parts) {
			const summaries = parts
				.filter((p): p is Record<string, unknown> => typeof p === "object" && p !== null)
				.map((p) => schemaSummary(p, depth + 1))
				.filter(Boolean);
			return `${combiner}(${summaries.join(", ")})`;
		}
	}

	return JSON.stringify(schema).slice(0, 80);
}
