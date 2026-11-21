import { execSync } from "node:child_process";
import { viteStaticCopy } from "vite-plugin-static-copy";
import { scramjetPath } from "@mercuryworkshop/scramjet/path";
import { controllerPath } from "@mercuryworkshop/scramjet-controller/path";

const buildId =
	process.env.GITHUB_SHA?.slice(0, 12) ||
	(() => {
		try {
			return execSync("git rev-parse --short HEAD", {
				encoding: "utf-8",
			}).trim();
		} catch {
			return "local";
		}
	})();

export default {
	define: {
		__MW_BUILD_ID__: JSON.stringify(buildId),
	},
	plugins: [
		{
			name: "minason-versioned-shell-assets",
			transformIndexHtml(html: string) {
				const version = encodeURIComponent(buildId);
				return html
					.replace(
						'src="/scramjet/scramjet.js"',
						'src="/scramjet/scramjet.js?v=' + version + '"'
					)
					.replace(
						'src="/controller/controller.api.js"',
						'src="/controller/controller.api.js?v=' + version + '"'
					);
			},
		},
		viteStaticCopy({
			structured: false,
			targets: [
				{
					src: scramjetPath + "/*",
					dest: "scramjet",
				},
				{
					src: controllerPath + "/*",
					dest: "controller",
				},
			],
			watch: {
				reloadPageOnChange: true,
			},
		}),
	],
};