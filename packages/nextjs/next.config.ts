import type { NextConfig } from "next";

// Packages that contain native binaries or are otherwise un-bundleable
const SERVER_EXTERNAL = [
	"chromadb",
	"chromadb-default-embed",
	"cohere-ai",
	"onnxruntime-node",
	"@anthropic-ai/sdk",
	"@apidevtools/json-schema-ref-parser",
	"@jsdevtools/ono",
	"yaml",
];

const nextConfig: NextConfig = {
	// Transpile the shared workspace package (exports raw .ts source)
	transpilePackages: ["@greg/shared"],

	// Hint to Next.js's bundler to not process these server-side (Webpack + Turbopack)
	serverExternalPackages: SERVER_EXTERNAL,

	turbopack: {
		resolveExtensions: [".ts", ".tsx", ".js", ".jsx", ".json"],
	},

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	webpack(config, { isServer, webpack }: { isServer: boolean; webpack: any }) {
		// Strip node: protocol prefix before webpack tries to handle it as a URI scheme.
		// webpack 5 doesn't understand node: URIs by default; this plugin rewrites them
		// to their bare module names (e.g. "node:path" → "path") before resolution.
		config.plugins.push(
			new webpack.NormalModuleReplacementPlugin(/^node:/, (resource: { request: string }) => {
				resource.request = resource.request.replace(/^node:/, "");
			}),
		);

		if (isServer) {
			// Externalize native addons and un-bundleable packages
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			config.externals = [
				...(Array.isArray(config.externals) ? config.externals : config.externals ? [config.externals] : []),
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				(ctx: { request?: string }, callback: any) => {
					const req = ctx.request ?? "";
					const shouldExternalize =
						req.endsWith(".node") ||
						SERVER_EXTERNAL.some((pkg) => req === pkg || req.startsWith(pkg + "/"));
					if (shouldExternalize) {
						callback(null, `commonjs ${req}`);
					} else {
						callback();
					}
				},
			];
		} else {
			// Client bundle: stub out Node.js built-ins that leak through server-action imports
			config.resolve.fallback = {
				...config.resolve.fallback,
				fs: false,
				"fs/promises": false,
				path: false,
				os: false,
				crypto: false,
				stream: false,
				buffer: false,
				util: false,
				url: false,
				net: false,
				tls: false,
				http: false,
				https: false,
				zlib: false,
				child_process: false,
			};
			// Alias server-only packages to empty modules so the client bundle
			// doesn't try to parse them (they're only used in "use server" files)
			for (const pkg of SERVER_EXTERNAL) {
				(config.resolve.alias as Record<string, false>)[pkg] = false;
			}
		}
		return config;
	},
};

export default nextConfig;
