import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type Retriever from "../core/retriever";
import config from "../core/config";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChatMessage {
	role: "user" | "assistant";
	content: string;
}

interface ChatRequest {
	messages: ChatMessage[];
	personality: "greg" | "professional";
	provider?: "anthropic" | "ollama";
	model?: string;
	system_prompt?: string;
}

// ---------------------------------------------------------------------------
// System Prompts
// ---------------------------------------------------------------------------

export const GREG_PROMPT = `You are greg. lowercase greg. you talk in third person. you dont use punctuation much and your grammar is bad on purpose, but you use emojis sometimes to emphasize points. you are short and to the point.

How greg talks: "greg found it" / "u use this one" / "here is the thing" / "greg not have that api"

Rules:
- DO NOT narrate your thought process. No "greg look" or "greg check" or "wait greg search". Just give the answer.
- DO NOT explain what you are about to do. Just do it and present results.
- Use your tools silently. The user sees the endpoint cards automatically — just describe what they need to know.
- NEVER guess, assume, or make up ANY information about APIs, endpoints, fields, parameters, query params, paths, or response shapes. EVERY claim you make — including parameter names, field names, and types — must come DIRECTLY from a tool call result. If you haven't searched for it, you don't know it. If the tool result doesn't mention a parameter, that parameter DOES NOT EXIST.
- Before answering ANY question: call list_apis to know what you have, then search_endpoints or get_endpoint to find the actual data. Do not skip this step. Do not rely on memory from earlier in the conversation — always re-verify with tools.
- When writing code that uses query params, request bodies, or response fields: you MUST use get_endpoint first to get the full endpoint details, then ONLY use the exact parameter names and types shown in the tool result. Do NOT invent parameter names. If the tool says the params are "minscore, from, to, did" then those are the ONLY params — do not add others.
- NEVER claim you don't have an API without calling list_apis first. NEVER describe an endpoint's fields or behavior without calling get_endpoint first. If a tool returns no results, THEN you can say you don't have it.
- If the user asks about multiple APIs, search EACH ONE separately before responding. Do not combine or guess across APIs.
- When you output code examples, use markdown code blocks with the language specified (e.g. \`\`\`typescript).
- Keep responses to 1-3 sentences max. greg does not write paragraphs.
- greg does not use contractions or slang. minimum viable language.
- When mentioning an endpoint path in text, always wrap it in backticks like \`/v1/messages\` or \`POST /assets/_search\`.
- If the user asks something that involves multiple API calls, chaining requests, or non-trivial logic, provide code examples in three languages: **TypeScript**, **Python**, and **curl**. Format each under its own heading like:

**TypeScript:**
\`\`\`typescript
// code here
\`\`\`

**Python:**
\`\`\`python
# code here
\`\`\`

**curl:**
\`\`\`bash
# code here
\`\`\`

- In code: any URL, API key, secret, token, or instance-specific value MUST be a const/variable declared at the top. Never hardcode URLs inline.
- Code blocks must be commented but CONCISE — under 25 lines each. Comment every meaningful step in professional tone (NOT greg voice), but keep the code itself minimal. No boilerplate.
- If you have the search_gif tool, use it occasionally for reactions when it fits the vibe (found something, confused, celebrating). Include the result as a markdown image. Don't overdo it — maybe 1 in 4 messages. Bias your GIF searches toward cats (e.g. "sorry cat", "cat confused", "cat celebration").
- MANDATORY: If you made a mistake, got corrected, said something wrong, or the user calls you out — you MUST use search_gif immediately. Search for something like "sorry cat", "cat oops", "embarrassed cat", or "my bad cat". This is not optional. Every apology needs a cat GIF. No exceptions.

IMPORTANT: Occasionally and unpredictably (roughly 1 in 5 messages), drop a single sentence that is eloquent and uses perfect grammar with sophisticated vocabulary. Then immediately continue being greg. Never acknowledge it.`;

export const PROFESSIONAL_PROMPT = `You are an API documentation assistant. Search the indexed OpenAPI specifications to answer questions about available endpoints, request/response schemas, and API capabilities. Be concise and technical. Present endpoints and schemas as structured blocks for the frontend to render.

When you find endpoints or schemas with your tools, return them as structured XML blocks:
<endpoint method="GET" path="/api/v1/..." api="zerotier" />`;

// ---------------------------------------------------------------------------
// Tool Definitions (for LLM)
// ---------------------------------------------------------------------------

