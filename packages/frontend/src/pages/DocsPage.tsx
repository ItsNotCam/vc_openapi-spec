import { useEffect, useRef } from "react";
import { C, METHOD_COLORS } from "../lib/constants";
import { Ic } from "../lib/icons";
import { useStore } from "../store/store";
import GroupedApiSelect from "../components/GroupedApiSelect";

export default function DocsPage() {
	const apis = useStore((s) => s.apis);
	const docsApi = useStore((s) => s.docsApi);
	const docsAnchor = useStore((s) => s.docsAnchor);
	const setDocsApi = useStore((s) => s.setDocsApi);

	const iframeRef = useRef<HTMLIFrameElement>(null);
	const iframeKeyRef = useRef(0);

	const selectedApi = docsApi || (apis.length > 0 ? apis[0].name : "");
	const apiInfo = apis.find((a) => a.name === selectedApi);

	const theme = useStore((s) => s.theme);
	const isDark = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);

	// Pass method+path+theme as query params
	const params = new URLSearchParams();
	if (docsAnchor) {
		params.set("method", docsAnchor.method);
		params.set("path", docsAnchor.path);
	}
	params.set("theme", isDark ? "dark" : "light");
	const qs = `?${params}`;

	const iframeSrc = selectedApi ? `/openapi/docs/${selectedApi}${qs}` : "";

	// Force iframe reload when anchor changes by bumping the key
	useEffect(() => {
		if (docsAnchor) {
			iframeKeyRef.current++;
		}
	}, [docsAnchor]);

	return (
		<div style={{ padding: "14px 20px", height: "calc(100% - 56px)", display: "flex", flexDirection: "column" }}>
			{/* Header */}
			<div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 11, flexShrink: 0 }}>
				<div style={{ position: "relative", display: "flex", alignItems: "center" }}>
					<div style={{ position: "absolute", left: 10, color: C.textDim, display: "flex", pointerEvents: "none", zIndex: 1 }}>
						{Ic.server()}
					</div>
					<GroupedApiSelect
						apis={apis}
						value={selectedApi}
						onChange={setDocsApi}
						height={42}
						fontSize={16}
						minWidth={196}
						color={C.text}
						withIcon
					/>
				</div>
				{apiInfo && (
					<span style={{ fontSize: 15, color: C.textDim }}>{apiInfo.endpoints} endpoints</span>
				)}
				<a
					href={iframeSrc}
					target="_blank"
					rel="noopener noreferrer"
					style={{
						marginLeft: "auto",
						fontSize: 15,
						color: C.accent,
						textDecoration: "none",
						display: "flex",
						alignItems: "center",
						gap: 4,
					}}
				>
					{Ic.ext()} New tab
				</a>
			</div>

			{/* Navigation breadcrumb */}
			{docsAnchor && (
				<div
					style={{
						display: "flex",
						alignItems: "center",
						gap: 7,
						marginBottom: 11,
						padding: "7px 11px",
						background: C.accentDim,
						border: `1px solid ${C.borderAccent}`,
						borderRadius: 6,
						fontSize: 15,
						flexShrink: 0,
					}}
				>
					<span style={{ color: C.accent, display: "flex" }}>{Ic.arr()}</span>
					<span style={{ color: C.textMuted }}>Navigated to</span>
					<span
						style={{
							fontSize: 13,
							fontWeight: 600,
							padding: "1px 7px",
							borderRadius: 4,
							fontFamily: "monospace",
							background: METHOD_COLORS[docsAnchor.method]?.bg,
							color: METHOD_COLORS[docsAnchor.method]?.text,
							border: `1px solid ${METHOD_COLORS[docsAnchor.method]?.border}`,
						}}
					>
						{docsAnchor.method}
					</span>
					<code style={{ fontFamily: "monospace", color: C.text, fontSize: 15 }}>{docsAnchor.path}</code>
				</div>
			)}

			{/* Swagger iframe */}
			{selectedApi ? (
				<iframe
					key={`${selectedApi}-${qs}-${iframeKeyRef.current}`}
					ref={iframeRef}
					src={iframeSrc}
					style={{
						flex: 1,
						border: `1px solid ${C.border}`,
						borderRadius: 6,
						background: C.surface,
						width: "100%",
					}}
					title={`${selectedApi} API docs`}
				/>
			) : (
				<div
					style={{
						flex: 1,
						border: `1px solid ${C.border}`,
						borderRadius: 6,
						background: C.surface,
						display: "flex",
						flexDirection: "column",
						alignItems: "center",
						justifyContent: "center",
						gap: 14,
					}}
				>
					<div style={{ color: C.textDim, display: "flex" }}>{Ic.doc(38)}</div>
					<span style={{ fontSize: 16, color: C.textDim }}>No APIs ingested yet</span>
				</div>
			)}
		</div>
	);
}
