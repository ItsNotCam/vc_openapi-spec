"use client";
import { useState, useRef, useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { Ic } from "../lib/icons";
import { useStore, nextJobId } from "../store/store";
import type { IngestJob } from "../store/store";
import { listApis } from "../lib/api";
import "./SettingsPage.css";

type IngestMode = "url" | "file" | "paste";

// ---------------------------------------------------------------------------
// SSE ingest helper (updates store job in-place)
// ---------------------------------------------------------------------------

async function runIngestStream(
	fetchUrl: string,
	body: Record<string, unknown>,
	jobId: string,
	updateJob: (id: string, u: Partial<IngestJob>) => void,
	onDone: () => void,
) {
	updateJob(jobId, { status: "running", message: "Starting..." });
	try {
		const res = await fetch(fetchUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		if (!res.ok || !res.body) {
			const text = await res.text();
			let msg = `HTTP ${res.status}`;
			try { msg = JSON.parse(text).error ?? msg; } catch {}
			throw new Error(msg);
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
					const event = JSON.parse(line.slice(6));
					if (event.phase === "complete") {
						const s = event.summary;
						updateJob(jobId, { status: "done", message: `${s.endpointsIngested} endpoints, ${s.schemasIngested} schemas`, done: undefined, total: undefined });
						onDone();
					} else if (event.phase === "error") {
						throw new Error(event.message);
					} else {
						updateJob(jobId, { status: "running", message: event.message, done: event.done, total: event.total });
					}
				} catch (e) {
					if (e instanceof Error && e.message !== "Unexpected end of JSON input") throw e;
				}
			}
		}
	} catch (err) {
		updateJob(jobId, { status: "error", message: err instanceof Error ? err.message : "Failed", done: undefined, total: undefined });
	}
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function SettingsPage() {
	const {
		apis, setApis,
		customGregPrompt, customExplainerPrompt, customProPrompt,
		setCustomGregPrompt, setCustomExplainerPrompt, setCustomProPrompt,
		ingestJobs, addIngestJob, updateIngestJob, removeIngestJob, clearDoneJobs,
	} = useStore(useShallow((s) => ({
		apis: s.apis, setApis: s.setApis,
		customGregPrompt: s.customGregPrompt, customExplainerPrompt: s.customExplainerPrompt, customProPrompt: s.customProPrompt,
		setCustomGregPrompt: s.setCustomGregPrompt, setCustomExplainerPrompt: s.setCustomExplainerPrompt, setCustomProPrompt: s.setCustomProPrompt,
		ingestJobs: s.ingestJobs, addIngestJob: s.addIngestJob, updateIngestJob: s.updateIngestJob, removeIngestJob: s.removeIngestJob, clearDoneJobs: s.clearDoneJobs,
	})));

	const [mode, setMode] = useState<IngestMode>("url");
	const [url, setUrl] = useState("");
	const [apiName, setApiName] = useState("");
	const [pasteContent, setPasteContent] = useState("");
	const [pasteFormat, setPasteFormat] = useState<"yaml" | "json">("yaml");
	const fileRef = useRef<HTMLInputElement>(null);
	const [promptTab, setPromptTab] = useState<"greg" | "verbose" | "curt">("greg");
	const [defaultPrompts, setDefaultPrompts] = useState<{ greg: string; explainer: string; professional: string }>({ greg: "", explainer: "", professional: "" });

	useEffect(() => {
		fetch("/api/prompts").then((r) => r.json()).then(setDefaultPrompts).catch(() => {});
	}, []);

	const refreshApis = async () => {
		try {
			const a = await listApis();
			setApis(a);
		} catch {}
	};

	const startIngest = (fetchUrl: string, body: Record<string, unknown>, name: string) => {
		const id = nextJobId();
		addIngestJob({ id, apiName: name, status: "queued", message: "Queued" });
		runIngestStream(fetchUrl, body, id, updateIngestJob, refreshApis);
	};

	const handleIngestUrl = () => {
		if (!url.trim() || !apiName.trim()) return;
		startIngest("/openapi/ingest", { source: url, api_name: apiName }, apiName);
		setUrl("");
		setApiName("");
	};

	const handleIngestContent = (content: string, format: "yaml" | "json", name: string) => {
		if (!content.trim() || !name.trim()) return;
		startIngest("/openapi/ingest/upload", { content, format, api_name: name }, name);
	};

	const handleFiles = async () => {
		const files = fileRef.current?.files;
		if (!files || files.length === 0) return;

		for (const file of Array.from(files)) {
			const text = await file.text();
			const fmt = file.name.endsWith(".json") ? "json" : "yaml";
			const name = file.name.replace(/\.(ya?ml|json)$/i, "");
			handleIngestContent(text, fmt, name);
		}

		// Reset file input
		if (fileRef.current) fileRef.current.value = "";
	};

	const handleSubmit = () => {
		if (mode === "url") handleIngestUrl();
		else if (mode === "file") handleFiles();
		else {
			if (!apiName.trim()) return;
			handleIngestContent(pasteContent, pasteFormat, apiName);
			setPasteContent("");
			setApiName("");
		}
	};

	const handleDelete = async (name: string) => {
		try {
			await fetch(`/openapi/apis/${encodeURIComponent(name)}`, { method: "DELETE" });
			refreshApis();
		} catch {}
	};

	const hasActiveJobs = ingestJobs.some((j) => j.status === "running" || j.status === "queued");

	return (
		<div className="px-5 py-3.5 h-[calc(100%-3.5rem)] overflow-auto">
			<div className="max-w-[37.5rem]">

				{/* ── System Prompt ──────────────────────────── */}
				<div className="mb-6">
					<div className="settings-section-label">System Prompt</div>
					<div className="flex gap-[0.1875rem] mb-[0.6875rem]">
						{(["greg", "curt", "verbose"] as const).map((t) => (
							<button
								key={t}
								onClick={() => setPromptTab(t)}
								className={`settings-tab-btn${promptTab === t ? " active" : ""}`}
							>
								{t === "greg" ? "greg mode" : t}
							</button>
						))}
					</div>
					<textarea
						value={promptTab === "greg" ? (customGregPrompt || defaultPrompts.greg) : promptTab === "verbose" ? (customExplainerPrompt || defaultPrompts.explainer) : (customProPrompt || defaultPrompts.professional)}
						onChange={(e) => {
							if (promptTab === "greg") setCustomGregPrompt(e.target.value);
							else if (promptTab === "verbose") setCustomExplainerPrompt(e.target.value);
							else setCustomProPrompt(e.target.value);
						}}
						className="g-input h-[11.25rem] py-[0.6875rem] font-mono text-[0.9375rem] resize-y leading-[1.5]"
					/>
					<div className="flex gap-2 mt-1.5">
						<span className="text-sm text-[var(--g-text-dim)] flex-1">
							{(promptTab === "greg" ? customGregPrompt : promptTab === "verbose" ? customExplainerPrompt : customProPrompt)
								? "Using custom prompt"
								: "Using default prompt"}
						</span>
						{(promptTab === "greg" ? customGregPrompt : promptTab === "verbose" ? customExplainerPrompt : customProPrompt) && (
							<button
								onClick={() => {
									if (promptTab === "greg") setCustomGregPrompt("");
									else if (promptTab === "verbose") setCustomExplainerPrompt("");
									else setCustomProPrompt("");
								}}
								className="text-sm border-none cursor-pointer px-2 py-[0.1875rem] rounded bg-transparent text-[var(--g-text-dim)]"
							>
								Reset to default
							</button>
						)}
					</div>
				</div>

				{/* ── Ingest ──────────────────────────────────── */}
				<div className="mb-6">
					<div className="settings-section-label">Ingest API Spec</div>

					<div className="flex gap-[0.1875rem] mb-3.5">
						{(["url", "file", "paste"] as IngestMode[]).map((m) => (
							<button
								key={m}
								onClick={() => setMode(m)}
								className={`settings-mode-btn${mode === m ? " active" : ""}`}
							>
								{m === "url" ? "From URL" : m === "file" ? "Upload Files" : "Paste"}
							</button>
						))}
					</div>

					{/* API name — only for URL and paste modes */}
					{mode !== "file" && (
						<div className="mb-[0.6875rem]">
							<label className="text-sm text-[var(--g-text-dim)] block mb-1">
								API Name
							</label>
							<input
								type="text"
								placeholder="my-api"
								value={apiName}
								onChange={(e) => setApiName(e.target.value)}
								className="g-input"
							/>
						</div>
					)}

					{mode === "url" && (
						<div className="mb-[0.6875rem]">
							<label className="text-sm text-[var(--g-text-dim)] block mb-1">
								Spec URL or file path
							</label>
							<input
								type="text"
								placeholder="https://example.com/openapi.yaml"
								value={url}
								onChange={(e) => setUrl(e.target.value)}
								onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
								autoComplete="off"
								className="g-input"
							/>
						</div>
					)}

					{mode === "file" && (
						<div className="mb-[0.6875rem]">
							<label className="text-sm text-[var(--g-text-dim)] block mb-1">
								OpenAPI spec files (YAML or JSON) — select multiple
							</label>
							<div
								onClick={() => fileRef.current?.click()}
								className="p-[1.0625rem] bg-[var(--g-surface)] border border-dashed border-[var(--g-border)] rounded-md cursor-pointer text-center text-[0.9375rem] text-[var(--g-text-dim)]"
							>
								Click to select files
							</div>
							<input
								ref={fileRef}
								type="file"
								accept=".yaml,.yml,.json"
								multiple
								className="hidden"
								onChange={() => handleFiles()}
							/>
						</div>
					)}

					{mode === "paste" && (
						<div className="mb-[0.6875rem]">
							<div className="flex items-center gap-2 mb-1">
								<label className="text-sm text-[var(--g-text-dim)]">Paste spec content</label>
								<select
									value={pasteFormat}
									onChange={(e) => setPasteFormat(e.target.value as "yaml" | "json")}
									className="text-sm px-1.5 py-px bg-[var(--g-surface)] border border-[var(--g-border)] rounded text-[var(--g-text-muted)]"
								>
									<option value="yaml">YAML</option>
									<option value="json">JSON</option>
								</select>
							</div>
							<textarea
								placeholder="openapi: '3.0.0'..."
								value={pasteContent}
								onChange={(e) => setPasteContent(e.target.value)}
								className="g-input h-[10.5rem] py-[0.6875rem] font-mono text-[0.9375rem] resize-y"
							/>
						</div>
					)}

					{mode !== "file" && (
						<button
							onClick={handleSubmit}
							className="px-5 py-2 text-[0.9375rem] font-semibold border-none rounded-md cursor-pointer bg-[var(--g-accent)] text-[#0D0D10]"
						>
							Ingest
						</button>
					)}
				</div>

				{/* ── Active Jobs ──────────────────────────────── */}
				{ingestJobs.length > 0 && (
					<div className="mb-6">
						<div className="settings-section-label flex items-center">
							<span>Ingest Jobs</span>
							{!hasActiveJobs && ingestJobs.length > 0 && (
								<button
									onClick={clearDoneJobs}
									className="ml-auto text-[0.8125rem] border-none cursor-pointer px-2 py-[0.125rem] rounded bg-transparent text-[var(--g-text-dim)] normal-case tracking-normal font-normal"
								>
									Clear
								</button>
							)}
						</div>
						{ingestJobs.map((job) => (
							<div
								key={job.id}
								className="g-card px-[0.6875rem] py-2 mb-1"
								style={{
									borderColor:
										job.status === "error" ? "rgba(248,113,113,0.18)" :
										job.status === "done" ? "rgba(52,211,153,0.18)" :
										undefined,
								}}
							>
								<div className="flex items-center gap-2">
									<span className="text-sm font-semibold text-[var(--g-text)]">{job.apiName}</span>
									<span
										className={`text-xs px-1.5 py-px rounded font-medium${
											job.status === "running" ? " bg-[var(--g-accent-muted)] text-[var(--g-accent)]" :
											job.status === "done" ? " bg-[rgba(52,211,153,0.08)] text-[var(--g-green)]" :
											job.status === "error" ? " bg-[rgba(248,113,113,0.08)] text-[#F87171]" :
											" bg-[var(--g-bg)] text-[var(--g-text-dim)]"
										}`}
									>
										{job.status}
									</span>
									{(job.status === "done" || job.status === "error") && (
										<button
											onClick={() => removeIngestJob(job.id)}
											className="btn-icon ml-auto p-0.5"
										>
											{Ic.x(13)}
										</button>
									)}
								</div>
								<div className="text-[0.8125rem] text-[var(--g-text-dim)] mt-[0.1875rem]">{job.message}</div>
								{job.status === "running" && job.total != null && job.total > 0 && (
									<div className="h-1 bg-[var(--g-border)] rounded overflow-hidden mt-1.5">
										<div
											className="h-full bg-[var(--g-accent)] rounded"
											style={{
												width: `${Math.round(((job.done ?? 0) / job.total) * 100)}%`,
												transition: "width 0.15s",
											}}
										/>
									</div>
								)}
							</div>
						))}
					</div>
				)}

				{/* ── Ingested APIs ────────────────────────────── */}
				<div>
					<div className="settings-section-label">Ingested APIs</div>
					{apis.length === 0 && (
						<div className="text-[0.9375rem] text-[var(--g-text-dim)]">No APIs ingested yet</div>
					)}
					{apis.map((a) => (
						<div
							key={a.name}
							className="g-card flex items-center gap-[0.6875rem] px-[0.6875rem] py-[0.4375rem] mb-1"
						>
							<span className="flex text-[var(--g-accent)] opacity-50">{Ic.server()}</span>
							<span className="text-base font-medium text-[var(--g-text)]">{a.name}</span>
							<span className="text-sm text-[var(--g-text-dim)]">{a.endpoints} endpoints</span>
							<button
								onClick={() => handleDelete(a.name)}
								className="btn-icon ml-auto p-[0.1875rem]"
							>
								{Ic.x()}
							</button>
						</div>
					))}
				</div>
			</div>
		</div>
	);
}
