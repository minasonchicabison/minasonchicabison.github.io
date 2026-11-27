import { htmlRules } from "@/shared/htmlRules";
import {
	String,
	TextEncoder_encode,
	Object_keys,
	Object_defineProperty,
	atob,
} from "@/shared/snapshot";
import { bytesToBase64 } from "@/shared/util";
import { rewriteCss, unrewriteCss } from "@rewriters/css";
import { rewriteHtml, unrewriteHtml } from "@rewriters/html";
import { rewriteJs } from "@rewriters/js";
import { unrewriteUrl } from "@rewriters/url";
import { SCRAMJETCLIENT } from "@/symbols";
import { ScramjetClient } from "@client/index";
import {
	getScriptBlockTypeString,
	isHtmlMimeType,
	isModuleScriptType,
	isScriptType,
} from "@/shared/mime";
import { ForeignContext } from "@/shared/rewriters/html";

export function foreignContextForElement(
	client: ScramjetClient,
	element: Element
): ForeignContext {
	if (client.box.instanceof(element, "SVGElement")) return "svg";
	if (client.box.instanceof(element, "MathMLElement")) return "math";
	return "html";
}

// NOTE: NOT INCLUSIVE OF THE CURRENT ELEMENT
export function insideForeignContext(
	client: ScramjetClient,
	element: Element | null
): ForeignContext {
	let current: Element | null = element.parentElement;

	while (current) {
		const context = foreignContextForElement(client, current);
		if (context !== "html") return context;
		// EXPLICITLY an html context, don't go up further
		if (client.box.instanceof(current, "SVGForeignObjectElement"))
			return "html";
		current = current.parentElement;
	}

	return "html";
}

function scriptBlockTypeForElement(
	client: ScramjetClient,
	element: Element
): string {
	const hasType = client.natives.call(
		"Element.prototype.hasAttribute",
		element,
		"type"
	) as boolean;
	const hasLanguage = client.natives.call(
		"Element.prototype.hasAttribute",
		element,
		"language"
	) as boolean;
	const type = hasType
		? (client.natives.call(
				"Element.prototype.getAttribute",
				element,
				"type"
			) as string | null)
		: null;
	const language = hasLanguage
		? (client.natives.call(
				"Element.prototype.getAttribute",
				element,
				"language"
			) as string | null)
		: null;
	return getScriptBlockTypeString(type, language, hasType, hasLanguage);
}

// TODO: this is pretty bad. really this whole file sucks
function collectAttributeMap(
	client: ScramjetClient,
	element: Element,
	overrideName: string,
	overrideValue: unknown
) {
	const attrs: Record<string, string | undefined> = {};
	const attrNames =
		client.natives.call("Element.prototype.getAttributeNames", element) ?? [];

	for (const attrName of attrNames) {
		if (String(attrName).startsWith("scramjet-attr")) continue;
		const value = client.natives.call(
			"Element.prototype.getAttribute",
			element,
			attrName
		);
		attrs[String(attrName).toLowerCase()] =
			typeof value === "string" ? value : undefined;
	}

	attrs[String(overrideName).toLowerCase()] = String(overrideValue);
	return attrs;
}

