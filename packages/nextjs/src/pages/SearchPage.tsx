"use client";
import { useState, useMemo, useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import { METHOD_COLORS } from "../lib/constants";
import { Ic } from "../lib/icons";
import { searchEndpoints, searchSchemas } from "../lib/api";
import type { SearchResult } from "../lib/api";
import { useStore } from "../store/store";
import ScoreBar from "../components/ScoreBar";
import DetailPanel from "../components/DetailPanel";
import GroupedApiSelect from "../components/GroupedApiSelect";

export default function SearchPage() {
	const { apis, detailItem, detailType, setDetail } = useStore(
		useShallow((s) => ({ apis: s.apis, detailItem: s.detailItem, detailType: s.detailType, setDetail: s.setDetail }))
	);

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
		<div className="px-4 py-3.5 h-[calc(100%-3.5rem)] flex flex-col">
			{/* Search bar + filter */}
			<div className="flex gap-2 mb-[0.6875rem] shrink-0">
				<div className="relative flex items-center">
					<div className="absolute left-2.5 text-[var(--g-text-dim)] flex pointer-events-none z-[1]">
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
				<div className="flex-1 relative">
					<div className="absolute left-[0.8125rem] top-[0.8125rem] text-[var(--g-text-dim)] flex">
						{Ic.search()}
					</div>
					<input
						type="text"
						placeholder="Search endpoints and schemas..."
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						onKeyDown={handleKeyDown}
						className="g-input pl-[2.375rem] focus:border-[rgba(129,140,248,0.4)]"
					/>
				</div>
			</div>

			{/* Tab toggle */}
			<div className="flex gap-[0.1875rem] mb-2 shrink-0">
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
						className={[
							"py-1 px-[0.8125rem] text-[0.9375rem] font-medium border-none cursor-pointer rounded-md flex items-center gap-1",
							tab === t.key
								? "bg-[var(--g-accent-muted)] text-[var(--g-accent)]"
								: "bg-transparent text-[var(--g-text-dim)]",
						].join(" ")}
					>
						{t.icon()}
						{t.label}
					</button>
				))}
				<span className="ml-auto text-sm text-[var(--g-text-dim)] self-center">
					{loading ? "searching..." : `${filtered.length} result${filtered.length !== 1 ? "s" : ""}`}
				</span>
			</div>

			{/* Results + detail */}
			<div className="flex gap-3.5 flex-1 min-h-0">
				<div className="flex-1 min-w-0 overflow-auto">
					{filtered.map((item) => {
						const isSel = detailItem && "id" in detailItem && detailItem.id === item.id;
						const isEp = tab === "endpoints";
						const m = isEp ? METHOD_COLORS[item.method] ?? METHOD_COLORS.GET : null;

						return (
							<div
								key={item.id}
								onClick={() => setDetail(isSel ? null : item, tab)}
								className={[
									"py-2 px-[0.6875rem] rounded-md cursor-pointer border-l-2 mb-px",
									isSel
										? "border-l-[var(--g-accent)] bg-[var(--g-surface-active)]"
										: "border-l-transparent bg-transparent hover:bg-[var(--g-surface-hover)]",
								].join(" ")}
							>
								<div className="flex items-center gap-[0.4375rem]">
									{isEp ? (
										<>
											<span
												className="method-badge"
												style={{
													background: m!.bg,
													color: m!.text,
													border: `1px solid ${m!.border}`,
													minWidth: 46,
												}}
											>
												{item.method}
											</span>
											<code className="text-[0.9375rem] font-mono text-[var(--g-text)] truncate flex-1">
												{item.path}
											</code>
										</>
									) : (
										<>
											<span className="flex text-[var(--g-accent)] opacity-35 shrink-0">
												{Ic.cube(15)}
											</span>
											<span className="text-[0.9375rem] font-semibold font-mono text-[var(--g-text)]">
												{item.name}
											</span>
										</>
									)}
									<span className="ml-auto flex gap-[0.4375rem] items-center shrink-0">
										<ScoreBar score={item.score} />
										<span className="api-badge">
											{item.api}
										</span>
									</span>
								</div>
								<p
									className={`text-sm text-[var(--g-text-dim)] mt-[0.1875rem] leading-[1.4] truncate ${isEp ? "pl-14" : "pl-6"}`}
								>
									{item.description}
								</p>
							</div>
						);
					})}
					{!loading && filtered.length === 0 && query.trim() && (
						<div className="p-8 text-center text-[var(--g-text-dim)] text-base">
							No results
						</div>
					)}
					{!query.trim() && (
						<div className="p-8 text-center text-[var(--g-text-dim)] text-base">
							Type a query and press Enter to search
						</div>
					)}
				</div>

				{detailItem && (
					<div className="w-[26.875rem] shrink-0">
						<DetailPanel item={detailItem as never} type={detailType} onClose={() => setDetail(null)} />
					</div>
				)}
			</div>
		</div>
	);
}
