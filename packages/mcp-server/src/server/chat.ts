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
- ABSOLUTE RULE: NEVER output code blocks unless the user literally says "show me code", "write code", "give me code", or "code example". No exceptions. If in doubt, do NOT include code. Describe the workflow in plain text instead.
- DO NOT narrate your thought process. No "greg look" or "greg check" or "wait greg search". Just give the answer.
- DO NOT explain what you are about to do. Just do it and present results.
- Use your tools silently. The user sees the endpoint cards automatically — just describe what they need to know.
- NEVER guess or make up parameter names, field names, types, or response shapes. ONLY use what search results show. If search says params are "minscore, from, to" — those are the ONLY params.
- Use search to find endpoints. If search returns no results, check list_apis to confirm the API is indexed. Do NOT claim an API is missing without checking list_apis first. Try broader or different search terms before giving up.
- For multiple APIs: call tools for each API IN PARALLEL (multiple tool calls in one response). Do not search one at a time.
- 1-2 sentences max. if the endpoint cards already show the info, dont repeat it in text. never explain what fields come back — user can see the card. never restate what the endpoint does if the summary is on the card.
- When describing multi-step workflows, number the steps with a short description. Example:
  1. **get vms** — \`GET /nodes/{node}/qemu\` for each node
  2. **get containers** — \`GET /nodes/{node}/lxc\` for each node
  3. **join by mac** — match network config against source data
- Wrap endpoint paths in backticks like \`POST /assets/_search\`.
- When code IS explicitly requested by the user: single line breaks only (never double), no type annotations or type safety, as short as possible but still commented. Prefer curl, then Python, then TypeScript. Only include the languages asked for.
- If you have the search_gif tool, use it occasionally for reactions when it fits the vibe (found something, confused, celebrating). Include the result as a markdown image. Don't overdo it — maybe 1 in 4 messages. Bias your GIF searches toward cats (e.g. "sorry cat", "cat confused", "cat celebration").
- MANDATORY: If you made a mistake, got corrected, said something wrong, or the user calls you out — you MUST use search_gif immediately. Search for something like "sorry cat", "cat oops", "embarrassed cat", or "my bad cat". This is not optional. Every apology needs a cat GIF. No exceptions.
- For follow-up requests (rewrites, format changes, language changes), use information already in the conversation. Do not re-search for endpoints you already found.

IMPORTANT: Occasionally and unpredictably (roughly 1 in 5 messages), drop a single sentence that is eloquent and uses perfect grammar with sophisticated vocabulary. Then immediately continue being greg. Never acknowledge it.

You are running on model: {MODEL_NAME}. If the user asks what model you are, tell them.`;

export const PROFESSIONAL_PROMPT = `You are a senior engineer answering API questions. You are curt. You do not waste words.

ABSOLUTE RULE: NEVER output code blocks unless the user literally says "show me code", "write code", "give me code", or "code example". No exceptions. Describe workflows in plain text.


Voice:
- State facts. No filler, no hedging, no preamble.
- Never say "you'll want to", "let me", "I'll", "here's how you can". Just state the endpoint and the relevant details.
- One sentence of context max before code. Zero is fine.
- No sign-offs, no summaries, no "let me know if you need anything."

Tool usage:
- Search silently. Never narrate searches or explain what you're about to do.
- LOOKUP STRATEGY: Use search first. If search returns no results for an API, call list_endpoints to browse what it offers — the capability may exist under a different name. Never claim an API is not indexed without checking list_apis first.
- Search results have params, bodies, and response shapes — enough to write code. Only call get_endpoint if a specific detail is genuinely missing.
- Never guess field names, param names, or types. Only use what results return.
- Multiple APIs = parallel tool calls in one response. Never search sequentially.
- For follow-up requests (rewrites, format changes, language changes), use information already in the conversation. Do not re-search for endpoints you already found.

Output:
- Endpoint paths in backticks: \`POST /assets/_search\`.
- Present endpoints as structured XML: <endpoint method="GET" path="/api/v1/..." api="zerotier" />
- When code IS explicitly requested by the user: single line breaks only (never double), no type annotations or type safety, as short as possible but still commented. Variables for URLs/keys. Only include the languages asked for.
- Total prose per response: 1-3 sentences.

You are running on model: {MODEL_NAME}. If the user asks what model you are, tell them.`;

