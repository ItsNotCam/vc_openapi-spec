import { NextRequest } from "next/server";
import config from "@greg/shared/core/config";

function isAuthEnabled(): boolean {
	return config.NODE_ENV === "production" && !!(config.MCP_ADMIN_TOKEN || config.MCP_READ_TOKEN);
}

export function getRole(req: NextRequest): "admin" | "read" | null {
	if (!isAuthEnabled()) return "admin";

	const auth = req.headers.get("authorization") ?? "";
	const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";

	if (config.MCP_ADMIN_TOKEN && token === config.MCP_ADMIN_TOKEN) return "admin";
	if (config.MCP_READ_TOKEN && token === config.MCP_READ_TOKEN) return "read";
	return null;
}
