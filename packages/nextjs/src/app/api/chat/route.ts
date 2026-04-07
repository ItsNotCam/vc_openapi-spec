import { NextRequest } from "next/server";
import { handleChat, type ChatRequest } from "@greg/shared/chat";
import { getRetriever } from "@/lib/retriever";

export async function POST(req: NextRequest): Promise<Response> {
	const body = await req.json() as ChatRequest;
	return handleChat(body, getRetriever());
}
