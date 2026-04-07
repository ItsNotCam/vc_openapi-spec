import fs from "fs/promises";
import path from "path";
import $RefParser from "@apidevtools/json-schema-ref-parser";
import YAML from "yaml";

import { SpecLoadError } from "./errors";
import type { Endpoint, Parameter, SchemaDefinition } from "#types/openapi";

// ---------------------------------------------------------------------------
// Security constraints
// ---------------------------------------------------------------------------

const MAX_SPEC_SIZE = 50 * 1024 * 1024; // 50 MB
const MAX_REDIRECTS = 5;
const MAX_YAML_ALIASES = -1; // unlimited — large specs (e.g. MikroTik) use many aliases for $ref deduplication
const ALLOWED_EXTENSIONS = new Set([".json", ".yaml", ".yml"]);

// ---------------------------------------------------------------------------
// Spec Loading
// ---------------------------------------------------------------------------

export async function loadSpec(source: string): Promise<Record<string, unknown>> {
	let data: Record<string, unknown>;

	try {
		if (source.startsWith("http://") || source.startsWith("https://")) {
			data = await loadFromUrl(source);
		} else {
			data = await loadFromFile(source);
		}
	} catch (err: unknown) {
		if (err instanceof SpecLoadError) throw err;
		const message = err instanceof Error ? err.message : String(err);
		throw new SpecLoadError(source, message);
	}

	sanitizeObject(data);

	try {
		// Disable external resolution — $ref to file/URL paths would bypass all
		// SSRF and path-traversal checks since $RefParser fetches independently.
		const resolved = await $RefParser.dereference(data, {
			resolve: { file: false, http: false },
		});
		return resolved as Record<string, unknown>;
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		throw new SpecLoadError(source, `$ref resolution failed: ${message}`);
	}
}

export async function parseSpecContent(
	raw: string,
	format: "yaml" | "json",
): Promise<Record<string, unknown>> {
	if (raw.length > MAX_SPEC_SIZE) {
		throw new SpecLoadError("<upload>", `content too large (${raw.length} bytes, max ${MAX_SPEC_SIZE})`);
	}

	const data: Record<string, unknown> =
		format === "json"
			? JSON.parse(raw)
			: YAML.parse(raw, { maxAliasCount: MAX_YAML_ALIASES });

	sanitizeObject(data);

	try {
		const resolved = await $RefParser.dereference(data, {
			resolve: { file: false, http: false },
		});
		return resolved as Record<string, unknown>;
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		throw new SpecLoadError("<upload>", `$ref resolution failed: ${message}`);
	}
}

// ---------------------------------------------------------------------------
// URL loading (with SSRF protection)
// ---------------------------------------------------------------------------

