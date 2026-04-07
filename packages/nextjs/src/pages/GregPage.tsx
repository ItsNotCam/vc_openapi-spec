"use client";
import React, { useState, useRef, useEffect, useMemo, memo, useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { PrismLight as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import typescript from "react-syntax-highlighter/dist/esm/languages/prism/typescript";
import python from "react-syntax-highlighter/dist/esm/languages/prism/python";
import bash from "react-syntax-highlighter/dist/esm/languages/prism/bash";
import json from "react-syntax-highlighter/dist/esm/languages/prism/json";
import yaml from "react-syntax-highlighter/dist/esm/languages/prism/yaml";
import { METHOD_COLORS } from "../lib/constants";
import { Ic } from "../lib/icons";
import { streamChat, listModels, fetchSuggestions } from "../lib/api";
import type { EndpointCard } from "../lib/api";
import { useStore } from "../store/store";
import type { ChatMsg } from "../store/store";
import EpCard from "../components/EpCard";
import "./GregPage.css";

SyntaxHighlighter.registerLanguage("typescript", typescript);
SyntaxHighlighter.registerLanguage("javascript", typescript);
SyntaxHighlighter.registerLanguage("python", python);
SyntaxHighlighter.registerLanguage("bash", bash);
SyntaxHighlighter.registerLanguage("json", json);
SyntaxHighlighter.registerLanguage("yaml", yaml);


// Per-million-token pricing for Anthropic models (input, output)
const ANTHROPIC_PRICING: Record<string, [number, number]> = {
	"claude-opus-4": [15, 75],
	"claude-sonnet-4": [3, 15],
	"claude-haiku-4-5": [0.80, 4],
	"claude-3-5-sonnet": [3, 15],
	"claude-3-5-haiku": [0.80, 4],
	"claude-3-opus": [15, 75],
};

/** Returns a formatted USD cost string for a Claude API call, or null if the model is unrecognised. */
function estimateCost(model: string | undefined, usage: { input: number; output: number }): string | null {
	if (!model || !model.startsWith("claude")) return null;

	// Match longest key first so "claude-3-5-sonnet" beats "claude-3"
	const key = Object.keys(ANTHROPIC_PRICING)
		.sort((a, b) => b.length - a.length)
		.find((k) => model.startsWith(k));
	if (!key) return null;

	const [inputRate, outputRate] = ANTHROPIC_PRICING[key];
	const cost = (usage.input * inputRate + usage.output * outputRate) / 1_000_000;

	if (cost === 0) return "0.000000";

	// Show 4 significant figures after any leading zeros
	const magnitude = Math.floor(Math.log10(cost));
	const decimals = Math.min(Math.max(2, 2 - magnitude + 3), 8);

	return cost.toFixed(decimals);
}

/** Normalises raw LLM output: strips endpoint tags, unwraps markdown tables from code fences, and converts single newlines to paragraph breaks while preserving code blocks and list structure. */
function cleanText(raw: string): string {
	const text = raw
		.replace(/<endpoint[^>]*\/?>/g, "")
		// Unwrap fenced code blocks that are actually markdown tables
		.replace(/```[^\n]*\n([\s\S]*?)```/g, (match, inner: string) => {
			const lines = inner.trim().split("\n").filter((l: string) => l.trim());
			const isTable = lines.length >= 2 && lines.every((l: string) => l.trimStart().startsWith("|"));
			return isTable ? inner.trim() : match;
		})
		.replace(/\n{3,}/g, "\n\n")
		// Break when colon is immediately followed by a capital letter (no space/newline)
		.replace(/:([A-Z])/g, ":\n\n$1")
		// Break before labeled sections ("Proxmox workflow:", "Darktrace workflow:") after sentence end
		.replace(/([.!?)])\s+([A-Z][a-z]+ \w+:)/g, "$1\n\n$2")
		.trim();

	// Convert single newlines to double (markdown paragraph breaks)
	// but preserve: code blocks, tables, list items, headings
	// Also collapse blank lines inside code blocks (LLMs often add them despite instructions)
	const parts = text.split(/(```[\s\S]*?```)/);
	return parts.map((part, i) => {
		if (i % 2 === 1) {
			// Code block — pass through unchanged, blank lines are intentional
			return part;
		}
		return part.replace(/([^\n])\n([^\n])/g, (_, before, after) => {
			const prevLine = before.split("\n").pop() ?? before;
			if (prevLine.trimStart().startsWith("|") || after.trimStart().startsWith("|")) return `${before}\n${after}`;
			if (/^[-*\d#>]/.test(after.trimStart())) return `${before}\n${after}`;
			if (prevLine.trimStart().startsWith("|---")) return `${before}\n${after}`;
			return `${before}\n\n${after}`;
		});
	}).join("");
}

/** Icon button that copies text to the clipboard and briefly shows a checkmark on success. */
function CopyBtn({ text }: { text: string }) {
	const [copied, setCopied] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout>>();

	const handleClick = () => {
		navigator.clipboard?.writeText(text);
		setCopied(true);
		clearTimeout(timer.current);
	};

	const handleLeave = () => {
		if (!copied) return;
		timer.current = setTimeout(() => setCopied(false), 1000);
	};

	const handleEnter = () => {
		clearTimeout(timer.current);
	};

	return (
		<button
			onClick={handleClick}
			onMouseEnter={handleEnter}
			onMouseLeave={handleLeave}
			className={[
				"flex items-center justify-center border-none cursor-pointer p-2 rounded-md bg-[var(--g-surface-hover)] shrink-0 transition-[color,opacity] duration-150 w-[2.125rem] h-[2.125rem]",
				copied ? "text-[var(--g-green)] opacity-100" : "text-[var(--g-text-dim)] opacity-70",
			].join(" ")}
		>
			{copied ? (
				<svg width={18} height={18} viewBox="0 0 12 12" fill="none">
					<path d="M2 6.5l3 3 5-6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
				</svg>
			) : (
				Ic.copy(18)
			)}
		</button>
	);
}

const PERSONALITY_COLOR: Record<string, string> = {
	greg: "var(--g-green)",
	verbose: "#f59e0b",
	curt: "#A1A1AA",
};

/** Styled container for the chat input area; border colour changes on focus and is tinted by the active personality. */
function InputBoxWrapper({ children, personality }: { children: React.ReactNode; personality: "greg" | "verbose" | "curt" }) {
	const [focused, setFocused] = useState(false);
	const color = PERSONALITY_COLOR[personality];
	const bg = personality === "greg" ? "var(--g-surface)" : personality === "verbose" ? "rgba(245,158,11,0.04)" : "rgba(161,161,170,0.04)";
	return (
		<div
			onFocusCapture={() => setFocused(true)}
			onBlurCapture={() => setFocused(false)}
			className="flex items-center gap-2 rounded-[0.625rem] px-2.5 py-2 transition-[border-color,background] duration-150"
			style={{
				background: bg,
				border: `1px solid ${focused ? color : "var(--g-border)"}`,
			}}
		>
			{children}
		</div>
	);
}

function CodeDropdown({ code, lang, lineCount, blockKey }: { code: string; lang: string; lineCount: number; blockKey: string }) {
	const { open, toggle } = useStore(useShallow((s) => ({ open: !!s.openCodeBlocks[blockKey], toggle: s.toggleCodeBlock })));

	return (
		<div className="my-1.5">
			<div className="flex items-center gap-2">
				<button
					onClick={() => toggle(blockKey)}
					className="collapse-btn text-sm text-[var(--g-accent)] bg-[var(--g-accent-dim)] border border-[var(--g-border-accent)] rounded-md px-3 py-1 flex-1 text-left"
				>
					<span className="font-mono font-medium">code: {lineCount} lines</span>
					<span className={`ml-auto flex transition-transform duration-150 ${open ? "rotate-180" : "rotate-0"}`}>
						<svg width={10} height={10} viewBox="0 0 10 10" fill="none">
							<path d="M2 3.5l3 3 3-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
						</svg>
					</span>
				</button>
				<CopyBtn text={code} />
			</div>
			{open && (
				<div className="mt-1">
					<SyntaxHighlighter style={oneDark} language={lang} PreTag="div" customStyle={{ background: "var(--g-bg)", borderRadius: 6, fontSize: 13, lineHeight: 1.5, padding: "8px 12px", overflowX: "auto" }} codeTagProps={{ style: { background: "var(--g-bg)", fontSize: 13, lineHeight: 1.5, whiteSpace: "pre" } }}>
						{code}
					</SyntaxHighlighter>
				</div>
			)}
		</div>
	);
}

function StreamingText({ text, personality }: { text: string; personality?: "greg" | "verbose" | "curt" }) {
	const dotColor = PERSONALITY_COLOR[personality ?? "greg"] ?? "var(--g-green)";
	const cleaned = cleanText(text);
	if (!cleaned) return (
		<span className="inline-flex items-center gap-1 py-px">
			{[0, 1, 2].map((i) => (
				<span key={i} className="w-1.5 h-1.5 rounded-full inline-block" style={{
					background: dotColor,
					animation: `greg-bounce 1.2s ease-in-out ${i * 0.2}s infinite`,
				}} />
			))}
		</span>
	);
	// Check for an unclosed code block (streaming in progress)
	const openFences = (cleaned.match(/```/g) || []).length;
	const hasUnclosedCode = openFences % 2 === 1;
	if (hasUnclosedCode) {
		// Show text before the code block + "coding..." spinner
		const lastFence = cleaned.lastIndexOf("```");
		const before = cleaned.slice(0, lastFence).trim();
		return (
			<>
				{before && <span className="whitespace-pre-wrap">{before}</span>}
				<div className="flex items-center gap-2 py-2 text-[var(--g-text-dim)]">
					<svg className="animate-spin inline-block w-3.5 h-3.5" width={14} height={14} viewBox="0 0 14 14" fill="none">
						<circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.5" strokeDasharray="20 12" />
					</svg>
					<span className="text-sm italic">coding...</span>
				</div>
			</>
		);
	}
	return <span className="whitespace-pre-wrap">{cleaned}</span>;
}

const METHOD_RE = /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+(\/\S*|$)/;
const PARAM_RE = /(\{[a-zA-Z_][a-zA-Z0-9_]*\}|<[a-zA-Z][a-zA-Z0-9_-]*>)/g;
const PARAM_TEST = /\{[a-zA-Z_][a-zA-Z0-9_]*\}|<[a-zA-Z][a-zA-Z0-9_-]*>/;

function ApiPathCode({ code }: { code: string }) {
	const methodMatch = METHOD_RE.exec(code);
	const method = methodMatch?.[1];
	const path = method ? code.slice(methodMatch![0].length - methodMatch![2].length) : code;
	const mc = method ? (METHOD_COLORS[method] ?? METHOD_COLORS.GET) : null;

	const renderPath = (p: string) => {
		const parts = p.split(PARAM_RE);
		return parts.map((part, i) =>
			PARAM_TEST.test(part)
				? <span key={i} className="text-[#C084FC]">{part}</span>
				: <span key={i} className="text-[var(--g-accent)]">{part}</span>
		);
	};

	return (
		<code className="bg-[var(--g-bg)] py-px px-[0.3125rem] rounded font-mono text-[0.9em]">
			{mc && (
				<span className="font-bold mr-[0.3125rem]" style={{ color: mc.text }}>{method}</span>
			)}
			{renderPath(path)}
		</code>
	);
}

function isApiPath(code: string): boolean {
	if (METHOD_RE.test(code)) return true;
	if (code.startsWith("/") && PARAM_TEST.test(code)) return true;
	return false;
}

function stableKey(s: string): string {
	let h = 0;
	for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
	return String(h >>> 0);
}

const mdComponents = (msgKey: number | string, langMap: Record<string, string>) => ({
	code({ className, children }: { className?: string; children?: React.ReactNode }) {
		const match = /language-(\w+)/.exec(String(className ?? ""));
		const code = String(children ?? "").replace(/\n$/, "");
		if (match || code.includes("\n")) {
			const rawLang = match?.[1] ?? "text";
			const lang = langMap[rawLang] ?? rawLang;
			const lineCount = code.split("\n").length;
			const key = `msg-${msgKey}-${stableKey(code)}`;
			return <CodeDropdown code={code} lang={lang} lineCount={lineCount} blockKey={key} />;
		}
		if (isApiPath(code)) return <ApiPathCode code={code} />;
		return (
			<code className="bg-[var(--g-bg)] py-px px-[0.3125rem] rounded font-mono text-[0.9em] text-[var(--g-accent)]">
				{children as React.ReactNode}
			</code>
		);
	},
	pre({ children }: { children?: React.ReactNode }) { return <>{children as React.ReactNode}</>; },
	p({ children }: { children?: React.ReactNode }) { return <p className="my-[0.625rem]">{children as React.ReactNode}</p>; },
	ul({ children }: { children?: React.ReactNode }) { return <ul className="my-1 pl-[1.125rem]">{children as React.ReactNode}</ul>; },
	ol({ children, node }: { children?: React.ReactNode; node?: { children?: unknown[] } }) {
		const liCount = node?.children?.filter((c: unknown) => c && typeof c === "object" && (c as { tagName?: string }).tagName === "li").length ?? 0;
		if (liCount < 3) return <ol className="my-1 pl-[1.125rem]">{children as React.ReactNode}</ol>;
		// Wrap each li child in a LiDropdown
		let idx = 0;
		const wrapped = React.Children.map(children, (child) => {
			if (child && typeof child === "object" && "type" in (child as React.ReactElement) && (child as React.ReactElement).type === "li") {
				return <LiDropdown index={idx++}>{(child as React.ReactElement).props.children}</LiDropdown>;
			}
			return child;
		});
		return <ol className="my-1 pl-0 list-none">{wrapped}</ol>;
	},
	a({ href, children }: { href?: string; children?: React.ReactNode }) { return <a href={String(href)} className="text-[var(--g-accent)]" target="_blank" rel="noopener noreferrer">{children as React.ReactNode}</a>; },
	img({ src, alt }: { src?: string; alt?: string }) { return <img src={String(src)} alt={String(alt ?? "")} className="max-w-full max-h-[18.75rem] rounded-[0.625rem] mt-1.5 block" />; },
	table({ children }: { children?: React.ReactNode }) { return <div className="overflow-x-auto my-1.5"><table className="border-collapse min-w-full text-sm">{children as React.ReactNode}</table></div>; },
	thead({ children }: { children?: React.ReactNode }) { return <thead className="border-b border-[var(--g-border)]">{children as React.ReactNode}</thead>; },
	th({ children }: { children?: React.ReactNode }) { return <th className="text-left py-1 px-2 text-[var(--g-text)] font-semibold">{children as React.ReactNode}</th>; },
	td({ children }: { children?: React.ReactNode }) { return <td className="py-1 px-2 border-t border-[var(--g-border)] text-[var(--g-text-muted)]">{children as React.ReactNode}</td>; },
});

function LiDropdown({ children, index }: { children?: React.ReactNode; index: number }) {
	const [open, setOpen] = useState(false);
	// Extract first line of text as the summary
	const text = String(
		Array.isArray(children)
			? (typeof children[0] === "string" ? children[0] : children.find((c) => typeof c === "string") ?? "")
			: typeof children === "string" ? children : ""
	).split("\n")[0].slice(0, 80) || `Step ${index + 1}`;
	return (
		<li className="list-none mb-1">
			<button
				onClick={() => setOpen(!open)}
				className="collapse-btn bg-none border-none py-px text-left"
			>
				<span className={`text-[var(--g-text-dim)] text-xs transition-transform duration-150 inline-block ${open ? "rotate-90" : "rotate-0"}`}>▶</span>
				<span className="text-[var(--g-text)] text-[0.9375rem]"><strong>{index + 1}.</strong> {text}</span>
			</button>
			{open && <div className="pl-[1.375rem] text-sm text-[var(--g-text-muted)]">{children as React.ReactNode}</div>}
		</li>
	);
}

function SectionDropdown({ title, body, msgKey, langMap, defaultOpen }: { title: string; body: string; msgKey: number | string; langMap: Record<string, string>; defaultOpen: boolean }) {
	const [open, setOpen] = useState(defaultOpen);
	return (
		<div className="mb-1.5">
			<button
				onClick={() => setOpen(!open)}
				className="collapse-btn bg-none border-none py-1 w-full text-left"
			>
				<span className={`text-[var(--g-text-dim)] text-base transition-transform duration-150 inline-block ${open ? "rotate-90" : "rotate-0"}`}>▶</span>
				<span className="text-[var(--g-text)] font-semibold text-xl">{title}</span>
			</button>
			{open && (
				<div className="pl-[1.125rem] text-sm">
					<ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents(msgKey, langMap) as never}>{body}</ReactMarkdown>
				</div>
			)}
		</div>
	);
}

function GregMarkdown({ text, msgKey }: { text: string; msgKey: number | string }) {
	const langMap: Record<string, string> = { ts: "typescript", js: "javascript", py: "python", sh: "bash", yml: "yaml" };

	// Split into sections by headings — only use dropdowns if 2+ headings
	// Replace code block content with spaces (preserving length) so # comments inside don't match as headings
	const textForScan = text.replace(/```[\s\S]*?```/g, (m) => " ".repeat(m.length));
	const sectionRegex = /^(#{1,3})\s+(.+)$/gm;
	const headings = [...textForScan.matchAll(sectionRegex)];

	if (headings.length >= 2) {
		const sections: { preamble?: string; items: { title: string; body: string }[] } = { items: [] };
		const firstIdx = headings[0].index!;
		if (firstIdx > 0) sections.preamble = text.slice(0, firstIdx).trim();

		for (let i = 0; i < headings.length; i++) {
			const start = headings[i].index! + headings[i][0].length;
			const end = i + 1 < headings.length ? headings[i + 1].index! : text.length;
			sections.items.push({ title: headings[i][2], body: text.slice(start, end).trim() });
		}

		return (
			<>
				{sections.preamble && (
					<ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents(msgKey, langMap) as never}>{sections.preamble}</ReactMarkdown>
				)}
				{sections.items.map((s, i) => (
					<SectionDropdown key={i} title={s.title} body={s.body} msgKey={msgKey} langMap={langMap} defaultOpen={false} />
				))}
			</>
		);
	}

	return (
		<ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents(msgKey, langMap) as never}>
			{text}
		</ReactMarkdown>
	);
}

function EndpointDropdown({ endpoints, onSelect }: { endpoints: EndpointCard[]; onSelect: (ep: EndpointCard) => void }) {
	const [open, setOpen] = useState(false);

	return (
		<div className="mt-1.5">
			<button
				onClick={() => setOpen(!open)}
				className="collapse-btn text-[0.8125rem] text-[var(--g-accent)] bg-[var(--g-accent-dim)] border border-[var(--g-border-accent)] rounded px-2.5 py-1 w-full"
			>
				<span className="flex-1 text-left">
					{`${endpoints.length} endpoint${endpoints.length !== 1 ? "s" : ""} found`}
				</span>
				<span className={`flex transition-transform duration-150 ${open ? "rotate-180" : "rotate-0"}`}>
					<svg width={10} height={10} viewBox="0 0 10 10" fill="none">
						<path d="M2 3.5l3 3 3-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
					</svg>
				</span>
			</button>
			{open && (
				<div className="mt-1 flex flex-col gap-[0.1875rem] max-h-[18.75rem] overflow-auto">
					{[...endpoints].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).map((ep, j) => (
						<EpCard
							key={j}
							method={ep.method}
							path={ep.path}
							api={ep.api}
							description={ep.description}
							warnings={ep.warnings}
							onClick={() => onSelect(ep)}
						/>
					))}
				</div>
			)}
		</div>
	);
}

function DebugPanel({ entries, model, onClose }: { entries: Record<string, unknown>[]; model?: string; onClose: () => void }) {
	const rounds = entries.filter((e) => (e as { event: string }).event === "round");
	const lastRound = rounds[rounds.length - 1] as { totalInput?: number; totalOutput?: number } | undefined;
	const primaryTokens = lastRound ? ((lastRound.totalInput ?? 0) + (lastRound.totalOutput ?? 0)) : 0;
	const toolCallCount = entries.filter((e) => (e as { event: string }).event === "tool_call").length;

	// Verification tokens
	const verifyEntry = entries.find((e) => (e as { event: string }).event === "verification_done") as { inputTokens?: number; outputTokens?: number } | undefined;
	const verifyTokens = verifyEntry ? ((verifyEntry.inputTokens ?? 0) + (verifyEntry.outputTokens ?? 0)) : 0;
	const grandTotal = primaryTokens + verifyTokens;

	const primaryCost = estimateCost(model, {
		input: (lastRound?.totalInput ?? 0),
		output: (lastRound?.totalOutput ?? 0),
	});
	const verifyCost = verifyEntry ? estimateCost("claude-sonnet-4", {
		input: verifyEntry.inputTokens ?? 0,
		output: verifyEntry.outputTokens ?? 0,
	}) : null;
	const totalCostNum = (primaryCost ? parseFloat(primaryCost) : 0) + (verifyCost ? parseFloat(verifyCost) : 0);
	const cost = totalCostNum > 0 ? totalCostNum.toFixed(Math.max(2, 6 - Math.floor(Math.log10(totalCostNum)))) : primaryCost;

	return (
		<div className="w-[18.75rem] shrink-0 border-l border-[var(--g-border)] flex flex-col bg-[var(--g-surface)] min-h-0 overflow-hidden">
			{/* Header */}
			<div className="px-3.5 py-2.5 border-b border-[var(--g-border)] flex items-center bg-[var(--g-bg)] shrink-0">
				<span className="text-xs font-medium text-[var(--g-text-muted)] flex-1">Debug trace</span>
				<span className="debug-entry text-[var(--g-text-dim)] mr-2">{entries.length} events</span>
				<button onClick={onClose} className="btn-icon p-0.5">{Ic.x(12)}</button>
			</div>

			{/* Scroll area */}
			<div className="flex-1 overflow-y-auto overflow-x-hidden px-3 py-2.5 min-h-0">
				{entries.length === 0 ? (
					<div className="flex-1 flex items-center justify-center text-[var(--g-text-dim)] text-xs">
						No debug data yet
					</div>
				) : (
					<DebugPanelEntries entries={entries} />
				)}
			</div>

			{/* Token bar */}
			<div className="px-3 py-[0.4375rem] border-t border-[var(--g-border)] flex flex-col gap-1 bg-[var(--g-bg)] shrink-0">
				<div className="flex gap-3.5">
					<span className="debug-entry text-[var(--g-text-dim)]">
						primary <span className="text-[var(--g-text-muted)]">{primaryTokens.toLocaleString()}</span>
					</span>
					{verifyTokens > 0 && (
						<span className="debug-entry text-[var(--g-text-dim)]">
							double check <span className="text-[#10b981]">{verifyTokens.toLocaleString()}</span>
						</span>
					)}
					<span className="debug-entry text-[var(--g-text-dim)]">
						<span className="text-[var(--g-text-muted)]">{toolCallCount}</span> tools
					</span>
				</div>
				<div className="flex gap-3.5">
					<span className="debug-entry font-semibold text-[var(--g-text)]">
						total {grandTotal.toLocaleString()} tokens
					</span>
					{cost && (
						<span className="debug-entry text-[var(--g-text-dim)]">
							${cost}
						</span>
					)}
				</div>
			</div>
		</div>
	);
}

function DebugPanelEntries({ entries }: { entries: Record<string, unknown>[] }) {
	const [expandedIdx, setExpandedIdx] = useState<Set<number>>(new Set());

	const toggleExpand = (i: number) => {
		setExpandedIdx((prev) => {
			const next = new Set(prev);
			if (next.has(i)) next.delete(i); else next.add(i);
			return next;
		});
	};

	const rows: React.ReactNode[] = [];
	let currentGroup = "";
	let roundNum = 0;

	for (let i = 0; i < entries.length; i++) {
		const e = entries[i] as Record<string, unknown>;
		const ev = e.event as string;

		if (ev === "round") {
			roundNum++;
			const group = `round ${roundNum}`;
			if (group !== currentGroup) {
				currentGroup = group;
				rows.push(
					<div key={`grp-${i}`} className="debug-group-label">
						{group}
					</div>
				);
			}
			const inTok = (e.inputTokens as number ?? 0).toLocaleString();
			const outTok = (e.outputTokens as number ?? 0).toLocaleString();
			const stop = e.stopReason as string ?? "";
			rows.push(
				<div key={`r-${i}`} className="debug-entry text-[var(--g-accent)] font-medium truncate">
					in:{inTok} out:{outTok} stop:{stop}
				</div>
			);
			continue;
		}

		if (ev === "tool_call") {
			const name = e.name as string;
			const inputStr = JSON.stringify(e.input);
			const full = `${name}(${inputStr})`;
			const truncated = full.length > 80;
			const preview = truncated ? full.slice(0, 80) + "…" : full;
			const expanded = expandedIdx.has(i);
			rows.push(
				<div key={`tc-${i}`} className="debug-entry">
					<span className="text-[var(--g-accent)]">→ </span>
					<span className="text-[var(--g-green)]">{expanded ? full : preview}</span>
					{truncated && (
						<button onClick={() => toggleExpand(i)} className="text-[0.625rem] text-[var(--g-accent)] bg-transparent border-none cursor-pointer pl-1 font-mono">
							{expanded ? "less" : "more"}
						</button>
					)}
				</div>
			);
			continue;
		}

		if (ev === "tool_result") {
			const name = e.name as string;
			const len = (e.resultLength as number ?? 0).toLocaleString();
			const count = e.endpointCount as number ?? 0;
			const resultText = e.resultText as string ?? "";
			const preview = resultText.slice(0, 200);
			const truncated = resultText.length > 200;
			const expanded = expandedIdx.has(i);
			rows.push(
				<div key={`tr-${i}`} className="debug-entry ml-2">
					<span className="text-[var(--g-text-muted)]">← {name}: {len} chars, {count} cards</span>
					<div className="text-[var(--g-text-dim)] whitespace-pre-wrap break-words text-[0.625rem] mt-px">
						{expanded ? resultText : preview}{truncated && !expanded && "…"}
					</div>
					{truncated && (
						<button onClick={() => toggleExpand(i)} className="text-[0.625rem] text-[var(--g-accent)] bg-transparent border-none cursor-pointer pl-0 font-mono">
							{expanded ? "show less" : `show all (${(e.resultLength as number ?? 0).toLocaleString()} chars)`}
						</button>
					)}
				</div>
			);
			continue;
		}

		// Fallback for other event types
		rows.push(
			<div key={`oth-${i}`} className="debug-entry text-[var(--g-text-dim)] truncate">
				{JSON.stringify(e)}
			</div>
		);
	}

	return <>{rows}</>;
}

const BUBBLE_STYLES: Record<string, { bg: string; border: string }> = {
	greg: { bg: "rgba(52,211,153,0.06)", border: "rgba(52,211,153,0.2)" },
	verbose: { bg: "rgba(245,158,11,0.06)", border: "rgba(245,158,11,0.2)" },
	curt: { bg: "rgba(161,161,170,0.06)", border: "rgba(161,161,170,0.2)" },
};

function VerificationBadge({ text, usage, msgKey, streaming }: { text: string; usage?: { input: number; output: number }; msgKey: number | string; streaming?: boolean }) {
	const [open, setOpen] = useState(false);
	const isVerified = text.trim().startsWith("✓");
	const tokenCount = usage ? (usage.input + usage.output) : 0;

	// Still loading
	if (streaming && !text.trim()) {
		return (
			<div className="mt-2.5 px-2.5 py-1.5 flex items-center gap-1.5 text-[0.6875rem] text-[var(--g-text-dim)] border-t border-[var(--g-border)]">
				<svg className="animate-spin" width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
					<path d="M21 12a9 9 0 1 1-6.219-8.56" />
				</svg>
				<span>double checking...</span>
			</div>
		);
	}

	if (!text.trim()) return null;

	// Verified — simple inline badge
	if (isVerified) {
		return (
			<div className="mt-2.5 py-1.5 flex items-center gap-[0.3125rem] text-[0.6875rem] text-[#10b981] border-t border-[var(--g-border)]">
				<svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
				<span>{text.trim()}</span>
				{tokenCount > 0 && <span className="text-[var(--g-text-dim)] text-[0.625rem]">({tokenCount.toLocaleString()} tok)</span>}
			</div>
		);
	}

	// Correction — clickable dropdown
	return (
		<div className="mt-2.5 border-t border-[var(--g-border)]">
			<button
				onClick={() => setOpen(!open)}
				className="flex items-center gap-[0.3125rem] w-full py-2 border-none bg-transparent cursor-pointer text-[0.6875rem] font-semibold text-[#f59e0b] uppercase tracking-[0.5px]"
			>
				<svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
					<path d="M12 9v4m0 4h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
				</svg>
				<span>Corrected by Sonnet</span>
				{tokenCount > 0 && <span className="font-normal text-[var(--g-text-dim)]">{tokenCount.toLocaleString()} tok</span>}
				<span className="flex-1" />
				<svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"
					className={`transition-transform duration-150 ${open ? "rotate-180" : "rotate-0"}`}>
					<path d="M6 9l6 6 6-6" />
				</svg>
			</button>
			{open && (
				<div className="pb-1 text-sm leading-[1.6] text-[var(--g-text-muted)]">
					<GregMarkdown text={cleanText(text)} msgKey={`${msgKey}-verify`} />
				</div>
			)}
		</div>
	);
}

const ChatMessage = memo(function ChatMessage({ msg, i, onSelectEndpoint, onShowDebug, loadingGif }: {
	msg: ChatMsg;
	i: number;
	onSelectEndpoint: (ep: EndpointCard) => void;
	onShowDebug: (idx: number) => void;
	loadingGif?: string | null;
}) {
	const p = msg.personality ?? "greg";
	const bubbleStyle = BUBBLE_STYLES[p] ?? BUBBLE_STYLES.greg;
	return (
		<div className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
			<div className="max-w-[85%]">
				{msg.role === "assistant" && (
					<div className="flex items-center gap-2 mb-1.5">
						<span className="text-[0.8125rem] font-medium" style={{ color: PERSONALITY_COLOR[p] }}>greg</span>
						{msg.model && (
							<span className="text-[0.6875rem] text-[var(--g-text-dim)] font-mono">{msg.model}</span>
						)}
						{msg.debug && msg.debug.length > 0 && !msg.streaming && (
							<button
								onClick={() => onShowDebug(i)}
								title="Debug trace"
								className="btn-icon p-[0.1875rem] ml-0.5 opacity-60 hover:opacity-100 hover:text-[var(--g-accent)]"
							>
								{Ic.bug(12)}
							</button>
						)}
					</div>
				)}
				<div
					className={`px-3.5 py-3 text-sm leading-[1.6] ${msg.role === "user" ? "rounded-[12px_12px_2px_12px]" : "rounded-[0.625rem]"}`}
					style={{
						background: msg.role === "user" ? "var(--g-user-bg)" : bubbleStyle.bg,
						border: `1px solid ${msg.role === "user" ? "var(--g-border-accent)" : bubbleStyle.border}`,
						color: msg.role === "user" ? "var(--g-text)" : "var(--g-text-muted)",
					}}
				>
					{msg.role === "user" ? (
						msg.text
					) : msg.streaming ? (
						<>
							{loadingGif && !msg.text && (
								<img src={loadingGif} alt="greg thinking" className="max-h-[180px] max-w-full rounded-lg mb-1.5 block" />
							)}
							<StreamingText text={msg.text} personality={msg.personality} />
						</>
					) : (
						<GregMarkdown text={cleanText(msg.text)} msgKey={i} />
					)}
					{(msg.verificationText !== undefined || msg.verificationStreaming) && (
						<VerificationBadge text={msg.verificationText ?? ""} usage={msg.verificationUsage} msgKey={i} streaming={msg.verificationStreaming} />
					)}
				</div>
				{msg.endpoints && msg.endpoints.length > 0 && (
					<EndpointDropdown endpoints={msg.endpoints} onSelect={onSelectEndpoint} />
				)}
			</div>
		</div>
	);
});

function SwaggerPanel({ item, type, onClose }: { item: { method?: string; path?: string; api: string; name?: string }; type: "endpoints" | "schemas"; onClose: () => void }) {
	const theme = useStore((s) => s.theme);
	const isDark = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
	const initWidth = useMemo(() => {
		try { const v = parseInt(localStorage.getItem("greg-panel-width") ?? ""); return v > 200 ? v : 480; } catch { return 480; }
	}, []);
	const containerRef = useRef<HTMLDivElement>(null);
	const handleRef = useRef<HTMLDivElement>(null);

	const onMouseDown = useCallback((e: React.MouseEvent) => {
		e.preventDefault();
		const container = containerRef.current;
		const handle = handleRef.current;
		if (!container) return;
		const startX = e.clientX;
		const startW = container.offsetWidth;
		// Show overlay to block iframe from eating events
		const overlay = document.createElement("div");
		overlay.style.cssText = "position:fixed;inset:0;z-index:9999;cursor:col-resize;";
		document.body.appendChild(overlay);
		if (handle) { handle.style.background = "var(--g-accent)"; handle.style.opacity = "1"; }

		const onMove = (ev: MouseEvent) => {
			const delta = startX - ev.clientX;
			const next = Math.max(280, Math.min(window.innerWidth * 0.7, startW + delta));
			container.style.width = next + "px";
		};
		const onUp = () => {
			document.removeEventListener("mousemove", onMove);
			document.removeEventListener("mouseup", onUp);
			overlay.remove();
			document.body.style.cursor = "";
			document.body.style.userSelect = "";
			if (handle) { handle.style.background = ""; handle.style.opacity = ""; }
			try { localStorage.setItem("greg-panel-width", String(container.offsetWidth)); } catch {}
		};
		document.addEventListener("mousemove", onMove);
		document.addEventListener("mouseup", onUp);
		document.body.style.cursor = "col-resize";
		document.body.style.userSelect = "none";
	}, []);

	const isEp = type === "endpoints" && item.method && item.path;
	const iframeRef = useRef<HTMLIFrameElement>(null);
	const loadedApiRef = useRef<string>("");

	// Build iframe src — only changes when the API name or theme changes
	const baseSrc = useMemo(() => {
		const params = new URLSearchParams();
		if (isEp) {
			params.set("method", item.method!);
			params.set("path", item.path!);
		}
		params.set("theme", isDark ? "dark" : "light");
		return `/openapi/docs/${encodeURIComponent(item.api)}?${params}`;
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [item.api, isDark]);

	// When the item changes but we're on the same API, postMessage to scroll instead of reloading
	useEffect(() => {
		if (!isEp) return;
		if (loadedApiRef.current === item.api && iframeRef.current?.contentWindow) {
			iframeRef.current.contentWindow.postMessage(
				{ type: "scrollToEndpoint", method: item.method, path: item.path },
				"*",
			);
		}
	}, [item.method, item.path, item.api, isEp]);

	// Track which API the iframe has loaded
	const onIframeLoad = useCallback(() => {
		loadedApiRef.current = item.api;
	}, [item.api]);

	return (
		<div ref={containerRef} className="shrink-0 flex relative h-full" style={{ width: initWidth }}>
			{/* Drag handle */}
			<div
				onMouseDown={onMouseDown}
				className="w-2 cursor-col-resize shrink-0 flex items-center justify-center"
			>
				<div ref={handleRef} className="w-[0.1875rem] h-9 rounded-[0.125rem] bg-[var(--g-text-dim)] opacity-50" />
			</div>
			{/* Panel content */}
			<div className="flex-1 flex flex-col min-w-0">
				{/* Header */}
				<div className="flex items-center gap-2 px-2.5 py-2 bg-[var(--g-surface)] border-b border-[var(--g-border)] rounded-t-md">
					<span className="text-xs font-semibold text-[var(--g-text-dim)] uppercase tracking-[0.05em]">
						{isEp ? "Endpoint" : "Schema"} — {item.api}
					</span>
					<span className="flex-1" />
					<button
						onClick={onClose}
						className="btn-icon p-[0.1875rem]"
					>
						{Ic.x()}
					</button>
				</div>
				{/* Swagger iframe */}
				<iframe
					ref={iframeRef}
					src={baseSrc}
					onLoad={onIframeLoad}
					className="flex-1 border border-[var(--g-border)] border-t-0 rounded-b-md bg-[var(--g-surface)] w-full"
					title={`${item.api} docs`}
				/>
			</div>
		</div>
	);
}

const GREG_GREETINGS = [
	"greg here. what api u need",
	"yo. greg ready. ask greg thing",
	"greg online. u need endpoint or what",
	"greg awake. what u looking for",
	"sup. greg know ur apis. ask",
	"greg here. tell greg what u need",
	"ok greg ready. go",
];

function getGreeting(personality: "greg" | "verbose" | "curt"): string {
	if (personality === "verbose") return "Ready to explain your APIs in depth. What would you like to understand?";
	if (personality === "curt") return "What can I help you with?";
	return GREG_GREETINGS[Math.floor(Math.random() * GREG_GREETINGS.length)];
}

export default function GregPage() {
	const {
		chatMessages,
		personality,
		chatLoading,
		addChatMessage,
		updateLastAssistant,
		setPersonality,
		setChatLoading,
		detailItem,
		detailType,
		setDetail,
		customGregPrompt,
		customExplainerPrompt,
		customProPrompt,
		selectedModel,
		selectedProvider,
		setModel,
		chatHistory,
		newChat,
		loadChat,
		deleteChat,
		saveChat,
		setDoubleCheck,
	} = useStore(useShallow((s) => ({
		chatMessages: s.chatMessages,
		personality: s.personality,
		chatLoading: s.chatLoading,
		addChatMessage: s.addChatMessage,
		updateLastAssistant: s.updateLastAssistant,
		setPersonality: s.setPersonality,
		setChatLoading: s.setChatLoading,
		detailItem: s.detailItem,
		detailType: s.detailType,
		setDetail: s.setDetail,
		customGregPrompt: s.customGregPrompt,
		customExplainerPrompt: s.customExplainerPrompt,
		customProPrompt: s.customProPrompt,
		selectedModel: s.selectedModel,
		selectedProvider: s.selectedProvider,
		setModel: s.setModel,
		chatHistory: s.chatHistory,
		newChat: s.newChat,
		loadChat: s.loadChat,
		deleteChat: s.deleteChat,
		saveChat: s.saveChat,
		setDoubleCheck: s.setDoubleCheck,
	})));
	const doubleCheck = false; // disabled

	const isGregLike = personality === "greg";

	const [greetingGif, setGreetingGif] = useState<string | null>(null);
	const [loadingGif, setLoadingGif] = useState<string | null>(null);
	const [greeting, setGreetingText] = useState<string>("");
	const [models, setModels] = useState<Array<{ id: string; name: string; provider: string }>>([]);
	const [sidebarOpen, setSidebarOpen] = useState(true);
	const [debugMsgIdx, setDebugMsgIdx] = useState<number | null>(null);
	const [suggestions, setSuggestions] = useState<string[]>([]);
	const abortRef = useRef<AbortController | null>(null);

	useEffect(() => { listModels().then(setModels).catch(() => {}); }, []);
	useEffect(() => { fetchSuggestions().then(setSuggestions).catch(() => {}); }, []);
	useEffect(() => { setGreetingText(getGreeting(personality)); }, [personality]);

	const fetchGreetingGif = useCallback(() => {
		fetch("/api/greeting-gif").then((r) => r.json()).then((d) => setGreetingGif(d.url ?? null)).catch(() => {});
	}, []);

	// Fetch greeting gif on initial mount
	useEffect(() => { if (isGregLike) fetchGreetingGif(); }, []);

	const handleNewChat = useCallback(() => {
		newChat();
		setGreetingGif(null);
		fetchSuggestions().then(setSuggestions).catch(() => {});
		if (isGregLike) fetchGreetingGif();
	}, [isGregLike, newChat, fetchGreetingGif]);

	const handleSelectEndpoint = useCallback((ep: EndpointCard) => setDetail(ep, "endpoints"), [setDetail]);
	const [input, setInput] = useState("");
	const messagesEndRef = useRef<HTMLDivElement>(null);
	const scrollContainerRef = useRef<HTMLDivElement>(null);
	const [userScrolled, setUserScrolled] = useState(false);
	const userScrolledRef = useRef(false);

	// Check if user has scrolled up — use ref to avoid re-render storms
	const handleScroll = useCallback(() => {
		const el = scrollContainerRef.current;
		if (!el) return;
		const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
		if (userScrolledRef.current !== !atBottom) {
			userScrolledRef.current = !atBottom;
			setUserScrolled(!atBottom);
		}
	}, []);

	// Auto-scroll only if user hasn't scrolled up
	useEffect(() => {
		if (!userScrolledRef.current) {
			messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
		}
	}, [chatMessages]);

	const scrollToBottom = () => {
		messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
		userScrolledRef.current = false;
		setUserScrolled(false);
	};

	const handleSend = async (overrideText?: string) => {
		const text = (overrideText ?? input).trim();
		if (!text || chatLoading) return;

		setInput("");
		setUserScrolled(false);
		setLoadingGif(null);
		addChatMessage({ role: "user", text, personality });
		addChatMessage({ role: "assistant", text: "", streaming: true, model: selectedModel || undefined, personality });
		setChatLoading(true);
		if (isGregLike) {
			fetch("/api/greeting-gif").then((r) => r.json()).then((d) => setLoadingGif(d.url ?? null)).catch(() => {});
		}

		const history = [
			...chatMessages.map((m) => ({ role: m.role, content: m.text })),
			{ role: "user" as const, content: text },
		];

		let accumulated = "";
		let verificationText = "";
		let doneModel: string | undefined;
		let doneUsage: { input: number; output: number; toolCalls: number } | undefined;
		let doneVerificationUsage: { input: number; output: number } | undefined;
		const endpointMap = new Map<string, EndpointCard>();
		const debugLog: Record<string, unknown>[] = [];

		try {
			const customPrompt = personality === "greg" ? customGregPrompt : personality === "verbose" ? customExplainerPrompt : customProPrompt;
			const abort = new AbortController();
			abortRef.current = abort;
			for await (const event of streamChat(
				history,
				personality,
				{ systemPrompt: customPrompt || undefined, model: selectedModel || undefined, provider: selectedProvider || undefined, doubleCheck: doubleCheck || undefined },
				abort.signal,
			)) {
				switch (event.type) {
					case "text":
						accumulated += event.text ?? "";
						updateLastAssistant((m) => ({ ...m, text: accumulated }));
						break;
					case "endpoints":
						// Deduplicate by method+path, keep highest score
						for (const ep of event.data ?? []) {
							const key = `${ep.method}:${ep.path}:${ep.api}`;
							const existing = endpointMap.get(key);
							if (!existing || (ep.score ?? 0) > (existing.score ?? 0)) {
								endpointMap.set(key, ep);
							}
						}
						break;
					case "verification_text":
						// Arrives as one complete message (not streamed)
						verificationText = event.text ?? "";
						updateLastAssistant((m) => ({ ...m, verificationText, verificationStreaming: false }));
						break;
					case "error":
						accumulated += `\n[error: ${event.error}]`;
						updateLastAssistant((m) => ({ ...m, text: accumulated }));
						break;
					case "debug":
						debugLog.push(event as unknown as Record<string, unknown>);
						if (event.event === "verification_start") {
							// Greg is done, verification is starting — render Greg's markdown, show checking indicator
							const eps = [...endpointMap.values()];
							updateLastAssistant((m) => ({
								...m,
								streaming: false,
								endpoints: eps.length > 0 ? eps : m.endpoints,
								verificationStreaming: true,
								verificationText: "",
							}));
						}
						break;
					case "done":
						doneModel = event.model;
						doneUsage = event.usage ? { ...event.usage, toolCalls: (event.usage as { toolCalls?: number }).toolCalls ?? 0 } : undefined;
						doneVerificationUsage = (event as { verificationUsage?: { input: number; output: number } }).verificationUsage;
						break;
				}
			}
		} catch (err) {
			accumulated += `\n[connection error]`;
			updateLastAssistant((m) => ({ ...m, text: accumulated }));
		}

		abortRef.current = null;
		const dedupedEndpoints = [...endpointMap.values()];
		updateLastAssistant((m) => ({
			...m,
			streaming: false,
			verificationStreaming: false,
			endpoints: dedupedEndpoints.length > 0 ? dedupedEndpoints : undefined,
			model: doneModel,
			usage: doneUsage,
			verificationUsage: doneVerificationUsage,
			verificationText: verificationText || undefined,
			debug: debugLog.length > 0 ? debugLog : undefined,
		}));
		saveChat();
		setChatLoading(false);
	};

	const handleSuggestion = (q: string) => { handleSend(q); };

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			handleSend();
		}
	};

	return (
		<div className="px-6 py-5 h-[calc(100%-3.5rem)] flex flex-col">
			{/* Chat header */}
			<div className="flex items-center gap-4 mb-5 shrink-0">
				<div
					className="w-[2.625rem] h-[2.625rem] rounded-[0.625rem] flex items-center justify-center shrink-0 transition-[background] duration-150"
					style={{ background: PERSONALITY_COLOR[personality] }}
				>
					<svg width={26} height={26} viewBox="0 0 20 20" fill="none">
						<circle cx="7" cy="8" r="1.4" fill="white"/>
						<circle cx="13" cy="8" r="1.4" fill="white"/>
						<path d="M6.5 13.5h7" stroke="white" strokeWidth="1.8" strokeLinecap="round"/>
					</svg>
				</div>
				<span className="text-[1.375rem] font-semibold transition-colors duration-150" style={{ color: PERSONALITY_COLOR[personality] }}>greg</span>
				<span className="text-[0.8125rem] text-[var(--g-text-dim)]">{personality === "greg" ? "casual · finds endpoints fast" : personality === "curt" ? "minimal · straight answers" : "thorough · explains how & why"}</span>
				<span className="flex-1" />

				{/* Personality selector */}
				<div className="flex items-center text-sm h-9 rounded-lg bg-[var(--g-surface)] border border-[var(--g-border)] overflow-hidden">
					{(["greg", "curt", "verbose"] as const).map((p) => (
						<div
							key={p}
							onClick={() => setPersonality(p)}
							className="px-3 h-full flex items-center cursor-pointer transition-all duration-150"
							style={{
								color: personality === p ? (p === "greg" ? "var(--g-green)" : p === "verbose" ? "#f59e0b" : "var(--g-accent)") : "var(--g-text-dim)",
								background: personality === p ? (p === "greg" ? "rgba(52,211,153,0.1)" : p === "verbose" ? "rgba(245,158,11,0.1)" : "rgba(161,161,170,0.1)") : "transparent",
								fontWeight: personality === p ? 600 : 400,
								borderRight: p !== "verbose" ? "1px solid var(--g-border)" : "none",
							}}
						>
							{p}
						</div>
					))}
				</div>

				{/* Model picker */}
				<select
					value={selectedModel || ""}
					onChange={(e) => {
						const m = models.find((x) => x.id === e.target.value);
						if (m) setModel(m.id, m.provider);
					}}
					className="h-9 px-2.5 bg-[var(--g-surface)] border border-[var(--g-border)] rounded-lg text-sm text-[var(--g-text-muted)]"
				>
					<option value="">Default model</option>
					{models.filter((m) => m.provider === "anthropic").length > 0 && (
						<optgroup label="Anthropic">
							{models.filter((m) => m.provider === "anthropic").map((m) => (
								<option key={m.id} value={m.id}>{m.name}</option>
							))}
						</optgroup>
					)}
					{models.filter((m) => m.provider === "ollama").length > 0 && (
						<optgroup label="Ollama">
							{models.filter((m) => m.provider === "ollama").map((m) => (
								<option key={m.id} value={m.id}>{m.name}</option>
							))}
						</optgroup>
					)}
				</select>

				{/* Double-check toggle — disabled */}

				{/* History */}
				<button
					onClick={() => setSidebarOpen(!sidebarOpen)}
					title="Chat history"
					className={[
						"flex items-center gap-[0.3125rem] cursor-pointer px-2.5 py-1.5 rounded-lg text-[0.6875rem] font-medium",
						sidebarOpen
							? "border border-[var(--g-border-accent)] bg-[var(--g-accent-dim)] text-[var(--g-accent)]"
							: "border border-[var(--g-border)] bg-[var(--g-surface)] text-[var(--g-text-dim)]",
					].join(" ")}
				>
					<svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
					<span>History</span>
				</button>
			</div>

			{/* Main layout: sidebar + chat */}
			<div className="flex flex-1 min-h-0">

			{/* Chat history sidebar */}
			{sidebarOpen && (
				<div className="w-[16.25rem] shrink-0 bg-[var(--g-surface)] border-r border-[var(--g-border)] overflow-auto px-2.5 py-3">
					<div className="flex items-center mb-2.5">
						<span className="text-[0.9375rem] font-semibold text-[var(--g-text)] flex-1">History</span>
						<button onClick={handleNewChat} className="btn-icon p-1 text-[var(--g-accent)]" title="New chat">
							{Ic.plus(14)}
						</button>
						<button onClick={() => setSidebarOpen(false)} className="btn-icon p-1">
							{Ic.x(14)}
						</button>
					</div>
					{chatHistory.length === 0 && (
						<span className="text-[0.8125rem] text-[var(--g-text-dim)]">No chats yet</span>
					)}
					{chatHistory.map((chat) => {
						const isActive = chat.id === useStore.getState().activeChatId;
						return (
							<div
								key={chat.id}
								onClick={() => loadChat(chat.id)}
								className="flex items-center gap-1.5 px-2 py-1.5 rounded-md cursor-pointer mb-0.5 transition-colors duration-100"
								style={{
									background: isActive ? "var(--g-surface-active)" : "transparent",
									borderLeft: isActive ? "2px solid var(--g-accent)" : "2px solid transparent",
								}}
								onMouseEnter={(e) => { if (!isActive) (e.currentTarget as HTMLElement).style.background = "var(--g-surface-hover)"; }}
								onMouseLeave={(e) => { if (!isActive) (e.currentTarget as HTMLElement).style.background = "transparent"; }}
							>
								<span className="text-[0.8125rem] text-[var(--g-text)] flex-1 truncate">
									{chat.title}
								</span>
								<button
									onClick={(e) => { e.stopPropagation(); deleteChat(chat.id); }}
									className="btn-icon p-0.5 shrink-0 opacity-50"
								>
									{Ic.x(11)}
								</button>
							</div>
						);
					})}
				</div>
			)}

			{/* Main area */}
			<div className="flex-1 min-w-0 flex flex-col px-5">
			<div className="flex gap-5 flex-1 min-h-0">
				{/* Messages */}
				<div className="flex-1 min-w-0 flex flex-col relative">
					<div ref={scrollContainerRef} onScroll={handleScroll} className="flex-1 overflow-auto flex flex-col gap-3 relative">
						{chatMessages.length === 0 && (
							<div className="flex-1 flex items-center justify-center flex-col gap-4 text-[var(--g-text-dim)]">
								<div
									className="w-20 h-20 rounded-2xl flex items-center justify-center transition-[background] duration-150"
									style={{ background: PERSONALITY_COLOR[personality] }}
								>
									<svg width={50} height={50} viewBox="0 0 20 20" fill="none">
										<circle cx="7" cy="8" r="1.4" fill="white"/>
										<circle cx="13" cy="8" r="1.4" fill="white"/>
										<path d="M6.5 13.5h7" stroke="white" strokeWidth="1.8" strokeLinecap="round"/>
									</svg>
								</div>
								{isGregLike && (
									<img src="https://media0.giphy.com/media/v1.Y2lkPWM4MWI4ODBkMnl2cmJ4ODFic3pwcjNqdGx4eTd0NWZqeHR1Z21jZXk0dmc2NzByeiZlcD12MV9zdGlja2Vyc19zZWFyY2gmY3Q9cw/j0HjChGV0J44KrrlGv/giphy.gif" alt="greg" className="max-h-[45rem] rounded-xl" />
								)}
								<span className="text-2xl">
									{greeting}
								</span>
								{suggestions.length > 0 && (
									<div className="flex flex-wrap gap-2 justify-center max-w-[35rem]">
										{suggestions.map((s, i) => (
											<button
												key={i}
												onClick={() => handleSuggestion(s)}
												className="text-[0.8125rem] text-[var(--g-text-muted)] bg-[var(--g-surface)] border border-[var(--g-border)] rounded-[1.25rem] px-3.5 py-1.5 cursor-pointer transition-[border-color,color] duration-150 hover:border-[var(--g-border-accent)] hover:text-[var(--g-text)]"
											>
												{s}
											</button>
										))}
									</div>
								)}
							</div>
						)}
						{chatMessages.map((msg, i) => (
							<ChatMessage key={i} msg={msg} i={i} onSelectEndpoint={handleSelectEndpoint} onShowDebug={setDebugMsgIdx} loadingGif={msg.streaming ? loadingGif : null} />
						))}
						<div ref={messagesEndRef} />
					</div>

					{/* Scroll to bottom button */}
					{userScrolled && (
						<button
							onClick={scrollToBottom}
							className="absolute bottom-[5.625rem] left-1/2 -translate-x-1/2 flex items-center gap-1.5 px-4 py-2 rounded-[1.25rem] border border-[var(--g-border-accent)] bg-[var(--g-surface)] text-[var(--g-accent)] cursor-pointer text-sm shadow-[0_4px_16px_rgba(0,0,0,0.3)] z-10"
						>
							<svg width={14} height={14} viewBox="0 0 14 14" fill="none">
								<path d="M3 5.5l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
							</svg>
							Scroll to bottom
						</button>
					)}

					{/* Input */}
					<div className="mt-3 shrink-0">
						<InputBoxWrapper personality={personality}>
						<textarea
							rows={1}
							placeholder={isGregLike ? "talk to greg..." : "Search API documentation..."}
							value={input}
							onChange={(e) => { setInput(e.target.value); const t = e.target; t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 120) + "px"; }}
							onKeyDown={handleKeyDown}
							className="flex-1 bg-transparent border-none outline-none text-[0.8125rem] text-[var(--g-text)] resize-none font-[inherit] leading-[1.5] min-h-5 p-0"
						/>
						{chatLoading ? (
							<button
								onClick={() => { abortRef.current?.abort(); abortRef.current = null; setChatLoading(false); updateLastAssistant((m) => ({ ...m, streaming: false })); saveChat(); }}
								className="chat-action-btn bg-[rgba(248,113,113,0.1)] text-[#F87171]"
							>
								<svg width={14} height={14} viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="3" width="10" height="10" rx="2" /></svg>
							</button>
						) : (
							<button
								onClick={() => handleSend()}
								className="chat-action-btn bg-[var(--g-accent-muted)] text-[var(--g-accent)]"
							>
								{Ic.send(14)}
							</button>
						)}
					</InputBoxWrapper>
					</div>
				</div>

				{/* Detail panel — Swagger iframe */}
				{detailItem && (
					<SwaggerPanel item={detailItem as never} type={detailType} onClose={() => setDetail(null)} />
				)}
			</div>
			</div>

			{/* Debug panel — sibling to main area, right edge of the top-level flex row */}
			{debugMsgIdx !== null && (() => {
				const msg = chatMessages[debugMsgIdx];
				return msg ? <DebugPanel entries={msg.debug ?? []} model={msg.model} onClose={() => setDebugMsgIdx(null)} /> : null;
			})()}
			</div>
		</div>
	);
}
