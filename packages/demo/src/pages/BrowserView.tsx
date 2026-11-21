import { css, type Component, createState } from "dreamland/core";
import {
	CatchEscapedLinksPlugin,
	UrlWatcherPlugin,
} from "@mercuryworkshop/scramjet-utils";
import { cachePlugin, controller, getTransport } from "..";
import homepage from "./homepage.html?raw";
import type { Frame } from "@mercuryworkshop/scramjet-controller";
import { demoSettingsStore } from "../store";
import {
	addCustomWispUrl,
	connectWisp,
	getActiveWispUrl,
	getAllWispUrls,
	getCustomWispUrls,
	getWispStatus,
	removeCustomWispUrl,
	setActiveWispUrl,
} from "../wisp-status";

/* ---------- tiny storage helper ---------- */
const ls = {
	get: (k: string, d: string) => {
		try {
			return localStorage.getItem(k) ?? d;
		} catch {
			return d;
		}
	},
	set: (k: string, v: string) => {
		try {
			localStorage.setItem(k, v);
		} catch {}
	},
};

/* ---------- state mirrored from the active tab (the omnibox reads this) ---------- */
export const browserState = createState({
	url: "", // empty on purpose: no preset text in the address bar
	title: "New tab",
	frame: null! as Frame,
});

/* ---------- search ---------- */
const ENGINES: Record<string, { n: string; u: string }> = {
	duckduckgo: { n: "DuckDuckGo", u: "https://duckduckgo.com/?q=" },
	brave: { n: "Brave", u: "https://search.brave.com/search?q=" },
	google: { n: "Google", u: "https://www.google.com/search?q=" },
};
const engine = () => {
	const k = ls.get("mw-engine", "duckduckgo");
	return ENGINES[k] ? k : "duckduckgo";
};

/** Anything that looks like an address is opened; everything else is searched. */
export function toUrl(input: string): string {
	const q = input.trim();
	if (!q) return "";
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(q)) return q;
	if (
		!/\s/.test(q) &&
		(/^localhost(:\d+)?(\/.*)?$/i.test(q) ||
			/^[^\s/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(q))
	)
		return "https://" + q;
	return ENGINES[engine()].u + encodeURIComponent(q);
}

/* ---------- tab names ---------- */
// hostname -> custom tab name. Add more here.
const TAB_NAMES: Record<string, string> = {
	"cdn.jsdelivr.net": "jsDelivr CDN",
	"jsdelivr.com": "jsDelivr",
	"www.jsdelivr.com": "jsDelivr",
};

export function tabTitleFor(url: string, rawTitle?: string): string {
	if (!url || url.startsWith("data:")) return "New tab";
	try {
		const host = new URL(url).hostname;
		return TAB_NAMES[host] ?? (rawTitle || host.replace(/^www\./, ""));
	} catch {
		return rawTitle || "New tab";
	}
}


function isFaviconImage(value: string): boolean {
	return /^https?:\/\//i.test(value) || /^data:image\//i.test(value);
}

function applyTabAppearance(tab: Tab) {
	tab.title = tabTitleFor(tab.url);
	tab.icon = "🌐";
}

/* ---------- bookmarks ---------- */
type Bm = { t: string; u: string };
const loadBm = (): Bm[] => {
	try {
		return JSON.parse(ls.get("mw-bookmarks", "[]"));
	} catch {
		return [];
	}
};
const saveBm = (l: Bm[]) => {
	ls.set("mw-bookmarks", JSON.stringify(l));
	pushAll();
};
function addBookmark(input: string) {
	const u = toUrl(input);
	if (!u) return;
	const l = loadBm();
	if (l.some((b) => b.u === u)) return;
	saveBm([...l, { t: tabTitleFor(u), u }]);
}


/* ---------- live data for the Dynamic Island ---------- */
// Battery state and IP-based weather are read in the browser shell, then
// forwarded to the homepage iframe because it is hosted from a data: URL.
const svc = {
	bat: null as null | { level: number; charging: boolean },
	wx: null as null | { temp: number; code: number; day: boolean; city: string },
	started: false,
};
let refreshWeatherNow: (() => void) | null = null;