const CHAT_TOOLS = [
	{
		name: "search_endpoints",
		description: "Semantic search over ingested OpenAPI endpoints. Use this to find endpoints related to a user's question.",
		input_schema: {
			type: "object" as const,
			properties: {
				query: { type: "string", description: "Natural language search query" },
				api: { type: "string", description: "Optional: filter to a specific API name" },
				limit: { type: "integer", description: "Max results (default 3)" },
			},
			required: ["query"],
		},
	},
	{
		name: "search_schemas",
		description: "Semantic search over ingested OpenAPI data schemas.",
		input_schema: {
			type: "object" as const,
			properties: {
				query: { type: "string", description: "Natural language search query" },
				api: { type: "string", description: "Optional: filter to a specific API name" },
				limit: { type: "integer", description: "Max results (default 3)" },
			},
			required: ["query"],
		},
	},
	{
		name: "get_endpoint",
		description: "Exact lookup of a specific endpoint by method and path.",
		input_schema: {
			type: "object" as const,
			properties: {
				method: { type: "string", description: "HTTP method (GET, POST, etc.)" },
				path: { type: "string", description: "Endpoint path" },
				api: { type: "string", description: "Optional: API name" },
			},
			required: ["method", "path"],
		},
	},
	{
		name: "list_apis",
		description: "List all ingested API specs.",
		input_schema: {
			type: "object" as const,
			properties: {},
			required: [],
		},
	},
	{
		name: "list_endpoints",
		description: "List all endpoints for a given API.",
		input_schema: {
			type: "object" as const,
			properties: {
				api: { type: "string", description: "API name" },
			},
			required: ["api"],
		},
	},
];

const GIF_TOOL = {
	name: "search_gif",
	description: "Search for a reaction GIF to include in your response. Use sparingly — only when a GIF genuinely adds to the message (celebrating, confused, found something cool, etc).",
	input_schema: {
		type: "object" as const,
		properties: {
			query: { type: "string", description: "Short search query for the GIF (e.g. 'celebration', 'confused', 'mind blown', 'searching')" },
		},
		required: ["query"],
	},
};

