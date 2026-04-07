"use client";
import { useEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { METHOD_COLORS } from "../lib/constants";
import { Ic } from "../lib/icons";
import { useStore } from "../store/store";
import GroupedApiSelect from "../components/GroupedApiSelect";

export default function DocsPage() {
	const { apis, docsApi, docsAnchor, setDocsApi, theme } = useStore(
		useShallow((s) => ({ apis: s.apis, docsApi: s.docsApi, docsAnchor: s.docsAnchor, setDocsApi: s.setDocsApi, theme: s.theme }))
	);

	const iframeRef = useRef<HTMLIFrameElement>(null);
	const iframeKeyRef = useRef(0);

	const selectedApi = docsApi || (apis.length > 0 ? apis[0].name : "");
	const apiInfo = apis.find((a) => a.name === selectedApi);

	const isDark = theme === "dark" || (theme === "system" && typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches);

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
		<div className="px-5 py-3.5 h-[calc(100%-3.5rem)] flex flex-col">
			{/* Header */}
			<div className="flex items-center gap-3.5 mb-[0.6875rem] shrink-0">
				<div className="relative flex items-center">
					<div className="absolute left-2.5 text-[var(--g-text-dim)] flex pointer-events-none z-[1]">
						{Ic.server()}
					</div>
					<GroupedApiSelect
						apis={apis}
						value={selectedApi}
						onChange={setDocsApi}
						height={42}
						fontSize={16}
						minWidth={196}
						color="var(--g-text)"
						withIcon
					/>
				</div>
				{apiInfo && (
					<span className="text-[0.9375rem] text-[var(--g-text-dim)]">{apiInfo.endpoints} endpoints</span>
				)}
				<a
					href={iframeSrc}
					target="_blank"
					rel="noopener noreferrer"
					className="ml-auto text-[0.9375rem] text-[var(--g-accent)] no-underline flex items-center gap-1"
				>
					{Ic.ext()} New tab
				</a>
			</div>

			{/* Navigation breadcrumb */}
			{docsAnchor && (
				<div className="flex items-center gap-[0.4375rem] mb-[0.6875rem] px-[0.6875rem] py-[0.4375rem] bg-[var(--g-accent-dim)] border border-[var(--g-border-accent)] rounded-md text-[0.9375rem] shrink-0">
					<span className="text-[var(--g-accent)] flex">{Ic.arr()}</span>
					<span className="text-[var(--g-text-muted)]">Navigated to</span>
					<span
						className="method-badge"
						style={{
							background: METHOD_COLORS[docsAnchor.method]?.bg,
							color: METHOD_COLORS[docsAnchor.method]?.text,
							border: `1px solid ${METHOD_COLORS[docsAnchor.method]?.border}`,
						}}
					>
						{docsAnchor.method}
					</span>
					<code className="font-mono text-[var(--g-text)] text-[0.9375rem]">{docsAnchor.path}</code>
				</div>
			)}

			{/* Swagger iframe */}
			{selectedApi ? (
				<iframe
					key={`${selectedApi}-${qs}-${iframeKeyRef.current}`}
					ref={iframeRef}
					src={iframeSrc}
					className="flex-1 border border-[var(--g-border)] rounded-md bg-[var(--g-surface)] w-full"
					title={`${selectedApi} API docs`}
				/>
			) : (
				<div className="flex-1 border border-[var(--g-border)] rounded-md bg-[var(--g-surface)] flex flex-col items-center justify-center gap-3.5">
					<div className="text-[var(--g-text-dim)] flex">{Ic.doc(38)}</div>
					<span className="text-base text-[var(--g-text-dim)]">No APIs ingested yet</span>
				</div>
			)}
		</div>
	);
}
