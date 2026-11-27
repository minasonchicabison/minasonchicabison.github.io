import { ScramjetClient } from "@client/index";
import {
	Number,
	Object_keys,
	Reflect_apply,
	Reflect_get,
	Reflect_has,
	Reflect_ownKeys,
} from "@/shared/snapshot";

export default function (client: ScramjetClient) {
	client.Trap("Element.prototype.attributes", {
		get(ctx) {
			const map = ctx.get() as NamedNodeMap;
			const proxy = new Proxy(map, {
				get(target, prop, _receiver) {
					const value = Reflect_get(target, prop);

					if (prop === "length") {
						return Object_keys(proxy).length;
					}

					if (prop === "getNamedItem") {
						return (name: string) => proxy[name];
					}
					if (prop === "getNamedItemNS") {
						return (namespace: string, name: string) =>
							proxy[`${namespace}:${name}`];
					}

					if (prop in NamedNodeMap.prototype && typeof value === "function") {
						return new Proxy(value, {
							apply(target, that, args) {
								if (that === proxy) {
									const isIframeSandbox =
										element.tagName?.toLowerCase() === "iframe" &&
										((prop === "setNamedItem" &&
											(args[0] as Attr | null)?.namespaceURI == null &&
											String((args[0] as Attr | null)?.name).toLowerCase() ===
												"sandbox") ||
										(prop === "setNamedItemNS" &&
											args[0] != null &&
											(args[0] as Attr).namespaceURI == null &&
											String((args[0] as Attr).localName).toLowerCase() ===
												"sandbox"));
									if (isIframeSandbox) {
										const attr = args[0] as Attr;
										const previousValue = element.getAttribute("sandbox");
										let previous: Attr | null = null;
										if (previousValue !== null) {
											previous =
												element.ownerDocument.createAttribute("sandbox");
											previous.value = previousValue;
										}
										element.setAttribute("sandbox", attr.value);
										return previous;
									}
									if (
										element.tagName?.toLowerCase() === "iframe" &&
										((prop === "removeNamedItem" &&
											String(args[0]).toLowerCase() === "sandbox") ||
										(prop === "removeNamedItemNS" &&
											args[0] == null &&
											String(args[1]).toLowerCase() === "sandbox"))
									) {
										const previousValue = element.getAttribute("sandbox");
										if (previousValue === null) {
											return Reflect_apply(target, map, args);
										}
										element.removeAttribute("sandbox");
										const previous =
											element.ownerDocument.createAttribute("sandbox");
										previous.value = previousValue;
										return previous;
									}
									return Reflect_apply(target, map, args);
								}

								return Reflect_apply(target, that, args);
							},
						});
					}

					if (
						(typeof prop === "string" || typeof prop === "number") &&
						!isNaN(Number(prop))
					) {
						const position = Object_keys(proxy)[prop];

						return map[position];
					}

					if (!this.has(target, prop)) return undefined;

					return value;
				},
				ownKeys(target) {
					const keys = Reflect_ownKeys(target);

					return keys.filter((key) => this.has(target, key));
				},
				has(target, prop) {
					if (typeof prop === "symbol") return Reflect_has(target, prop);
					if (prop.startsWith("scramjet-attr-")) return false;
					if (map[prop]?.name?.startsWith("scramjet-attr-")) return false;

					return Reflect_has(target, prop);
				},
			});

			return proxy;
		},
	});

	client.Trap(["Attr.prototype.value", "Attr.prototype.nodeValue"], {
		get(ctx) {
			// eslint-disable-next-line scramjet-core/no-poisoned-ctx-value
			if (ctx.this?.ownerElement) {
				// eslint-disable-next-line scramjet-core/no-poisoned-ctx-value
				return ctx.this.ownerElement.getAttribute(ctx.this.name);
			}

			return ctx.get();
		},
		set(ctx, value) {
			// eslint-disable-next-line scramjet-core/no-poisoned-ctx-value
			if (ctx.this?.ownerElement) {
				// eslint-disable-next-line scramjet-core/no-poisoned-ctx-value
				return ctx.this.ownerElement.setAttribute(ctx.this.name, value);
			}

			return ctx.set(value);
		},
	});
}
