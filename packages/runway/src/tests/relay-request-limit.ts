import { limitRequests } from "../../../demo/src/request-limit.ts";
import { directTest } from "../testcommon.ts";

export default [
	directTest({
		name: "relay-request-limit-queues-through-headers",
		fn: async ({ assertEqual }) => {
			const started: string[] = [];
			const release = new Map<string, () => void>();
			const incoming = limitRequests(async (url) => {
				started.push(url.pathname);
				await new Promise<void>((resolve, reject) => {
					release.set(
						url.pathname,
						url.pathname === "/2"
							? () => reject(new Error("network error"))
							: resolve,
					);
				});
				return {
					body: new ReadableStream(),
					headers: [],
					status: 200,
					statusText: "OK",
				};
			}, 5);
			const invoke = (id: number, signal?: AbortSignal) =>
				incoming(new URL("https://relay.test/" + id), "GET", null, [], signal);
			const abort = new AbortController();
			const initial = [1, 2, 3, 4, 5].map((i) =>
				invoke(i).catch((error) => error),
			);
			const cancelled = invoke(6, abort.signal).catch((error) => error);
			const next = invoke(7);
			const last = invoke(8);
			assertEqual(started.join(","), "/1,/2,/3,/4,/5");
			abort.abort();
			assertEqual((await cancelled).name, "AbortError");

			release.get("/1")!();
			await initial[0];
			assertEqual(started.join(","), "/1,/2,/3,/4,/5,/7");
			release.get("/2")!();
			assertEqual((await initial[1]).message, "network error");
			assertEqual(started.join(","), "/1,/2,/3,/4,/5,/7,/8");
			for (const id of ["/3", "/4", "/5", "/7", "/8"]) release.get(id)!();
			await Promise.all([...initial, next, last]);
		},
	}),
];
