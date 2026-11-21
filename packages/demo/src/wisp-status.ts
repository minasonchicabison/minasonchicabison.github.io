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
	return states.get(url) ?? { url, state: "idle" };
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

function encodePacket(type: number, payload: Uint8Array): Uint8Array {
	const packet = new Uint8Array(5 + payload.length);
	packet[0] = type;
	new DataView(packet.buffer).setUint32(1, 0, true);
	packet.set(payload, 5);
	return packet;
}

/**
 * Complete the Wisp handshake, not just the underlying WebSocket upgrade.
 * The live socket is kept open so the status indicator can notice disconnects.
 */
export function connectWisp(input: string, timeoutMs = 5000): Promise<boolean> {
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

		const fail = (message: string) => {
			if (settled) return;
			settled = true;
			setState(url, "failed", message);
			resolve(false);
		};

		const attempt = (useV2: boolean) => {
			if (settled) return;
			let socket: WebSocket;
			try {
				socket = useV2
					? new WebSocket(url, ["wisp-v2"])
					: new WebSocket(url);
			} catch (error) {
				if (useV2) attempt(false);
				else fail(error instanceof Error ? error.message : "Connection failed");
				return;
			}

			let attemptEnded = false;
			const retryOrFail = (message: string) => {
				if (attemptEnded || settled) return;
				attemptEnded = true;
				window.clearTimeout(timer);
				socket.onmessage = null;
				socket.onerror = null;
				socket.onclose = null;
				try {
					socket.close();
				} catch {}
				if (useV2) attempt(false);
				else fail(message);
			};

			const timer = window.setTimeout(
				() => retryOrFail("Wisp handshake timed out"),
				timeoutMs
			);

			socket.binaryType = "arraybuffer";
			socket.onmessage = async (event: MessageEvent) => {
				try {
					let bytes: Uint8Array;
					if (event.data instanceof ArrayBuffer) {
						bytes = new Uint8Array(event.data);
					} else if (event.data instanceof Blob) {
						bytes = new Uint8Array(await event.data.arrayBuffer());
					} else {
						return;
					}
					if (bytes.length < 5) return;

					const view = new DataView(
						bytes.buffer,
						bytes.byteOffset,
						bytes.byteLength
					);
					const type = view.getUint8(0);
					const streamId = view.getUint32(1, true);
					if (streamId !== 0) return;

					// Wisp v2: respond to the server INFO packet with our INFO packet.
					if (type === 0x05 && useV2) {
						const extensions = new Uint8Array([
							0x01, 0, 0, 0, 0, // UDP extension
							0x04, 0, 0, 0, 0, // MOTD extension
						]);
						const payload = new Uint8Array(2 + extensions.length);
						payload[0] = 2;
						payload[1] = 0;
						payload.set(extensions, 2);
						socket.send(encodePacket(0x05, payload));
						return;
					}

					// CONTINUE on stream 0 means the Wisp protocol handshake completed.
					if (type === 0x03) {
						if (attemptEnded || settled) return;
						attemptEnded = true;
						window.clearTimeout(timer);
						settled = true;
						sockets.set(url, socket);
						setState(url, "connected");
						resolve(true);
					} else if (type === 0x04) {
						retryOrFail("Wisp server rejected the connection");
					}
				} catch (error) {
					retryOrFail(
						error instanceof Error ? error.message : "Invalid Wisp response"
					);
				}
			};

			socket.onerror = () =>
				retryOrFail("WebSocket connection failed");
			socket.onclose = () => {
				if (!settled) {
					retryOrFail("Wisp server closed before completing its handshake");
				} else if (sockets.get(url) === socket) {
					sockets.delete(url);
					setState(url, "failed", "Wisp connection closed");
				}
			};
		};

		attempt(true);
	});

	pending.set(url, task);
	void task.then(() => pending.delete(url));
	return task;
}
