import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { getRetriever } from "@/lib/retriever";
import { getRole } from "@/lib/auth";

const SPECS_DIR = process.env.SPECS_DIR ?? path.resolve(process.cwd(), "../../specs");

async function saveSpecFile(apiName: string, content: string, ext: string): Promise<void> {
	if (!fs.existsSync(SPECS_DIR)) fs.mkdirSync(SPECS_DIR, { recursive: true });
	const filePath = path.join(SPECS_DIR, `${apiName}${ext}`);
	await fs.promises.writeFile(filePath, content, "utf-8");
}

export async function POST(req: NextRequest): Promise<Response> {
	const role = getRole(req);
	if (!role) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
	if (role !== "admin") return NextResponse.json({ error: "admin role required" }, { status: 403 });

	const body = await req.json() as { content: string; format: "yaml" | "json"; api_name: string };
	if (!body.content || !body.format || !body.api_name) {
		return NextResponse.json({ error: "missing content, format, or api_name" }, { status: 400 });
	}

	const { readable, writable } = new TransformStream();
	const writer = writable.getWriter();
	const enc = new TextEncoder();
	const send = (obj: Record<string, unknown>) =>
		writer.write(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));

	(async () => {
		try {
			const ext = body.format === "json" ? ".json" : ".yaml";
			await saveSpecFile(body.api_name, body.content, ext);
			const summary = await getRetriever().ingestContent(body.content, body.format, body.api_name, (e) => send(e as unknown as Record<string, unknown>));
			send({ phase: "complete", summary });
		} catch (err) {
			send({ phase: "error", message: err instanceof Error ? err.message : "ingest failed" });
		} finally {
			writer.close();
		}
	})();

	return new Response(readable, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		},
	});
}
