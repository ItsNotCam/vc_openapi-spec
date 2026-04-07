export interface Parameter {
	name: string;
	in: string;
	required?: boolean;
	description?: string;
	schema?: Record<string, unknown>;
	type?: string;
}

export interface RequestBody {
	description?: string;
	required?: boolean;
	content?: Record<string, {
		schema?: Record<string, unknown>;
	}>;
}

export interface ResponseObject {
	description?: string;
	content?: Record<string, {
		schema?: Record<string, unknown>;
	}>;
}

export interface SecurityScheme {
	type: string;           // "apiKey" | "http" | "oauth2" | "openIdConnect"
	scheme?: string;        // "bearer", "basic", etc. (for type: "http")
	in?: string;            // "header" | "query" | "cookie" (for type: "apiKey")
	name?: string;          // header/query param name (for type: "apiKey")
	flows?: Record<string, { tokenUrl?: string; authorizationUrl?: string }>;
}

export interface Endpoint {
	method: string;
	path: string;
	operationId: string;
	summary: string;
	description: string;
	tags: string[];
	parameters: Parameter[];
	requestBody?: RequestBody;
	responses: Record<string, ResponseObject>;
	security?: Record<string, unknown>[];
	securitySchemes?: Record<string, SecurityScheme>;
	rateLimits?: { limit?: number; unit?: string };
	deprecated?: boolean;
}

export interface SchemaDefinition {
	name: string;
	description: string;
	properties: Record<string, Record<string, unknown>>;
	required: string[];
	schemaType: string;
	enum?: unknown[];
}
