import App from "./App";
import LibcurlClient from "@mercuryworkshop/libcurl-transport";
import EpoxyClient from "@mercuryworkshop/epoxy-transport";
import { defaultConfigDev } from "@mercuryworkshop/scramjet";
import { Controller } from "@mercuryworkshop/scramjet-controller";
import { HttpCachePlugin } from "@mercuryworkshop/scramjet-utils";
import { DEFAULT_WISP_URL, demoSettingsStore, WISP_URLS } from "./store";
import {
	connectWisp,
	getActiveWispUrl,
	setActiveWispUrl,
} from "./wisp-status";

declare const __MW_BUILD_ID__: string;

let app = document.getElementById("app")!;
const buildAsset = (path: string): string =>
	path + "?v=" + encodeURIComponent(__MW_BUILD_ID__);

let controller: InstanceType<typeof Controller>;
const cachePlugin = new HttpCachePlugin();

export function getTransport(
	wispOverride?: string,
	kind: string = demoSettingsStore.transport
): LibcurlClient | EpoxyClient {
	const wisp = wispOverride ?? demoSettingsStore.wispUrl;
	return kind === "epoxy"
		? new EpoxyClient({ wisp })
		: new LibcurlClient({ wisp });
}

async function pickWisp(): Promise<string> {
	const savedPreferred = getActiveWispUrl(demoSettingsStore.wispUrl);
	// Move users saved on an older built-in relay to the new default. Custom
	// Wisp selections remain preferred.
	const preferred = WISP_URLS.slice(1).includes(savedPreferred)
		? DEFAULT_WISP_URL
		: savedPreferred;
	if (preferred !== savedPreferred) {
		demoSettingsStore.wispUrl = preferred;
		setActiveWispUrl(preferred);
	}

	const candidates = [...new Set([preferred, ...WISP_URLS])];
	for (const url of candidates) {
		if (await connectWisp(url, 3000)) {
			demoSettingsStore.wispUrl = url;
			setActiveWispUrl(url);
			return url;
		}
	}

	// Keep the browser UI available so a working custom Wisp can be added.
	demoSettingsStore.wispUrl = preferred || DEFAULT_WISP_URL;
	return demoSettingsStore.wispUrl;
}

function isCompatibleServiceWorker(
	worker: ServiceWorker | null
): worker is ServiceWorker {
	if (!worker) return false;
	try {
		const url = new URL(worker.scriptURL);
		return url.origin === location.origin && url.pathname === "/sw.js";
	} catch {
		return false;
	}
}

async function waitForController(timeoutMs = 12000): Promise<ServiceWorker> {
	const currentController = () => {
		const worker = navigator.serviceWorker.controller;
		return isCompatibleServiceWorker(worker) ? worker : null;
	};

	// Reuse the active Minason worker even while a newer build installs.
	// The proxy worker interface stays compatible across Minason app releases.
	const existing = currentController();
	if (existing) return existing;

	return await new Promise<ServiceWorker>((resolve, reject) => {
		let timer = 0;
		let settled = false;
		const cleanup = () => {
			navigator.serviceWorker.removeEventListener("controllerchange", onChange);
			window.clearTimeout(timer);
		};
		const finish = (worker: ServiceWorker | null) => {
			if (settled || !worker) return;
			settled = true;
			cleanup();
			resolve(worker);
		};
		const onChange = () => finish(currentController());

		navigator.serviceWorker.addEventListener("controllerchange", onChange);
		timer = window.setTimeout(() => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(new Error("The browser worker did not become ready in time."));
		}, timeoutMs);
		void navigator.serviceWorker.ready.then(onChange).catch(() => {});
		onChange();
	});
}

async function init() {
	try {
		if (!("serviceWorker" in navigator)) {
			throw new Error("This browser does not support the service needed to run Minason Web.");
		}

		const serviceWorkerUrl = new URL("/sw.js", location.origin);
		serviceWorkerUrl.searchParams.set("v", __MW_BUILD_ID__);
		await navigator.serviceWorker.register(serviceWorkerUrl.href, {
			updateViaCache: "none",
		});

		const readySw = await waitForController();
		const wisp = await pickWisp();
		const savedTransport = localStorage.getItem("mw-transport");
		const primaryKind: "epoxy" | "libcurl" =
			savedTransport === "epoxy" || savedTransport === "libcurl"
				? savedTransport
				: "libcurl";
		demoSettingsStore.transport = primaryKind;
		const fallbackKind = primaryKind === "epoxy" ? "libcurl" : "epoxy";

		const startController = async (kind: "epoxy" | "libcurl") => {
			const transport = getTransport(wisp, kind);
			await transport.init();
			const instance = new Controller({
				serviceworker: readySw,
				transport,
				config: {
					scramjetPath: buildAsset("/scramjet/scramjet.js"),
					injectPath: buildAsset("/controller/controller.inject.js"),
					wasmPath: buildAsset("/scramjet/scramjet.wasm"),
				},
				scramjetConfig: defaultConfigDev,
			});
			await instance.wait();
			return instance;
		};

		try {
			controller = await startController(primaryKind);
		} catch (err) {
			console.warn(
				primaryKind + " transport initialization failed, trying " + fallbackKind,
				err
			);
			controller = await startController(fallbackKind);
			demoSettingsStore.transport = fallbackKind;
			localStorage.setItem("mw-transport", fallbackKind);
		}
		console.log(controller);
	} catch (e) {
		console.error("Error during Minason Web startup:", e);
		throw e;
	}
}

async function mount() {
	try {
		const root = <App />;
		app.replaceWith(root);
	} catch (e) {
		let err = e as any;
		app.replaceWith(
			document.createTextNode(
				`Error mounting: ${"message" in err ? err.message : err}`
			)
		);
		console.error(err);
		throw e;
	}
}

init()
	.then(() => mount())
	.catch((error) => {
		app.innerText = "Failed to initialize Minason Web: " +
			(error instanceof Error ? error.message : String(error));
		window.dispatchEvent(new CustomEvent("mw-initial-error", {
			detail: error instanceof Error ? error.message : String(error),
		}));
		console.error(error);
	});
export { controller, cachePlugin };
