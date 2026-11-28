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
				try {
					for (const [method, failure, path] of [
						["PUT", 35, "/v2/session/00000000-0000-4000-8000-000000000001"],
						["PUT", 56, "/v2/session/00000000-0000-4000-8000-000000000001"],
						["PUT", 403, "/v2/session/00000000-0000-4000-8000-000000000001"],
						["POST", 35, "/v2/session"],
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
							const status = bodies.length === 1 ? failure : 200;
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
