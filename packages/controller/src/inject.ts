import type {
	RawHeaders,
	ProxyTransport,
	TransferrableResponse,
} from "@mercuryworkshop/proxy-transports";

import { RpcHelper } from "@mercuryworkshop/rpc";
import type { Config } from ".";
import { CONTROLLERFRAME } from "./symbols";
import type {
	SerializedCookieSyncEntry,
	ControllerToTransport,
	TransportToController,
	WebSocketMessage,
} from "./types";
import {
	CookieJar,
	SCRAMJETCLIENT,
	ScramjetClient,
	setWasm,
	Tap,
	type CookieSyncOptions,
	type ScramjetConfig,
	type ScramjetContext,
	type TrackedHistoryState,
} from "@mercuryworkshop/scramjet";

const MessagePort_postMessage = MessagePort.prototype.postMessage;
const postMessage = (
	port: MessagePort,
	data: any,
	transfer?: Transferable[]
) => {
	MessagePort_postMessage.call(port, data, transfer as any);
};

class RemoteTransport implements ProxyTransport {
	private readyResolve!: () => void;
	private readyPromise: Promise<void> = new Promise((resolve) => {
		this.readyResolve = resolve;
	});

	public ready = false;
	async init() {
		await this.readyPromise;
		this.ready = true;
	}

	private rpc: RpcHelper<ControllerToTransport, TransportToController>;
	constructor(public port: MessagePort) {
		this.rpc = new RpcHelper<ControllerToTransport, TransportToController>(
			{
				ready: async () => {
					this.readyResolve();
				},
			},
			"transport",
			(data, transfer) => {
				postMessage(port, data, transfer);
			}
		);
		port.onmessageerror = (ev) => {
			console.error("onmessageerror (this should never happen!)", ev);
		};
		port.onmessage = (ev) => {
			this.rpc.recieve(ev.data);
		};
		port.start();
	}
	connect(
		url: URL,
		protocols: string[],
		requestHeaders: RawHeaders,
		onopen: (protocol: string, extensions: string) => void,
		onmessage: (data: Blob | ArrayBuffer | string) => void,
		onclose: (code: number, reason: string) => void,
		onerror: (error: string) => void
	): [
		(data: Blob | ArrayBuffer | string) => void,
		(code: number, reason: string) => void,
	] {
		const channel = new MessageChannel();
		const port = channel.port1;
		console.warn("connecting");
		this.rpc
			.call(
				"connect",
				{
					url: url.href,
					protocols,
					requestHeaders,
					port: channel.port2,
				},
				[channel.port2]
			)
			.then((response) => {
				console.log(response);
				if (response.result === "success") {
					onopen(response.protocol, response.extensions);
				} else {
					onerror(response.error);
				}
			});
		port.onmessage = (ev) => {
			const message = ev.data as WebSocketMessage;
			if (message.type === "data") {
				onmessage(message.data);
			} else if (message.type === "close") {
				onclose(message.code, message.reason);
			}
		};
		port.onmessageerror = (ev) => {
			console.error("onmessageerror (this should never happen!)", ev);
			onerror("Message error in transport port");
		};

		return [
			(data) => {
				postMessage(
					port,
					{
						type: "data",
						data: data,
					},
					data instanceof ArrayBuffer ? [data] : []
				);
			},
			(code) => {
				postMessage(port, {
					type: "close",
					code: code,
				});
			},
		];
	}

	async request(
		remote: URL,
		method: string,
		body: BodyInit | null,
		headers: RawHeaders,
		_signal: AbortSignal | undefined
	): Promise<TransferrableResponse> {
		return await this.rpc.call("request", {
			remote: remote.href,
			method,
			body,
			headers,
		});
	}

	async sendSetCookie(
		cookies: Array<{ url: URL; cookie: string }>,
		options: CookieSyncOptions = {}
	): Promise<void> {
		await this.rpc.call("sendSetCookie", {
			cookies: cookies.map(({ url, cookie }) => ({
				url: url.href,
				cookie,
			})),
			options,
		});
	}
}

