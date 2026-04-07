"use client";
import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { listApis } from "./lib/api";
import { useStore } from "./store/store";
import Header from "./components/Header";
import GregPage from "./pages/GregPage";
import SearchPage from "./pages/SearchPage";
import DocsPage from "./pages/DocsPage";
import SettingsPage from "./pages/SettingsPage";
import IngestFloat from "./components/IngestFloat";

export default function App() {
	const { page, setApis, setDocsApi, docsApi, theme, setTheme, hydrateFromStorage } = useStore(
		useShallow((s) => ({ page: s.page, setApis: s.setApis, setDocsApi: s.setDocsApi, docsApi: s.docsApi, theme: s.theme, setTheme: s.setTheme, hydrateFromStorage: s.hydrateFromStorage }))
	);

	useEffect(() => {
		hydrateFromStorage();
	}, []);

	useEffect(() => {
		listApis()
			.then((apis) => {
				setApis(apis);
				if (!docsApi && apis.length > 0) {
					setDocsApi(apis[0].name);
				}
			})
			.catch(() => {});
	}, []);

	// Re-apply when system preference changes
	useEffect(() => {
		if (theme !== "system") return;
		const mq = window.matchMedia("(prefers-color-scheme: dark)");
		const handler = () => setTheme("system");
		mq.addEventListener("change", handler);
		return () => mq.removeEventListener("change", handler);
	}, [theme]);

	return (
		<div className="h-screen flex flex-col">
			<Header />
			{page === "greg" && <GregPage />}
			{page === "search" && <SearchPage />}
			{page === "docs" && <DocsPage />}
			{page === "settings" && <SettingsPage />}
			<IngestFloat />
		</div>
	);
}
