// All colors reference CSS custom properties so light/dark mode is a single class toggle
export const C = {
	bg: "var(--g-bg)",
	surface: "var(--g-surface)",
	surfaceHover: "var(--g-surface-hover)",
	surfaceActive: "var(--g-surface-active)",
	border: "var(--g-border)",
	borderHover: "var(--g-border-hover)",
	borderAccent: "var(--g-border-accent)",
	text: "var(--g-text)",
	textMuted: "var(--g-text-muted)",
	textDim: "var(--g-text-dim)",
	accent: "var(--g-accent)",
	accentMuted: "var(--g-accent-muted)",
	accentDim: "var(--g-accent-dim)",
	green: "var(--g-green)",
	userBg: "var(--g-user-bg)",
	gregBg: "var(--g-greg-bg)",
	codeBg: "var(--g-code-bg)",
} as const;

export const METHOD_COLORS: Record<string, { bg: string; text: string; border: string }> = {
	GET: { bg: "var(--g-method-get-bg)", text: "var(--g-method-get-text)", border: "var(--g-method-get-border)" },
	POST: { bg: "var(--g-method-post-bg)", text: "var(--g-method-post-text)", border: "var(--g-method-post-border)" },
	PUT: { bg: "var(--g-method-put-bg)", text: "var(--g-method-put-text)", border: "var(--g-method-put-border)" },
	DELETE: { bg: "var(--g-method-del-bg)", text: "var(--g-method-del-text)", border: "var(--g-method-del-border)" },
	PATCH: { bg: "var(--g-method-patch-bg)", text: "var(--g-method-patch-text)", border: "var(--g-method-patch-border)" },
};
