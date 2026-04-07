"use client";
import { METHOD_COLORS } from "../lib/constants";

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
			className={`g-card ${compact ? "px-1.5 py-[0.1875rem]" : "px-2 py-1"} ${onClick ? "cursor-pointer hover:border-[var(--g-border-hover)]" : "cursor-default"} transition-all duration-100`}
		>
			<div className="flex items-center gap-[0.3125rem]">
				<span
					className="method-badge text-center"
					style={{
						background: m.bg,
						color: m.text,
						border: `1px solid ${m.border}`,
						minWidth: compact ? 30 : 34,
					}}
				>
					{method}
				</span>
				<code
					className={`${compact ? "text-[0.6875rem]" : "text-xs"} font-mono text-[var(--g-text)] truncate flex-1`}
				>
					{path}
				</code>
				<span className="api-badge flex-shrink-0">
					{api}
				</span>
			</div>
			<p
				className={`${compact ? "text-[0.625rem] pl-[2.1875rem]" : "text-[0.6875rem] pl-10"} text-[var(--g-text-dim)] mt-0.5 leading-[1.3] truncate`}
			>
				{description}
			</p>
			{!compact && warningList.length > 0 && (
				<div className="flex flex-wrap gap-[0.1875rem] mt-1 pl-10">
					{warningList.map((w, i) => (
						<span
							key={i}
							className="text-xs px-2 py-[0.1875rem] rounded bg-[rgba(251,191,36,0.15)] text-[#FCD34D] border border-[rgba(251,191,36,0.35)] leading-[1.5]"
						>
							⚠ {w}
						</span>
					))}
				</div>
			)}
		</div>
	);
}
