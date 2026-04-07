"use server";

import { getRetriever } from "@/lib/retriever";
import type { ApiInfo } from "#types/store";

export async function listApis(): Promise<ApiInfo[]> {
	return getRetriever().listApis();
}

export async function deleteApi(name: string): Promise<void> {
	await getRetriever().deleteApi(name);
}