function startServices() {
	if (svc.started) return;
	svc.started = true;

	try {
		const getBattery = (navigator as any).getBattery;
		if (typeof getBattery === "function") {
			void getBattery.call(navigator).then((battery: any) => {
				const update = () => {
					svc.bat = {
						level: Math.max(0, Math.min(100, Math.round(Number(battery.level) * 100))),
						charging: !!battery.charging,
					};
					pushAll();
				};
				update();
				battery.addEventListener("levelchange", update);
				battery.addEventListener("chargingchange", update);
			}).catch(() => {});
		}
	} catch {}

	let lastWeatherLoaded = 0;
	const loadWeather = async (force = false) => {
		const now = Date.now();
		if (now - lastWeatherLoaded < (force ? 60_000 : 15 * 60_000)) return;
		lastWeatherLoaded = now;
		try {
			const locationResponse = await fetch("https://ipapi.co/json/", { cache: "no-store" });
			if (!locationResponse.ok) throw new Error("Weather location lookup failed");
			const place = await locationResponse.json();
			const latitude = Number(place.latitude);
			const longitude = Number(place.longitude);
			if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
				throw new Error("Weather location was unavailable");
			}
			const unit = /^en-US/i.test(navigator.language) ? "fahrenheit" : "celsius";
			const weatherResponse = await fetch(
				"https://api.open-meteo.com/v1/forecast?latitude=" +
					encodeURIComponent(String(latitude)) +
					"&longitude=" +
					encodeURIComponent(String(longitude)) +
					"&current=temperature_2m,weather_code,is_day&temperature_unit=" +
					unit,
				{ cache: "no-store" }
			);
			if (!weatherResponse.ok) throw new Error("Weather lookup failed");
			const result = await weatherResponse.json();
			const current = result?.current;
			if (!current || !Number.isFinite(Number(current.temperature_2m))) {
				throw new Error("Weather response was incomplete");
			}
			svc.wx = {
				temp: Math.round(Number(current.temperature_2m)),
				code: Number(current.weather_code) || 0,
				day: !!current.is_day,
				city: typeof place.city === "string" ? place.city : "",
			};
			pushAll();
		} catch {
			// Leave the last good reading in place, if one exists.
		}
	};
	refreshWeatherNow = () => { void loadWeather(true); };
	void loadWeather();
	window.setInterval(() => { void loadWeather(); }, 15 * 60_000);
}

// EDIT THESE STRINGS to change the rotating greeting under the Minason Web heading.
const WELCOME_MESSAGES = [
	"Your tabs called. They want a union.",
	"Powered by questionable amounts of caffeine.",
	"Browsing at the speed of mild inconvenience.",
	"Another day, another 47 open tabs.",
	"Your search history is between you and the pixels.",
	"Welcome back, professional button clicker.",
	"Loading vibes… please do not refresh the vibes.",
	"Internet explorer? We barely know her.",
	"Now with 12% more unnecessary gradients.",
	"Somewhere, a server just sneezed.",
	"Go forth and open suspiciously many tabs.",
	"Your curiosity has entered the chat.",
	"Built different. Compiled similarly.",
	"Less spinning wheel, more winning feel.",
	"Today's forecast: scattered tabs.",
	"Ctrl+T is a lifestyle.",
	"Be right back, negotiating with the internet.",
	"Searching for the meaning of the loading bar.",
	"One small click for you, one giant request for the server.",
	"Please keep all hands inside the browser.",
	"Fresh tab. Same chaotic energy.",
	"Your bookmarks are judging your life choices.",
	"404 problems, but a vibe ain't one.",
	"Welcome to the information superhighway. Mind the potholes.",
	"Tabs are temporary. Screenshots are forever.",
	"Maximum curiosity. Minimum context.",
	"Currently orbiting the world wide web.",
	"May your pages load and your snacks be plentiful.",
	"Shiny pixels, questionable decisions.",
	"Congratulations, you found the internet again."
];

