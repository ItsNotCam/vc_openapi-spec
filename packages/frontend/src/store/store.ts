import { create } from "zustand";
import { generateTitle } from "../lib/api";
import type { ApiInfo, SearchResult, EndpointCard } from "../lib/api";

// ---------------------------------------------------------------------------
// Chat message with optional endpoint cards
// ---------------------------------------------------------------------------

export interface ChatMsg {
	role: "user" | "assistant";
	text: string;
	endpoints?: EndpointCard[];
	streaming?: boolean;
	model?: string;
	personality?: "greg" | "verbose" | "curt";
	usage?: { input: number; output: number; toolCalls: number };
	verificationUsage?: { input: number; output: number };
	verificationText?: string;
	verificationStreaming?: boolean;
	debug?: Record<string, unknown>[];
}

// ---------------------------------------------------------------------------
// Ingest job
// ---------------------------------------------------------------------------

export interface IngestJob {
	id: string;
	apiName: string;
	status: "queued" | "running" | "done" | "error";
	message: string;
	done?: number;
	total?: number;
}

let jobIdCounter = 0;
export function nextJobId(): string {
	return `job-${++jobIdCounter}`;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export type ThemePref = "light" | "dark" | "system";

function getStoredTheme(): ThemePref {
	try { return (localStorage.getItem("greg-theme") as ThemePref) ?? "system"; } catch { return "system"; }
}

function applyTheme(pref: ThemePref) {
	const isDark = pref === "dark" || (pref === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
	document.documentElement.classList.toggle("light", !isDark);
	try { localStorage.setItem("greg-theme", pref); } catch {}
}

// Apply on load immediately (before React renders)
applyTheme(getStoredTheme());

interface AppState {
	// Theme
	theme: ThemePref;
	setTheme: (t: ThemePref) => void;

	// Navigation
	page: "greg" | "search" | "docs" | "settings";
	setPage: (p: "greg" | "search" | "docs" | "settings") => void;

	// APIs metadata
	apis: ApiInfo[];
	setApis: (a: ApiInfo[]) => void;

	// Docs tab
	docsApi: string;
	docsAnchor: { method: string; path: string; operationId?: string; tag?: string } | null;
	setDocsApi: (api: string) => void;
	viewDocs: (api: string, method: string, path: string, operationId?: string, tag?: string) => void;

	// Chat
	chatMessages: ChatMsg[];
	personality: "greg" | "verbose" | "curt";
	chatLoading: boolean;
	selectedModel: string;
	selectedProvider: string;
	setChatMessages: (msgs: ChatMsg[]) => void;
	addChatMessage: (msg: ChatMsg) => void;
	updateLastAssistant: (updater: (msg: ChatMsg) => ChatMsg) => void;
	setPersonality: (v: "greg" | "verbose" | "curt") => void;
	setChatLoading: (v: boolean) => void;
	setModel: (model: string, provider: string) => void;
	clearChat: () => void;

	// Chat history
	chatHistory: Array<{ id: string; title: string; messages: ChatMsg[]; ts: number }>;
	activeChatId: string | null;
	saveChat: () => void;
	loadChat: (id: string) => void;
	deleteChat: (id: string) => void;
	newChat: () => void;

	// Double check (verification pass)
	doubleCheck: boolean;
	setDoubleCheck: (v: boolean) => void;

	// Custom system prompt
	customGregPrompt: string;
	customExplainerPrompt: string;
	customProPrompt: string;
	setCustomGregPrompt: (v: string) => void;
	setCustomExplainerPrompt: (v: string) => void;
	setCustomProPrompt: (v: string) => void;

	// Ingest jobs
	ingestJobs: IngestJob[];
	addIngestJob: (job: IngestJob) => void;
	updateIngestJob: (id: string, updates: Partial<IngestJob>) => void;
	removeIngestJob: (id: string) => void;
	clearDoneJobs: () => void;

	// Code dropdown open states (persists across re-renders)
	openCodeBlocks: Record<string, boolean>;
	toggleCodeBlock: (key: string) => void;

	// Search
	searchResults: SearchResult[];
	setSearchResults: (r: SearchResult[]) => void;

	// Detail panel
	detailItem: SearchResult | EndpointCard | null;
	detailType: "endpoints" | "schemas";
	setDetail: (item: SearchResult | EndpointCard | null, type?: "endpoints" | "schemas") => void;
}

export const useStore = create<AppState>()((set) => ({
	theme: getStoredTheme(),
	setTheme: (t) => { applyTheme(t); set({ theme: t }); },

	page: "greg",
	setPage: (p) => set({ page: p, docsAnchor: p !== "docs" ? null : undefined }),

	apis: [],
	setApis: (apis) => set({ apis }),

	docsApi: "",
	docsAnchor: null,
	setDocsApi: (api) => set({ docsApi: api, docsAnchor: null }),
	viewDocs: (api, method, path, operationId, tag) => set({ page: "docs", docsApi: api, docsAnchor: { method, path, operationId, tag } }),

	chatMessages: [],
	personality: (() => { try { const v = localStorage.getItem("greg-personality"); return (v === "greg" || v === "verbose" || v === "curt") ? v : localStorage.getItem("greg-mode") === "false" ? "curt" : "greg"; } catch { return "greg" as const; } })(),
	chatLoading: false,
	selectedModel: (() => { try { return localStorage.getItem("greg-model") ?? ""; } catch { return ""; } })(),
	selectedProvider: (() => { try { return localStorage.getItem("greg-provider") ?? ""; } catch { return ""; } })(),
	setChatMessages: (msgs) => set({ chatMessages: msgs }),
	addChatMessage: (msg) => set((s) => ({ chatMessages: [...s.chatMessages, msg] })),
	updateLastAssistant: (updater) =>
		set((s) => {
			const msgs = [...s.chatMessages];
			for (let i = msgs.length - 1; i >= 0; i--) {
				if (msgs[i].role === "assistant") {
					msgs[i] = updater(msgs[i]);
					break;
				}
			}
			return { chatMessages: msgs };
		}),
	setPersonality: (v) => { try { localStorage.setItem("greg-personality", v); } catch {} set({ personality: v }); },
	setChatLoading: (v) => set({ chatLoading: v }),
	setModel: (model, provider) => {
		try { localStorage.setItem("greg-model", model); localStorage.setItem("greg-provider", provider); } catch {}
		set({ selectedModel: model, selectedProvider: provider });
	},
	clearChat: () => set((s) => { s.saveChat(); return { chatMessages: [], chatLoading: false, activeChatId: null }; }),

	chatHistory: (() => { try { return JSON.parse(localStorage.getItem("greg-history") ?? "[]"); } catch { return []; } })(),
	activeChatId: null,
	saveChat: () => set((s) => {
		if (s.chatMessages.length === 0) return {};
		const id = s.activeChatId ?? `chat-${Date.now()}`;
		const userMsg = s.chatMessages.find((m) => m.role === "user")?.text ?? "";
		const title = userMsg.slice(0, 50) || "New chat";
		const existing = s.chatHistory.filter((c) => c.id !== id);
		const history = [{ id, title, messages: s.chatMessages, ts: Date.now() }, ...existing].slice(0, 50);
		try { localStorage.setItem("greg-history", JSON.stringify(history)); } catch {}
		// Generate a better title async
		if (userMsg) {
			generateTitle(userMsg).then((t) => {
				set((cur) => {
					const updated = cur.chatHistory.map((c) => c.id === id ? { ...c, title: t } : c);
					try { localStorage.setItem("greg-history", JSON.stringify(updated)); } catch {}
					return { chatHistory: updated };
				});
			});
		}
		return { chatHistory: history, activeChatId: id };
	}),
	loadChat: (id) => set((s) => {
		const chat = s.chatHistory.find((c) => c.id === id);
		if (!chat) return {};
		return { chatMessages: chat.messages, activeChatId: id };
	}),
	deleteChat: (id) => set((s) => {
		const history = s.chatHistory.filter((c) => c.id !== id);
		try { localStorage.setItem("greg-history", JSON.stringify(history)); } catch {}
		const updates: Partial<AppState> = { chatHistory: history };
		if (s.activeChatId === id) { updates.chatMessages = []; updates.activeChatId = null; }
		return updates;
	}),
	newChat: () => set((s) => { s.saveChat(); return { chatMessages: [], activeChatId: null }; }),

	doubleCheck: (() => { try { return localStorage.getItem("greg-double-check") === "true"; } catch { return false; } })(),
	setDoubleCheck: (v) => { try { localStorage.setItem("greg-double-check", String(v)); } catch {} set({ doubleCheck: v }); },

	customGregPrompt: "",
	customExplainerPrompt: "",
	customProPrompt: "",
	setCustomGregPrompt: (v) => set({ customGregPrompt: v }),
	setCustomExplainerPrompt: (v) => set({ customExplainerPrompt: v }),
	setCustomProPrompt: (v) => set({ customProPrompt: v }),

	ingestJobs: [],
	addIngestJob: (job) => set((s) => ({ ingestJobs: [...s.ingestJobs, job] })),
	updateIngestJob: (id, updates) =>
		set((s) => ({
			ingestJobs: s.ingestJobs.map((j) => (j.id === id ? { ...j, ...updates } : j)),
		})),
	removeIngestJob: (id) => set((s) => ({ ingestJobs: s.ingestJobs.filter((j) => j.id !== id) })),
	clearDoneJobs: () => set((s) => ({ ingestJobs: s.ingestJobs.filter((j) => j.status === "queued" || j.status === "running") })),

	openCodeBlocks: {},
	toggleCodeBlock: (key) => set((s) => ({
		openCodeBlocks: { ...s.openCodeBlocks, [key]: !s.openCodeBlocks[key] },
	})),

	searchResults: [],
	setSearchResults: (r) => set({ searchResults: r }),

	detailItem: null,
	detailType: "endpoints",
	setDetail: (item, type) => set({ detailItem: item, detailType: type ?? "endpoints" }),
}));