async function waitForServiceWorkerController(
	serviceWorkers: ServiceWorkerContainer | undefined,
	timeoutMs = 5000
): Promise<ServiceWorker | null> {
	if (!serviceWorkers) return null;
	if (serviceWorkers.controller) {
		serviceWorkers.controller.postMessage({ $sw$claimClients: true });
		return serviceWorkers.controller;
	}

	let registration: ServiceWorkerRegistration | null = null;
	try {
		registration = await Promise.race([
			serviceWorkers.ready,
			new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
		]);
	} catch {}

	registration?.active?.postMessage({ $sw$claimClients: true });
	if (serviceWorkers.controller) return serviceWorkers.controller;

	return await new Promise<ServiceWorker | null>((resolve) => {
		let finished = false;
		const finish = () => {
			if (finished) return;
			finished = true;
			clearTimeout(timeout);
			serviceWorkers.removeEventListener("controllerchange", onChange);
			resolve(serviceWorkers.controller);
		};
		const onChange = () => finish();
		const timeout = setTimeout(finish, timeoutMs);
		serviceWorkers.addEventListener("controllerchange", onChange, { once: true });
		if (serviceWorkers.controller) finish();
	});
}

const serviceWorkers = navigator.serviceWorker;

function isGeForceNowHostname(hostname?: string): boolean {
	const normalized = hostname?.toLowerCase() ?? "";
	return normalized === "geforcenow.com" || normalized.endsWith(".geforcenow.com");
}

function getServiceWorkerContainer(global: typeof globalThis): ServiceWorkerContainer {
	try {
		// Same-origin child frames have their own service-worker client. Use
		// that container so clients.claim() can control the frame that performs
		// native resource loads. Opaque frames cannot be controlled, so retain
		// the parent container as the transport fallback.
		if (global.location?.origin !== "null") {
			return global.navigator.serviceWorker ?? serviceWorkers;
		}
	} catch {}
	return serviceWorkers;
}

type Init = {
	geforceNowFrameTree?: boolean;
	config: Config;
	sjconfig: ScramjetConfig;
	prefix: URL;
	cookies: string;
	yieldGetInjectScripts: (
		config: Config,
		sjconfig: ScramjetConfig,
		prefix: URL,
		cookieJar: CookieJar,
		codecEncode: (input: string) => string,
		codecDecode: (input: string) => string
	) => any;
	codecEncode: (input: string) => string;
	codecDecode: (input: string) => string;
	initHeaders: RawHeaders;
	history: TrackedHistoryState[];
};

export function load(init: Init) {
	if (SCRAMJETCLIENT in globalThis) {
		((globalThis as any)[SCRAMJETCLIENT] as ScramjetClient).syncDocumentInit({
			initHeaders: init.initHeaders,
			history: init.history,
			cookies: init.cookies,
		});
		return;
	}
	if (!("WASM" in self)) {
		throw new Error("WASM not found in global scope!");
	}
	const wasm = Uint8Array.from(atob(self.WASM as string), (c) => c.charCodeAt(0));
	delete (self as any).WASM;
	setWasm(wasm);

	new ExecutionContextWrapper(globalThis, init);
}

function createFrameId() {
	return `${Array(8)
		.fill(0)
		.map(() => Math.floor(Math.random() * 36).toString(36))
		.join("")}`;
}

class ExecutionContextWrapper {
	client!: ScramjetClient;
	cookieJar: CookieJar;
	transport: RemoteTransport;
	private serviceWorkers: ServiceWorkerContainer;
	private handleServiceWorkerCookieMessage: (event: MessageEvent) => void;

