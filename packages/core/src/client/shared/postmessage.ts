import { iswindow } from "@client/entry";
import { SCRAMJETCLIENT } from "@/symbols";
import { ScramjetClient } from "@client/index";
import { Object_defineProperty, Reflect_apply } from "@/shared/snapshot";
import { POLLUTANT } from "./realm";

function wrapWindowMessage(caller: ScramjetClient, args: any[]) {
	const inheritsOrigin =
		caller.url.href === "about:srcdoc" || caller.url.href === "about:blank";
	args[0] = {
		$scramjet$messagetype: "window",
		$scramjet$origin: inheritsOrigin
			? (caller.global.parent[SCRAMJETCLIENT]?.url.origin ?? caller.url.origin)
			: caller.url.origin,
		$scramjet$data: args[0],
	};
	if (typeof args[1] === "string") args[1] = "*";
	if (args[1] && typeof args[1] === "object") {
		args[1] = { targetOrigin: "*", transfer: args[1].transfer };
	}
}

export default function (client: ScramjetClient, self: Self) {
	let callFromWindow:
		| ((fn: Window["postMessage"], target: Window, args: any[]) => void)
		| undefined;
	if (iswindow) {
		// The browser takes MessageEvent.source from the realm calling the
		// native method. A bound method from the target window loses that
		// information for string-only messages (for example, Google's IMA SDK).
		callFromWindow = client.natives.call(
			"Function",
			null,
			"apply",
			"return (fn, target, args) => apply(fn, target, args);",
		)(Reflect_apply);

		client.Proxy("window.postMessage", {
			apply(ctx) {
				// so we need to send the real origin here, since the recieving window can't possibly know.
				// except, remember that this code is being ran in a different realm than the invoker, so if we ask our `client` it may give us the wrong origin
				// if we were given any object that came from the real realm we can use that to get the real origin
				// and this works in every case EXCEPT for the fact that all three arguments can be strings which are copied instead of cloned
				// so we have to use `$setrealm` which will pollute this with an object from the real realm

				let pollutant;

				if (typeof ctx.args[0] === "object" && ctx.args[0] !== null) {
					pollutant = ctx.args[0]; // try to use the first object we can find because it's more reliable
				} else if (typeof ctx.args[2] === "object" && ctx.args[2] !== null) {
					pollutant = ctx.args[2]; // next try to use transfer
				} else if (
					ctx.this &&
					POLLUTANT in ctx.this &&
					typeof ctx.this[POLLUTANT] === "object" &&
					ctx.this[POLLUTANT] !== null
				) {
					pollutant = ctx.this[POLLUTANT]; // lastly try to use the object from $setrealm
				} else {
					pollutant = {}; // give up
				}

				// and now we can steal Function from the caller's realm
				const {
					constructor: { constructor: Function },
				} = pollutant;

				// invoking stolen function will give us the caller's globalThis, remember scramjet has already proxied it!!!
				const callerGlobalThisProxied: Self = Function("return globalThis")();
				const callerClient = callerGlobalThisProxied[SCRAMJETCLIENT];

				// Third-party frames may call postMessage without having a Scramjet
				// client installed. In that case, preserve the native message instead
				// of trying to read origin metadata from a missing client.
				if (!callerClient?.url) {
					ctx.return(ctx.call());
					return;
				}

				// this WOULD be enough but the source argument of MessageEvent has to return the caller's window
				// and if we just call it normally it would be coming from here, which WILL NOT BE THE CALLER'S because the accessor is from the parent
				// so with the stolen function we wrap postmessage so the source will truly be the caller's window (remember that function is scramjet's!!!)
				const wrappedPostMessage = Function("...args", "this(...args)");

				// console.log(
				// 	callerClient,
				// 	client,
				// 	callerGlobalThisProxied.document,
				// 	self.document,
				// 	callerClient === client
				// );
				wrapWindowMessage(callerClient, ctx.args);
				ctx.return(wrappedPostMessage.call(ctx.fn, ...ctx.args));
			},
		});
		client.box.windowPostMessages.set(
			(self as Window).postMessage,
			client.natives.store["window.postMessage"],
		);
	}

	client.Proxy("BroadcastChannel.prototype.postMessage", {
		apply(ctx) {
			ctx.args[0] = {
				$scramjet$messagetype: "window",
				// TODO: need to actually look up the broadcastchannel itself in box i think
				$scramjet$origin: client.url.origin,
				$scramjet$data: ctx.args[0],
			};
		},
	});

	const toproxy = ["MessagePort.prototype.postMessage"];

	if (self.Worker) toproxy.push("Worker.prototype.postMessage");
	if (!iswindow) toproxy.push("self.postMessage"); // only do the generic version if we're in a worker

	client.Proxy(toproxy, {
		apply(ctx) {
			// origin/source doesn't need to be preserved - it's null in the message event

			ctx.args[0] = {
				$scramjet$messagetype: "worker",
				$scramjet$data: ctx.args[0],
			};
		},
	});
	Object_defineProperty(self, client.config.globals.wrappostmessagefn, {
		value: function (obj: any) {
			const postMessage = obj?.postMessage;
			if (typeof postMessage !== "function") return obj;
			const nativePostMessage = client.box.windowPostMessages.get(postMessage);
			return {
				postMessage:
					callFromWindow && nativePostMessage
						? (...args: any[]) => {
								wrapWindowMessage(client, args);
								callFromWindow(nativePostMessage, obj, args);
							}
						: postMessage.bind(obj),
			};
		},
		configurable: false,
		writable: false,
		enumerable: false,
	});
}
