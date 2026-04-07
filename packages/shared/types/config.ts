import z from "zod";

export type AppConfig = z.infer<typeof AppConfig>;
export const AppConfig = z.object({
	CHROMA_HOST: z.string().optional(),
	CHROMA_PORT: z.coerce.number().default(8000),
	CHROMA_SSL: z.string().transform((v) => v === "true").default("false"),
	CHROMA_AUTH_TOKEN: z.string().optional(),
	CHROMA_DB_PATH: z.string().default(".chroma_db"),
	CHROMA_COLLECTION: z.string().default("openapi_specs"),

	OLLAMA_URL: z.string().optional(),
	OLLAMA_MODEL: z.string().default("mxbai-embed-large"),
	OLLAMA_CHAT_SUMMARY_MODEL: z.string().default("smollm:1.7b"),
	EMBEDDING_MODEL: z.string().default("all-MiniLM-L6-v2"),

	PORT: z.coerce.number().default(3000),
	HOST: z.string().default("0.0.0.0"),

	MCP_ADMIN_TOKEN: z.string().optional(),
	MCP_READ_TOKEN: z.string().optional(),

	LLM_PROVIDER: z.enum(["anthropic", "ollama"]).default("anthropic"),
	LLM_MODEL: z.string().default("claude-haiku-4-5-20251001"),
	ANTHROPIC_API_KEY: z.string().optional(),
	GIPHY_API_KEY: z.string().optional(),

	MAX_TOOL_CALLS_PER_SESSION: z.coerce.number().default(5),
	LLM_MAX_TOKENS: z.coerce.number().default(4096),

	NODE_ENV: z.string().default("development"),
});
