import React, { useState, useMemo, useRef, useEffect } from "react";
import { C } from "../lib/constants";
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

	const triggerStyle: React.CSSProperties = {
		display: "flex",
		alignItems: "center",
		gap: 6,
		height,
		padding: withIcon ? `0 28px 0 30px` : `0 28px 0 11px`,
		background: C.surface,
		border: `1px solid ${C.border}`,
		borderRadius: 6,
		fontSize,
		color: color ?? C.textMuted,
		cursor: "pointer",
		minWidth,
		userSelect: "none",
		position: "relative",
		boxSizing: "border-box",
		whiteSpace: "nowrap",
		overflow: "hidden",
		textOverflow: "ellipsis",
	};

	const dropdownStyle: React.CSSProperties = {
		position: "absolute",
		top: "calc(100% + 3px)",
		left: 0,
		zIndex: 200,
		minWidth: Math.max(minWidth, 160),
		background: C.surface,
		border: `1px solid ${C.border}`,
		borderRadius: 6,
		boxShadow: "0 6px 20px rgba(0,0,0,0.28)",
		overflow: "visible",
		paddingTop: 4,
		paddingBottom: 4,
	};

	const itemStyle = (selected: boolean, hovered?: boolean) => ({
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		padding: "7px 11px",
		fontSize: fontSize - 1,
		color: selected ? C.accent : C.text,
		background: selected ? C.accentDim : hovered ? C.surfaceHover : "transparent",
		cursor: "pointer",
		whiteSpace: "nowrap",
	});

	const flyoutStyle: React.CSSProperties = {
		position: "absolute",
		left: "100%",
		top: -1,
		zIndex: 201,
		minWidth: 180,
		background: C.surface,
		border: `1px solid ${C.border}`,
		borderRadius: 6,
		boxShadow: "0 6px 20px rgba(0,0,0,0.28)",
		overflow: "hidden",
	};

	return (
		<div ref={rootRef} style={{ position: "relative", display: "inline-block" }}>
			{/* Trigger */}
			<div
				style={triggerStyle}
				onClick={() => {
					setOpen((o) => !o);
					if (open) setHoveredGroup(null);
				}}
			>
				<span
					style={{
						flex: 1,
						overflow: "hidden",
						textOverflow: "ellipsis",
					}}
				>
					{displayLabel}
				</span>
				{/* Chevron */}
				<svg
					width="12"
					height="12"
					viewBox="0 0 12 12"
					fill="none"
					style={{
						position: "absolute",
						right: 9,
						top: "50%",
						transform: open ? "translateY(-50%) rotate(180deg)" : "translateY(-50%)",
						transition: "transform 0.15s",
						flexShrink: 0,
						color: C.textDim,
					}}
				>
					<path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
				</svg>
			</div>

			{/* Dropdown */}
			{open && (
				<div style={dropdownStyle}>
					{/* "All" option */}
					{allLabel && (
						<div
							style={itemStyle(value === "all", hoveredItem === "__all__")}
							onMouseEnter={() => { setHoveredGroup(null); setHoveredItem("__all__"); }}
							onMouseLeave={() => setHoveredItem(null)}
							onClick={() => select("all")}
						>
							<span>{allLabel}</span>
						</div>
					)}

					{/* Divider after all option */}
					{allLabel && entries.length > 0 && (
						<div style={{ height: 1, background: C.border, margin: "2px 0" }} />
					)}

					{entries.map((entry) => {
						if (entry.type === "single") {
							return (
								<div
									key={entry.api.name}
									style={itemStyle(value === entry.api.name, hoveredItem === entry.api.name)}
									onMouseEnter={() => { setHoveredGroup(null); setHoveredItem(entry.api.name); }}
									onMouseLeave={() => setHoveredItem(null)}
									onClick={() => select(entry.api.name)}
								>
									<span>{entry.api.name}</span>
									<span style={{ fontSize: 12, color: C.textDim, marginLeft: 8 }}>
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
								style={{ position: "relative" }}
								onMouseEnter={() => setHoveredGroup(entry.name)}
								onMouseLeave={() => setHoveredGroup(null)}
								onClick={(e) => { e.stopPropagation(); setHoveredGroup(isHovered ? null : entry.name); }}
							>
								<div style={itemStyle(hasSelectedChild, isHovered)}>
									<span>{entry.name}</span>
									<div style={{ display: "flex", alignItems: "center", gap: 6 }}>
										<span style={{ fontSize: 12, color: C.textDim }}>
											{entry.children.reduce((s, c) => s + c.endpoints, 0)}
										</span>
										{/* Right arrow indicator */}
										<svg
											width="10"
											height="10"
											viewBox="0 0 10 10"
											fill="none"
											style={{ color: C.textDim, flexShrink: 0 }}
										>
											<path d="M3 2l4 3-4 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
										</svg>
									</div>
								</div>

								{/* Flyout */}
								{isHovered && (
									<div style={flyoutStyle} onMouseEnter={() => setHoveredGroup(entry.name)}>
										{entry.children.map((child) => (
											<div
												key={child.name}
												style={itemStyle(value === child.name, hoveredItem === child.name)}
												onMouseEnter={() => setHoveredItem(child.name)}
												onMouseLeave={() => setHoveredItem(null)}
												onClick={() => select(child.name)}
											>
												<span>{child.name}</span>
												<span style={{ fontSize: 12, color: C.textDim, marginLeft: 8 }}>
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