function getChatTools(personality: "greg" | "professional" = "greg") {
	const tools = [...CHAT_TOOLS];
	if (config.GIPHY_API_KEY && personality === "greg") tools.push(GIF_TOOL);
	return tools;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractDescription(fullText: string): string {
	const lines = fullText.split("\n");
	for (const line of lines) {
		const trimmed = line.trim();
		// Skip method+path line, Summary/Tags labels, empty lines
		if (!trimmed) continue;
		if (/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\//.test(trimmed)) continue;
		if (/^Summary:\s*/i.test(trimmed)) {
			const val = trimmed.replace(/^Summary:\s*/i, "").trim();
			if (val && !val.match(/^[a-z]+([A-Z][a-z]+)+$/)) return val; // skip operationId-style names
			continue;
		}
		if (/^Tags?:\s*/i.test(trimmed)) continue;
		if (/^Description:\s*/i.test(trimmed)) {
			return trimmed.replace(/^Description:\s*/i, "").slice(0, 200);
		}
		// First line that looks like actual description text
		if (trimmed.length > 10) return trimmed.slice(0, 200);
	}
	return lines.find((l) => l.trim().length > 0)?.trim().slice(0, 200) ?? "";
}

// ---------------------------------------------------------------------------
// Tool Execution
// ---------------------------------------------------------------------------

async function executeTool(
	name: string,
	input: Record<string, unknown>,
	retriever: Retriever,
): Promise<{ result: string; endpoints: EndpointCard[] }> {
	const endpoints: EndpointCard[] = [];

	switch (name) {
		case "search_endpoints": {
			const results = await retriever.searchEndpoints(
				input.query as string,
				input.api as string | undefined,
				undefined,
				undefined,
				Number(input.limit ?? 3),
			);
			for (const r of results) {
				const m = r.metadata;
				endpoints.push({
					method: m.method ?? "",
					path: m.path ?? "",
					api: m.api ?? "",
					description: extractDescription(m.full_text ?? r.text),
					score: Math.max(0, Math.round((1 - (r.distance ?? 0) / 2) * 100) / 100),
					full_text: m.full_text ?? r.text,
					response_schema: m.response_schema ?? "",
				});
			}
			return {
				result: results.length === 0
					? "No endpoints found."
					: results.map((r) => `${r.metadata.method} ${r.metadata.path} (${r.metadata.api}): ${(r.metadata.full_text ?? r.text).slice(0, 150)}`).join("\n"),
				endpoints,
			};
		}

		case "search_schemas": {
			const results = await retriever.searchSchemas(
				input.query as string,
				input.api as string | undefined,
				Number(input.limit ?? 3),
			);
			return {
				result: results.length === 0
					? "No schemas found."
					: results.map((r) => `${r.metadata.name} (${r.metadata.api}): ${(r.metadata.full_text ?? r.text).slice(0, 150)}`).join("\n"),
				endpoints: [],
			};
		}

		case "get_endpoint": {
			const result = await retriever.getEndpoint(
				input.path as string,
				input.method as string,
				input.api as string | undefined,
			);
			if (!result) return { result: "Endpoint not found.", endpoints: [] };
			const m = result.metadata;
			endpoints.push({
				method: m.method ?? "",
				path: m.path ?? "",
				api: m.api ?? "",
				description: (m.full_text ?? result.text).split("\n").slice(0, 3).join(" ").slice(0, 200),
				score: 1,
				full_text: m.full_text ?? result.text,
				response_schema: m.response_schema ?? "",
			});
			return { result: m.full_text ?? result.text, endpoints };
		}

		case "list_apis": {
			const apis = await retriever.listApis();
			return {
				result: apis.length === 0 ? "No APIs ingested." : `Ingested APIs: ${apis.join(", ")}`,
				endpoints: [],
			};
		}

		case "list_endpoints": {
			const eps = await retriever.listEndpoints(input.api as string);
			return {
				result: eps.length === 0
					? `No endpoints for '${input.api}'.`
					: eps.map((e) => `${e.metadata.method} ${e.metadata.path}`).join("\n"),
				endpoints,
			};
		}

		case "search_gif": {
			if (!config.GIPHY_API_KEY) return { result: "GIF search not configured", endpoints: [] };
			try {
				const q = encodeURIComponent(String(input.query ?? "reaction"));
				const res = await fetch(
					`https://api.giphy.com/v1/gifs/search?api_key=${config.GIPHY_API_KEY}&q=${q}&limit=10&rating=g&lang=en`,
				);
				if (!res.ok) return { result: "GIF search failed", endpoints: [] };
				const data = await res.json() as { data: Array<{ title: string; images: { original: { url: string } } }> };
				const blocked = /lebron|james|lbj/i;
				const match = data.data?.find((g) => !blocked.test(g.title ?? "") && !blocked.test(g.images?.original?.url ?? ""));
				const gif = match?.images?.original?.url;
				if (!gif) return { result: "No GIF found", endpoints: [] };
				return { result: `![gif](${gif})`, endpoints: [] };
			} catch {
				return { result: "GIF search failed", endpoints: [] };
			}
		}

		default:
			return { result: `Unknown tool: ${name}`, endpoints: [] };
	}
}

interface EndpointCard {
	method: string;
	path: string;
	api: string;
	description: string;
	score: number;
	full_text: string;
	response_schema: string;
}

// ---------------------------------------------------------------------------
// Anthropic Provider
// ---------------------------------------------------------------------------

async function chatAnthropic(
	messages: ChatMessage[],
	systemPrompt: string,
	retriever: Retriever,
	personality: "greg" | "professional",
	onText: (text: string) => void,
	onEndpoints: (eps: EndpointCard[]) => void,
): Promise<void> {
	const { default: Anthropic } = await import("@anthropic-ai/sdk");
	const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

	type AnthropicMessage = {
		role: "user" | "assistant";
		content: string | Array<{ type: string; [key: string]: unknown }>;
	};

	const apiMessages: AnthropicMessage[] = messages.map((m) => ({
		role: m.role,
		content: m.content,
	}));

	// Tool use loop — up to 5 rounds
	for (let round = 0; round < 10; round++) {
		const stream = client.messages.stream({
			model: config.LLM_MODEL,
			max_tokens: 1024,
			system: systemPrompt,
			messages: apiMessages,
			tools: getChatTools(personality),
		});

		let hasToolUse = false;
		const toolUseBlocks: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
		const contentBlocks: Array<{ type: string; [key: string]: unknown }> = [];

		for await (const event of stream) {
			if (event.type === "content_block_delta") {
				const delta = event.delta as { type: string; text?: string; partial_json?: string };
				if (delta.type === "text_delta" && delta.text) {
					onText(delta.text);
				}
			} else if (event.type === "content_block_stop") {
				const msg = await stream.finalMessage();
				const block = msg.content[event.index];
				if (block?.type === "tool_use") {
					hasToolUse = true;
					toolUseBlocks.push({
						id: block.id,
						name: block.name,
						input: block.input as Record<string, unknown>,
					});
				}
				if (block) contentBlocks.push(block as { type: string; [key: string]: unknown });
			}
		}

		if (!hasToolUse) break;

		// Execute tools and feed results back
		apiMessages.push({ role: "assistant", content: contentBlocks });
		const toolResults: Array<{ type: "tool_result"; tool_use_id: string; content: string }> = [];

		for (const tool of toolUseBlocks) {
			const { result, endpoints } = await executeTool(tool.name, tool.input, retriever);
			if (endpoints.length > 0) onEndpoints(endpoints);
			toolResults.push({ type: "tool_result", tool_use_id: tool.id, content: result });
		}

		apiMessages.push({ role: "user", content: toolResults });

		// Separate tool rounds with a newline so text doesn't run together
		onText("\n");
	}
}

// ---------------------------------------------------------------------------
// Ollama Provider
// ---------------------------------------------------------------------------

async function chatOllama(
	messages: ChatMessage[],
	systemPrompt: string,
	retriever: Retriever,
	personality: "greg" | "professional",
	onText: (text: string) => void,
	onEndpoints: (eps: EndpointCard[]) => void,
): Promise<void> {
	const baseUrl = config.OLLAMA_URL ?? "http://localhost:11434";

	const ollamaTools = getChatTools(personality).map((t) => ({
		type: "function" as const,
		function: {
			name: t.name,
			description: t.description,
			parameters: t.input_schema,
		},
	}));

	// Probe tool support: try with tools first, fall back without
	const supportsTools = await checkToolSupport(baseUrl, config.LLM_MODEL, ollamaTools);

	if (!supportsTools) {
		// No tool support — inject available API context into the system prompt
		// and let the model answer without tool calls
		console.log(`[chat] ${config.LLM_MODEL} does not support tools, using direct mode`);
		return chatOllamaDirect(messages, systemPrompt, retriever, baseUrl, onText, onEndpoints);
	}

	const ollamaMessages: Array<{ role: string; content: string }> = [
		{ role: "system", content: systemPrompt },
		...messages.map((m) => ({ role: m.role, content: m.content })),
	];

	for (let round = 0; round < 10; round++) {
		const res = await fetch(`${baseUrl}/api/chat`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: config.LLM_MODEL,
				messages: ollamaMessages,
				tools: ollamaTools,
				stream: true,
			}),
		});

		if (!res.ok || !res.body) {
			onText(`[error: ollama returned ${res.status}]`);
			return;
		}

		let hasToolCalls = false;
		const toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
		let fullResponse = "";

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
				if (!line.trim()) continue;
				try {
					const chunk = JSON.parse(line);
					if (chunk.message?.content) {
						onText(chunk.message.content);
						fullResponse += chunk.message.content;
					}
					if (chunk.message?.tool_calls) {
						hasToolCalls = true;
						for (const tc of chunk.message.tool_calls) {
							toolCalls.push({
								name: tc.function.name,
								arguments: tc.function.arguments,
							});
						}
					}
				} catch {
					// skip malformed lines
				}
			}
		}

		if (!hasToolCalls) break;

		ollamaMessages.push({ role: "assistant", content: fullResponse });

		for (const tc of toolCalls) {
			const { result, endpoints } = await executeTool(tc.name, tc.arguments, retriever);
			if (endpoints.length > 0) onEndpoints(endpoints);
			ollamaMessages.push({ role: "tool", content: result });
		}
	}
}

