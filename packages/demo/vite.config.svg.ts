// Build config for the single-folder "SVG" edition of Minason Web v2 (jsDelivr-hosted).
// Does NOT touch vite.config.ts. Run from packages/demo:
//   pnpm exec vite build --config vite.config.svg.ts && node scripts/make-svg.mjs
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { viteStaticCopy } from "vite-plugin-static-copy";
import { scramjetPath } from "@mercuryworkshop/scramjet/path";
import { controllerPath } from "@mercuryworkshop/scramjet-controller/path";

const here = path.dirname(fileURLToPath(import.meta.url));
const indexTsx = path.resolve(here, "src/index.tsx");
const indexSvgTsx = path.resolve(here, "src/index.svg.tsx");

const buildId =
	process.env.GITHUB_SHA?.slice(0, 12) ||
	(() => {
		try {
			return execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
		} catch {
			return "local";
		}
	})();

// Service worker for the SVG edition. importScripts is relative to this file,
// so it works from any jsDelivr folder (the original uses an absolute "/controller/...").
const swSource = `importScripts("./controller/controller.sw.js");

addEventListener("fetch", (e) => {
\tif ($scramjetController.shouldRoute(e)) {
\t\te.respondWith($scramjetController.route(e));
\t}
});
`;

export default {
	base: "./",
	publicDir: false,
	define: { __MW_BUILD_ID__: JSON.stringify(buildId) },
	build: {
		outDir: "dist-svg",
		emptyOutDir: true,
		rollupOptions: { input: path.resolve(here, "index.svg.html") },
	},
	plugins: [
		{
			// BrowserView.tsx does `import ... from ".."` (= src/index.tsx). Point that at
			// src/index.svg.tsx for this build only; src/index.tsx stays untouched.
			name: "minason-svg-entry-swap",
			enforce: "pre",
			async resolveId(this: any, source: string, importer: string | undefined, opts: any) {
				if (!importer) return null;
				const r = await this.resolve(source, importer, { ...opts, skipSelf: true });
				if (r && path.resolve(r.id) === indexTsx) return indexSvgTsx;
				return null;
			},
		},
		{
			// Two origin-absolute URLs in BrowserView.tsx would hit cdn.jsdelivr.net's root
			// inside the SVG build. Patched in memory at build time; the file is not edited.
			name: "minason-svg-relative-urls",
			enforce: "pre",
			transform(this: any, code: string, id: string) {
				if (!id.replace(/\\/g, "/").endsWith("/src/pages/BrowserView.tsx")) return null;
				let out = code;
				const swaps: [string, string][] = [
					[
						'"/icon.png"',
						'new URL("icon.png", location.href).href',
					],
					[
						"new URL(`/?goto=${encodeURIComponent(url.href)}`, location.origin)",
						'new URL("index.svg?goto=" + encodeURIComponent(url.href), new URL("./", location.href))',
					],
				];
				for (const [from, to] of swaps) {
					if (!out.includes(from)) {
						this.warn("SVG build: pattern not found in BrowserView.tsx, left unpatched: " + from);
						continue;
					}
					out = out.replace(from, to);
				}
				return { code: out, map: null };
			},
		},
		{
			name: "minason-svg-shell",
			transformIndexHtml(html: string) {
				const v = encodeURIComponent(buildId);
				return html
					.replace('src="scramjet/scramjet.js"', 'src="scramjet/scramjet.js?v=' + v + '"')
					.replace('src="controller/controller.api.js"', 'src="controller/controller.api.js?v=' + v + '"');
			},
			generateBundle(this: any) {
				this.emitFile({ type: "asset", fileName: "sw.js", source: swSource });
			},
		},
		viteStaticCopy({
			structured: false,
			targets: [
				{ src: scramjetPath + "/*", dest: "scramjet" },
				{ src: controllerPath + "/*", dest: "controller" },
				{ src: path.resolve(here, "public/icon.png"), dest: "." },
			],
		}),
	],
};