	constructor(
		public global: typeof globalThis,
		public init: Init
	) {
		this.serviceWorkers = getServiceWorkerContainer(this.global);
		if (this.serviceWorkers !== serviceWorkers) {
			console.info("[Minason SW] using frame-local service worker container", {
				origin: this.global.location?.origin,
				controller: this.serviceWorkers.controller?.scriptURL ?? null,
			});
		}

		const channel = new MessageChannel();
		this.transport = new RemoteTransport(channel.port1);
		void (async () => {
			let sw = await waitForServiceWorkerController(this.serviceWorkers);
			// An opaque or otherwise uncontrollable subframe still uses the
			// already-controlled parent frame to establish Scramjet transport.
			if (!sw && this.serviceWorkers !== serviceWorkers) {
				sw = await waitForServiceWorkerController(serviceWorkers);
			}
			if (!sw) {
				channel.port2.close();
				console.warn(
					"[Minason SW] no controller for proxy frame",
					this.global.location?.href
				);
				return;
			}
			console.info(
				"[Minason SW] transport connected for proxy frame",
				this.global.location?.href
			);
			sw.postMessage(
				{
					$sw$initRemoteTransport: {
						port: channel.port2,
						prefix: this.init.prefix.href,
					},
				},
				[channel.port2]
			);
		})().catch((error) => {
			channel.port2.close();
			console.warn("[Minason SW] controller wait failed", error);
		});

		this.cookieJar = new CookieJar();
		this.cookieJar.load(this.init.cookies);

		this.handleServiceWorkerCookieMessage = (event: MessageEvent) => {
			if (
				!event.data?.$controller$setCookie ||
				typeof event.data.$controller$setCookie !== "object"
			) {
				return;
			}

			const payload = event.data.$controller$setCookie as {
				cookies?: SerializedCookieSyncEntry[];
				options?: CookieSyncOptions;
				id?: string;
			};

			if (payload.options?.clear) {
				this.cookieJar.clear();
			}

			if (Array.isArray(payload.cookies)) {
				for (const cookie of payload.cookies) {
					if (
						typeof cookie?.url !== "string" ||
						typeof cookie.cookie !== "string"
					) {
						continue;
					}

					try {
						this.cookieJar.setCookies(cookie.cookie, new URL(cookie.url));
					} catch {
						console.error("Failed to set cookie", cookie);
					}
				}
			}

			if (typeof payload.id === "string") {
				const targetSw = this.serviceWorkers.controller ?? serviceWorkers.controller;
				targetSw?.postMessage({
					$sw$setCookieDone: {
						id: payload.id,
					},
				});
			}
		};

		this.serviceWorkers.addEventListener(
			"message",
			this.handleServiceWorkerCookieMessage
		);
		if (this.serviceWorkers !== serviceWorkers) {
			serviceWorkers.addEventListener(
				"message",
				this.handleServiceWorkerCookieMessage
			);
		}

		this.injectScramjet();
	}

	injectScramjet() {
		const frame = this.global.frameElement as HTMLIFrameElement | null;
		if (frame && !frame.name) {
			window.name = frame.name = createFrameId();
		}
		let controllerFrame = frame?.[CONTROLLERFRAME];
		let isTopLevel = true;
		if (!controllerFrame) {
			isTopLevel = false;
			let currentwin = this.global.window;
			while (currentwin.parent !== currentwin) {
				const currentclient = currentwin[SCRAMJETCLIENT];
				if (!currentclient) {
					currentwin = currentwin.parent.window;
					continue;
				}
				const currentFrame = currentclient.descriptors.get(
					"window.frameElement",
					currentwin
				);
				if (currentFrame && currentFrame[CONTROLLERFRAME]) {
					controllerFrame = currentFrame[CONTROLLERFRAME];
					break;
				}
				currentwin = currentwin.parent.window;
			}
		}
		const context: ScramjetContext = {
			config: this.init.sjconfig,
			prefix: this.init.prefix,
			cookieJar: this.cookieJar,
			geforceNowFrameTree: Boolean(this.init.geforceNowFrameTree),
			interface: {
				getInjectScripts: this.init.yieldGetInjectScripts(
					this.init.config,
					this.init.sjconfig,
					this.init.prefix,
					this.cookieJar,
					this.init.codecEncode,
					this.init.codecDecode
				),
				codecEncode: this.init.codecEncode,
				codecDecode: this.init.codecDecode,
			},
		};
		this.client = new ScramjetClient(this.global, {
			context,
			transport: this.transport,
			sendSetCookie: async (cookies, options) => {
				await this.transport.sendSetCookie(cookies, options);
			},
			shouldBlockMessageEvent: () => {
				return false;
			},
			hookSubcontext: (frameself) => {
				// Opaque-origin ad frames cannot reliably inspect their ancestors.
				// Carry the GeForce NOW context forward when Scramjet hooks descendants.
				const nestedFrameTree =
					Boolean(context.geforceNowFrameTree) ||
					isGeForceNowHostname(this.client.url.hostname);
				const nested = new ExecutionContextWrapper(frameself, {
					...this.init,
					cookies: this.cookieJar.dump(),
					geforceNowFrameTree: nestedFrameTree,
				});
				return nested.client;
			},
			initHeaders: this.init.initHeaders,
			history: this.init.history,
		});
		// Detect the initial proxied GeForce NOW page once, then retain that
		// fact in ScramjetContext for descendants with opaque origins.
		if (isGeForceNowHostname(this.client.url.hostname)) {
			context.geforceNowFrameTree = true;
		}
		const frameInitContext = {
			window: this.global.window,
			client: this.client,
			isTopLevel,
		};
		if (controllerFrame)
			Tap.dispatch(controllerFrame.hooks.init.pre, frameInitContext, {});
		this.client.hook();
		if (controllerFrame)
			Tap.dispatch(controllerFrame.hooks.init.post, frameInitContext, {});
	}
}
