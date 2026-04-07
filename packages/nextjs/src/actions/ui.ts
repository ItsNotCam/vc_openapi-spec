"use server";

import config from "@greg/shared/core/config";
import { GREG_PROMPT, VERBOSE_PROMPT, CURT_PROMPT } from "@greg/shared/chat";
import { getRetriever } from "@/lib/retriever";

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

export interface ModelInfo {
	id: string;
	name: string;
	provider: "anthropic" | "ollama";
}

const ANTHROPIC_MODELS: ModelInfo[] = [
	{ id: "claude-opus-4-6", name: "Claude Opus 4.6", provider: "anthropic" },
	{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" },
	{ id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", provider: "anthropic" },
];

export async function listModels(): Promise<ModelInfo[]> {
	const models: ModelInfo[] = [];

	if (config.ANTHROPIC_API_KEY) {
		models.push(...ANTHROPIC_MODELS);
	}

	if (config.OLLAMA_URL) {
		try {
			const res = await fetch(`${config.OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
			if (res.ok) {
				const data = await res.json() as { models: Array<{ name: string }> };
				for (const m of data.models ?? []) {
					models.push({ id: m.name, name: m.name, provider: "ollama" });
				}
			}
		} catch {
			// Ollama not available
		}
	}

	return models;
}

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

const SUGGESTION_POOL = [
	"create a new user",
	"list all resources",
	"authenticate with API key",
	"search by query",
	"update an existing record",
	"delete by ID",
	"get resource by ID",
	"paginate results",
	"filter by status",
	"upload a file",
	"download a file",
	"batch operation",
	"webhook configuration",
	"rate limit headers",
	"error response format",
	"streaming response",
];

export async function fetchSuggestions(): Promise<string[]> {
	const shuffled = [...SUGGESTION_POOL].sort(() => Math.random() - 0.5);
	return shuffled.slice(0, 4);
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

export async function getPrompts(): Promise<{ greg: string; verbose: string; curt: string }> {
	return { greg: GREG_PROMPT, verbose: VERBOSE_PROMPT, curt: CURT_PROMPT };
}

// ---------------------------------------------------------------------------
// Greeting GIF
// ---------------------------------------------------------------------------

export async function getGreetingGif(): Promise<{ url: string | null }> {
	if (!config.GIPHY_API_KEY) return { url: null };
	try {
		const queries = ["cat hello", "cat wave", "cat greeting", "anime hello", "cat hi"];
		const q = encodeURIComponent(queries[Math.floor(Math.random() * queries.length)]);
		const res = await fetch(
			`https://api.giphy.com/v1/stickers/search?api_key=${config.GIPHY_API_KEY}&q=${q}&limit=10&rating=g&lang=en`,
			{ signal: AbortSignal.timeout(5000) },
		);
		if (!res.ok) return { url: null };
		const data = await res.json() as { data: Array<{ images: { original: { url: string } } }> };
		const match = data.data?.[Math.floor(Math.random() * (data.data?.length ?? 1))];
		return { url: match?.images?.original?.url ?? null };
	} catch {
		return { url: null };
	}
}

// ---------------------------------------------------------------------------
// Chat title
// ---------------------------------------------------------------------------

export async function generateTitle(prompt: string): Promise<{ title: string }> {
	const fallback = { title: prompt.slice(0, 50) };
	const instruction = `Summarize this in 4-6 words as a chat title. Reply with ONLY the title, no punctuation:\n\n${prompt}`;

	// Try Ollama first
	if (config.OLLAMA_URL) {
		try {
			const model = config.OLLAMA_CHAT_SUMMARY_MODEL || config.LLM_MODEL;
			const res = await fetch(`${config.OLLAMA_URL}/api/chat`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model,
					messages: [{ role: "user", content: instruction }],
					stream: false,
				}),
				signal: AbortSignal.timeout(10_000),
			});
			if (res.ok) {
				const data = await res.json() as { message: { content: string } };
				const title = data.message?.content?.trim().slice(0, 60);
				if (title) return { title };
			}
		} catch {
			// fallthrough to Anthropic
		}
	}

	// Try Anthropic
	if (config.ANTHROPIC_API_KEY) {
		try {
			const { default: Anthropic } = await import("@anthropic-ai/sdk");
			const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
			const msg = await client.messages.create({
				model: "claude-haiku-4-5-20251001",
				max_tokens: 32,
				messages: [{ role: "user", content: instruction }],
			});
			const text = msg.content.find((b: { type: string }) => b.type === "text");
			const title = (text as { text?: string } | undefined)?.text?.trim().slice(0, 60);
			if (title) return { title };
		} catch {
			// fallthrough
		}
	}

	return fallback;
}

// ---------------------------------------------------------------------------
// Spec file listing (for SettingsPage ingest suggestions)
// ---------------------------------------------------------------------------

import fs from "fs";
import path from "path";

const SPECS_DIR = process.env.SPECS_DIR ?? path.resolve(process.cwd(), "../../specs");

export async function listSpecFiles(): Promise<Array<{ url: string; name: string }>> {
	if (!fs.existsSync(SPECS_DIR)) return [];
	const SIZE_WARN_BYTES = 10 * 1024 * 1024;
	const entries = fs.readdirSync(SPECS_DIR).sort();
	const specs: Array<{ url: string; name: string }> = [];

	for (const filename of entries) {
		const ext = path.extname(filename);
		if (![".yaml", ".yml", ".json"].includes(ext)) continue;
		const name = path.basename(filename, ext);
		const filePath = path.join(SPECS_DIR, filename);
		const size = fs.statSync(filePath).size;
		let label: string;
		if (size > SIZE_WARN_BYTES) {
			label = `${name} (${Math.floor(size / (1024 * 1024))} MB - large)`;
		} else if (size > 1024 * 1024) {
			label = `${name} (${(size / (1024 * 1024)).toFixed(1)} MB)`;
		} else {
			label = `${name} (${Math.round(size / 1024)} KB)`;
		}
		specs.push({ url: `/openapi/specs/${filename}`, name: label });
	}
	return specs;
}
