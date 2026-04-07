"use client";
export const Ic = {
	chat: (s = 13) => (
		<svg width={s} height={s} viewBox="0 0 16 16" fill="none">
			<path d="M2 3h12v8H6l-3 2.5V11H2z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" fill="none" />
		</svg>
	),
	search: (s = 13) => (
		<svg width={s} height={s} viewBox="0 0 16 16" fill="none">
			<circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" strokeWidth="1.4" />
			<path d="M10 10l4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
		</svg>
	),
	doc: (s = 13) => (
		<svg width={s} height={s} viewBox="0 0 16 16" fill="none">
			<rect x="3" y="2" width="10" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.2" fill="none" />
			<path d="M5.5 5.5h5M5.5 8h3.5M5.5 10.5h4.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
		</svg>
	),
	cube: (s = 13) => (
		<svg width={s} height={s} viewBox="0 0 16 16" fill="none">
			<path d="M8 1.5L14 5v6l-6 3.5L2 11V5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" fill="none" />
			<path d="M8 8.5V15M8 8.5L2 5M8 8.5l6-3.5" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />
		</svg>
	),
	ext: (s = 11) => (
		<svg width={s} height={s} viewBox="0 0 12 12" fill="none">
			<path d="M5 2.5h-2a1 1 0 00-1 1v5.5a1 1 0 001 1h5.5a1 1 0 001-1v-2" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
			<path d="M7 1.5h3.5V5M7 5.5L10.5 1.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
		</svg>
	),
	server: (s = 11) => (
		<svg width={s} height={s} viewBox="0 0 16 16" fill="none">
			<rect x="2" y="3" width="12" height="4" rx="1" stroke="currentColor" strokeWidth="1.1" fill="none" />
			<rect x="2" y="9" width="12" height="4" rx="1" stroke="currentColor" strokeWidth="1.1" fill="none" />
			<circle cx="4.5" cy="5" r="0.7" fill="currentColor" />
			<circle cx="4.5" cy="11" r="0.7" fill="currentColor" />
		</svg>
	),
	bolt: (s = 11) => (
		<svg width={s} height={s} viewBox="0 0 16 16" fill="none">
			<path d="M9 1.5L4 9h4l-1 5.5L12 7H8z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" fill="none" />
		</svg>
	),
	tag: (s = 10) => (
		<svg width={s} height={s} viewBox="0 0 12 12" fill="none">
			<path d="M1.5 2.5h4l4.5 4.5-4 4-4.5-4.5z" stroke="currentColor" strokeWidth="1" fill="none" />
			<circle cx="4" cy="4.5" r="0.7" fill="currentColor" />
		</svg>
	),
	arr: (s = 10) => (
		<svg width={s} height={s} viewBox="0 0 12 12" fill="none">
			<path d="M2 6h8M7 3l3 3-3 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
		</svg>
	),
	x: (s = 13) => (
		<svg width={s} height={s} viewBox="0 0 14 14" fill="none">
			<path d="M3.5 3.5l7 7M10.5 3.5l-7 7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
		</svg>
	),
	copy: (s = 11) => (
		<svg width={s} height={s} viewBox="0 0 12 12" fill="none">
			<rect x="4" y="4" width="6.5" height="6.5" rx="1" stroke="currentColor" strokeWidth="1" fill="none" />
			<path d="M8 4V2.5a1 1 0 00-1-1H2.5a1 1 0 00-1 1V7a1 1 0 001 1H4" stroke="currentColor" strokeWidth="1" />
		</svg>
	),
	send: (s = 14) => (
		<svg width={s} height={s} viewBox="0 0 16 16" fill="none">
			<path d="M14 8L2 2.5 6 8l-4 5.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" fill="none" />
		</svg>
	),
	plus: (s = 13) => (
		<svg width={s} height={s} viewBox="0 0 14 14" fill="none">
			<path d="M7 2v10M2 7h10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
		</svg>
	),
	bug: (s = 14) => (
		<svg width={s} height={s} viewBox="0 0 16 16" fill="none">
			<ellipse cx="8" cy="9.5" rx="3.5" ry="4.5" stroke="currentColor" strokeWidth="1.2"/>
			<path d="M5.5 6C5.5 4.5 6.5 3.5 8 3.5s2.5 1 2.5 2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
			<path d="M4 8.5H2M12 8.5h2M4 11H2M12 11h2M4.5 14l-1.5 1.5M11.5 14l1.5 1.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
			<path d="M6.5 3.5L5.5 2M9.5 3.5l1-1.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
		</svg>
	),
};
