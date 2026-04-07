"use client";
import { useShallow } from "zustand/react/shallow";
import { Ic } from "../lib/icons";
import { useStore } from "../store/store";
import type { ThemePref } from "../store/store";

const THEME_OPTS: { value: ThemePref; label: string }[] = [
	{ value: "system", label: "Auto" },
	{ value: "light", label: "Light" },
	{ value: "dark", label: "Dark" },
];

function ThemeToggle() {
	const { theme, setTheme } = useStore(useShallow((s) => ({ theme: s.theme, setTheme: s.setTheme })));

	return (
		<div className="flex bg-[var(--g-surface)] border border-[var(--g-border)] rounded-md overflow-hidden">
			{THEME_OPTS.map((o) => (
				<button
					key={o.value}
					onClick={() => setTheme(o.value)}
					className={[
						"py-[0.1875rem] px-2 text-xs border-none cursor-pointer",
						theme === o.value
							? "bg-[var(--g-accent-muted)] text-[var(--g-accent)] font-semibold"
							: "bg-transparent text-[var(--g-text-dim)] font-normal",
					].join(" ")}
				>
					{o.label}
				</button>
			))}
		</div>
	);
}

const TABS = [
	{ key: "greg" as const, label: "greg", icon: Ic.chat },
	{ key: "search" as const, label: "Semantic search", icon: Ic.search },
	{ key: "docs" as const, label: "API docs", icon: Ic.doc },
	{ key: "settings" as const, label: "Settings", icon: Ic.server },
];

export default function Header() {
	const { page, setPage, apis } = useStore(useShallow((s) => ({ page: s.page, setPage: s.setPage, apis: s.apis })));

	const totalEndpoints = apis.reduce((s, a) => s + a.endpoints, 0);

	return (
		<div className="border-b border-[var(--g-border)] px-5 flex items-stretch h-14 shrink-0">
			{/* Logo */}
			<div className="flex items-center gap-2 mr-[1.375rem]">
				<div className="w-7 h-7 rounded-md bg-[var(--g-green)] flex items-center justify-center">
					<svg width={18} height={18} viewBox="0 0 20 20" fill="none">
						<circle cx="7" cy="8" r="1.4" fill="white"/>
						<circle cx="13" cy="8" r="1.4" fill="white"/>
						<path d="M6.5 13.5h7" stroke="white" strokeWidth="1.8" strokeLinecap="round"/>
					</svg>
				</div>
				<span className="text-lg font-semibold tracking-[-0.01em]">greg</span>
			</div>

			{/* Tabs */}
			{TABS.map((t) => (
				<button
					key={t.key}
					onClick={() => setPage(t.key)}
					className={[
						"flex items-center gap-1.5 px-3.5 text-base font-medium border-none cursor-pointer bg-transparent -mb-px border-b-2",
						page === t.key
							? "text-[var(--g-accent)] border-b-[var(--g-accent)]"
							: "text-[var(--g-text-dim)] border-b-transparent",
					].join(" ")}
				>
					{t.icon()}
					{t.label}
				</button>
			))}

			{/* Stats + theme toggle */}
			<div className="ml-auto flex items-center gap-[0.6875rem]">
				<span className="text-sm text-[var(--g-text-dim)] flex items-center gap-1">
					{Ic.server()} {apis.length} APIs
				</span>
				<span className="text-sm text-[var(--g-text-dim)]">{totalEndpoints} endpoints</span>
				<ThemeToggle />
			</div>
		</div>
	);
}