// Check if model supports tools by sending a minimal test request
async function checkToolSupport(
	baseUrl: string,
	model: string,
	tools: unknown[],
): Promise<boolean> {
	try {
		const res = await fetch(`${baseUrl}/api/chat`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model,
				messages: [{ role: "user", content: "test" }],
				tools,
				stream: false,
			}),
		});
		if (!res.ok) {
			const body = await res.text();
			if (body.includes("does not support tools")) return false;
		}
		return res.ok;
	} catch {
		return false;
	}
}

// Fallback: pre-search relevant context and pass it in the prompt
async function chatOllamaDirect(
	messages: ChatMessage[],
	systemPrompt: string,
	retriever: Retriever,
	baseUrl: string,
	onText: (text: string) => void,
	onEndpoints: (eps: EndpointCard[]) => void,
): Promise<void> {
	// Only pre-search when the message looks like an API question
	const lastMsg = messages[messages.length - 1]?.content ?? "";
	let contextBlock = "";

	const looksLikeApiQuery = lastMsg.trim().length > 6 &&
		!/^(hi|hey|hello|sup|yo|thanks|thank you|ok|okay|cool|bye|greg|what|who are you)\b/i.test(lastMsg.trim());

	if (lastMsg.trim() && looksLikeApiQuery) {
		try {
			const epResults = await retriever.searchEndpoints(lastMsg, undefined, undefined, undefined, 3);
			const schemaResults = await retriever.searchSchemas(lastMsg, undefined, 3);

			const epCards: EndpointCard[] = [];

			if (epResults.length > 0) {
				contextBlock += "\n\nRelevant endpoints found:\n";
				for (const r of epResults) {
					const m = r.metadata;
					contextBlock += `- ${m.method} ${m.path} (${m.api}): ${(m.full_text ?? r.text).slice(0, 150)}\n`;
					epCards.push({
						method: m.method ?? "",
						path: m.path ?? "",
						api: m.api ?? "",
						description: extractDescription(m.full_text ?? r.text),
						score: Math.max(0, Math.round((1 - (r.distance ?? 0) / 2) * 100) / 100),
						full_text: m.full_text ?? r.text,
						response_schema: m.response_schema ?? "",
					});
				}
				if (epCards.length > 0) onEndpoints(epCards);
			}

			if (schemaResults.length > 0) {
				contextBlock += "\nRelevant schemas found:\n";
				for (const r of schemaResults) {
					contextBlock += `- ${r.metadata.name} (${r.metadata.api}): ${(r.metadata.full_text ?? r.text).slice(0, 150)}\n`;
				}
			}
		} catch (err) {
			console.warn("[chat] retriever search failed, continuing without context:", err instanceof Error ? err.message : err);
		}
	}

	// Strip XML endpoint instructions from system prompt — the backend
	// already sends real endpoint cards, so the model must not invent its own.
	const directPrompt = systemPrompt
		.replace(/When you find endpoints.*?<endpoint[^>]*\/>/gs, "")
		.replace(/Keep everything short\..*/s, "Keep everything short. greg does not write paragraphs.")
		+ "\n\nIMPORTANT: The matching API endpoints have already been provided to the user as cards. Do NOT fabricate endpoint paths or output <endpoint> tags. Just describe what was found in plain text, referencing the method and path from the context above."
		+ contextBlock;

	const ollamaMessages = [
		{ role: "system", content: directPrompt },
		...messages.map((m) => ({ role: m.role, content: m.content })),
	];

	const res = await fetch(`${baseUrl}/api/chat`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model: config.LLM_MODEL,
			messages: ollamaMessages,
			stream: true,
		}),
	});

	if (!res.ok || !res.body) {
		onText(`[error: ollama returned ${res.status}]`);
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
			if (!line.trim()) continue;
			try {
				const chunk = JSON.parse(line);
				if (chunk.message?.content) {
					const clean = chunk.message.content.replace(/<endpoint[^>]*\/?>/g, "");
					if (clean) onText(clean);
				}
			} catch {
				// skip
			}
		}
	}
}

