import { playwrightTest } from "../testcommon.ts";

export default [
	playwrightTest({
		name: "scramjet-session-transport-retries-only-tls-handshake-errors",
		fn: async ({ page }) => {
			const cases = await page.evaluate(async () => {
				const harness = window as typeof window & {
					__runwayController: {
						transport: { request: (...args: any[]) => Promise<any> };
					};
					__runwayGetProxiedUrl: (url: string) => string;
				};
				const transport = harness.__runwayController.transport;
				const original = transport.request;
				const results = [];
				const host = "https://np-test.cloudmatchbeta.nvidiagrid.net";
				const epoxyHandshake =
					'Hyper client: hyper_util::client::legacy::Error(Connect, Io(Custom { kind: UnexpectedEof, error: "tls handshake eof" })) (client error (IO: Custom { kind: UnexpectedEof, error: "tls handshake eof" } (tls handshake eof)))';
				const session = "/v2/session/00000000-0000-4000-8000-000000000001";
				try {
					for (const [method, failure, path, persistent] of [
						["PUT", 35, session, false],
						["PUT", epoxyHandshake, session, false],
						["PUT", epoxyHandshake, session, true],
						[
							"PUT",
							epoxyHandshake.replace("Error(Connect,", "Error(SendRequest,"),
							session,
							false,
						],
						["PUT", 56, session, false],
						["PUT", 403, session, false],
						["POST", epoxyHandshake, "/v2/session", false],
					] as const) {
						const bodies: string[] = [];
						transport.request = async (
							url: URL,
							actualMethod: string,
							body: BodyInit,
						) => {
							if (url.href !== host + path || actualMethod !== method) {
								throw new Error("Unexpected request in session fixture");
							}
							bodies.push(await new Response(body).text());
							const status = bodies.length === 1 || persistent ? failure : 200;
							if (typeof status === "string") throw new Error(status);
							if (status < 100) {
								throw new TypeError(
									`Request failed with error code ${status}: test failure`,
								);
							}
							return { status, statusText: "", headers: [], body: "fixture" };
						};
						const response = await fetch(
							harness.__runwayGetProxiedUrl(host + path),
							{
								method,
								body: '{"state":"ad-ended"}',
							},
						);
						results.push({ status: response.status, bodies });
					}
				} finally {
					transport.request = original;
				}
				return results;
			});
			const body = '{"state":"ad-ended"}';
			const expected = [
				{ status: 200, bodies: [body, body] },
				{ status: 200, bodies: [body, body] },
				{ status: 500, bodies: [body, body] },
				{ status: 500, bodies: [body] },
				{ status: 500, bodies: [body] },
				{ status: 403, bodies: [body] },
				{ status: 500, bodies: [body] },
			];
			if (JSON.stringify(cases) !== JSON.stringify(expected)) {
				throw new Error(`Unexpected outcomes: ${JSON.stringify(cases)}`);
			}
		},
	}),
];
