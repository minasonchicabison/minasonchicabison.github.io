import LoadInterstitial from "./components/LoadInterstitial";
import App from "./App";
import LibcurlClient from "@mercuryworkshop/libcurl-transport";
import EpoxyClient from "@mercuryworkshop/epoxy-transport";
import { defaultConfigDev } from "@mercuryworkshop/scramjet";
import { Controller } from "@mercuryworkshop/scramjet-controller";
import { HttpCachePlugin } from "@mercuryworkshop/scramjet-utils";
import { demoSettingsStore, WISP_URLS } from "./store";
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
	const preferred = getActiveWispUrl(demoSettingsStore.wispUrl);
	const candidates = [...new Set([preferred, ...WISP_URLS])];
	for (const url of candidates) {
		if (await connectWisp(url, 3000)) {
			demoSettingsStore.wispUrl = url;
			setActiveWispUrl(url);
			return url;
		}
	}

	// Keep the browser UI available so a working custom Wisp can be added.
	demoSettingsStore.wispUrl = preferred || WISP_URLS[0];
	return demoSettingsStore.wispUrl;
}

function isCurrentServiceWorker(
	worker: ServiceWorker | null
): worker is ServiceWorker {
	if (!worker) return false;
	try {
		return new URL(worker.scriptURL).searchParams.get("v") === __MW_BUILD_ID__;
	} catch {
		return false;
	}
}

async function waitForController(timeoutMs = 15000): Promise<ServiceWorker> {
	const currentController = () => {
		const worker = navigator.serviceWorker.controller;
		return isCurrentServiceWorker(worker) ? worker : null;
	};

	let worker = currentController();
	if (worker) return worker;

	// "ready" means an active registration exists, not that this page is controlled.
	await navigator.serviceWorker.ready;
	worker = currentController();
	if (worker) return worker;

	await new Promise<void>((resolve, reject) => {
		let timer = 0;
		const cleanup = () => {
			navigator.serviceWorker.removeEventListener("controllerchange", onChange);
			window.clearTimeout(timer);
		};
		const onChange = () => {
			if (!currentController()) return;
			cleanup();
			resolve();
		};

		navigator.serviceWorker.addEventListener("controllerchange", onChange);
		timer = window.setTimeout(() => {
			cleanup();
			reject(new Error("The current service worker did not take control of this page."));
		}, timeoutMs);
		onChange();
	});

	worker = currentController();
	if (!worker) {
		throw new Error("No current service worker is controlling this page.");
	}
	return worker;
}

async function init() {
	const interstitial: any = (
		<LoadInterstitial status={"Loading"}></LoadInterstitial>
	);
	document.body.append(interstitial);
	interstitial.showModal();

	try {
		const serviceWorkerUrl = new URL("/sw.js", location.origin);
		serviceWorkerUrl.searchParams.set("v", __MW_BUILD_ID__);
		const registration = await navigator.serviceWorker.register(serviceWorkerUrl.href, {
			updateViaCache: "none",
		});

		// Non-blocking progress updates on state transitions.
		const updateStatus = (sw: ServiceWorker | null) => {
			if (!sw) return;
			const set = (msg: string) => (interstitial.$.state.status = msg);
			const apply = () => {
				switch (sw.state) {
					case "installing":
						set("Installing service worker...");
						break;
					case "installed":
						set("Service worker installed, waiting to activate...");
						break;
					case "activating":
						set("Activating service worker...");
						break;
					case "activated":
						set("Service worker activated");
						break;
					case "redundant":
						set("Service worker became redundant");
						break;
				}
			};
			apply();
			sw.addEventListener("statechange", apply);
		};

		updateStatus(registration.installing ?? registration.waiting ?? null);

		// Wait until this exact build's worker controls the current page.
		interstitial.$.state.status =
			"Waiting for the current service worker to take control...";
		const readySw = await waitForController();
		interstitial.$.state.status =
			"Service worker is controlling this page";

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
			// Initialize the network layer now instead of waiting for the first
			// navigation to discover that the Wisp transport is not ready.
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
		interstitial.$.state.status = "Controller initialized";
		interstitial.close();
	} catch (e) {
		console.error("Error during service worker registration:", e);
		// Always close the modal on error to prevent hanging UI.
		try {
			interstitial.close();
		} catch {}
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
		console.error(error);
	});
export { controller, cachePlugin };
