"use client";
export default function ScoreBar({ score }: { score: number }) {
	const p = Math.round(score * 100);
	return (
		<div className="flex items-center gap-1.5">
			<div className="w-[34px] h-1 bg-[var(--g-border)] rounded-[2px] overflow-hidden">
				<div style={{ width: `${p}%` }} className="h-full bg-[var(--g-accent)] rounded-[2px]" />
			</div>
			<span className="text-[0.8125rem] text-[var(--g-text-dim)] font-mono">{p}%</span>
		</div>
	);
}
