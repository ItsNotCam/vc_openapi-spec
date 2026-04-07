"use client";
import { useState } from "react";
import { PrismLight as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import bash from "react-syntax-highlighter/dist/esm/languages/prism/bash";
import json from "react-syntax-highlighter/dist/esm/languages/prism/json";
SyntaxHighlighter.registerLanguage("bash", bash);
SyntaxHighlighter.registerLanguage("json", json);
import { METHOD_COLORS } from "../lib/constants";
import { Ic } from "../lib/icons";
import ScoreBar from "./ScoreBar";
import { useStore } from "../store/store";

interface DetailItem {
	method?: string;
	path?: string;
	name?: string;
	api: string;
	score?: number;
	description?: string;
	full_text?: string;
	response_schema?: string;
	operation_id?: string;
	tags?: string;
}

function PBadge({ type }: { type: string }) {
	const isPath = type === "path";
	return (
		<span
			className={[
				"text-[0.6875rem] px-[0.4375rem] py-px rounded font-mono uppercase tracking-[0.05em]",
				isPath
					? "bg-[rgba(251,191,36,0.08)] text-[#FBBF24]"
					: "bg-[rgba(129,140,248,0.08)] text-[#818CF8]",
			].join(" ")}
		>
			{type}
		</span>
	);
}

function CodeBlock({ lines, nameColor }: { lines: string[]; nameColor: string }) {
	return (
		<div className="font-mono text-xs text-[var(--g-text-muted)] bg-[var(--g-bg)] rounded p-2 py-[0.6875rem] leading-[1.7] overflow-x-auto">
			{"{"}
			<br />
			{lines.map((f, i) => {
				const colonIdx = f.indexOf(": ");
				const name = colonIdx >= 0 ? f.slice(0, colonIdx) : f;
				const type = colonIdx >= 0 ? f.slice(colonIdx) : "";
				return (
					<div key={i} className="pl-5">
						<span style={{ color: nameColor }}>{name}</span>
						<span className="text-[var(--g-text-dim)]">{type}</span>
						{i < lines.length - 1 ? "," : ""}
					</div>
				);
			})}
			{"}"}
		</div>
	);
}

function CurlExample({ method, path, params }: {
	method: string;
	path: string;
	params: Array<{ name: string; in: string; type: string; required: boolean }>;
}) {
	const m = method.toUpperCase();
	// Replace path params with placeholder values
	let curlPath = path.replace(/\{([^}]+)\}/g, (_, name) => `{${name}}`);

	// Build query string from query params
	const queryParams = params.filter((p) => p.in === "query");
	const pathParams = params.filter((p) => p.in === "path");

	let url = `https://api.example.com${curlPath}`;
	if (queryParams.length > 0) {
		const qs = queryParams.map((p) => `${p.name}={${p.name}}`).join("&");
		url += `?${qs}`;
	}

	let curl = `curl -X ${m} '${url}'`;
	curl += ` \\\n  -H 'Content-Type: application/json'`;
	curl += ` \\\n  -H 'Authorization: Bearer {token}'`;

	if (["POST", "PUT", "PATCH"].includes(m)) {
		curl += ` \\\n  -d '{}'`;
	}

	return (
		<div>
			<div className="flex items-center gap-1.5 mb-1.5">
				<div className="text-xs font-semibold text-[var(--g-text-dim)] uppercase tracking-[0.06em]">
					Example
				</div>
				<button
					onClick={() => navigator.clipboard?.writeText(curl)}
					className="btn-icon ml-auto"
				>
					{Ic.copy()}
				</button>
			</div>
			<SyntaxHighlighter style={oneDark} language="bash" PreTag="div" wrapLongLines customStyle={{ margin: 0, borderRadius: 4, fontSize: 11, background: "var(--g-bg)" }} codeTagProps={{ style: { background: "var(--g-bg)" } }}>
				{curl}
			</SyntaxHighlighter>
		</div>
	);
}