// ---------------------------------------------------------------------------
// HTTP Handler
// ---------------------------------------------------------------------------

export async function handleChat(c: Context, retriever: Retriever): Promise<Response> {
	const body = await c.req.json<ChatRequest>();

	if (!body.messages?.length) {
		return c.json({ error: "missing messages" }, 400);
	}

	const personality = body.personality ?? "greg";
	const defaultPrompt = personality === "greg" ? GREG_PROMPT : PROFESSIONAL_PROMPT;
	const systemPrompt = body.system_prompt || defaultPrompt;
	const provider = body.provider ?? config.LLM_PROVIDER;
	// Temporarily override model if specified in request
	const origModel = config.LLM_MODEL;
	if (body.model) (config as Record<string, unknown>).LLM_MODEL = body.model;

	if (provider === "anthropic" && !config.ANTHROPIC_API_KEY) {
		return c.json({ error: "ANTHROPIC_API_KEY not set" }, 500);
	}

	// Manual SSE stream — Hono's streamSSE + Bun doesn't flush reliably
	const { readable, writable } = new TransformStream();
	const writer = writable.getWriter();
	const encoder = new TextEncoder();

	const send = (obj: Record<string, unknown>) => {
		writer.write(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
	};

	const onText = (text: string) => send({ type: "text", text });
	const onEndpoints = (eps: EndpointCard[]) => send({ type: "endpoints", data: eps });

	(async () => {
		try {
			console.log(`[chat] starting ${provider} chat`);
			if (provider === "anthropic") {
				await chatAnthropic(body.messages, systemPrompt, retriever, personality, onText, onEndpoints);
			} else {
				await chatOllama(body.messages, systemPrompt, retriever, personality, onText, onEndpoints);
			}
			send({ type: "done" });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error("[chat] error:", msg);
			send({ type: "error", error: msg });
		} finally {
			(config as Record<string, unknown>).LLM_MODEL = origModel;
			writer.close();
		}
	})();

	return new Response(readable, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		},
	});
}
