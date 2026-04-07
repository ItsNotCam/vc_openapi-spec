import { useState, useRef, useEffect } from "react";
import { C } from "../lib/constants";
import { Ic } from "../lib/icons";
import { useStore, nextJobId } from "../store/store";
import type { IngestJob } from "../store/store";
import { listApis } from "../lib/api";

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
	const apis = useStore((s) => s.apis);
	const setApis = useStore((s) => s.setApis);
	const customGregPrompt = useStore((s) => s.customGregPrompt);
	const customExplainerPrompt = useStore((s) => s.customExplainerPrompt);
	const customProPrompt = useStore((s) => s.customProPrompt);
	const setCustomGregPrompt = useStore((s) => s.setCustomGregPrompt);
	const setCustomExplainerPrompt = useStore((s) => s.setCustomExplainerPrompt);
	const setCustomProPrompt = useStore((s) => s.setCustomProPrompt);
	const ingestJobs = useStore((s) => s.ingestJobs);
	const addIngestJob = useStore((s) => s.addIngestJob);
	const updateIngestJob = useStore((s) => s.updateIngestJob);
	const removeIngestJob = useStore((s) => s.removeIngestJob);
	const clearDoneJobs = useStore((s) => s.clearDoneJobs);

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
			const a = await listApis(true);
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

	const inputStyle = {
		width: "100%",
		height: 44,
		padding: "0 14px",
		background: C.surface,
		border: `1px solid ${C.border}`,
		borderRadius: 6,
		fontSize: 16,
		color: C.text,
		outline: "none",
		boxSizing: "border-box" as const,
	};

	const sectionHeader = {
		fontSize: 15,
		fontWeight: 600 as const,
		color: C.textDim,
		textTransform: "uppercase" as const,
		letterSpacing: "0.06em",
		marginBottom: 8,
	};

	const hasActiveJobs = ingestJobs.some((j) => j.status === "running" || j.status === "queued");

	return (
		<div style={{ padding: "14px 20px", height: "calc(100% - 56px)", overflow: "auto" }}>
			<div style={{ maxWidth: 600 }}>

				{/* ── System Prompt ──────────────────────────── */}
				<div style={{ marginBottom: 24 }}>
					<div style={sectionHeader}>System Prompt</div>
					<div style={{ display: "flex", gap: 3, marginBottom: 11 }}>
						{(["greg", "curt", "verbose"] as const).map((t) => (
							<button
								key={t}
								onClick={() => setPromptTab(t)}
								style={{
									padding: "4px 13px",
									fontSize: 15,
									fontWeight: 500,
									border: "none",
									cursor: "pointer",
									borderRadius: 6,
									background: promptTab === t ? C.accentMuted : "transparent",
									color: promptTab === t ? C.accent : C.textDim,
								}}
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
						style={{
							width: "100%",
							height: 180,
							padding: "11px 14px",
							background: C.surface,
							border: `1px solid ${C.border}`,
							borderRadius: 6,
							fontSize: 15,
							fontFamily: "monospace",
							color: C.text,
							outline: "none",
							resize: "vertical",
							lineHeight: 1.5,
							boxSizing: "border-box",
						}}
					/>
					<div style={{ display: "flex", gap: 8, marginTop: 6 }}>
						<span style={{ fontSize: 14, color: C.textDim, flex: 1 }}>
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
								style={{
									fontSize: 14,
									border: "none",
									cursor: "pointer",
									padding: "3px 8px",
									borderRadius: 4,
									background: "transparent",
									color: C.textDim,
								}}
							>
								Reset to default
							</button>
						)}
					</div>
				</div>

				{/* ── Ingest ──────────────────────────────────── */}
				<div style={{ marginBottom: 24 }}>
					<div style={sectionHeader}>Ingest API Spec</div>

					<div style={{ display: "flex", gap: 3, marginBottom: 14 }}>
						{(["url", "file", "paste"] as IngestMode[]).map((m) => (
							<button
								key={m}
								onClick={() => setMode(m)}
								style={{
									padding: "6px 14px",
									fontSize: 15,
									fontWeight: 500,
									border: "none",
									cursor: "pointer",
									borderRadius: 6,
									background: mode === m ? C.accentMuted : "transparent",
									color: mode === m ? C.accent : C.textDim,
								}}
							>
								{m === "url" ? "From URL" : m === "file" ? "Upload Files" : "Paste"}
							</button>
						))}
					</div>

					{/* API name — only for URL and paste modes */}
					{mode !== "file" && (
						<div style={{ marginBottom: 11 }}>
							<label style={{ fontSize: 14, color: C.textDim, display: "block", marginBottom: 4 }}>
								API Name
							</label>
							<input
								type="text"
								placeholder="my-api"
								value={apiName}
								onChange={(e) => setApiName(e.target.value)}
								style={inputStyle}
							/>
						</div>
					)}

					{mode === "url" && (
						<div style={{ marginBottom: 11 }}>
							<label style={{ fontSize: 14, color: C.textDim, display: "block", marginBottom: 4 }}>
								Spec URL or file path
							</label>
							<input
								type="text"
								placeholder="https://example.com/openapi.yaml"
								value={url}
								onChange={(e) => setUrl(e.target.value)}
								onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
								autoComplete="off"
								style={inputStyle}
							/>
						</div>
					)}

					{mode === "file" && (
						<div style={{ marginBottom: 11 }}>
							<label style={{ fontSize: 14, color: C.textDim, display: "block", marginBottom: 4 }}>
								OpenAPI spec files (YAML or JSON) — select multiple
							</label>
							<div
								onClick={() => fileRef.current?.click()}
								style={{
									padding: "17px",
									background: C.surface,
									border: `1px dashed ${C.border}`,
									borderRadius: 6,
									cursor: "pointer",
									textAlign: "center",
									fontSize: 15,
									color: C.textDim,
								}}
							>
								Click to select files
							</div>
							<input
								ref={fileRef}
								type="file"
								accept=".yaml,.yml,.json"
								multiple
								style={{ display: "none" }}
								onChange={() => handleFiles()}
							/>
						</div>
					)}

					{mode === "paste" && (
						<div style={{ marginBottom: 11 }}>
							<div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
								<label style={{ fontSize: 14, color: C.textDim }}>Paste spec content</label>
								<select
									value={pasteFormat}
									onChange={(e) => setPasteFormat(e.target.value as "yaml" | "json")}
									style={{
										fontSize: 14,
										padding: "1px 6px",
										background: C.surface,
										border: `1px solid ${C.border}`,
										borderRadius: 4,
										color: C.textMuted,
									}}
								>
									<option value="yaml">YAML</option>
									<option value="json">JSON</option>
								</select>
							</div>
							<textarea
								placeholder="openapi: '3.0.0'..."
								value={pasteContent}
								onChange={(e) => setPasteContent(e.target.value)}
								style={{
									...inputStyle,
									height: 168,
									padding: "11px 14px",
									fontFamily: "monospace",
									fontSize: 15,
									resize: "vertical",
								}}
							/>
						</div>
					)}

					{mode !== "file" && (
						<button
							onClick={handleSubmit}
							style={{
								padding: "8px 20px",
								fontSize: 15,
								fontWeight: 600,
								border: "none",
								borderRadius: 6,
								cursor: "pointer",
								background: C.accent,
								color: "#0D0D10",
							}}
						>
							Ingest
						</button>
					)}
				</div>

				{/* ── Active Jobs ──────────────────────────────── */}
				{ingestJobs.length > 0 && (
					<div style={{ marginBottom: 24 }}>
						<div style={{ ...sectionHeader, display: "flex", alignItems: "center" }}>
							<span>Ingest Jobs</span>
							{!hasActiveJobs && ingestJobs.length > 0 && (
								<button
									onClick={clearDoneJobs}
									style={{
										marginLeft: "auto",
										fontSize: 13,
										border: "none",
										cursor: "pointer",
										padding: "2px 8px",
										borderRadius: 4,
										background: "transparent",
										color: C.textDim,
										textTransform: "none",
										letterSpacing: "normal",
										fontWeight: 400,
									}}
								>
									Clear
								</button>
							)}
						</div>
						{ingestJobs.map((job) => (
							<div
								key={job.id}
								style={{
									padding: "8px 11px",
									borderRadius: 6,
									background: C.surface,
									border: `1px solid ${job.status === "error" ? "rgba(248,113,113,0.18)" : job.status === "done" ? "rgba(52,211,153,0.18)" : C.border}`,
									marginBottom: 4,
								}}
							>
								<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
									<span style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{job.apiName}</span>
									<span
										style={{
											fontSize: 12,
											padding: "1px 6px",
											borderRadius: 4,
											fontWeight: 500,
											background:
												job.status === "running" ? C.accentMuted :
												job.status === "done" ? "rgba(52,211,153,0.08)" :
												job.status === "error" ? "rgba(248,113,113,0.08)" : C.bg,
											color:
												job.status === "running" ? C.accent :
												job.status === "done" ? C.green :
												job.status === "error" ? "#F87171" : C.textDim,
										}}
									>
										{job.status}
									</span>
									{(job.status === "done" || job.status === "error") && (
										<button
											onClick={() => removeIngestJob(job.id)}
											style={{ marginLeft: "auto", display: "flex", border: "none", cursor: "pointer", padding: 2, background: "transparent", color: C.textDim, borderRadius: 4 }}
										>
											{Ic.x(13)}
										</button>
									)}
								</div>
								<div style={{ fontSize: 13, color: C.textDim, marginTop: 3 }}>{job.message}</div>
								{job.status === "running" && job.total != null && job.total > 0 && (
									<div style={{ height: 4, background: C.border, borderRadius: 4, overflow: "hidden", marginTop: 6 }}>
										<div
											style={{
												height: "100%",
												width: `${Math.round(((job.done ?? 0) / job.total) * 100)}%`,
												background: C.accent,
												borderRadius: 4,
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
					<div style={sectionHeader}>Ingested APIs</div>
					{apis.length === 0 && (
						<div style={{ fontSize: 15, color: C.textDim }}>No APIs ingested yet</div>
					)}
					{apis.map((a) => (
						<div
							key={a.name}
							style={{
								display: "flex",
								alignItems: "center",
								gap: 11,
								padding: "7px 11px",
								borderRadius: 6,
								background: C.surface,
								border: `1px solid ${C.border}`,
								marginBottom: 4,
							}}
						>
							<span style={{ display: "flex", color: C.accent, opacity: 0.5 }}>{Ic.server()}</span>
							<span style={{ fontSize: 16, fontWeight: 500, color: C.text }}>{a.name}</span>
							<span style={{ fontSize: 14, color: C.textDim }}>{a.endpoints} endpoints</span>
							<button
								onClick={() => handleDelete(a.name)}
								style={{
									marginLeft: "auto",
									display: "flex",
									border: "none",
									cursor: "pointer",
									padding: 3,
									background: "transparent",
									color: C.textDim,
									borderRadius: 4,
								}}
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
