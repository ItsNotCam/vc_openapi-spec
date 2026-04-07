import Retriever from "@greg/shared/core/retriever";
import fs from "node:fs";
import path from "node:path";

let _retriever: Retriever | null = null;
let _autoIngestDone = false;

export function getRetriever(): Retriever {
	if (!_retriever) {
		_retriever = new Retriever();
		// Kick off auto-ingest in the background on first use
		if (!_autoIngestDone) {
			_autoIngestDone = true;
			void autoIngestSpecs(_retriever);
		}
	}
	return _retriever;
}

async function autoIngestSpecs(retriever: Retriever): Promise<void> {
	const SPECS_DIR = process.env.SPECS_DIR ?? path.resolve(process.cwd(), "../../specs");
	if (!fs.existsSync(SPECS_DIR)) return;

	try {
		const indexed = new Set((await retriever.listApis()).map((a) => a.name));
		const entries = fs.readdirSync(SPECS_DIR).sort();

		for (const filename of entries) {
			const ext = path.extname(filename);
			if (![".yaml", ".yml", ".json"].includes(ext)) continue;
			const apiName = path.basename(filename, ext);
			if (indexed.has(apiName)) continue;

			const filePath = path.join(SPECS_DIR, filename);
			console.log(`[auto-ingest] ingesting ${filename} as '${apiName}' ...`);
			try {
				const summary = await retriever.ingest(filePath, apiName, (e) => {
					if (e.phase === "embedding" || e.phase === "storing") {
						if (e.done === e.total || (e.done ?? 0) % 500 === 0) {
							console.log(`[auto-ingest] ${apiName}: ${e.phase} ${e.done}/${e.total}`);
						}
					} else {
						console.log(`[auto-ingest] ${apiName}: ${e.message}`);
					}
				}, { skipDelete: true });
				console.log(`[auto-ingest] ${apiName}: done — ${summary.endpointsIngested} endpoints, ${summary.schemasIngested} schemas`);
			} catch (err) {
				console.error(`[auto-ingest] ${filename}:`, err instanceof Error ? err.message : err);
			}
		}
	} catch {
		// Non-fatal — app works without auto-ingest
	}
}
