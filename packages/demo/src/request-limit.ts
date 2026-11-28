import type { ProxyTransport } from "@mercuryworkshop/proxy-transports";

export function limitRequests(
	request: ProxyTransport["request"],
	limit: number
): ProxyTransport["request"] {
	let inFlight = 0;
	const waiting = new Set<() => void>();

	return async (...args) => {
		const signal = args[4];
		signal?.throwIfAborted();
		if (inFlight < limit) {
			inFlight++;
		} else {
			await new Promise<void>((resolve, reject) => {
				const start = () => {
					waiting.delete(start);
					signal?.removeEventListener("abort", abort);
					resolve();
				};
				const abort = () => {
					waiting.delete(start);
					reject(signal?.reason);
				};
				waiting.add(start);
				signal?.addEventListener("abort", abort, { once: true });
			});
		}

		try {
			signal?.throwIfAborted();
			// A slot covers the request through response headers. The body
			// can continue streaming while another connection opens.
			return await request(...args);
		} finally {
			const next = waiting.values().next().value;
			if (next) next();
			else inFlight--;
		}
	};
}
