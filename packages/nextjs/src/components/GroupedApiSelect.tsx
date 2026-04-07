"use client";
import React, { useState, useMemo, useRef, useEffect } from "react";
import type { ApiInfo } from "../lib/api";

// ---------------------------------------------------------------------------
// Grouping logic
// ---------------------------------------------------------------------------

interface ApiGroup {
	type: "group";
	name: string;
	children: ApiInfo[];
}
interface ApiSingle {
	type: "single";
	api: ApiInfo;
}
type GroupedEntry = ApiGroup | ApiSingle;

function groupApis(apis: ApiInfo[]): GroupedEntry[] {
	const prefixToApis = new Map<string, ApiInfo[]>();

	for (const api of apis) {
		const idx = api.name.indexOf("-");
		if (idx > 0) {
			const prefix = api.name.slice(0, idx);
			if (!prefixToApis.has(prefix)) prefixToApis.set(prefix, []);
			prefixToApis.get(prefix)!.push(api);
		}
	}

	const result: GroupedEntry[] = [];
	const seenPrefixes = new Set<string>();

	for (const api of apis) {
		const idx = api.name.indexOf("-");
		const prefix = idx > 0 ? api.name.slice(0, idx) : null;

		if (prefix && (prefixToApis.get(prefix)?.length ?? 0) >= 2) {
			if (!seenPrefixes.has(prefix)) {
				seenPrefixes.add(prefix);
				result.push({ type: "group", name: prefix, children: prefixToApis.get(prefix)! });
			}
		} else {
			result.push({ type: "single", api });
		}
	}

	return result;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface GroupedApiSelectProps {
	apis: ApiInfo[];
	value: string;
	onChange: (value: string) => void;
	/** If provided, prepends an "all" option with this label */
	allLabel?: string;
	height?: number;
	fontSize?: number;
	minWidth?: number;
	color?: string;
	withIcon?: boolean;
}

export default function GroupedApiSelect({
	apis,
	value,
	onChange,
	allLabel,
	height = 44,
	fontSize = 15,
	minWidth = 140,
	color,
	withIcon = false,
}: GroupedApiSelectProps) {
	const [open, setOpen] = useState(false);
	const [hoveredGroup, setHoveredGroup] = useState<string | null>(null);
	const [hoveredItem, setHoveredItem] = useState<string | null>(null);
	const rootRef = useRef<HTMLDivElement>(null);

	const entries = useMemo(() => groupApis(apis), [apis]);

	// Close on outside click
	useEffect(() => {
		if (!open) return;
		const handler = (e: MouseEvent) => {
			if (!rootRef.current?.contains(e.target as Node)) {
				setOpen(false);
				setHoveredGroup(null);
			}
		};
		document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, [open]);

	const displayLabel = value === "all" ? (allLabel ?? "All APIs") : value;

	const select = (v: string) => {
		onChange(v);
		setOpen(false);
		setHoveredGroup(null);
	};

	const itemClassName = (selected: boolean, hovered?: boolean) =>
		`flex items-center justify-between px-[0.6875rem] py-[0.4375rem] cursor-pointer whitespace-nowrap ${
			selected
				? "text-[var(--g-accent)] bg-[var(--g-accent-dim)]"
				: hovered
				? "text-[var(--g-text)] bg-[var(--g-surface-hover)]"
				: "text-[var(--g-text)] bg-transparent"
		}`;

	return (
		<div ref={rootRef} className="relative inline-block">
			{/* Trigger */}
			<div
				className="flex items-center gap-1.5 bg-[var(--g-surface)] border border-[var(--g-border)] rounded-md cursor-pointer select-none relative box-border whitespace-nowrap overflow-hidden text-ellipsis"
				style={{
					height,
					padding: withIcon ? `0 28px 0 30px` : `0 28px 0 11px`,
					fontSize,
					color: color ?? "var(--g-text-muted)",
					minWidth,
				}}
				onClick={() => {
					setOpen((o) => !o);
					if (open) setHoveredGroup(null);
				}}
			>
				<span className="flex-1 overflow-hidden text-ellipsis">
					{displayLabel}
				</span>
				{/* Chevron */}
				<svg
					width="12"
					height="12"
					viewBox="0 0 12 12"
					fill="none"
					className={`absolute right-[0.5625rem] top-1/2 -translate-y-1/2 transition-transform duration-150 flex-shrink-0 text-[var(--g-text-dim)] ${open ? "rotate-180" : ""}`}
				>
					<path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
				</svg>
			</div>

			{/* Dropdown */}
			{open && (
				<div
					className="absolute top-[calc(100%+3px)] left-0 z-[200] bg-[var(--g-surface)] border border-[var(--g-border)] rounded-md shadow-[0_6px_20px_rgba(0,0,0,0.28)] overflow-visible py-1"
					style={{ minWidth: Math.max(minWidth, 160) }}
				>
					{/* "All" option */}
					{allLabel && (
						<div
							className={itemClassName(value === "all", hoveredItem === "__all__")}
							onMouseEnter={() => { setHoveredGroup(null); setHoveredItem("__all__"); }}
							onMouseLeave={() => setHoveredItem(null)}
							onClick={() => select("all")}
						>
							<span>{allLabel}</span>
						</div>
					)}

					{/* Divider after all option */}
					{allLabel && entries.length > 0 && (
						<div className="h-px bg-[var(--g-border)] my-[0.125rem]" />
					)}

					{entries.map((entry) => {
						if (entry.type === "single") {
							return (
								<div
									key={entry.api.name}
									className={itemClassName(value === entry.api.name, hoveredItem === entry.api.name)}
									onMouseEnter={() => { setHoveredGroup(null); setHoveredItem(entry.api.name); }}
									onMouseLeave={() => setHoveredItem(null)}
									onClick={() => select(entry.api.name)}
								>
									<span>{entry.api.name}</span>
									<span className="text-xs text-[var(--g-text-dim)] ml-2">
										{entry.api.endpoints}
									</span>
								</div>
							);
						}

						// Group entry
						const isHovered = hoveredGroup === entry.name;
						const hasSelectedChild = entry.children.some((c) => c.name === value);
						return (
							<div
								key={entry.name}
								className="relative"
								onMouseEnter={() => setHoveredGroup(entry.name)}
								onMouseLeave={() => setHoveredGroup(null)}
								onClick={(e) => { e.stopPropagation(); setHoveredGroup(isHovered ? null : entry.name); }}
							>
								<div className={itemClassName(hasSelectedChild, isHovered)}>
									<span>{entry.name}</span>
									<div className="flex items-center gap-1.5">
										<span className="text-xs text-[var(--g-text-dim)]">
											{entry.children.reduce((s, c) => s + c.endpoints, 0)}
										</span>
										{/* Right arrow indicator */}
										<svg
											width="10"
											height="10"
											viewBox="0 0 10 10"
											fill="none"
											className="text-[var(--g-text-dim)] flex-shrink-0"
										>
											<path d="M3 2l4 3-4 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
										</svg>
									</div>
								</div>

								{/* Flyout */}
								{isHovered && (
									<div
										className="absolute left-full top-[-1px] z-[201] min-w-[180px] bg-[var(--g-surface)] border border-[var(--g-border)] rounded-md shadow-[0_6px_20px_rgba(0,0,0,0.28)] overflow-hidden"
										onMouseEnter={() => setHoveredGroup(entry.name)}
									>
										{entry.children.map((child) => (
											<div
												key={child.name}
												className={itemClassName(value === child.name, hoveredItem === child.name)}
												onMouseEnter={() => setHoveredItem(child.name)}
												onMouseLeave={() => setHoveredItem(null)}
												onClick={() => select(child.name)}
											>
												<span>{child.name}</span>
												<span className="text-xs text-[var(--g-text-dim)] ml-2">
													{child.endpoints}
												</span>
											</div>
										))}
									</div>
								)}
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}