function isPrivateHost(hostname: string): boolean {
	// Normalize — URL.hostname includes brackets for IPv6 in some runtimes
	const host = hostname.startsWith("[") && hostname.endsWith("]")
		? hostname.slice(1, -1)
		: hostname;

	if (/^localhost$/i.test(host) || host.endsWith(".localhost")) return true;

	// IPv4
	const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (v4) {
		const [a, b] = [Number(v4[1]), Number(v4[2])];
		return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
	}

	// IPv6 loopback / unspecified
	const norm = host.toLowerCase();
	if (norm === "::1" || norm === "::" ||
		norm === "0:0:0:0:0:0:0:1" || norm === "0:0:0:0:0:0:0:0") return true;
	// fe80::/10 link-local, fc00::/7 unique-local
	if (norm.startsWith("fe80") || norm.startsWith("fc") || norm.startsWith("fd")) return true;

	// IPv4-mapped IPv6 (::ffff:x.x.x.x)
	const mapped = norm.match(/^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (mapped) {
		const [a, b] = [Number(mapped[1]), Number(mapped[2])];
		return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
	}

	return false;
}

function assertSafeUrl(source: string): URL {
	const url = new URL(source);

	if (url.protocol !== "http:" && url.protocol !== "https:") {
		console.warn(`[security] blocked disallowed protocol: ${url.protocol} src=${source}`);
		throw new SpecLoadError(source, "only http and https URLs are allowed");
	}

	if (url.username || url.password) {
		console.warn(`[security] blocked URL with embedded credentials src=${source}`);
		throw new SpecLoadError(source, "URLs with embedded credentials are not allowed");
	}

	if (isPrivateHost(url.hostname)) {
		console.warn(`[security] blocked SSRF attempt to private host=${url.hostname} src=${source}`);
		throw new SpecLoadError(source, "requests to private/internal network addresses are not allowed");
	}

	return url;
}

async function loadFromUrl(source: string): Promise<Record<string, unknown>> {
	// Follow redirects manually so each hop is validated against the SSRF blocklist.
	// `redirect: "follow"` would let the initial URL pass then redirect to 169.254.x.
	let url = source;
	let response: Response | undefined;

	for (let i = 0; i <= MAX_REDIRECTS; i++) {
		assertSafeUrl(url);
		response = await fetch(url, {
			signal: AbortSignal.timeout(30000),
			redirect: "manual",
		});

		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get("location");
			if (!location) throw new SpecLoadError(source, "redirect with no Location header");
			url = new URL(location, url).toString();
			console.warn(`[security] following redirect hop=${i + 1} target=${url} src=${source}`);
			continue;
		}
		break;
	}

	if (!response || (response.status >= 300 && response.status < 400)) {
		console.warn(`[security] blocked redirect chain — exceeded max=${MAX_REDIRECTS} src=${source}`);
		throw new SpecLoadError(source, `too many redirects (max ${MAX_REDIRECTS})`);
	}
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} ${response.statusText}`);
	}

	const contentLength = Number(response.headers.get("content-length") ?? "0");
	if (contentLength > MAX_SPEC_SIZE) {
		console.warn(`[security] blocked oversized response content-length=${contentLength} src=${source}`);
		throw new SpecLoadError(source, `response too large (${contentLength} bytes, max ${MAX_SPEC_SIZE})`);
	}

	const raw = await response.text();
	if (raw.length > MAX_SPEC_SIZE) {
		console.warn(`[security] blocked oversized response body=${raw.length} src=${source}`);
		throw new SpecLoadError(source, `response too large (${raw.length} bytes, max ${MAX_SPEC_SIZE})`);
	}

	const contentType = response.headers.get("content-type") ?? "";
	if (source.endsWith(".json") || contentType.startsWith("application/json")) {
		return JSON.parse(raw);
	}
	return YAML.parse(raw, { maxAliasCount: MAX_YAML_ALIASES });
}

// ---------------------------------------------------------------------------
// File loading (with path traversal protection)
// ---------------------------------------------------------------------------

async function loadFromFile(source: string): Promise<Record<string, unknown>> {
	const resolved = path.resolve(source);
	const cwd = process.cwd();
	const specsDir = process.env.SPECS_DIR ? path.resolve(process.env.SPECS_DIR) : null;

	const withinCwd = resolved.startsWith(cwd + path.sep) || resolved === cwd;
	const withinSpecsDir = specsDir && (resolved.startsWith(specsDir + path.sep) || resolved === specsDir);

	if (!withinCwd && !withinSpecsDir) {
		console.warn(`[security] blocked path traversal resolved=${resolved} src=${source}`);
		throw new SpecLoadError(source, "path traversal detected — file must be within the working directory");
	}

	// Follow symlinks and re-check — a symlink inside cwd can target /etc/passwd
	const realPath = await fs.realpath(resolved);
	const realWithinCwd = realPath.startsWith(cwd + path.sep) || realPath === cwd;
	const realWithinSpecsDir = specsDir && (realPath.startsWith(specsDir + path.sep) || realPath === specsDir);

	if (!realWithinCwd && !realWithinSpecsDir) {
		console.warn(`[security] blocked symlink traversal realpath=${realPath} src=${source}`);
		throw new SpecLoadError(source, "symlink resolves outside working directory");
	}

	const ext = path.extname(realPath).toLowerCase();
	if (!ALLOWED_EXTENSIONS.has(ext)) {
		console.warn(`[security] blocked disallowed extension ext=${ext} src=${source}`);
		throw new SpecLoadError(source, `unsupported file extension '${ext}' (allowed: ${[...ALLOWED_EXTENSIONS].join(", ")})`);
	}

	// Use lstat on the resolved real path to ensure it's a regular file, not a device/pipe
	const stat = await fs.lstat(realPath);
	if (!stat.isFile()) {
		console.warn(`[security] blocked non-file path src=${source}`);
		throw new SpecLoadError(source, "path is not a regular file");
	}
	if (stat.size > MAX_SPEC_SIZE) {
		console.warn(`[security] blocked oversized file size=${stat.size} src=${source}`);
		throw new SpecLoadError(source, `file too large (${stat.size} bytes, max ${MAX_SPEC_SIZE})`);
	}

	const raw = await fs.readFile(realPath, "utf-8");
	if (ext === ".json") {
		return JSON.parse(raw);
	}
	return YAML.parse(raw, { maxAliasCount: MAX_YAML_ALIASES });
}

// ---------------------------------------------------------------------------
// Prototype-pollution sanitization
// ---------------------------------------------------------------------------

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function sanitizeObject(obj: unknown): void {
	if (obj === null || typeof obj !== "object") return;

	if (Array.isArray(obj)) {
		for (const item of obj) sanitizeObject(item);
		return;
	}

	const record = obj as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (DANGEROUS_KEYS.has(key)) {
			console.warn(`[security] stripped dangerous key="${key}" from parsed spec`);
			delete record[key];
		} else {
			sanitizeObject(record[key]);
		}
	}
}

// ---------------------------------------------------------------------------
// Endpoint Extraction
// ---------------------------------------------------------------------------

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options", "trace"] as const;

export function extractEndpoints(spec: Record<string, unknown>): Endpoint[] {
	const endpoints: Endpoint[] = [];
	const paths = (spec.paths ?? {}) as Record<string, Record<string, unknown>>;

	// Extract spec-level security schemes and global security
	const components = (spec.components ?? {}) as Record<string, unknown>;
	const securitySchemes = (components.securitySchemes ?? spec.securityDefinitions ?? {}) as Endpoint["securitySchemes"];
	const globalSecurity = spec.security as Record<string, unknown>[] | undefined;

	// Extract rate limit extensions if present at spec level
	const specRateLimit = extractRateLimit(spec);

	for (const [pathStr, pathItem] of Object.entries(paths)) {
		if (!pathItem || typeof pathItem !== "object") continue;

		const pathLevelParams = (pathItem.parameters ?? []) as Parameter[];

		for (const method of HTTP_METHODS) {
			const operation = pathItem[method];
			if (!operation || typeof operation !== "object") continue;

			const op = operation as Record<string, unknown>;
			const opParams = (op.parameters ?? []) as Parameter[];
			const mergedParams = mergeParameters(pathLevelParams, opParams);

			const opSecurity = (op.security as Record<string, unknown>[] | undefined) ?? globalSecurity;
			const opRateLimit = extractRateLimit(op) ?? specRateLimit;

			endpoints.push({
				method: method.toUpperCase(),
				path: pathStr,
				operationId: (op.operationId as string) ?? "",
				summary: (op.summary as string) ?? "",
				description: (op.description as string) ?? "",
				tags: (op.tags as string[]) ?? [],
				parameters: mergedParams,
				requestBody: op.requestBody as Endpoint["requestBody"],
				responses: (op.responses ?? {}) as Endpoint["responses"],
				security: opSecurity,
				securitySchemes: securitySchemes,
				rateLimits: opRateLimit ?? undefined,
				deprecated: (op.deprecated as boolean) ?? false,
			});
		}
	}

	return endpoints;
}

function extractRateLimit(obj: Record<string, unknown>): { limit?: number; unit?: string } | null {
	for (const key of Object.keys(obj)) {
		const lower = key.toLowerCase();
		if (lower.includes("ratelimit") || lower.includes("rate-limit") || lower.includes("rate_limit") || lower.includes("throttl")) {
			const val = obj[key];
			if (typeof val === "number") return { limit: val, unit: "req/min" };
			if (typeof val === "object" && val !== null) {
				const r = val as Record<string, unknown>;
				const limit = (r.limit ?? r.rate ?? r.requests ?? r.max) as number | undefined;
				const unit = (r.unit ?? r.period ?? r.window ?? r.per) as string | undefined;
				if (limit) return { limit, unit: unit ?? "req/min" };
			}
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// Schema Extraction
// ---------------------------------------------------------------------------

export function extractSchemas(spec: Record<string, unknown>): SchemaDefinition[] {
	const schemas: SchemaDefinition[] = [];

	let rawSchemas: Record<string, Record<string, unknown>> = {};
	const components = spec.components as Record<string, unknown> | undefined;
	const definitions = spec.definitions as Record<string, Record<string, unknown>> | undefined;

	if (components) {
		rawSchemas = (components.schemas ?? {}) as Record<string, Record<string, unknown>>;
	} else if (definitions) {
		rawSchemas = definitions;
	}

	for (const [name, schema] of Object.entries(rawSchemas)) {
		if (!schema || typeof schema !== "object") continue;

		schemas.push({
			name,
			description: (schema.description as string) ?? "",
			properties: (schema.properties ?? {}) as Record<string, Record<string, unknown>>,
			required: (schema.required ?? []) as string[],
			schemaType: (schema.type as string) ?? "object",
			enum: schema.enum as unknown[] | undefined,
		});
	}

	return schemas;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function mergeParameters(pathParams: Parameter[], opParams: Parameter[]): Parameter[] {
	const merged = new Map<string, Parameter>();

	for (const p of pathParams) {
		if (p && typeof p === "object") {
			const key = `${p.in ?? ""}:${p.name ?? ""}`;
			merged.set(key, p);
		}
	}
	for (const p of opParams) {
		if (p && typeof p === "object") {
			const key = `${p.in ?? ""}:${p.name ?? ""}`;
			merged.set(key, p);
		}
	}

	return Array.from(merged.values());
}
