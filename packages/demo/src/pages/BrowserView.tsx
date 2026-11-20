import { css, type Component, createState } from "dreamland/core";
import {
	CatchEscapedLinksPlugin,
	UrlWatcherPlugin,
} from "@mercuryworkshop/scramjet-utils";
import { cachePlugin, controller } from "..";
import homepage from "./homepage.html?raw";
import type { Frame } from "@mercuryworkshop/scramjet-controller";

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

/* ---------- live data for the dynamic island ---------- */
// Read here (the homepage iframe is a data: URL and can't) and posted in.
const svc = {
	bat: null as null | { level: number; charging: boolean },
	wx: null as null | Record<string, unknown>,
	started: false,
};

async function startServices() {
	if (svc.started) return;
	svc.started = true;
	try {
		const b = await (navigator as any).getBattery?.();
		if (b) {
			const update = () => {
				svc.bat = { level: Math.round(b.level * 100), charging: !!b.charging };
				pushAll();
			};
			update();
			b.addEventListener("levelchange", update);
			b.addEventListener("chargingchange", update);
		}
	} catch {}

	let loc: { latitude: number; longitude: number; city?: string } | null = null;
	const loadWeather = async () => {
		try {
			loc ??= await (await fetch("https://ipapi.co/json/")).json();
			const f = /^en-US/i.test(navigator.language);
			const r = await (
				await fetch(
					`https://api.open-meteo.com/v1/forecast?latitude=${loc!.latitude}&longitude=${loc!.longitude}&current=temperature_2m,weather_code,is_day&temperature_unit=${f ? "fahrenheit" : "celsius"}`
				)
			).json();
			svc.wx = {
				temp: Math.round(r.current.temperature_2m),
				code: r.current.weather_code,
				day: !!r.current.is_day,
				city: loc!.city ?? "",
			};
			pushAll();
		} catch {}
	};
	loadWeather();
	setInterval(loadWeather, 15 * 60 * 1000);
}

const themeVars = (): Record<string, string> =>
	(window as any).mwTheme?.vars() ?? {};

const buildHomeSrc = () => {
	const vars = Object.entries(themeVars())
		.map(([k, v]) => `${k}:${v}`)
		.join(";");
	const html = homepage.replace("/*VARS*/", `:root{${vars}}`);
	let bin = "";
	new TextEncoder().encode(html).forEach((c) => (bin += String.fromCharCode(c)));
	return `data:text/html;charset=utf-8;base64,${btoa(bin)}`;
};

/* ---------- tabs ---------- */
type Tab = {
	id: number;
	url: string;
	title: string;
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
		{ type: "mw-state", vars: themeVars(), bat: svc.bat, wx: svc.wx, bm: loadBm() },
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
			'<i class="mwt-dot"></i><span class="mwt-title"></span><button type="button" class="mwt-x" aria-label="Close tab">\u00d7</button>';
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
	const t = { id: nextId++, url: "", title: "New tab", iframe } as Tab;
	const urlWatcher = new UrlWatcherPlugin((url) => {
		t.url = url.startsWith("data:") ? "" : url;
		t.title = tabTitleFor(t.url);
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

/* ---------- settings popover: theme + search engine only ---------- */
const SETTINGS_CSS = `
.mws{position:fixed;top:96px;right:12px;z-index:2147483000;width:292px;padding:16px;border-radius:26px;border:1px solid rgba(255,255,255,.14);background:rgba(28,28,44,.55);backdrop-filter:blur(34px) saturate(190%);-webkit-backdrop-filter:blur(34px) saturate(190%);box-shadow:inset 0 1px 0 rgba(255,255,255,.18),0 28px 70px rgba(0,0,0,.55);color:#ececf6;font:500 13px "Manrope Variable",Manrope,system-ui,sans-serif;transform-origin:top right;animation:mwsin .5s cubic-bezier(.34,1.5,.5,1)}
@keyframes mwsin{from{transform:scale(.6) translateY(-12px);opacity:0}}
.mws h3{margin:0 0 10px;font-size:12px;font-weight:700;color:#9a9ab4;letter-spacing:.02em}
.mws section+section{margin-top:18px}
.mws .g{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.mws button{display:flex;align-items:center;gap:9px;padding:9px 11px;border-radius:16px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.055);color:inherit;font:600 12.5px inherit;font-family:inherit;cursor:pointer;text-align:left;transition:transform .4s cubic-bezier(.34,1.5,.5,1),background .25s,border-color .25s}
.mws button:hover{background:rgba(255,255,255,.1);transform:translateY(-1px)}
.mws button.on{border-color:var(--mw-accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--mw-accent) 35%,transparent)}
.mws .d{width:20px;height:20px;border-radius:50%;flex:none;box-shadow:inset 0 1px 1px rgba(255,255,255,.5),0 2px 8px rgba(0,0,0,.35)}
.mws .row{display:flex;flex-direction:column;gap:8px}
.mws .foot{margin-top:16px;font-size:11.5px;color:#9a9ab4;text-align:center}
`;

let pop: HTMLDivElement | null = null;
function closeSettings() {
	pop?.remove();
	pop = null;
}
function toggleSettings(ev?: Event) {
	ev?.stopPropagation();
	if (pop) return closeSettings();
	if (!document.getElementById("mws-css")) {
		const s = document.createElement("style");
		s.id = "mws-css";
		s.textContent = SETTINGS_CSS;
		document.head.appendChild(s);
	}
	const T = (window as any).mwTheme;
	const el = document.createElement("div");
	el.className = "mws";
	el.innerHTML =
		`<section><h3>Theme</h3><div class="g">` +
		Object.keys(T?.presets ?? {})
			.map(
				(id) =>
					`<button data-theme="${id}"><span class="d" style="background:linear-gradient(135deg,${T.presets[id].g1},${T.presets[id].g2})"></span>${T.presets[id].n}</button>`
			)
			.join("") +
		`</div></section><section><h3>Search engine</h3><div class="row">` +
		Object.keys(ENGINES)
			.map((k) => `<button data-engine="${k}">${ENGINES[k].n}</button>`)
			.join("") +
		`</div></section><div class="foot">minason web v2</div>`;
	const mark = () =>
		el.querySelectorAll<HTMLElement>("button").forEach((b) =>
			b.classList.toggle(
				"on",
				b.dataset.theme === T?.current || b.dataset.engine === engine()
			)
		);
	el.onclick = (e) => {
		const b = (e.target as HTMLElement).closest("button");
		if (!b) return;
		if (b.dataset.theme) T?.set(b.dataset.theme);
		if (b.dataset.engine) ls.set("mw-engine", b.dataset.engine);
		mark();
	};
	mark();
	document.body.appendChild(el);
	pop = el;
	setTimeout(
		() =>
			document.addEventListener(
				"click",
				(e) => {
					if (pop && !pop.contains(e.target as Node)) closeSettings();
				},
				{ once: true }
			),
		0
	);
}

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
					<span class="url-dot"></span>
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
	}
	.url-dot {
		position: absolute;
		left: 14px;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: #30d158;
		box-shadow: 0 0 10px #30d158;
		pointer-events: none;
	}
	.url-input {
		box-sizing: border-box;
		width: 100%;
		height: 2.5em;
		padding: 0 14px 0 34px !important;
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
		await controller.wait();
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