function escapeHtml(value: string): string {
	const entities: Record<string, string> = {
		"&": "&amp;",
		"<": "&lt;",
		">": "&gt;",
		'"': "&quot;",
		"'": "&#39;",
	};
	return value.replace(/[&<>"']/g, (char) => entities[char] ?? char);
}

const themeVars = (): Record<string, string> =>
	(window as any).mwTheme?.vars() ?? {};

const buildHomeSrc = () => {
	const vars = Object.entries(themeVars())
		.map(([k, v]) => `${k}:${v}`)
		.join(";");
	const message = WELCOME_MESSAGES[Math.floor(Math.random() * WELCOME_MESSAGES.length)];
	const html = homepage
		.replace("/*VARS*/", `:root{${vars}}`)
		.replace("/*WELCOME_MESSAGE*/", escapeHtml(message));
	let bin = "";
	new TextEncoder().encode(html).forEach((c) => (bin += String.fromCharCode(c)));
	return `data:text/html;charset=utf-8;base64,${btoa(bin)}`;
};

/* ---------- tabs ---------- */
type Tab = {
	id: number;
	url: string;
	title: string;
	icon: string;
	iframe: HTMLIFrameElement;
	frame: Frame;
};
const tabs: Tab[] = [];
let activeId = 0;
let nextId = 1;
let host: HTMLElement | null = null;
let inited = false;
const activeTab = () => tabs.find((t) => t.id === activeId);

function pushTo(t: Tab) {
	t.iframe.contentWindow?.postMessage(
		{ type: "mw-state", vars: themeVars(), bm: loadBm(), bat: svc.bat, wx: svc.wx },
		"*"
	);
}
function pushAll() {
	tabs.forEach(pushTo);
}

function renderStrip() {
	const el = document.getElementById("mw-tabs");
	if (!el) return;
	el.innerHTML = "";
	tabs.forEach((t) => {
		const d = document.createElement("div");
		d.className = "mwt" + (t.id === activeId ? " on" : "");
		d.innerHTML =
			'<span class="mwt-icon"></span><span class="mwt-title"></span><button type="button" class="mwt-x" aria-label="Close tab">\u00d7</button>';
		const icon = d.querySelector<HTMLElement>(".mwt-icon")!;
		if (isFaviconImage(t.icon)) {
			const image = document.createElement("img");
			image.src = t.icon;
			image.alt = "";
			image.referrerPolicy = "no-referrer";
			image.onerror = () => { icon.textContent = "🌐"; };
			icon.appendChild(image);
		} else {
			icon.textContent = t.icon || "🌐";
		}
		d.querySelector(".mwt-title")!.textContent = t.title;
		d.onclick = () => select(t.id);
		(d.querySelector(".mwt-x") as HTMLElement).onclick = (e) => {
			e.stopPropagation();
			closeTab(t.id);
		};
		el.appendChild(d);
	});
	const add = document.createElement("button");
	add.type = "button";
	add.className = "mwt-add";
	add.title = "New tab";
	add.setAttribute("aria-label", "New tab");
	add.textContent = "+";
	add.onclick = () => newTab();
	el.appendChild(add);
}

function sync() {
	const t = activeTab();
	browserState.url = t?.url ?? "";
	browserState.title = t?.title ?? "New tab";
	browserState.frame = t?.frame as Frame;
	document.title = t?.url ? `${t.title} - Minason Web` : "Minason Web v2";
	const faviconLink = document.getElementById("mw-app-favicon") as HTMLLinkElement | null;
	if (faviconLink) {
		faviconLink.removeAttribute("type");
		faviconLink.href = t && isFaviconImage(t.icon) ? t.icon : "/icon.png";
	}
	renderStrip();
}

function select(id: number) {
	activeId = id;
	tabs.forEach((t) => t.iframe.classList.toggle("on", t.id === id));
	sync();
}

function newTab() {
	if (!host) return;
	const iframe = document.createElement("iframe");
	iframe.className = "mw-frame";
	host.appendChild(iframe);
	const t = { id: nextId++, url: "", title: "New tab", icon: "🌐", iframe } as Tab;
	applyTabAppearance(t);
	const urlWatcher = new UrlWatcherPlugin((url) => {
		t.url = url.startsWith("data:") ? "" : url;
		applyTabAppearance(t);
		t.id === activeId ? sync() : renderStrip();
	});
	const catchEscapedLinks = new CatchEscapedLinksPlugin(
		(url) => new URL(`/?goto=${encodeURIComponent(url.href)}`, location.origin)
	);
	t.frame = controller.createFrame(iframe, {
		plugins: [cachePlugin, urlWatcher, catchEscapedLinks],
	});
	iframe.addEventListener("load", () => pushTo(t));
	iframe.src = buildHomeSrc();
	tabs.push(t);
	select(t.id);
}

function closeTab(id: number) {
	const i = tabs.findIndex((t) => t.id === id);
	if (i < 0) return;
	tabs[i].iframe.remove();
	tabs.splice(i, 1);
	if (!tabs.length) newTab();
	else if (id === activeId) select(tabs[Math.max(0, i - 1)].id);
	else renderStrip();
}

export function go(input: string) {
	const t = activeTab();
	const u = toUrl(input);
	if (!t || !u) return;
	t.url = u;
	t.title = tabTitleFor(u);
	t.frame.go(u);
	sync();
}

/** Omnibox home button. */
export const home = {
	go: () => {
		const t = activeTab();
		if (!t) return;
		t.url = "";
		t.title = "New tab";
		t.iframe.src = buildHomeSrc();
		sync();
	},
};

function onMessage(e: MessageEvent) {
	const t = tabs.find((x) => x.iframe.contentWindow === e.source);
	if (!t) return;
	const d = e.data;
	if (d?.type === "mw-ready") pushTo(t);
	else if (d?.type === "mw-refresh-live") refreshWeatherNow?.();
	else if (d?.type === "mw-go") {
		if (t.id !== activeId) select(t.id);
		go(d.q);
	} else if (d?.type === "mw-add-bm") {
		const u = prompt("Add a bookmark - enter an address:");
		if (u) addBookmark(u);
	} else if (d?.type === "mw-rm-bm") {
		const l = loadBm();
		l.splice(d.i, 1);
		saveBm(l);
	}
}

function initTabs(el: HTMLElement) {
	if (inited) return;
	inited = true;
	host = el;
	window.addEventListener("message", onMessage);
	window.addEventListener("mw-theme", pushAll);
	startServices();
	newTab();
	const goto = new URL(location.href).searchParams.get("goto");
	if (goto) {
		go(goto);
		history.replaceState(null, "", location.href.split("?")[0]);
	}
}


/* ---------- browser settings ---------- */
const SETTINGS_CSS = `
.mws-backdrop{position:fixed;inset:0;z-index:2147482998;background:rgba(2,3,10,.48);backdrop-filter:blur(4px) saturate(115%);-webkit-backdrop-filter:blur(4px) saturate(115%);animation:mws-fade .18s ease}
.mws{position:fixed;top:88px;right:12px;z-index:2147483000;width:min(360px,calc(100vw - 24px));max-height:calc(100vh - 104px);overflow:auto;padding:18px;border-radius:26px;border:1px solid rgba(255,255,255,.19);background:rgba(17,18,31,.97);backdrop-filter:blur(38px) saturate(180%);-webkit-backdrop-filter:blur(38px) saturate(180%);box-shadow:inset 0 1px 0 rgba(255,255,255,.18),0 30px 90px rgba(0,0,0,.78),0 0 38px color-mix(in srgb,var(--mw-accent,#8f7cff) 14%,transparent);color:#f5f5ff;font:500 13px "Manrope Variable",Manrope,system-ui,sans-serif;transform-origin:top right;animation:mws-in .34s cubic-bezier(.2,1.25,.35,1)}
@keyframes mws-fade{from{opacity:0}to{opacity:1}}
@keyframes mws-in{from{transform:translateY(-10px) scale(.96);opacity:0;filter:blur(8px)}to{transform:translateY(0) scale(1);opacity:1;filter:none}}
.mws-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:15px}
.mws-head strong{font-size:15px;font-weight:800;letter-spacing:-.025em}
.mws-close{width:29px;height:29px;display:grid;place-items:center;border-radius:50%;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.09);color:#fff;font-size:17px;cursor:pointer}
.mws h3{margin:0 0 10px;font-size:10px;font-weight:800;color:#bbbcd2;letter-spacing:.13em;text-transform:uppercase}
.mws section+section{margin-top:17px;padding-top:15px;border-top:1px solid rgba(255,255,255,.11)}
.mws .g{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.mws button{display:flex;align-items:center;gap:9px;padding:9px 11px;border-radius:14px;border:1px solid rgba(255,255,255,.13);background:rgba(255,255,255,.075);color:inherit;font:600 12px system-ui,sans-serif;cursor:pointer;text-align:left;transition:transform .22s,background .22s,border-color .22s}
.mws button:hover{background:rgba(255,255,255,.14);transform:translateY(-1px)}
.mws button.on{border-color:var(--mw-accent);background:color-mix(in srgb,var(--mw-accent) 17%,rgba(255,255,255,.08));box-shadow:0 0 0 2px color-mix(in srgb,var(--mw-accent) 24%,transparent)}
.mws .d{width:22px;height:22px;border-radius:50%;flex:none;border:1px solid rgba(255,255,255,.22);box-shadow:inset 0 1px 1px rgba(255,255,255,.45),0 2px 8px rgba(0,0,0,.4)}
.mws .row{display:grid;grid-template-columns:repeat(3,1fr);gap:7px}
.mws .row button{justify-content:center;text-align:center}
.mws .mws-tab-form{display:grid;grid-template-columns:minmax(0,1fr);gap:9px}
.mws .mws-tab-form label{display:flex;flex-direction:column;gap:6px;color:#b8b8ce;font-size:11px;font-weight:700;grid-column:1/-1;min-width:0}
.mws input{box-sizing:border-box;width:100%;height:37px;min-width:0;padding:0 10px;border:1px solid rgba(255,255,255,.15);border-radius:11px;background:rgba(4,5,13,.72);color:#fff;font:600 13px system-ui,sans-serif;outline:0}
.mws input:focus{border-color:var(--mw-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--mw-accent) 25%,transparent)}
.mws .mws-tab-form button{grid-column:1/-1;justify-content:center;background:color-mix(in srgb,var(--mw-accent) 24%,rgba(255,255,255,.08));border-color:color-mix(in srgb,var(--mw-accent) 55%,transparent);padding:10px}
.mws .mws-hint{margin-top:8px;color:#a8a8c0;font-size:10.5px;line-height:1.5}
.mws .foot{margin-top:15px;padding-top:12px;border-top:1px solid rgba(255,255,255,.1);font-size:10.5px;line-height:1.55;color:#a9aac0}
.mws .saved{min-height:14px;margin-top:7px;color:#8ee6a3;font-size:10.5px}
@media(prefers-reduced-motion:reduce){.mws,.mws-backdrop,.mws *{animation:none!important;transition:none!important}}
`;

let pop: HTMLDivElement | null = null;
let settingsBackdrop: HTMLDivElement | null = null;
function closeSettings() {
	pop?.remove();
	pop = null;
	settingsBackdrop?.remove();
	settingsBackdrop = null;
	document.removeEventListener("keydown", onSettingsKeydown);
}
function onSettingsKeydown(event: KeyboardEvent) {
	if (event.key === "Escape") closeSettings();
}
function toggleSettings(ev?: Event) {
	ev?.stopPropagation();
	if (pop) return closeSettings();
	if (!document.getElementById("mws-css")) {
		const style = document.createElement("style");
		style.id = "mws-css";
		style.textContent = SETTINGS_CSS;
		document.head.appendChild(style);
	}

	const T = (window as any).mwTheme;
	const backdrop = document.createElement("div");
	backdrop.className = "mws-backdrop";
	backdrop.setAttribute("aria-hidden", "true");
	backdrop.addEventListener("click", closeSettings);

	const el = document.createElement("div");
	el.className = "mws";
	el.setAttribute("role", "dialog");
	el.setAttribute("aria-label", "Browser settings");
	el.innerHTML =
		`<div class="mws-head"><strong>Browser settings</strong><button type="button" class="mws-close" aria-label="Close settings">×</button></div>` +
		`<section><h3>Colorway</h3><div class="g">` +
		Object.keys(T?.presets ?? {})
			.map((id) =>
				`<button type="button" data-theme="${id}"><span class="d" style="background:linear-gradient(135deg,${T.presets[id].g1},${T.presets[id].g2})"></span>${T.presets[id].n}</button>`
			).join("") +
		`</div></section><section><h3>Search engine</h3><div class="row">` +
		Object.keys(ENGINES)
			.map((key) => `<button type="button" data-engine="${key}">${ENGINES[key].n}</button>`)
			.join("") +
		`</div></section>
		<div class="foot">Website cookies and storage are kept in this browser profile. Nothing is uploaded to Minason. Clearing this site’s browser data can sign you out and reset settings.</div>`;
	el.querySelector(".mws-close")!.addEventListener("click", closeSettings);

	const mark = () => {
		el.querySelectorAll<HTMLElement>("button").forEach((button) => {
			button.classList.toggle(
				"on",
				button.dataset.theme === T?.current ||
					button.dataset.engine === engine()
			);
		});
	};
	el.addEventListener("click", (event) => {
		const button = (event.target as HTMLElement).closest("button");
		if (!button) return;
		if (button.dataset.theme) T?.set(button.dataset.theme);
		if (button.dataset.engine) ls.set("mw-engine", button.dataset.engine);
		mark();
	});

	mark();
	document.body.append(backdrop, el);
	settingsBackdrop = backdrop;
	pop = el;
	document.addEventListener("keydown", onSettingsKeydown);
}


// The transport created in index.tsx starts on this selected Wisp endpoint.
let transportBoundWisp = getActiveWispUrl(demoSettingsStore.wispUrl);
let transportReconnectNeeded = false;
let transportReconnectInFlight = false;

async function rebindTransportToActiveWisp() {
	const url = getActiveWispUrl(demoSettingsStore.wispUrl);
	if (getWispStatus(url).state !== "connected") return;
	if (url !== transportBoundWisp) transportReconnectNeeded = true;
	if (!transportReconnectNeeded || transportReconnectInFlight) return;
	// The first Wisp handshake can finish before Controller has been constructed.
	if (!controller) return;

	transportReconnectInFlight = true;
	try {
		await controller.wait();
		const saved = localStorage.getItem("mw-transport");
		const kind = saved === "epoxy" ? "epoxy" : "libcurl";
		const transport = getTransport(url, kind);
		await transport.init();
		controller.setTransport(transport);
		transportBoundWisp = url;
		transportReconnectNeeded = false;
		console.info("Minason Web: proxy transport reconnected to Wisp", url);
	} catch (error) {
		console.warn("Minason Web: automatic Wisp transport recovery failed", error);
		transportReconnectNeeded = true;
	} finally {
		transportReconnectInFlight = false;
	}
}

/* ---------- Wisp connection panel ---------- */
const WISP_PANEL_CSS = `
.mww{position:fixed;top:96px;right:14px;z-index:2147483000;width:min(390px,calc(100vw - 28px));max-height:min(76vh,620px);overflow:auto;padding:16px;border-radius:25px;border:1px solid rgba(255,255,255,.14);background:rgba(20,20,34,.78);backdrop-filter:blur(34px) saturate(190%);-webkit-backdrop-filter:blur(34px) saturate(190%);box-shadow:inset 0 1px 0 rgba(255,255,255,.18),0 28px 70px rgba(0,0,0,.58);color:#ececf6;font:500 12.5px "Manrope Variable",Manrope,system-ui,sans-serif;transform-origin:top right;animation:mww-in .42s cubic-bezier(.2,1.3,.35,1)}
@keyframes mww-in{from{transform:translateY(-9px) scale(.94);opacity:0;filter:blur(8px)}to{transform:translateY(0) scale(1);opacity:1;filter:none}}
.mww-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:14px}
.mww-head strong{display:block;font-size:14px;font-weight:800;letter-spacing:-.02em}
.mww-head small,.mww-sub{display:block;margin-top:3px;color:#a5a5bd;font-size:11px;line-height:1.5}
.mww-close{width:28px;height:28px;display:grid;place-items:center;border-radius:50%;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.06);color:inherit;font-size:18px;cursor:pointer}
.mww-list{display:flex;flex-direction:column;gap:8px}
.mww-item{display:grid;grid-template-columns:10px minmax(0,1fr) auto;align-items:center;gap:10px;padding:10px;border:1px solid rgba(255,255,255,.09);border-radius:15px;background:rgba(255,255,255,.045)}
.mww-light{width:8px;height:8px;border-radius:50%;background:#ff453a;box-shadow:0 0 10px currentColor;color:#ff453a}
.mww-light.connecting{background:#ffd60a;color:#ffd60a;animation:mww-pulse 1.1s ease-in-out infinite}
.mww-light.connected{background:#30d158;color:#30d158}
.mww-endpoint{min-width:0;overflow-wrap:anywhere;color:#eeeef6;font-size:11.5px;font-weight:650}
.mww-state{display:block;margin-top:3px;color:#a3a3b9;font-size:10.5px;font-weight:500}
.mww-actions{display:flex;align-items:center;gap:5px}
.mww button{border:1px solid rgba(255,255,255,.11);border-radius:10px;background:rgba(255,255,255,.06);color:#ececf6;padding:6px 8px;font:700 10.5px system-ui,sans-serif;cursor:pointer;transition:transform .2s,background .2s,border-color .2s}
.mww button:hover{background:rgba(255,255,255,.12);transform:translateY(-1px)}
.mww button:disabled{opacity:.5;cursor:default;transform:none}
.mww button.selected{border-color:rgba(48,209,88,.4);color:#7ee69a;background:rgba(48,209,88,.1)}
.mww-section{margin-top:14px;padding-top:13px;border-top:1px solid rgba(255,255,255,.09)}
.mww-section h4{margin:0 0 8px;color:#aaaac0;font-size:10px;font-weight:800;letter-spacing:.12em;text-transform:uppercase}
.mww-add{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:7px}
.mww-add input{min-width:0;width:100%;height:36px;padding:0 11px;border:1px solid rgba(255,255,255,.12);border-radius:11px;background:rgba(0,0,0,.22);color:#fff;font:500 11.5px inherit;font-family:inherit;outline:0}
.mww-add input:focus{border-color:var(--mw-accent,#8f7cff);box-shadow:0 0 0 3px color-mix(in srgb,var(--mw-accent,#8f7cff) 22%,transparent)}
.mww-note{min-height:14px;margin-top:7px;color:#a5a5bd;font-size:10.5px;line-height:1.4}
.mww-engines{display:grid;grid-template-columns:1fr 1fr;gap:7px}
.mww-engine{justify-content:center;text-align:center;padding:9px 8px!important}
.mww-engine.selected{border-color:var(--mw-accent,#8f7cff);background:color-mix(in srgb,var(--mw-accent,#8f7cff) 17%,transparent)}
@keyframes mww-pulse{50%{opacity:.35;box-shadow:0 0 2px currentColor}}
@media(prefers-reduced-motion:reduce){.mww,.mww *{animation:none!important;transition:none!important}}
`;

let wispPop: HTMLDivElement | null = null;
let wispOutside: ((event: PointerEvent) => void) | null = null;

function updateWispDot() {
	const dot = document.getElementById("mw-wisp-dot");
	if (!dot) return;
	const active = getActiveWispUrl(demoSettingsStore.wispUrl);
	const state = getWispStatus(active).state;
	dot.classList.toggle("connected", state === "connected");
	dot.classList.toggle("connecting", state === "connecting");
	dot.classList.toggle("failed", state === "failed" || state === "idle");
	dot.setAttribute(
		"aria-label",
		"Wisp connection: " + state + ". Open Wisp connections."
	);
	dot.setAttribute("title", "Wisp: " + state + " · Manage connections");
}

function renderWispPanel(panel: HTMLDivElement) {
	const list = panel.querySelector(".mww-list")!;
	list.replaceChildren();
	const active = getActiveWispUrl(demoSettingsStore.wispUrl);
	const custom = getCustomWispUrls();

	for (const url of getAllWispUrls()) {
		const status = getWispStatus(url);
		const row = document.createElement("div");
		row.className = "mww-item";

		const light = document.createElement("span");
		light.className = "mww-light " + status.state;
		const detail = document.createElement("div");
		detail.className = "mww-endpoint";
		detail.textContent = url.replace(/^wss?:\/\//, "");
		const state = document.createElement("span");
		state.className = "mww-state";
		state.textContent =
			status.state === "connected"
				? "WebSocket handshake connected"
				: status.state === "connecting"
					? "Connecting to Wisp..."
					: status.state === "failed"
						? status.error || "Connection failed"
						: "Not tested yet";
		detail.appendChild(state);

		const actions = document.createElement("div");
		actions.className = "mww-actions";
		const use = document.createElement("button");
		const selected = url === active;
		use.className = selected ? "selected" : "";
		use.textContent = selected ? "Active" : "Use";
		use.disabled = selected;
		use.title = selected
			? "Currently selected Wisp server"
			: "Use this server and reload the browser";
		use.onclick = () => {
			setActiveWispUrl(url);
			demoSettingsStore.wispUrl = url;
			window.location.reload();
		};
		actions.appendChild(use);

		const test = document.createElement("button");
		test.textContent = status.state === "connecting" ? "..." : "Test";
		test.disabled = status.state === "connecting";
		test.onclick = async () => {
			await connectWisp(url);
			updateWispDot();
			if (wispPop) renderWispPanel(wispPop);
		};
		actions.appendChild(test);

		if (custom.includes(url)) {
			const remove = document.createElement("button");
			remove.textContent = "×";
			remove.title = "Remove custom server";
			remove.onclick = () => {
				removeCustomWispUrl(url);
				if (wispPop) renderWispPanel(wispPop);
				updateWispDot();
			};
			actions.appendChild(remove);
		}

		row.append(light, detail, actions);
		list.appendChild(row);
	}

	const engine = localStorage.getItem("mw-transport") || demoSettingsStore.transport;
	panel.querySelectorAll<HTMLButtonElement>("[data-engine]").forEach((button) => {
		button.classList.toggle("selected", button.dataset.engine === engine);
	});

	const note = panel.querySelector<HTMLElement>(".mww-note");
	if (note && !note.dataset.keep) note.textContent = "";
	updateWispDot();
}

function closeWispPanel() {
	wispPop?.remove();
	wispPop = null;
	if (wispOutside) {
		document.removeEventListener("pointerdown", wispOutside);
		wispOutside = null;
	}
}

function toggleWispPanel(event?: Event) {
	event?.stopPropagation();
	if (wispPop) {
		closeWispPanel();
		return;
	}
	closeSettings();
	if (!document.getElementById("mww-css")) {
		const style = document.createElement("style");
		style.id = "mww-css";
		style.textContent = WISP_PANEL_CSS;
		document.head.appendChild(style);
	}
	const panel = document.createElement("div");
	panel.className = "mww";
	panel.innerHTML = `
		<div class="mww-head">
			<div><strong>Wisp connections</strong><small>Choose a relay and check its handshake status</small></div>
			<button type="button" class="mww-close" aria-label="Close">×</button>
		</div>
		<div class="mww-list"></div>
		<div class="mww-section">
			<h4>Add your own Wisp</h4>
			<form class="mww-add">
				<input name="wisp" type="url" autocomplete="off" spellcheck="false" placeholder="wss://server.example/wisp/" aria-label="Wisp WebSocket URL" required>
				<button type="submit">Add</button>
			</form>
			<div class="mww-note">Use a secure wss:// address ending in /.</div>
		</div>
		<div class="mww-section">
			<h4>Transport engine</h4>
			<div class="mww-engines">
				<button type="button" class="mww-engine" data-engine="libcurl">Libcurl · recommended</button>
				<button type="button" class="mww-engine" data-engine="epoxy">Epoxy · alternate</button>
			</div>
			<div class="mww-sub">Changing the engine reloads the browser.</div>
		</div>`;
	panel.querySelector(".mww-close")!.addEventListener("click", closeWispPanel);
	panel.querySelector<HTMLFormElement>(".mww-add")!.addEventListener("submit", async (event) => {
		event.preventDefault();
		const input = panel.querySelector<HTMLInputElement>('input[name="wisp"]')!;
		const note = panel.querySelector<HTMLElement>(".mww-note")!;
		const url = addCustomWispUrl(input.value);
		if (!url) {
			note.dataset.keep = "1";
			note.textContent = "Enter a valid wss:// URL (or ws:// localhost URL).";
			return;
		}
		input.value = "";
		note.dataset.keep = "";
		note.textContent = "Added. Checking the Wisp handshake...";
		renderWispPanel(panel);
		await connectWisp(url);
		renderWispPanel(panel);
		note.dataset.keep = "1";
		note.textContent = "Server saved on this device. Use it to make it active.";
	});
	panel.querySelectorAll<HTMLButtonElement>("[data-engine]").forEach((button) => {
		button.addEventListener("click", () => {
			const engine = button.dataset.engine;
			if (engine !== "libcurl" && engine !== "epoxy") return;
			localStorage.setItem("mw-transport", engine);
			demoSettingsStore.transport = engine;
			window.location.reload();
		});
	});
	document.body.appendChild(panel);
	wispPop = panel;
	renderWispPanel(panel);

	wispOutside = (event: PointerEvent) => {
		if (
			wispPop &&
			!wispPop.contains(event.target as Node) &&
			event.target !== document.getElementById("mw-wisp-dot")
		) {
			closeWispPanel();
		}
	};
	setTimeout(() => {
		if (wispOutside) document.addEventListener("pointerdown", wispOutside);
	}, 0);
}

let lastWispRefresh = 0;
function refreshActiveWispStatus() {
	updateWispDot();
	const now = Date.now();
	if (now - lastWispRefresh < 10000) return;
	const url = getActiveWispUrl(demoSettingsStore.wispUrl);
	const status = getWispStatus(url);
	if (status.state === "idle" || status.state === "failed") {
		lastWispRefresh = now;
		void connectWisp(url, 3000).finally(updateWispDot);
	}
}
window.addEventListener("mw-wisp-status", () => {
	updateWispDot();
	const active = getActiveWispUrl(demoSettingsStore.wispUrl);
	const state = getWispStatus(active).state;
	if (active !== transportBoundWisp || state === "failed" || state === "idle") {
		transportReconnectNeeded = true;
	}
	if (state === "connected") {
		void rebindTransportToActiveWisp();
	}
	if (wispPop) renderWispPanel(wispPop);
});
window.addEventListener("focus", refreshActiveWispStatus);
document.addEventListener("visibilitychange", () => {
	if (!document.hidden) refreshActiveWispStatus();
});


/* ---------- omnibox ---------- */
export const Omnibox: Component = function (cx) {
	return (
		<form
			class="url-form"
			on:submit={(e: SubmitEvent) => {
				e.preventDefault();
				go(browserState.url);
			}}
		>
			<div class="browser-omnibox-shell">
				<div class="omnibox-nav">
					<button type="button" class="nav-btn" aria-label="Back" on:click={() => browserState.frame?.back()}>
						<span class="material-symbols-outlined">arrow_back</span>
					</button>
					<button type="button" class="nav-btn" aria-label="Forward" on:click={() => browserState.frame?.forward()}>
						<span class="material-symbols-outlined">arrow_forward</span>
					</button>
					<button type="button" class="nav-btn" aria-label="Reload" on:click={() => browserState.frame?.reload()}>
						<span class="material-symbols-outlined">refresh</span>
					</button>
					<button type="button" class="nav-btn" aria-label="Home" on:click={() => home.go()}>
						<span class="material-symbols-outlined">home</span>
					</button>
				</div>
				<div class="url-wrap">
					<button
						id="mw-wisp-dot"
						type="button"
						class="url-dot failed"
						aria-label="Wisp connection: not connected. Open Wisp connections."
						title="Wisp: not connected · Manage connections"
						on:click={(e: Event) => toggleWispPanel(e)}
					></button>
					<input
						id="search"
						class="url-input"
						type="text"
						value={use(browserState.url)}
						on:input={(e: Event) => (browserState.url = (e.target as HTMLInputElement).value)}
						spellcheck="false"
						placeholder="Search or enter address"
					/>
				</div>
				<div class="omnibox-nav">
					<button type="button" class="nav-btn" aria-label="Bookmark this page" on:click={() => addBookmark(browserState.url)}>
						<span class="material-symbols-outlined">bookmark</span>
					</button>
					<button
						type="button"
						class="nav-btn"
						aria-label="Fullscreen"
						on:click={() =>
							document.fullscreenElement
								? document.exitFullscreen()
								: document.documentElement.requestFullscreen()
						}
					>
						<span class="material-symbols-outlined">fullscreen</span>
					</button>
					<button type="button" class="nav-btn" aria-label="Settings" on:click={(e: Event) => toggleSettings(e)}>
						<span class="material-symbols-outlined">tune</span>
					</button>
				</div>
			</div>
		</form>
	);
};
Omnibox.style = css`
	:scope {
		display: flex;
		align-items: center;
		background: transparent;
		padding: 4px 10px 8px;
		min-width: 0;
		width: 100%;
		box-sizing: border-box;
	}
	.browser-omnibox-shell {
		display: flex;
		width: 100%;
		align-items: center;
		gap: 0.5em;
		min-width: 0;
		flex: 1;
	}
	.omnibox-nav {
		display: flex;
		align-items: center;
		gap: 0.1em;
	}
	.nav-btn {
		border: 0;
		background: transparent;
		color: var(--mw-mut, #9a9ab4);
		width: 2.1em;
		height: 2.1em;
		padding: 0;
		border-radius: 50%;
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		transition:
			background 0.25s,
			color 0.25s,
			transform 0.4s cubic-bezier(0.34, 1.5, 0.5, 1);
	}
	.nav-btn:hover {
		background: var(--mw-line, rgba(255, 255, 255, 0.1));
		color: var(--mw-fg, #ececf6);
	}
	.nav-btn:active {
		transform: scale(0.88);
	}
	.browser-omnibox-shell .material-symbols-outlined {
		font-size: 19px !important;
		line-height: 1 !important;
		font-variation-settings:
			"OPSZ" 20,
			"wght" 300,
			"FILL" 0,
			"GRAD" 0;
	}
	.url-wrap {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		position: relative;
		gap: 0;
	}
	.url-dot {
		position: static;
		flex: none;
		width: 9px;
		height: 9px;
		min-width: 9px;
		margin: 0 10px 0 15px;
		padding: 0;
		border: 0;
		border-radius: 50%;
		background: #ff453a;
		box-shadow: 0 0 0 3px rgba(255,69,58,.11), 0 0 12px rgba(255,69,58,.7);
		cursor: pointer;
		transition: background .25s, box-shadow .35s, transform .25s;
	}
	.url-dot:hover { transform: scale(1.18); }
	.url-dot.connected {
		background: #30d158;
		box-shadow: 0 0 0 3px rgba(48,209,88,.11), 0 0 13px rgba(48,209,88,.8);
	}
	.url-dot.connecting {
		background: #ffd60a;
		box-shadow: 0 0 0 3px rgba(255,214,10,.12), 0 0 13px rgba(255,214,10,.8);
		animation: mw-dot-pulse 1s ease-in-out infinite;
	}
	.url-dot.failed {
		background: #ff453a;
		box-shadow: 0 0 0 3px rgba(255,69,58,.11), 0 0 12px rgba(255,69,58,.7);
	}
	@keyframes mw-dot-pulse { 50% { opacity: .45; } }
	.url-input {
		box-sizing: border-box;
		flex: 1;
		min-width: 0;
		width: 100%;
		height: 2.5em;
		padding: 0 14px 0 0 !important;
		font-size: 0.9em;
		color: var(--mw-fg, #ececf6);
	}
	.url-input::placeholder {
		color: var(--mw-mut, #9a9ab4);
	}
`;

/* ---------- browser view: holds one iframe per tab ---------- */
const BrowserView: Component<
	{},
	{},
	{
		hostel: HTMLDivElement;
	}
> = function (cx) {
	cx.mount = async () => {
		updateWispDot();
		await controller.wait();
		const activeWisp = getActiveWispUrl(demoSettingsStore.wispUrl);
		if (activeWisp !== transportBoundWisp) transportReconnectNeeded = true;
		transportReconnectNeeded =
			transportReconnectNeeded ||
			getWispStatus(transportBoundWisp).state !== "connected";
		initTabs(this.hostel);
		const wait = () =>
			document.getElementById("mw-tabs")
				? renderStrip()
				: requestAnimationFrame(wait);
		wait();
	};

	return (
		<div class="tab-panel browser-view">
			<div class="mw-host" this={use(this.hostel)}></div>
		</div>
	);
};

BrowserView.style = css`
	:scope {
		flex: 1;
		width: 100%;
		min-width: 0;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}
	.mw-host {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}
`;

export default BrowserView;
