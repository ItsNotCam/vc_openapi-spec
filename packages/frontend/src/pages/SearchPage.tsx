import { useState, useMemo, useCallback } from "react";
import { C, METHOD_COLORS } from "../lib/constants";
import { Ic } from "../lib/icons";
import { searchEndpoints, searchSchemas } from "../lib/api";
import type { SearchResult } from "../lib/api";
import { useStore } from "../store/store";
import ScoreBar from "../components/ScoreBar";
import DetailPanel from "../components/DetailPanel";
import GroupedApiSelect from "../components/GroupedApiSelect";

export default function SearchPage() {
	const apis = useStore((s) => s.apis);
	const detailItem = useStore((s) => s.detailItem);
	const detailType = useStore((s) => s.detailType);
	const setDetail = useStore((s) => s.setDetail);

	const [query, setQuery] = useState("");
	const [apiFilter, setApiFilter] = useState("all");
	const [tab, setTab] = useState<"endpoints" | "schemas">("endpoints");
	const [results, setResults] = useState<SearchResult[]>([]);
	const [loading, setLoading] = useState(false);

	const doSearch = useCallback(
		async (q: string, t: "endpoints" | "schemas", api: string) => {
			if (!q.trim()) {
				setResults([]);
				return;
			}
			setLoading(true);
			try {
				const apiParam = api === "all" ? undefined : api;
				const fn = t === "endpoints" ? searchEndpoints : searchSchemas;
				const r = await fn(q, apiParam, 20);
				setResults(r);
			} catch {
				setResults([]);
			}
			setLoading(false);
		},
		[],
	);

	const handleSearch = () => doSearch(query, tab, apiFilter);

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter") handleSearch();
	};

	const filtered = useMemo(() => {
		if (apiFilter === "all") return results;
		return results.filter((r) => r.api === apiFilter);
	}, [results, apiFilter]);

	return (
		<div style={{ padding: "14px 16px", height: "calc(100% - 56px)", display: "flex", flexDirection: "column" }}>
			{/* Search bar + filter */}
			<div style={{ display: "flex", gap: 8, marginBottom: 11, flexShrink: 0 }}>
				<div style={{ position: "relative", display: "flex", alignItems: "center" }}>
					<div style={{ position: "absolute", left: 10, color: C.textDim, display: "flex", pointerEvents: "none", zIndex: 1 }}>
						{Ic.server()}
					</div>
					<GroupedApiSelect
						apis={apis}
						value={apiFilter}
						onChange={setApiFilter}
						allLabel="All APIs"
						height={44}
						fontSize={15}
						minWidth={140}
						withIcon
					/>
				</div>
				<div style={{ flex: 1, position: "relative" }}>
					<div style={{ position: "absolute", left: 13, top: 13, color: C.textDim, display: "flex" }}>
						{Ic.search()}
					</div>
					<input
						type="text"
						placeholder="Search endpoints and schemas..."
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						onKeyDown={handleKeyDown}
						style={{
							width: "100%",
							height: 44,
							padding: "0 14px 0 38px",
							background: C.surface,
							border: `1px solid ${C.border}`,
							borderRadius: 6,
							fontSize: 16,
							color: C.text,
							outline: "none",
							boxSizing: "border-box",
						}}
						onFocus={(e) => ((e.target as HTMLElement).style.borderColor = "rgba(129,140,248,0.4)")}
						onBlur={(e) => ((e.target as HTMLElement).style.borderColor = C.border)}
					/>
				</div>
			</div>

			{/* Tab toggle */}
			<div style={{ display: "flex", gap: 3, marginBottom: 8, flexShrink: 0 }}>
				{(
					[
						{ key: "endpoints" as const, icon: Ic.bolt, label: "Endpoints" },
						{ key: "schemas" as const, icon: Ic.cube, label: "Schemas" },
					] as const
				).map((t) => (
					<button
						key={t.key}
						onClick={() => {
							setTab(t.key);
							setDetail(null);
							if (query.trim()) doSearch(query, t.key, apiFilter);
						}}
						style={{
							padding: "4px 13px",
							fontSize: 15,
							fontWeight: 500,
							border: "none",
							cursor: "pointer",
							borderRadius: 6,
							display: "flex",
							alignItems: "center",
							gap: 4,
							background: tab === t.key ? C.accentMuted : "transparent",
							color: tab === t.key ? C.accent : C.textDim,
						}}
					>
						{t.icon()}
						{t.label}
					</button>
				))}
				<span style={{ marginLeft: "auto", fontSize: 14, color: C.textDim, alignSelf: "center" }}>
					{loading ? "searching..." : `${filtered.length} result${filtered.length !== 1 ? "s" : ""}`}
				</span>
			</div>

			{/* Results + detail */}
			<div style={{ display: "flex", gap: 14, flex: 1, minHeight: 0 }}>
				<div style={{ flex: 1, minWidth: 0, overflow: "auto" }}>
					{filtered.map((item) => {
						const isSel = detailItem && "id" in detailItem && detailItem.id === item.id;
						const isEp = tab === "endpoints";
						const m = isEp ? METHOD_COLORS[item.method] ?? METHOD_COLORS.GET : null;

						return (
							<div
								key={item.id}
								onClick={() => setDetail(isSel ? null : item, tab)}
								style={{
									padding: "8px 11px",
									borderRadius: 6,
									cursor: "pointer",
									borderLeft: isSel ? `2px solid ${C.accent}` : "2px solid transparent",
									background: isSel ? C.surfaceActive : "transparent",
									marginBottom: 1,
								}}
								onMouseEnter={(e) => {
									if (!isSel) (e.currentTarget as HTMLElement).style.background = C.surfaceHover;
								}}
								onMouseLeave={(e) => {
									if (!isSel) (e.currentTarget as HTMLElement).style.background = "transparent";
								}}
							>
								<div style={{ display: "flex", alignItems: "center", gap: 7 }}>
									{isEp ? (
										<>
											<span
												style={{
													fontSize: 13,
													fontWeight: 600,
													padding: "1px 7px",
													borderRadius: 4,
													fontFamily: "monospace",
													background: m!.bg,
													color: m!.text,
													border: `1px solid ${m!.border}`,
													minWidth: 46,
													textAlign: "center",
													flexShrink: 0,
												}}
											>
												{item.method}
											</span>
											<code
												style={{
													fontSize: 15,
													fontFamily: "monospace",
													color: C.text,
													overflow: "hidden",
													textOverflow: "ellipsis",
													whiteSpace: "nowrap",
													flex: 1,
												}}
											>
												{item.path}
											</code>
										</>
									) : (
										<>
											<span style={{ display: "flex", color: C.accent, opacity: 0.35, flexShrink: 0 }}>
												{Ic.cube(15)}
											</span>
											<span style={{ fontSize: 15, fontWeight: 600, fontFamily: "monospace", color: C.text }}>
												{item.name}
											</span>
										</>
									)}
									<span
										style={{
											marginLeft: "auto",
											display: "flex",
											gap: 7,
											alignItems: "center",
											flexShrink: 0,
										}}
									>
										<ScoreBar score={item.score} />
										<span
											style={{
												fontSize: 13,
												padding: "1px 7px",
												borderRadius: 4,
												background: C.accentDim,
												color: C.accent,
												fontWeight: 500,
											}}
										>
											{item.api}
										</span>
									</span>
								</div>
								<p
									style={{
										fontSize: 14,
										color: C.textDim,
										margin: "3px 0 0",
										lineHeight: 1.4,
										overflow: "hidden",
										textOverflow: "ellipsis",
										whiteSpace: "nowrap",
										paddingLeft: isEp ? 56 : 24,
									}}
								>
									{item.description}
								</p>
							</div>
						);
					})}
					{!loading && filtered.length === 0 && query.trim() && (
						<div style={{ padding: "2rem", textAlign: "center", color: C.textDim, fontSize: 16 }}>
							No results
						</div>
					)}
					{!query.trim() && (
						<div style={{ padding: "2rem", textAlign: "center", color: C.textDim, fontSize: 16 }}>
							Type a query and press Enter to search
						</div>
					)}
				</div>

				{detailItem && (
					<div style={{ width: 430, flexShrink: 0 }}>
						<DetailPanel item={detailItem as never} type={detailType} onClose={() => setDetail(null)} />
					</div>
				)}
			</div>
		</div>
	);
}
