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
	console.log(`[specs] saved ${filePath}`);
}

export async function POST(req: NextRequest): Promise<Response> {
	const role = getRole(req);
	if (!role) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
	if (role !== "admin") return NextResponse.json({ error: "admin role required" }, { status: 403 });

	const body = await req.json() as { source: string; api_name: string };
	if (!body.source || !body.api_name) {
		return NextResponse.json({ error: "missing source or api_name" }, { status: 400 });
	}

	const { readable, writable } = new TransformStream();
	const writer = writable.getWriter();
	const enc = new TextEncoder();
	const send = (obj: Record<string, unknown>) =>
		writer.write(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));

	(async () => {
		try {
			// Save raw spec file
			if (!body.source.startsWith("http")) {
				try {
					const raw = await fs.promises.readFile(path.resolve(body.source), "utf-8");
					const ext = path.extname(body.source) || ".yaml";
					await saveSpecFile(body.api_name, raw, ext);
				} catch {}
			} else {
				try {
					const res = await fetch(body.source);
					if (res.ok) {
						const raw = await res.text();
						const ext = body.source.match(/\.(json|ya?ml)/i)?.[0] ?? ".yaml";
						await saveSpecFile(body.api_name, raw, ext);
					}
				} catch {}
			}

			const summary = await getRetriever().ingest(body.source, body.api_name, (e) => send(e as unknown as Record<string, unknown>));
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