function ResponseDropdown({ content }: { content: string }) {
	const [open, setOpen] = useState(false);
	const isJson = content.trimStart().startsWith("{") || content.trimStart().startsWith("[");

	return (
		<div className="mb-3.5">
			<button
				onClick={() => setOpen(!open)}
				className="flex items-center gap-1.5 text-xs font-semibold text-[var(--g-text-dim)] bg-transparent border-none cursor-pointer p-0 uppercase tracking-[0.06em]"
			>
				Response
				<span className={open ? "rotate-180 flex transition-transform duration-150" : "rotate-0 flex transition-transform duration-150"}>
					<svg width={10} height={10} viewBox="0 0 10 10" fill="none">
						<path d="M2 3.5l3 3 3-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
					</svg>
				</span>
			</button>
			{open && (
				<div className="mt-1.5">
					<SyntaxHighlighter
						style={oneDark}
						language={isJson ? "json" : "text"}
						PreTag="div"
						wrapLongLines
						customStyle={{ margin: 0, borderRadius: 4, fontSize: 11, background: "var(--g-bg)" }}
						codeTagProps={{ style: { background: "var(--g-bg)" } }}
					>
						{content}
					</SyntaxHighlighter>
				</div>
			)}
		</div>
	);
}

// Parse the full_text into structured sections
function parseFullText(text: string) {
	const params: Array<{ name: string; in: string; type: string; required: boolean; desc: string }> = [];
	const bodyFields: string[] = [];
	const responseFields: string[] = [];
	let responseType = "";

	const lines = text.split("\n");
	for (const line of lines) {
		const paramMatch = line.match(/^\s*-\s*\[(\w+)\]\s+(\w+)\s+\((\w+)(?:,\s*required)?\)(?:\s*[:-]\s*(.*))?/);
		if (paramMatch) {
			params.push({
				in: paramMatch[1],
				name: paramMatch[2],
				type: paramMatch[3],
				required: line.includes("required"),
				desc: paramMatch[4]?.trim() ?? "",
			});
		}

		if (line.includes("Request body") || line.includes("request body")) {
			// Next lines might have fields
		}

		const fieldMatch = line.match(/^\s{2,}(\w+):\s*(.+)/);
		if (fieldMatch && !line.startsWith("  -")) {
			// Could be body or response field based on context
		}
	}

	// Simple heuristic: extract fields from response_schema
	return { params, bodyFields, responseFields, responseType };
}

