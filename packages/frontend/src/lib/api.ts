// ---------------------------------------------------------------------------
// API Client
// ---------------------------------------------------------------------------

export interface ApiInfo {
	name: string;
	endpoints: number;
}

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
}

export interface ChatMessage {
	role: "user" | "assistant";
	content: string;
}

export interface EndpointCard {
	method: string;
	path: string;
	api: string;
	description: string;
	score: number;
	full_text: string;
	response_schema: string;
}

export interface ChatSSEEvent {
	type: "text" | "endpoints" | "done" | "error";
	text?: string;
	data?: EndpointCard[];
	error?: string;
}

export async function searchEndpoints(query: string, api?: string, limit = 10): Promise<SearchResult[]> {
	const res = await fetch("/api/search/endpoints", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ query, api: api || undefined, limit }),
	});
	if (!res.ok) throw new Error(`Search failed: ${res.status}`);
	return res.json();
}

export async function searchSchemas(query: string, api?: string, limit = 10): Promise<SearchResult[]> {
	const res = await fetch("/api/search/schemas", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ query, api: api || undefined, limit }),
	});
	if (!res.ok) throw new Error(`Search failed: ${res.status}`);
	return res.json();
}

export async function getEndpoint(method: string, path: string, api?: string): Promise<SearchResult> {
	const params = new URLSearchParams({ method, path });
	if (api) params.set("api", api);
	const res = await fetch(`/api/endpoint?${params}`);
	if (!res.ok) throw new Error(`Lookup failed: ${res.status}`);
	return res.json();
}

export async function listApis(): Promise<ApiInfo[]> {
	const res = await fetch("/api/apis");
	if (!res.ok) throw new Error(`List APIs failed: ${res.status}`);
	return res.json();
}

export async function listEndpoints(api: string): Promise<SearchResult[]> {
	const res = await fetch(`/api/endpoints?api=${encodeURIComponent(api)}`);
	if (!res.ok) throw new Error(`List endpoints failed: ${res.status}`);
	return res.json();
}

export interface ModelInfo {
	id: string;
	name: string;
	provider: string;
}

export async function listModels(): Promise<ModelInfo[]> {
	const res = await fetch("/api/models");
	if (!res.ok) return [];
	return res.json();
}

export async function* streamChat(
	messages: ChatMessage[],
	personality: "greg" | "professional",
	opts?: { systemPrompt?: string; model?: string; provider?: string },
	signal?: AbortSignal,
): AsyncGenerator<ChatSSEEvent> {
	const body: Record<string, unknown> = { messages, personality };
	if (opts?.systemPrompt) body.system_prompt = opts.systemPrompt;
	if (opts?.model) body.model = opts.model;
	if (opts?.provider) body.provider = opts.provider;

	const res = await fetch("/api/chat", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal,
	});

	if (!res.ok || !res.body) {
		yield { type: "error", error: `Chat failed: ${res.status}` };
		return;
	}

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });

		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";

		for (const line of lines) {
			if (!line.startsWith("data: ")) continue;
			try {
				const event: ChatSSEEvent = JSON.parse(line.slice(6));
				yield event;
			} catch {
				// skip malformed
			}
		}
	}
}