export default function (client: ScramjetClient, self: typeof window) {
	const attrObject = {
		nonce: [self.HTMLElement],
		integrity: [self.HTMLScriptElement, self.HTMLLinkElement],
		csp: [self.HTMLIFrameElement],
		credentialless: [self.HTMLIFrameElement],
		src: [
			self.HTMLImageElement,
			self.HTMLMediaElement,
			self.HTMLIFrameElement,
			self.HTMLFrameElement,
			self.HTMLEmbedElement,
			self.HTMLScriptElement,
			self.HTMLSourceElement,
		],
		href: [self.HTMLAnchorElement, self.HTMLLinkElement],
		data: [self.HTMLObjectElement],
		action: [self.HTMLFormElement],
		formaction: [self.HTMLButtonElement, self.HTMLInputElement],
		srcdoc: [self.HTMLIFrameElement],
		poster: [self.HTMLVideoElement],
		imagesrcset: [self.HTMLLinkElement],
	};

	const urlinterfaces = [
		self.HTMLAnchorElement.prototype,
		self.HTMLAreaElement.prototype,
	];
	const originalhrefs = [
		client.natives.call(
			"Object.getOwnPropertyDescriptor",
			null,
			self.HTMLAnchorElement.prototype,
			"href"
		),
		client.natives.call(
			"Object.getOwnPropertyDescriptor",
			null,
			self.HTMLAreaElement.prototype,
			"href"
		),
	];

	const attrs = Object_keys(attrObject);

	for (const attr of attrs) {
		for (const element of attrObject[attr]) {
			const descriptor = client.natives.call(
				"Object.getOwnPropertyDescriptor",
				null,
				element.prototype,
				attr
			);
			Object_defineProperty(element.prototype, attr, {
				get() {
					if (["src", "data", "href", "action", "formaction"].includes(attr)) {
						return unrewriteUrl(descriptor.get.call(this), client.context);
					}

					return descriptor.get.call(this);
				},

				set(value) {
					// if (
					// 	this.tagName === "IFRAME" &&
					// 	attr === "src" &&
					// 	value === "about:blank"
					// ) {
					// 	this.setAttribute("srcdoc", "");
					// 	return;
					// }
					return this.setAttribute(attr, value);
				},
			});
		}
	}

	/* eslint-disable scramjet-core/no-globals */
	// Sandboxed iframes without allow-same-origin get an opaque origin, which a
	// service worker can never control: every request made inside them skips the
	// proxy and 404s on the host (this is what broke GeForce NOW's ad
	// verification iframes). Scramjet already strips the `sandbox` attribute for
	// HTML parsing and setAttribute(), but ad SDKs also set it through the
	// `iframe.sandbox` property / DOMTokenList, which bypassed that. Give scripts
	// a harmless detached token list so mutations never reach the real element.
	const sandboxDescriptor = client.natives.call(
		"Object.getOwnPropertyDescriptor",
		null,
		self.HTMLIFrameElement.prototype,
		"sandbox"
	);
	if (sandboxDescriptor && sandboxDescriptor.get) {
		const inertSandboxLists = new WeakMap<object, any>();
		const makeInertTokenList = (iframe: HTMLIFrameElement) => {
			// Keep the DOMTokenList view backed by Scramjet's virtual attribute.
			// setAttribute("sandbox", ...) stores the original value as
			// scramjet-attr-sandbox while the html rule removes the real attribute,
			// so the browser never applies an opaque-origin sandbox.
			const readTokens = () => {
				const value = iframe.getAttribute("sandbox") || "";
				return value.trim() ? value.trim().split(/\s+/) : [];
			};
			const writeTokens = (tokens: string[]) => {
				iframe.setAttribute("sandbox", tokens.join(" "));
			};
			const list: any = {
				add: (...newTokens: string[]) => {
					const tokens = readTokens();
					for (const token of newTokens) {
						if (!tokens.includes(token)) tokens.push(token);
					}
					writeTokens(tokens);
				},
				remove: (...removeTokens: string[]) => {
					const remove = new Set(removeTokens);
					writeTokens(readTokens().filter((token) => !remove.has(token)));
				},
				toggle: (token: string, force?: boolean) => {
					const tokens = readTokens();
					const has = tokens.includes(token);
					if (force === true || (force === undefined && !has)) {
						if (!has) tokens.push(token);
						writeTokens(tokens);
						return true;
					}
					if (has) writeTokens(tokens.filter((item) => item !== token));
					return false;
				},
				replace: (oldToken: string, newToken: string) => {
					const tokens = readTokens();
					const index = tokens.indexOf(oldToken);
					if (index < 0) return false;
					if (tokens.includes(newToken)) tokens.splice(index, 1);
					else tokens[index] = newToken;
					writeTokens(tokens);
					return true;
				},
				contains: (token: string) => readTokens().includes(token),
				// Every sandbox keyword is "supported"; none are ever enforced.
				supports: () => true,
				item: (index: number) => readTokens()[index] ?? null,
				forEach: (cb: any, thisArg?: any) =>
					readTokens().forEach((token) =>
						cb.call(thisArg, token, token, list)
					),
				entries: () =>
					readTokens().map((token, index) => [index, token] as [number, string])[
						Symbol.iterator
					](),
				keys: () => readTokens().map((_token, index) => index)[Symbol.iterator](),
				values: () => readTokens()[Symbol.iterator](),
				[Symbol.iterator]: () => readTokens()[Symbol.iterator](),
				toString: () => readTokens().join(" "),
				get length() {
					return readTokens().length;
				},
				get value() {
					return readTokens().join(" ");
				},
				set value(value: string) {
					const tokens: string[] = [];
					for (const token of String(value).split(/\s+/)) {
						if (token && !tokens.includes(token)) tokens.push(token);
					}
					writeTokens(tokens);
				},
			};
			return list;
		};
		Object_defineProperty(self.HTMLIFrameElement.prototype, "sandbox", {
			configurable: true,
			enumerable: true,
			get() {
				let list = inertSandboxLists.get(this);
				if (!list) {
					list = makeInertTokenList(this);
					inertSandboxLists.set(this, list);
				}
				return list;
			},
			set(value) {
				this.setAttribute("sandbox", String(value));
			},
		});
	}
	/* eslint-enable scramjet-core/no-globals */

	client.Trap("HTMLImageElement.prototype.currentSrc", {
		get(ctx) {
			const currentSrc = ctx.get() as string;
			if (!currentSrc) return currentSrc;
			return unrewriteUrl(currentSrc, client.context);
		},
	});

	// note that href is not here
	const urlprops = [
		"protocol",
		"hash",
		"host",
		"hostname",
		"origin",
		"pathname",
		"port",
		"search",
	];
	for (const prop of urlprops) {
		for (const i in urlinterfaces) {
			const target = urlinterfaces[i];
			const desc = originalhrefs[i];
			client.RawTrap(target, prop, {
				get(ctx) {
					const href = desc.get.call(ctx.this);
					if (!href) return href;

					const url = new URL(unrewriteUrl(href, client.context));

					return url[prop];
				},
			});
		}
	}

	client.Trap("Node.prototype.baseURI", {
		get(ctx) {
			const node = ctx.this as Node;
			const doc = client.box.instanceof(node, "Document")
				? (node as Document)
				: node.ownerDocument;
			const base = doc?.querySelector("base[href]") as HTMLBaseElement | null;

			if (base) {
				const href = base.getAttribute("href") || base.href;
				if (href) return new URL(href, client.url.href).href;
			}

			return client.url.href;
		},
		set() {
			return false;
		},
	});

	client.Proxy("Element.prototype.getAttribute", {
		apply(ctx) {
			const [name] = ctx.args;

			if (name.startsWith("scramjet-attr")) {
				return ctx.return(null);
			}

			if (
				client.natives.call(
					"Element.prototype.hasAttribute",
					ctx.this,
					`scramjet-attr-${name}`
				)
			) {
				const attrib = ctx.fn.call(ctx.this, `scramjet-attr-${name}`);
				if (attrib === null) return ctx.return("");

				return ctx.return(attrib);
			}
		},
	});

	client.Proxy("Element.prototype.getAttributeNames", {
		apply(ctx) {
			const attrNames = ctx.call() as string[];
			const cleaned = attrNames.filter(
				(attr) => !attr.startsWith("scramjet-attr")
			);

			ctx.return(cleaned);
		},
	});

	client.Proxy("Element.prototype.getAttributeNode", {
		apply(ctx) {
			if (String(ctx.args[0]).startsWith("scramjet-attr"))
				return ctx.return(null);
		},
	});

	client.Proxy("Element.prototype.hasAttribute", {
		apply(ctx) {
			const name = String(ctx.args[0]);
			if (name.startsWith("scramjet-attr"))
				return ctx.return(false);
			if (isVirtualIframeSandboxAttribute(ctx.this, name)) {
				const virtual = client.natives.call(
					"Element.prototype.hasAttribute",
					ctx.this,
					`scramjet-attr-${name}`
				);
				const real = client.natives.call(
					"Element.prototype.hasAttribute",
					ctx.this,
					name
				);
				return ctx.return(Boolean(virtual || real));
			}
		},
	});

	client.Proxy("Element.prototype.setAttribute", {
		apply(ctx) {
			let [name, value] = ctx.args;
			const tagName = ctx.this.tagName.toLowerCase();

			if (value != null) value = String(value);
			ctx.args[1] = value;

			const ruleList = htmlRules.find((rule) => {
				const r = rule[name.toLowerCase()];
				if (!r) return false;
				if (r === "*") return true;
				if (typeof r === "function") return false; // this can't happen but ts

				return r.includes(tagName);
			});

			if (ruleList) {
				const ret = ruleList.fn(
					value,
					client.context,
					client.meta,
					collectAttributeMap(client, ctx.this, name, value)
				);
				if (ret == null) {
					client.natives.call(
						"Element.prototype.removeAttribute",
						ctx.this,
						name
					);
					ctx.fn.call(ctx.this, `scramjet-attr-${name}`, value);
					ctx.return(undefined);

					return;
				}
				ctx.args[1] = ret;
				ctx.fn.call(ctx.this, `scramjet-attr-${ctx.args[0]}`, value);
			}
		},
	});

	// i actually need to do something with this
	client.Proxy("Element.prototype.setAttributeNode", {
		apply(ctx) {
			const attr = ctx.args[0] as Attr | null;
			if (attr && isVirtualIframeSandboxAttribute(ctx.this, attr.name)) {
				const previous = client.natives.call(
					"Element.prototype.getAttributeNode",
					ctx.this,
					"sandbox"
				);
				ctx.this.setAttribute("sandbox", attr.value);
				ctx.return(previous);
			}
		},
	});
	client.Proxy("Element.prototype.setAttributeNodeNS", {
		apply(ctx) {
			const attr = ctx.args[0] as Attr | null;
			if (
				attr &&
				attr.namespaceURI == null &&
				isVirtualIframeSandboxAttribute(ctx.this, attr.localName)
			) {
				const previous = client.natives.call(
					"Element.prototype.getAttributeNodeNS",
					ctx.this,
					null,
					"sandbox"
				);
				ctx.this.setAttribute("sandbox", attr.value);
				ctx.return(previous);
			}
		},
	});

	const isVirtualIframeSandboxAttribute = (element: Element, name: unknown) =>
		element.tagName?.toLowerCase() === "iframe" &&
		String(name).toLowerCase() === "sandbox";

	// Some ad SDKs build iframe nodes with sandbox attributes through APIs
	// that don't pass through setAttribute/DOMTokenList interception. Strip
	// any remaining native sandbox immediately before a node enters the DOM.
	// This matches htmlRules' existing policy of virtualizing iframe sandbox.
	const virtualizeSandboxInNode = (value: unknown) => {
		if (!value || typeof value !== "object" || !("nodeType" in value)) return;

		const visit = (node: Node) => {
			if (node.nodeType === 1) {
				const element = node as Element;
				if (element.tagName?.toLowerCase() === "iframe") {
					const sandbox = client.natives.call(
						"Element.prototype.getAttribute",
						element,
						"sandbox"
					) as string | null;
					if (sandbox !== null) {
						client.natives.call(
							"Element.prototype.setAttribute",
							element,
							"scramjet-attr-sandbox",
							sandbox
						);
						client.natives.call(
							"Element.prototype.removeAttribute",
							element,
							"sandbox"
						);
						console.info(
							"[Minason iframe] virtualized sandbox before insertion",
							client.natives.call(
								"Element.prototype.getAttribute",
								element,
								"src"
							) || "about:blank"
						);
					}
				}
			}

			let child = node.firstChild;
			while (child) {
				const next = child.nextSibling;
				visit(child);
				child = next;
			}
		};

		visit(value as Node);
	};

	const virtualizeSandboxInArgs = (args: unknown[]) => {
		for (const value of args) virtualizeSandboxInNode(value);
	};

	client.Proxy(
		[
			"Node.prototype.appendChild",
			"Node.prototype.insertBefore",
			"Node.prototype.replaceChild",
			"Element.prototype.append",
			"Element.prototype.prepend",
			"Element.prototype.replaceChildren",
			"Element.prototype.replaceWith",
			"Element.prototype.before",
			"Element.prototype.after",
			"Document.prototype.append",
			"Document.prototype.prepend",
			"Document.prototype.replaceChildren",
			"DocumentFragment.prototype.append",
			"DocumentFragment.prototype.prepend",
			"DocumentFragment.prototype.replaceChildren",
			"Range.prototype.insertNode",
		],
		{
			apply(ctx) {
				virtualizeSandboxInArgs(ctx.args);
			},
		}
	);

	client.Proxy("Element.prototype.setAttributeNS", {
		apply(ctx) {
			// TODO: this could leak by like calling stringify twice or some dumb shit lol
			const namespace = ctx.args[0] as string | null;
			const name = String(ctx.args[1]);
			const value = String(ctx.args[2]);

			const ruleList = htmlRules.find((rule) => {
				const r = rule[name.toLowerCase()];
				if (!r) return false;
				if (r === "*") return true;
				if (typeof r === "function") return false; // this can't happen but ts

				return r.includes(ctx.this.tagName.toLowerCase());
			});

			if (ruleList) {
				const rewritten = ruleList.fn(
					value,
					client.context,
					client.meta,
					collectAttributeMap(client, ctx.this, name, value)
				);
				if (rewritten == null) {
					client.natives.call(
						"Element.prototype.removeAttributeNS",
						ctx.this,
						namespace,
						name
					);
					client.natives.call(
						"Element.prototype.setAttribute",
						ctx.this,
						`scramjet-attr-${name}`,
						value
					);
					ctx.return(undefined);
					return;
				}
				ctx.args[2] = rewritten;
				client.natives.call(
					"Element.prototype.setAttribute",
					ctx.this,
					`scramjet-attr-${name}`,
					value
				);
			}
		},
	});

	// this is separate from the regular href handlers because it returns an SVGAnimatedString
	client.Trap("SVGAnimatedString.prototype.baseVal", {
		get(ctx) {
			const href = ctx.get() as string;
			if (!href) return href;

			return unrewriteUrl(href, client.context);
		},
		set(ctx, val: string) {
			ctx.set(client.rewriteUrl(val));
		},
	});
	client.Trap("SVGAnimatedString.prototype.animVal", {
		get(ctx) {
			const href = ctx.get() as string;
			if (!href) return href;

			return unrewriteUrl(href, client.context);
		},
		// it has no setter
	});

	client.Proxy("Element.prototype.removeAttribute", {
		apply(ctx) {
			const name = String(ctx.args[0]);
			if (name.startsWith("scramjet-attr")) return ctx.return(undefined);
			if (isVirtualIframeSandboxAttribute(ctx.this, name)) {
				client.natives.call(
					"Element.prototype.removeAttribute",
					ctx.this,
					`scramjet-attr-${name}`
				);
				client.natives.call(
					"Element.prototype.removeAttribute",
					ctx.this,
					name
				);
				return ctx.return(undefined);
			}
			if (
				client.natives.call("Element.prototype.hasAttribute", ctx.this, name)
			) {
				ctx.fn.call(ctx.this, `scramjet-attr-${ctx.args[0]}`);
			}
		},
	});

	client.Proxy("Element.prototype.toggleAttribute", {
		apply(ctx) {
			const name = String(ctx.args[0]);
			if (name.startsWith("scramjet-attr")) return ctx.return(false);

			if (isVirtualIframeSandboxAttribute(ctx.this, name)) {
				const hasSandbox = ctx.this.getAttribute("sandbox") !== null;
				const force = ctx.args[1];
				const present = force === undefined ? !hasSandbox : Boolean(force);
				if (present) ctx.this.setAttribute("sandbox", "");
				else ctx.this.removeAttribute("sandbox");
				return ctx.return(present);
			}

			if (
				client.natives.call("Element.prototype.hasAttribute", ctx.this, name)
			) {
				ctx.fn.call(ctx.this, `scramjet-attr-${ctx.args[0]}`);
			}
		},
	});

	client.Trap("Element.prototype.innerHTML", {
		set(ctx, value: string) {
			// null specifically becomes "" and not "null". undefined does not
			if (value === null) return;
			const html = String(value);
			let newval;
			const scriptBlockType = client.box.instanceof(
				ctx.this,
				"HTMLScriptElement"
			)
				? scriptBlockTypeForElement(client, ctx.this)
				: null;
			if (
				client.box.instanceof(ctx.this, "HTMLScriptElement") &&
				isScriptType(scriptBlockType)
			) {
				newval = rewriteJs(
					html,
					"(anonymous script element)",
					client.context,
					client.meta,
					isModuleScriptType(scriptBlockType)
				);
				client.natives.call(
					"Element.prototype.setAttribute",
					ctx.this,
					"scramjet-attr-script-source-src",
					bytesToBase64(TextEncoder_encode(newval))
				);
			} else if (client.box.instanceof(ctx.this, "HTMLStyleElement")) {
				newval = rewriteCss(html, client.context, client.meta);
			} else {
				try {
					newval = rewriteHtml(html, client.context, client.meta, {
						loadScripts: false,
						inline: true,
						source: client.url.href,
						apisource: "set Element.prototype.innerHTML",
						foreignContext: foreignContextForElement(client, ctx.this),
					});
				} catch {
					newval = html;
				}
			}

			ctx.set(newval);
		},
		get(ctx) {
			if (client.box.instanceof(ctx.this, "HTMLScriptElement")) {
				const scriptSource = client.natives.call(
					"Element.prototype.getAttribute",
					ctx.this,
					"scramjet-attr-script-source-src"
				);

				if (scriptSource) {
					return atob(scriptSource);
				}

				return ctx.get();
			}
			if (client.box.instanceof(ctx.this, "HTMLStyleElement")) {
				return ctx.get();
			}

			return unrewriteHtml(
				ctx.get(),
				foreignContextForElement(client, ctx.this)
			);
		},
	});

	const rewriteTextForElement = (element: Element, value: string) => {
		const scriptBlockType = client.box.instanceof(element, "HTMLScriptElement")
			? scriptBlockTypeForElement(client, element)
			: null;

		if (
			client.box.instanceof(element, "HTMLScriptElement") &&
			isScriptType(scriptBlockType)
		) {
			const newval: string = rewriteJs(
				value,
				"(anonymous script element)",
				client.context,
				client.meta,
				isModuleScriptType(scriptBlockType)
			) as string;
			client.natives.call(
				"Element.prototype.setAttribute",
				element,
				"scramjet-attr-script-source-src",
				bytesToBase64(TextEncoder_encode(value))
			);

			return newval;
		} else if (client.box.instanceof(element, "HTMLStyleElement")) {
			return rewriteCss(value, client.context, client.meta);
		} else {
			return value;
		}
	};
	const getTextForElement = (element: Element, text: string) => {
		if (client.box.instanceof(element, "HTMLScriptElement")) {
			const scriptSource = client.natives.call(
				"Element.prototype.getAttribute",
				element,
				"scramjet-attr-script-source-src"
			);
			if (scriptSource) return atob(scriptSource);
			return text;
		}
		if (client.box.instanceof(element, "HTMLStyleElement")) {
			return unrewriteCss(text, client.context);
		}
		return text;
	};

	client.Trap(
		["Node.prototype.textContent", "HTMLScriptElement.prototype.textContent"],
		{
			set(ctx, value) {
				const text = String(value);
				return ctx.set(rewriteTextForElement(ctx.this, text));
			},
			get(ctx) {
				return getTextForElement(ctx.this, ctx.get());
			},
		}
	);
	client.Trap(
		[
			"HTMLElement.prototype.innerText",
			"HTMLScriptElement.prototype.innerText",
		],
		{
			set(ctx, value: string) {
				const text = String(value);
				return ctx.set(rewriteTextForElement(ctx.this, text));
			},
			get(ctx) {
				return getTextForElement(ctx.this, ctx.get());
			},
		}
	);

	client.Trap("Element.prototype.outerHTML", {
		set(ctx, value: string) {
			const html = String(value);
			ctx.set(
				rewriteHtml(html, client.context, client.meta, {
					loadScripts: false,
					inline: true,
					source: client.url.href,
					apisource: "set Element.prototype.outerHTML",
					foreignContext: insideForeignContext(client, ctx.this),
				})
			);
		},
		get(ctx) {
			return unrewriteHtml(ctx.get(), insideForeignContext(client, ctx.this));
		},
	});

	client.Proxy("Element.prototype.setHTMLUnsafe", {
		apply(ctx) {
			const html = String(ctx.args[0]);
			ctx.args[0] = rewriteHtml(html, client.context, client.meta, {
				loadScripts: false,
				inline: true,
				source: client.url.href,
				apisource: "set Element.prototype.setHTMLUnsafe",
				foreignContext: foreignContextForElement(client, ctx.this),
			});
		},
	});

	client.Proxy("Element.prototype.getHTML", {
		apply(ctx) {
			ctx.return(unrewriteHtml(ctx.call()));
		},
	});

	client.Proxy("Element.prototype.insertAdjacentHTML", {
		apply(ctx) {
			const html = String(ctx.args[1]);
			ctx.args[1] = rewriteHtml(html, client.context, client.meta, {
				loadScripts: false,
				inline: true,
				source: client.url.href,
				apisource: "set Element.prototype.insertAdjacentHTML",
				foreignContext: foreignContextForElement(client, ctx.this),
			});
		},
	});

	// TODO: this needs to be done for all insert methods
	// client.Proxy(["Element.prototype.appendChild", "Element.prototype.append"], {
	// 	apply(ctx) {
	// 		if (ctx.this instanceof self.HTMLStyleElement) {
	// 			for (const node of ctx.args) {
	// 				if (node instanceof self.Text) {
	// 					node.data = rewriteCss(
	// 						ctx.args[0].data,
	// 						client.context,
	// 						client.meta
	// 					);
	// 				}
	// 			}
	// 		} else if (ctx.this instanceof self.HTMLScriptElement) {
	// 			for (const node of ctx.args) {
	// 				if (node instanceof self.Text) {
	// 					const newval: string = rewriteJs(
	// 						node.data,
	// 						"(anonymous script element)",
	// 						client.context,
	// 						client.meta
	// 					) as string;
	// 					client.natives.call(
	// 						"Element.prototype.setAttribute",
	// 						ctx.this,
	// 						"scramjet-attr-script-source-src",
	// 						bytesToBase64(encoder.encode(newval))
	// 					);
	// 					node.data = newval;
	// 				}
	// 			}
	// 		}
	// 	},
	// });

	client.Proxy("Audio", {
		construct(ctx) {
			if (ctx.args[0]) ctx.args[0] = client.rewriteUrl(ctx.args[0]);
		},
	});
	client.Proxy("Text.prototype.appendData", {
		apply(ctx) {
			const text = String(ctx.args[0]);
			const parent = client.natives.call(
				"Node.prototype.parentElement",
				ctx.this
			);
			ctx.args[0] = rewriteTextForElement(parent, text);
		},
	});

	client.Proxy("Text.prototype.insertData", {
		apply(ctx) {
			const text = String(ctx.args[1]);
			const parent = client.natives.call(
				"Node.prototype.parentElement",
				ctx.this
			);
			ctx.args[1] = rewriteTextForElement(parent, text);
		},
	});

	client.Proxy("Text.prototype.replaceData", {
		apply(ctx) {
			const text = String(ctx.args[2]);
			const parent = client.natives.call(
				"Node.prototype.parentElement",
				ctx.this
			);
			ctx.args[2] = rewriteTextForElement(parent, text);
		},
	});

	client.Trap("Text.prototype.wholeText", {
		get(ctx) {
			const parent = client.natives.call(
				"Node.prototype.parentElement",
				ctx.this
			);
			return getTextForElement(parent, ctx.get());
		},
		set(ctx, v) {
			const text = String(v);
			const parent = client.natives.call(
				"Node.prototype.parentElement",
				ctx.this
			);
			return ctx.set(rewriteTextForElement(parent, text));
		},
	});

	client.Proxy("HTMLAnchorElement.prototype.toString", {
		apply(ctx) {
			const href = ctx.call();
			if (!href) return href;
			return ctx.return(unrewriteUrl(href, client.context));
		},
	});

	client.Trap(
		[
			"HTMLIFrameElement.prototype.contentWindow",
			"HTMLFrameElement.prototype.contentWindow",
			"HTMLObjectElement.prototype.contentWindow",
			"HTMLEmbedElement.prototype.contentWindow",
		],
		{
			get(ctx) {
				const realwin = ctx.get() as Window;
				if (!realwin) return realwin;

				try {
					if (!(SCRAMJETCLIENT in realwin)) {
						// hook the iframe before the client can start to steal globals out of it
						client.init.hookSubcontext(realwin, ctx.this);
					}
				} catch {
					// cross-origin iframe, can't do anything here
					return realwin;
				}

				return realwin;
			},
		}
	);

	client.Trap(
		[
			"HTMLIFrameElement.prototype.contentDocument",
			"HTMLFrameElement.prototype.contentDocument",
			"HTMLObjectElement.prototype.contentDocument",
			"HTMLEmbedElement.prototype.contentDocument",
		],
		{
			get(ctx) {
				const realwin = client.descriptors.get(
					`${ctx.this.constructor.name}.prototype.contentWindow`,
					ctx.this
				);
				if (!realwin) return realwin;

				if (!(SCRAMJETCLIENT in realwin)) {
					client.init.hookSubcontext(realwin, ctx.this);
				}

				return realwin.document;
			},
		}
	);

	client.Proxy(
		[
			"HTMLIFrameElement.prototype.getSVGDocument",
			"HTMLObjectElement.prototype.getSVGDocument",
			"HTMLEmbedElement.prototype.getSVGDocument",
		],
		{
			apply(ctx) {
				const doc = ctx.call();
				if (doc) {
					// we trap the contentDocument, this is really the scramjet version
					return ctx.return(ctx.this.contentDocument);
				}
			},
		}
	);

	client.Proxy("DOMParser.prototype.parseFromString", {
		apply(ctx) {
			const html = String(ctx.args[0]);
			const mime = String(ctx.args[1]);
			// TODO: what do we do if it's xml/svg?
			if (!isHtmlMimeType(mime)) return;
			ctx.args[0] = rewriteHtml(html, client.context, client.meta, {
				loadScripts: false,
				inline: true,
				source: client.url.href,
				apisource: "DOMParser.prototype.parseFromString",
			});
		},
	});
}
