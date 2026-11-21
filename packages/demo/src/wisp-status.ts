import { WISP_URLS } from "./store";

export type WispConnectionState =
	| "idle"
	| "connecting"
	| "connected"
	| "failed";

export type WispStatusRecord = {
	url: string;
	state: WispConnectionState;
	error?: string;
};

const CUSTOM_KEY = "mw-custom-wisps";
const ACTIVE_KEY = "mw-active-wisp";
const states = new Map<string, WispStatusRecord>();
const sockets = new Map<string, WebSocket>();
const pending = new Map<string, Promise<boolean>>();

function publish() {
	if (typeof window !== "undefined") {
		window.dispatchEvent(new Event("mw-wisp-status"));
	}
}

function setState(
	url: string,
	state: WispConnectionState,
	error?: string
) {
	states.set(url, { url, state, ...(error ? { error } : {}) });
	publish();
}

export function normalizeWispUrl(input: string): string | null {
	try {
		const url = new URL(input.trim());
		if (url.protocol !== "wss:" && url.protocol !== "ws:") return null;
		if (
			url.protocol === "ws:" &&
			!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
		) return null;
		if (url.username || url.password) return null;
		if (!url.pathname.endsWith("/")) url.pathname += "/";
		url.hash = "";
		return url.href;
	} catch {
		return null;
	}
}

function readCustom(): string[] {
	try {
		const stored = JSON.parse(localStorage.getItem(CUSTOM_KEY) || "[]");
		if (!Array.isArray(stored)) return [];
		return stored
			.map((value) => normalizeWispUrl(String(value)))
			.filter((value): value is string => !!value);
	} catch {
		return [];
	}
}

function writeCustom(urls: string[]) {
	try {
		localStorage.setItem(CUSTOM_KEY, JSON.stringify(urls));
	} catch {}
	publish();
}

export function getAllWispUrls(): string[] {
	return [...new Set([...WISP_URLS, ...readCustom()])];
}

export function getCustomWispUrls(): string[] {
	return readCustom().filter((url) => !WISP_URLS.includes(url));
}

export function getWispStatus(url: string): WispStatusRecord {
	const status = states.get(url) ?? { url, state: "idle" as const };
	if (
		status.state === "connected" &&
		sockets.get(url)?.readyState !== WebSocket.OPEN
	) {
		setState(url, "failed", "Wisp connection is no longer open");
		return states.get(url)!;
	}
	return status;
}

export function getWispStatuses(): WispStatusRecord[] {
	return getAllWispUrls().map((url) => getWispStatus(url));
}

export function getActiveWispUrl(fallback = WISP_URLS[0]): string {
	try {
		return localStorage.getItem(ACTIVE_KEY) || fallback;
	} catch {
		return fallback;
	}
}

export function setActiveWispUrl(url: string) {
	try {
		localStorage.setItem(ACTIVE_KEY, url);
	} catch {}
	publish();
}

export function addCustomWispUrl(input: string): string | null {
	const url = normalizeWispUrl(input);
	if (!url) return null;
	const custom = readCustom();
	if (WISP_URLS.includes(url) || custom.includes(url)) return url;
	if (custom.length >= 8) return null;
	writeCustom([...custom, url]);
	return url;
}

export function removeCustomWispUrl(url: string) {
	writeCustom(readCustom().filter((item) => item !== url));
	const socket = sockets.get(url);
	if (socket) {
		sockets.delete(url);
		socket.close();
	}
	states.delete(url);
	if (getActiveWispUrl() === url) {
		setActiveWispUrl(WISP_URLS[0]);
	}
	publish();
}

export function connectWisp(input: string, timeoutMs = 6000): Promise<boolean> {
	const url = normalizeWispUrl(input);
	if (!url) return Promise.resolve(false);

	const existing = sockets.get(url);
	if (
		existing?.readyState === WebSocket.OPEN &&
		getWispStatus(url).state === "connected"
	) {
		return Promise.resolve(true);
	}

	const current = pending.get(url);
	if (current) return current;

	setState(url, "connecting");

	const task = new Promise<boolean>((resolve) => {
		let settled = false;
		let socket: WebSocket | null = null;
		let timer = 0;

		const cleanupAttempt = () => {
			window.clearTimeout(timer);
			if (socket) {
				socket.onmessage = null;
				socket.onerror = null;
				socket.onclose = null;
			}
		};

		const fail = (message: string) => {
			if (settled) return;
			settled = true;
			cleanupAttempt();
			try {
				socket?.close();
			} catch {}
			setState(url, "failed", message);
			resolve(false);
		};

		try {
			// No subprotocol means Wisp v1. Wisp v2 servers are required to
			// continue accepting v1 clients, avoiding a fragile custom INFO exchange.
			socket = new WebSocket(url);
			socket.binaryType = "arraybuffer";
		} catch (error) {
			fail(error instanceof Error ? error.message : "WebSocket could not be created");
			return;
		}

		const ws = socket;
		if (!ws) {
			fail("WebSocket connection could not be created");
			return;
		}

		timer = window.setTimeout(
			() => fail("Wisp handshake timed out"),
			timeoutMs
		);

		ws.onmessage = async (event: MessageEvent) => {
			try {
				let bytes: Uint8Array;
				if (event.data instanceof ArrayBuffer) {
					bytes = new Uint8Array(event.data);
				} else if (event.data instanceof Blob) {
					bytes = new Uint8Array(await event.data.arrayBuffer());
				} else {
					return;
				}

				// Wisp packets have a 5-byte header. CONTINUE carries a
				// 4-byte receive-window value and is the v1 ready signal.
				if (bytes.length < 9) return;
				const view = new DataView(
					bytes.buffer,
					bytes.byteOffset,
					bytes.byteLength
				);
				const type = view.getUint8(0);
				const streamId = view.getUint32(1, true);
				if (streamId !== 0) return;

				if (type === 0x03) {
					if (settled || ws.readyState !== WebSocket.OPEN) return;
					settled = true;
					window.clearTimeout(timer);
					sockets.set(url, ws);
					setState(url, "connected");
					resolve(true);
				} else if (type === 0x04) {
					if (settled) {
						sockets.delete(url);
						setState(url, "failed", "Wisp server closed the connection");
						try { ws.close(); } catch {}
					} else {
						fail("Wisp server rejected the connection");
					}
				} else if (type === 0x05) {
					fail("Server sent Wisp v2 INFO instead of the v1 handshake");
				}
			} catch (error) {
				fail(error instanceof Error ? error.message : "Invalid Wisp response");
			}
		};

		ws.onerror = () => {
			if (!settled) fail("WebSocket connection failed");
			else if (ws.readyState !== WebSocket.OPEN) {
				sockets.delete(url);
				setState(url, "failed", "Wisp connection error");
			}
		};

		ws.onclose = () => {
			if (!settled) {
				fail("Wisp server closed before completing its handshake");
			} else if (sockets.get(url) === socket) {
				sockets.delete(url);
				setState(url, "failed", "Wisp connection closed");
			}
		};
	});

	pending.set(url, task);
	void task.then(() => pending.delete(url));
	return task;
}