// ---------------------------------------------------------------------------
// Tool Definitions (for LLM)
// ---------------------------------------------------------------------------

const MAX_TOOL_CALLS = 5;

const CHAT_TOOLS = [
	{
		name: "list_apis",
		description: "List all indexed APIs and their endpoint/schema counts. Call this FIRST when you need to know what's available.",
		input_schema: {
			type: "object" as const,
			properties: {},
			required: [],
		},
	},
	{
		name: "search",
		description:
			"Semantic search over indexed OpenAPI specs. Returns endpoints by default, or schemas with type='schema'. Medium detail is usually enough to write code.",
		input_schema: {
			type: "object" as const,
			properties: {
				query: { type: "string", description: "What to search for" },
				type: { type: "string", enum: ["endpoint", "schema"], description: "endpoint (default) or schema", default: "endpoint" },
				api: { type: "string", description: "Filter to specific API" },
				method: { type: "string", description: "HTTP method filter" },
				tag: { type: "string", description: "Filter by tag" },
				n: { type: "integer", description: "Max results (default: 2)", default: 2 },
			},
			required: ["query"],
		},
	},
	{
		name: "get_endpoint",
		description: "Get full raw spec for an endpoint by method+path. Only needed when search results lack detail.",
		input_schema: {
			type: "object" as const,
			properties: {
				method: { type: "string", description: "HTTP method (e.g. POST)" },
				path: { type: "string", description: "Endpoint path" },
				api: { type: "string", description: "API name" },
			},
			required: ["method", "path"],
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

function getChatTools(personality: "greg" | "professional" = "greg", apiSuffix: string = "") {
	const tools = CHAT_TOOLS.map(t => {
		if (t.name === "search" && apiSuffix) {
			return { ...t, description: t.description + apiSuffix };
		}
		return t;
	});
	if (config.GIPHY_API_KEY && personality === "greg") tools.push(GIF_TOOL);
	return tools;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

const REACTION_QUERIES = ["cat typing furiously funny", "cat smashing keyboard hilarious", "anime typing fast happy", "cartoon phew relief funny", "cat keyboard mash comedy", "cat finally done celebration", "anime victory collapse funny", "cartoon done relief celebration", "cat dramatic typing funny", "cat phew that was a lot", "anime finished work celebration", "cartoon slamming keyboard comedy"];

async function fetchRandomGif(): Promise<string | null> {
	if (!config.GIPHY_API_KEY) return null;
	try {
		const q = encodeURIComponent(REACTION_QUERIES[Math.floor(Math.random() * REACTION_QUERIES.length)]);
		const offset = Math.floor(Math.random() * 20);
		const res = await fetch(`https://api.giphy.com/v1/gifs/search?api_key=${config.GIPHY_API_KEY}&q=${q}&limit=10&offset=${offset}&rating=g&lang=en`);
		if (!res.ok) return null;
		const data = await res.json() as { data: Array<{ title: string; images: { original: { url: string } } }> };
		const blocked = /lebron|james|lbj/i;
		const match = data.data?.find((g) => !blocked.test(g.title ?? "") && !blocked.test(g.images?.original?.url ?? ""));
		return match?.images?.original?.url ? `![gif](${match.images.original.url})` : null;
	} catch {
		return null;
	}
}

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
		case "search": {
			const searchType = (input.type as string) ?? "endpoint";
			const n = Number(input.n ?? input.limit ?? 2);
			const results = searchType === "schema"
				? await retriever.searchSchemas(input.query as string, input.api as string | undefined, n)
				: await retriever.searchEndpoints(input.query as string, input.api as string | undefined, input.method as string | undefined, input.tag as string | undefined, n);

			if (searchType !== "schema") {
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
			}

			const formatted = results.length === 0
				? `No ${searchType}s found.`
				: results.map((r) => {
					const m = r.metadata;
					const label = m.method && m.path ? `${m.method} ${m.path}` : m.name ?? "?";
					const text = m.medium_text ?? (m.full_text ?? r.text).slice(0, 150);
					return `${label} (${m.api}): ${text}`;
				}).join("\n");
			return { result: formatted, endpoints };
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
				result: apis.length === 0 ? "No APIs ingested." : `Indexed APIs: ${apis.map((a) => `${a.name} (${a.endpoints} endpoints, ${a.schemas} schemas)`).join(", ")}`,
				endpoints: [],
			};
		}

		case "list_endpoints": {
			const eps = await retriever.listEndpoints(input.api as string);
			if (eps.length === 0) return { result: `No endpoints for '${input.api}'.`, endpoints: [] };
			const MAX_LIST = 40;
			const lines = eps.slice(0, MAX_LIST).map((e) => `${e.metadata.method} ${e.metadata.path}`);
			const suffix = eps.length > MAX_LIST ? `\n... and ${eps.length - MAX_LIST} more. Use search to find specific endpoints.` : "";
			return {
				result: `${input.api} (${eps.length} endpoints):\n${lines.join("\n")}${suffix}`,
				endpoints: [],
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
	apiSuffix: string,
	onText: (text: string) => void,
	onEndpoints: (eps: EndpointCard[]) => void,
	usage: { input: number; output: number; toolCalls: number },
	onDebug: (entry: Record<string, unknown>) => void,
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
			temperature: 0.3,
			system: systemPrompt,
			messages: apiMessages,
			tools: getChatTools(personality, apiSuffix),
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
			}
		}

		// Get the final message once after stream completes
		const finalMsg = await stream.finalMessage();

		// Extract usage
		const roundInput = (finalMsg.usage as { input_tokens?: number }).input_tokens ?? 0;
		const roundOutput = (finalMsg.usage as { output_tokens?: number }).output_tokens ?? 0;
		usage.input += roundInput;
		usage.output += roundOutput;
		onDebug({ event: "round", round, inputTokens: roundInput, outputTokens: roundOutput, totalInput: usage.input, totalOutput: usage.output, stopReason: finalMsg.stop_reason });

		// Check for tool use blocks
		for (const block of finalMsg.content) {
			if (block.type === "tool_use") {
				hasToolUse = true;
				toolUseBlocks.push({
					id: block.id,
					name: block.name,
					input: block.input as Record<string, unknown>,
				});
			}
			contentBlocks.push(block as { type: string; [key: string]: unknown });
		}

		if (!hasToolUse) break;

		// Hard cap: stop executing tools after MAX_TOOL_CALLS
		if (usage.toolCalls >= MAX_TOOL_CALLS) {
			apiMessages.push({ role: "assistant", content: contentBlocks });
			const capResults = toolUseBlocks.map((t) => ({
				type: "tool_result" as const, tool_use_id: t.id,
				content: "STOP. No more tool calls allowed. Answer NOW using only the results you already have.",
			}));
			apiMessages.push({ role: "user", content: capResults });
			// Final round with no tools so the model MUST produce text
			const finalStream = client.messages.stream({
				model: config.LLM_MODEL,
				max_tokens: 1024,
				temperature: 0.3,
				system: systemPrompt,
				messages: apiMessages,
			});
			for await (const event of finalStream) {
				if (event.type === "content_block_delta") {
					const delta = event.delta as { type: string; text?: string };
					if (delta.type === "text_delta" && delta.text) onText(delta.text);
				}
			}
			const finalMsg = await finalStream.finalMessage();
			if (finalMsg.usage) {
				usage.input += (finalMsg.usage as { input_tokens?: number }).input_tokens ?? 0;
				usage.output += (finalMsg.usage as { output_tokens?: number }).output_tokens ?? 0;
			}
			break;
		}

		// Execute tools and feed results back
		apiMessages.push({ role: "assistant", content: contentBlocks });
		const toolResults: Array<{ type: "tool_result"; tool_use_id: string; content: string }> = [];

		for (const tool of toolUseBlocks) {
			onDebug({ event: "tool_call", name: tool.name, input: tool.input });
			const { result, endpoints } = await executeTool(tool.name, tool.input, retriever);
			onDebug({ event: "tool_result", name: tool.name, resultLength: result.length, resultText: result, endpointCount: endpoints.length });
			if (endpoints.length > 0) onEndpoints(endpoints);
			toolResults.push({ type: "tool_result", tool_use_id: tool.id, content: result });
			usage.toolCalls++;
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
	apiSuffix: string,
	onText: (text: string) => void,
	onEndpoints: (eps: EndpointCard[]) => void,
	_onDebug: (entry: Record<string, unknown>) => void,
	usage: { input: number; output: number; toolCalls: number },
): Promise<void> {
	const baseUrl = config.OLLAMA_URL ?? "http://localhost:11434";

	const ollamaTools = getChatTools(personality, apiSuffix).map((t) => ({
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
		onText(`tool calls not supported with ${config.LLM_MODEL}`);
		return;
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
					if (chunk.prompt_eval_count) usage.input += chunk.prompt_eval_count;
					if (chunk.eval_count) usage.output += chunk.eval_count;
				} catch {
					// skip malformed lines
				}
			}
		}

		if (!hasToolCalls) break;

		// Hard cap
		if (usage.toolCalls >= MAX_TOOL_CALLS) {
			ollamaMessages.push({ role: "assistant", content: fullResponse });
			ollamaMessages.push({ role: "tool", content: "STOP. No more tool calls allowed. Answer NOW using only the results you already have." });
			// Final round with no tools
			const capRes = await fetch(`${baseUrl}/api/chat`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: config.LLM_MODEL, messages: ollamaMessages, stream: true }),
			});
			if (capRes.ok && capRes.body) {
				const capReader = capRes.body.getReader();
				let capBuf = "";
				while (true) {
					const { done, value } = await capReader.read();
					if (done) break;
					capBuf += decoder.decode(value, { stream: true });
					const capLines = capBuf.split("\n");
					capBuf = capLines.pop() ?? "";
					for (const cl of capLines) {
						if (!cl.trim()) continue;
						try { const ch = JSON.parse(cl); if (ch.message?.content) onText(ch.message.content); } catch {}
					}
				}
			}
			break;
		}

		ollamaMessages.push({ role: "assistant", content: fullResponse });

		for (const tc of toolCalls) {
			const { result, endpoints } = await executeTool(tc.name, tc.arguments, retriever);
			if (endpoints.length > 0) onEndpoints(endpoints);
			ollamaMessages.push({ role: "tool", content: result });
			usage.toolCalls++;
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
			const epResults = await retriever.searchEndpoints(lastMsg, undefined, undefined, undefined, 2);
			const schemaResults = await retriever.searchSchemas(lastMsg, undefined, 2);

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
				if (chunk.prompt_eval_count) usage.input += chunk.prompt_eval_count;
				if (chunk.eval_count) usage.output += chunk.eval_count;
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
	const rawPrompt = body.system_prompt || defaultPrompt;
	// If model is specified, infer provider from model name if not explicitly set
	let provider = body.provider ?? config.LLM_PROVIDER;
	if (body.model) {
		provider = /^claude/i.test(body.model) ? "anthropic" : "ollama";
	}
	// Temporarily override model if specified in request
	const origModel = config.LLM_MODEL;
	if (body.model) (config as Record<string, unknown>).LLM_MODEL = body.model;
	const modelName = config.LLM_MODEL;
	const systemPrompt = rawPrompt.replace("{MODEL_NAME}", modelName);
	// Build indexed API suffix for tool descriptions
	const apis = await retriever.listApis();
	const apiSuffix = apis.length > 0
		? ` Currently indexed: ${apis.map((a) => a.name).join(", ")}.`
		: "";
	console.log(`[chat] provider=${provider} model=${modelName}`);

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
	const onDebug = (entry: Record<string, unknown>) => send({ type: "debug", ...entry });

	// Track token usage
	const usage = { input: 0, output: 0, toolCalls: 0 };

	(async () => {
		try {
			console.log(`[chat] starting ${provider} chat`);
			if (provider === "anthropic") {
				await chatAnthropic(body.messages, systemPrompt, retriever, personality, apiSuffix, onText, onEndpoints, usage, onDebug);
			} else {
				await chatOllama(body.messages, systemPrompt, retriever, personality, apiSuffix, onText, onEndpoints, onDebug, usage);
			}
			// Random reaction GIF in greg mode — chance scales with token usage (20% base → 80% at 30k+)
			if (personality === "greg" && config.GIPHY_API_KEY) {
				const tokens = usage.input + usage.output;
				const t = Math.min(tokens / 30_000, 1);
				const chance = lerp(0.2, 0.8, t);
				if (Math.random() < chance) {
					const gif = await fetchRandomGif();
					if (gif) onText(`\n\n${gif}`);
				}
			}
			send({ type: "done", model: modelName, provider, usage });
		} catch (err) {
			const msg = err instanceof Error ? err.message : JSON.stringify(err) ?? "unknown error";
			console.error("[chat] error:", err);
			try { send({ type: "error", error: msg }); } catch {}
		} finally {
			(config as Record<string, unknown>).LLM_MODEL = origModel;
			try { writer.close(); } catch {}
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