export default function DetailPanel({
	item,
	type,
	onClose,
}: {
	item: DetailItem;
	type: "endpoints" | "schemas";
	onClose: () => void;
}) {
	const viewDocs = useStore((s) => s.viewDocs);
	const isEp = type === "endpoints";
	const m = isEp ? METHOD_COLORS[item.method ?? "GET"] ?? METHOD_COLORS.GET : null;

	// Format response schema — now stored as JSON from chunker
	let responseDisplay = "";
	if (item.response_schema) {
		try {
			const parsed = JSON.parse(item.response_schema);
			responseDisplay = JSON.stringify(parsed, null, 2);
		} catch {
			responseDisplay = item.response_schema.trim();
		}
	}

	// Extract a meaningful description from full_text
	let fullDescription = item.description ?? "";
	if (item.full_text) {
		const lines = item.full_text.split("\n");
		const descLines: string[] = [];
		let pastHeader = false;
		for (const line of lines) {
			const t = line.trim();
			if (!t) { if (pastHeader) break; continue; }
			if (/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\//.test(t)) { pastHeader = true; continue; }
			if (/^(Summary|Tags?|Parameters?|Request body|Responses?):/i.test(t)) break;
			if (/^param:\s*\[/.test(t)) break;
			if (pastHeader && t.length > 5) descLines.push(t);
		}
		if (descLines.length > 0) fullDescription = descLines.join(" ");
	}

	// Parse params from full_text
	const params: Array<{ name: string; in: string; type: string; required: boolean; desc: string }> = [];
	if (item.full_text) {
		for (const line of item.full_text.split("\n")) {
			const m2 = line.match(
				/param:\s*\[(\w+)\]\s+(\S+)\s+\((\w+)(?:,\s*required)?\)/,
			);
			if (m2) {
				params.push({
					in: m2[1],
					name: m2[2],
					type: m2[3],
					required: line.includes("required"),
					desc: "",
				});
			}
		}
	}

	return (
		<div className="bg-[var(--g-surface)] rounded-md border border-[var(--g-border-accent)]">
			{/* Header */}
			<div className="px-3.5 py-[0.6875rem] border-b border-[var(--g-border)] flex items-center gap-2">
				<span className="text-xs font-semibold text-[var(--g-text-dim)] uppercase tracking-[0.05em]">
					{isEp ? "Endpoint" : "Schema"}
				</span>
				<span className="flex-1" />
				{isEp && (
					<button
						onClick={() => viewDocs(item.api, item.method ?? "GET", item.path ?? "", item.operation_id, item.tags?.split(",")[0]?.trim())}
						className="flex items-center gap-1 text-xs font-medium border-none cursor-pointer px-2.5 py-1 rounded bg-[var(--g-accent-muted)] text-[var(--g-accent)]"
					>
						{Ic.doc(14)} Docs {Ic.arr(13)}
					</button>
				)}
				<button
					onClick={onClose}
					className="btn-icon p-[0.1875rem]"
				>
					{Ic.x()}
				</button>
			</div>

			{/* Body */}
			<div className="p-3.5">
				{isEp ? (
					<>
						{/* Method + API + Score */}
						<div className="flex items-center gap-[0.4375rem] mb-2 flex-wrap">
							<span
								className="method-badge"
								style={{ background: m!.bg, color: m!.text, border: `1px solid ${m!.border}` }}
							>
								{item.method}
							</span>
							<span className="api-badge">
								<span className="opacity-50 flex">{Ic.tag()}</span>
								{item.api}
							</span>
							{item.score != null && <ScoreBar score={item.score} />}
						</div>

						{/* Path */}
						<div className="flex items-center gap-1.5 bg-[var(--g-bg)] rounded px-[0.6875rem] py-[0.4375rem] mb-[0.6875rem]">
							<code className="text-xs font-mono text-[var(--g-text)] flex-1 break-all">
								{item.path}
							</code>
							<button
								onClick={() => navigator.clipboard?.writeText(item.path ?? "")}
								className="btn-icon shrink-0"
							>
								{Ic.copy()}
							</button>
						</div>

						{/* Description */}
						{fullDescription && (
							<p className="text-xs text-[var(--g-text-muted)] mb-3.5 leading-[1.5] m-0">
								{fullDescription}
							</p>
						)}

						{/* Parameters */}
						{params.length > 0 && (
							<div className="mb-3.5">
								<div className="text-xs font-semibold text-[var(--g-text-dim)] uppercase tracking-[0.06em] mb-1.5">
									Parameters
								</div>
								{params.map((p, j) => (
									<div
										key={j}
										className={[
											"flex items-center gap-[0.4375rem] text-xs px-2 py-1.5 rounded",
											j % 2 === 0 ? "bg-[var(--g-bg)]" : "bg-transparent",
										].join(" ")}
									>
										<PBadge type={p.in} />
										<code className="font-mono text-[var(--g-text)] font-medium">{p.name}</code>
										<span className="text-[var(--g-text-dim)] text-sm">{p.type}</span>
										{p.required && <span className="text-[0.6875rem] text-[#F87171]">req</span>}
										<span className="text-[var(--g-text-dim)] ml-auto text-sm">{p.desc}</span>
									</div>
								))}
							</div>
						)}

						{/* Response (collapsible) */}
						{responseDisplay && <ResponseDropdown content={responseDisplay} />}

					</>
				) : (
					<>
						{/* Schema header */}
						<div className="flex items-center gap-[0.4375rem] mb-2">
							<span className="flex text-[var(--g-accent)] opacity-50">{Ic.cube(18)}</span>
							<span className="text-sm font-semibold font-mono text-[var(--g-text)]">
								{item.name}
							</span>
							<span className="api-badge">
								<span className="opacity-50 flex">{Ic.tag()}</span>
								{item.api}
							</span>
							{item.score != null && <ScoreBar score={item.score} />}
						</div>

						{/* Description */}
						<p className="text-xs text-[var(--g-text-muted)] mb-3.5 leading-[1.5] m-0">
							{item.description}
						</p>

						{/* Full text */}
						{item.full_text && (
							<div className="font-mono text-xs text-[var(--g-text-muted)] bg-[var(--g-bg)] rounded px-3.5 py-[0.6875rem] leading-[1.7] whitespace-pre-wrap max-h-[300px] overflow-auto">
								{item.full_text}
							</div>
						)}
					</>
				)}
			</div>
		</div>
	);
}
