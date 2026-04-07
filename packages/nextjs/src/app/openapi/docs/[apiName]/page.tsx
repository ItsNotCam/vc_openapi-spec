"use client";

import { use, useEffect } from "react";
import SwaggerUI from "swagger-ui-react";
import "swagger-ui-react/swagger-ui.css";
import "./swagger-theme.css";

interface Props {
	params: Promise<{ apiName: string }>;
	searchParams: Promise<{ method?: string; path?: string; theme?: string }>;
}

export default function DocsPage({ params, searchParams }: Props) {
	const { apiName } = use(params);
	const { method, path, theme = "dark" } = use(searchParams);

	useEffect(() => {
		if (theme === "light") {
			document.body.classList.add("light");
		} else {
			document.body.classList.remove("light");
		}
	}, [theme]);

	useEffect(() => {
		if (!method || !path) return;
		const tryScroll = (attempts = 0) => {
			const m = method.toLowerCase();
			// SwaggerUI IDs: operations-{tag}-{method}{path_with_slashes_and_braces_as_underscores}
			// e.g. GET /ip/address/{id} → operations-ip-get_ip_address__id_
			const pathSlug = path.replace(/[{}]/g, "_").replace(/\//g, "_");
			const candidates = document.querySelectorAll<HTMLElement>(`[id^="operations-"]`);
			let target: HTMLElement | null = null;
			for (const el of candidates) {
				if (el.id.includes(`-${m}`) && el.id.endsWith(pathSlug)) {
					target = el;
					break;
				}
			}
			// Fallback: looser match (path may have trailing underscores or slight variation)
			if (!target) {
				for (const el of candidates) {
					if (el.id.includes(`-${m}`) && el.id.includes(pathSlug.replace(/_+$/, ""))) {
						target = el;
						break;
					}
				}
			}
			if (!target) {
				if (attempts < 25) setTimeout(() => tryScroll(attempts + 1), 300);
				return;
			}

			// Expand parent tag section if it's collapsed
			const tagSection = target.closest<HTMLElement>(".opblock-tag-section");
			if (tagSection) {
				const isCollapsed = !tagSection.querySelector(".opblock-tag[data-is-open='true'], .opblock");
				if (isCollapsed) {
					tagSection.querySelector<HTMLElement>(".opblock-tag button, h4.opblock-tag")?.click();
					// Re-run after expansion animation
					setTimeout(() => tryScroll(attempts), 400);
					return;
				}
			}

			target.scrollIntoView({ behavior: "smooth", block: "start" });

			// Expand the operation if it's collapsed
			const opblock = target.querySelector<HTMLElement>(".opblock");
			if (opblock && !opblock.classList.contains("is-open")) {
				opblock.querySelector<HTMLElement>(".opblock-summary")?.click();
			}
		};
		setTimeout(() => tryScroll(), 1200);
	}, [method, path]);

	// Try yaml first, fall back to json
	const specUrl = `/openapi/specs/${apiName}.yaml`;

	return <SwaggerUI url={specUrl} tryItOutEnabled={false} />;
}
