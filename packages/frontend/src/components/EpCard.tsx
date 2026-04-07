import { C, METHOD_COLORS } from "../lib/constants";

interface EpCardProps {
	method: string;
	path: string;
	api: string;
	description: string;
	warnings?: string;
	compact?: boolean;
	onClick?: () => void;
}

export default function EpCard({ method, path, api, description, warnings, compact, onClick }: EpCardProps) {
	const warningList = warnings ? warnings.split("|").filter(Boolean) : [];
	const m = METHOD_COLORS[method] ?? METHOD_COLORS.GET;
	return (
		<div
			onClick={onClick}
			style={{
				background: C.surface,
				border: `1px solid ${C.border}`,
				borderRadius: 4,
				padding: compact ? "3px 6px" : "4px 8px",
				cursor: onClick ? "pointer" : "default",
				transition: "all 0.1s",
			}}
			onMouseEnter={(e) => {
				if (onClick) (e.currentTarget as HTMLElement).style.borderColor = C.borderHover;
			}}
			onMouseLeave={(e) => {
				(e.currentTarget as HTMLElement).style.borderColor = C.border;
			}}
		>
			<div style={{ display: "flex", alignItems: "center", gap: 5 }}>
				<span
					style={{
						fontSize: 10,
						fontWeight: 600,
						padding: "0px 4px",
						borderRadius: 3,
						fontFamily: "monospace",
						background: m.bg,
						color: m.text,
						border: `1px solid ${m.border}`,
						minWidth: compact ? 30 : 34,
						textAlign: "center",
					}}
				>
					{method}
				</span>
				<code
					style={{
						fontSize: compact ? 11 : 12,
						fontFamily: "monospace",
						color: C.text,
						overflow: "hidden",
						textOverflow: "ellipsis",
						whiteSpace: "nowrap",
						flex: 1,
					}}
				>
					{path}
				</code>
				<span
					style={{
						fontSize: 10,
						padding: "0px 4px",
						borderRadius: 3,
						background: C.accentDim,
						color: C.accent,
						fontWeight: 500,
						flexShrink: 0,
					}}
				>
					{api}
				</span>
			</div>
			<p
				style={{
					fontSize: compact ? 10 : 11,
					color: C.textDim,
					margin: "2px 0 0",
					lineHeight: 1.3,
					paddingLeft: compact ? 35 : 40,
					overflow: "hidden",
					textOverflow: "ellipsis",
					whiteSpace: "nowrap",
				}}
			>
				{description}
			</p>
			{!compact && warningList.length > 0 && (
				<div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginTop: 4, paddingLeft: 40 }}>
					{warningList.map((w, i) => (
						<span key={i} style={{
							fontSize: 12,
							padding: "3px 8px",
							borderRadius: 4,
							background: "rgba(251,191,36,0.15)",
							color: "#FCD34D",
							border: "1px solid rgba(251,191,36,0.35)",
							lineHeight: 1.5,
						}}>
							⚠ {w}
						</span>
					))}
				</div>
			)}
		</div>
	);
}
