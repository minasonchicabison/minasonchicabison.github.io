import {
	css,
	type Delegate,
	type Component,
	createState,
} from "dreamland/core";
import {
	CatchEscapedLinksPlugin,
	UrlWatcherPlugin,
} from "@mercuryworkshop/scramjet-utils";
import { versionInfo } from "@mercuryworkshop/scramjet";
import { cachePlugin, controller } from "..";
import { demoSettingsStore, normalizeHomeUrl } from "../store";
import homepage from "./homepage.html?raw";
import type { Frame } from "@mercuryworkshop/scramjet-controller";

export const browserState = createState({
	url: demoSettingsStore.homeUrl,
	title: "New tab",
	frame: null! as Frame,
});

/** Omnibox home button calls this; BrowserView wires it up on mount. */
export const home = { go: () => {} };

/* ---------- tab names ---------- */
// hostname -> custom tab name. Add more here.
const TAB_NAMES: Record<string, string> = {
	"cdn.jsdelivr.net": "jsDelivr CDN",
	"jsdelivr.com": "jsDelivr",
	"www.jsdelivr.com": "jsDelivr",
};

/** Use this wherever your tab strip needs a label for a url. */
export function tabTitleFor(url: string, rawTitle?: string): string {
	if (!url || url.startsWith("data:")) return "New tab";
	try {
		const host = new URL(url).hostname;
		return TAB_NAMES[host] ?? (rawTitle || host.replace(/^www\./, ""));
	} catch {
		return rawTitle || "New tab";
	}
}

/* ---------- live data for the dynamic island ---------- */
// Battery and weather are read here (the homepage iframe is a data: URL, so it
// can't call these APIs itself) and are posted into it.
const svc = {
	bat: null as null | { level: number; charging: boolean },
	wx: null as null | Record<string, unknown>,
	listeners: new Set<() => void>(),
	started: false,
};
const emit = () => svc.listeners.forEach((f) => f());

async function startServices() {
	if (svc.started) return;
	svc.started = true;
	try {
		const b = await (navigator as any).getBattery?.();
		if (b) {
			const update = () => {
				svc.bat = { level: Math.round(b.level * 100), charging: !!b.charging };
				emit();
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
			emit();
		} catch {}
	};
	loadWeather();
	setInterval(loadWeather, 15 * 60 * 1000);
}

const themeVars = (): Record<string, string> =>
	(window as any).mwTheme?.vars() ?? {};

/* ---------- homepage enhancement (injected into homepage.html) ---------- */
const HOME_CSS = String.raw`
html{background:var(--mw-bg)!important;background-image:radial-gradient(60vmax 42vmax at 50% 38%,color-mix(in srgb,var(--mw-g1) 22%,transparent),transparent),radial-gradient(55vmax 42vmax at 106% 112%,color-mix(in srgb,var(--mw-g2) 28%,transparent),transparent)!important;background-attachment:fixed!important}
body{background:transparent!important}
#mwg{position:fixed;inset:0;width:100%;height:100%;z-index:-1;pointer-events:none}
#mwi{position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483000;width:150px;height:38px;overflow:hidden;cursor:pointer;background:#000;color:#fff;border-radius:20px;font:600 13px/1 "Manrope Variable",Manrope,system-ui,sans-serif;box-shadow:0 0 0 1px rgba(255,255,255,.08),0 12px 40px rgba(0,0,0,.55),0 0 38px -10px var(--mw-accent);transition:width .65s cubic-bezier(.34,1.45,.5,1),height .65s cubic-bezier(.34,1.45,.5,1),border-radius .55s cubic-bezier(.34,1.3,.5,1);user-select:none}
.ly{position:absolute;left:50%;top:50%;display:flex;align-items:center;white-space:nowrap;opacity:0;filter:blur(9px);transform:translate(-50%,-50%) scale(.82);transition:opacity .3s,filter .4s,transform .55s cubic-bezier(.34,1.4,.5,1);pointer-events:none}
.ly.on{opacity:1;filter:none;transform:translate(-50%,-50%)}
#mwc{gap:13px;padding:10px 16px}
#mwe{gap:26px;padding:18px 28px}
.mwr{display:flex;align-items:center;gap:6px}
.mwc{display:flex;flex-direction:column;gap:5px}
.mwc small{font-size:11.5px;font-weight:500;color:#a1a1b5}
.mwc b.big{font-size:26px;font-weight:700;letter-spacing:-.03em}
.mwc b.mid{font-size:22px;font-weight:700;letter-spacing:-.02em}
@media (prefers-reduced-motion:reduce){#mwi,.ly{transition-duration:.01ms!important}}
`;

const HOME_HTML = String.raw`
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fontsource-variable/manrope@5/index.css">
<canvas id="mwg"></canvas>
<div id="mwi" role="status" aria-live="polite">
<div id="mwc" class="ly on"><b id="ct"></b><span id="cw" class="mwr"></span><span id="cb" class="mwr"></span></div>
<div id="mwe" class="ly"><div class="mwc"><b class="big" id="et"></b><small id="ed"></small></div><div class="mwc" id="ew"></div><div class="mwc" id="eb"></div></div>
</div>
`;

const HOME_JS = String.raw`
(function(){
var $=function(i){return document.getElementById(i)};
/* v1 -> v2 badge */
Array.prototype.forEach.call(document.querySelectorAll("body *"),function(e){if(!e.children.length&&e.textContent.trim()==="v1")e.textContent="v2"});
function hex(h){h=(h||"").trim().replace("#","");if(h.length!==6)return[143,124,255];return[parseInt(h.substr(0,2),16),parseInt(h.substr(2,2),16),parseInt(h.substr(4,2),16)]}
var S={bat:null,wx:null},rgb=hex(getComputedStyle(document.documentElement).getPropertyValue("--mw-accent")),prevCh=null;

/* ---------- reactive dotted grid ---------- */
var c=$("mwg"),x=c.getContext("2d"),W,H,D=[],G=26,R=140,mx=-999,my=-999,ws=[];
function size(){var r=Math.min(devicePixelRatio||1,2);W=innerWidth;H=innerHeight;c.width=W*r;c.height=H*r;x.setTransform(r,0,0,r,0,0);D=[];for(var j=G/2;j<H;j+=G)for(var i=G/2;i<W;i+=G)D.push({hx:i,hy:j,x:i,y:j,vx:0,vy:0})}
addEventListener("resize",size);size();
addEventListener("mousemove",function(e){mx=e.clientX;my=e.clientY});
document.addEventListener("mouseleave",function(){mx=my=-999});
addEventListener("pointerdown",function(e){ws.push({x:e.clientX,y:e.clientY,t:performance.now()})});
function loop(t){
x.clearRect(0,0,W,H);
ws=ws.filter(function(w){return t-w.t<1400});
var cs="rgb("+rgb[0]+","+rgb[1]+","+rgb[2]+")";
for(var i=0;i<D.length;i++){
var d=D[i],ox=d.hx,oy=d.hy+Math.sin(t/1600+d.hx*.012+d.hy*.01)*1.6;
var dx=d.x-mx,dy=d.y-my,q=Math.sqrt(dx*dx+dy*dy)||1,f=0;
if(q<R){f=1-q/R;var p=f*f*2.4;d.vx+=dx/q*p;d.vy+=dy/q*p}
for(var k=0;k<ws.length;k++){var w=ws[k],a=t-w.t,r=a*.45,ex=d.hx-w.x,ey=d.hy-w.y,ed=Math.sqrt(ex*ex+ey*ey),gap=Math.abs(ed-r);
if(gap<46){var s=(1-gap/46)*(1-a/1400)*3.2;d.vx+=ex/(ed||1)*s;d.vy+=ey/(ed||1)*s;f=Math.max(f,s/4)}}
d.vx+=(ox-d.x)*.07;d.vy+=(oy-d.y)*.07;d.vx*=.84;d.vy*=.84;d.x+=d.vx;d.y+=d.vy;
var g=Math.max(f,Math.min(1,Math.sqrt((d.x-d.hx)*(d.x-d.hx)+(d.y-d.hy)*(d.y-d.hy))/14));
x.globalAlpha=.2+g*.75;x.fillStyle=g>.04?cs:"#c8c8e6";
x.beginPath();x.arc(d.x,d.y,(1.1+g*2.2)/2+.4,0,6.283);x.fill()}
requestAnimationFrame(loop)}
requestAnimationFrame(loop);

/* ---------- dynamic island ---------- */
var I=$("mwi"),C=$("mwc"),E=$("mwe"),open=false,pinned=false,hover=false,flash=0;
function kind(c){if(c===0)return"clear";if(c<4)return"cloud";if(c<50)return"fog";if(c<70||(c>=80&&c<83))return"rain";if(c<80||c===85||c===86)return"snow";return"storm"}
var NAMES={clear:"Clear",cloud:"Cloudy",fog:"Fog",rain:"Rain",snow:"Snow",storm:"Storm"};
function ic(w,s){var k=kind(w.code),cl='<path d="M7 18a4 4 0 0 1-.6-8A5.5 5.5 0 0 1 17 11.3 3.4 3.4 0 0 1 17 18z" fill="#cbd5e1"/>',b;
if(k==="clear")b=w.day?'<circle cx="12" cy="12" r="4.5" fill="#fbbf24"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" stroke="#fbbf24" stroke-width="1.7" stroke-linecap="round"/>':'<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" fill="#c7d2fe"/>';
else if(k==="cloud")b=cl;
else if(k==="fog")b=cl+'<path d="M6 20.5h12" stroke="#94a3b8" stroke-width="1.7" stroke-linecap="round"/>';
else if(k==="rain")b=cl+'<path d="M8 19.5l-1 2.5M12 19.5l-1 2.5M16 19.5l-1 2.5" stroke="#60a5fa" stroke-width="1.7" stroke-linecap="round"/>';
else if(k==="snow")b=cl+'<circle cx="8" cy="21" r="1.1" fill="#e0f2fe"/><circle cx="12" cy="21" r="1.1" fill="#e0f2fe"/><circle cx="16" cy="21" r="1.1" fill="#e0f2fe"/>';
else b=cl+'<path d="M12.5 17.5 10 21h2.6l-.8 2.5" stroke="#facc15" stroke-width="1.7" fill="none" stroke-linecap="round" stroke-linejoin="round"/>';
return'<svg width="'+s+'" height="'+s+'" viewBox="0 0 24 24">'+b+'</svg>'}
function bt(b,s){var col=b.charging?"#30d158":b.level<=20?"#ff453a":"#fff",fw=18*b.level/100;
return'<svg width="'+25*s+'" height="'+12*s+'" viewBox="0 0 25 12"><rect x=".5" y=".5" width="21" height="11" rx="3.5" fill="none" stroke="#fff" opacity=".4"/><rect x="2" y="2" width="'+fw+'" height="8" rx="2" fill="'+col+'"/><rect x="23" y="4" width="1.8" height="4" rx=".9" fill="#fff" opacity=".4"/>'+(b.charging?'<path d="M12.6 1.8 8.4 6.5h2.7l-.7 3.7 4.2-4.8h-2.7z" fill="#fff" stroke="#000" stroke-width=".5" stroke-linejoin="round"/>':'')+'</svg>'}
function fit(){var l=open?E:C;I.style.width=l.offsetWidth+"px";I.style.height=l.offsetHeight+"px";I.style.borderRadius=open?"34px":"20px"}
function setOpen(o){open=o;C.classList.toggle("on",!o);E.classList.toggle("on",o);fit()}
function tick(){var n=new Date();$("ct").textContent=n.toLocaleTimeString([],{hour:"numeric",minute:"2-digit"});$("et").textContent=$("ct").textContent;$("ed").textContent=n.toLocaleDateString([],{weekday:"long",month:"long",day:"numeric"})}
function render(){var w=S.wx,b=S.bat;
$("cw").innerHTML=w?ic(w,17)+"<b>"+w.temp+"\u00b0</b>":"";
$("cb").innerHTML=b?"<b>"+b.level+"%</b>"+bt(b,1):"";
$("ew").innerHTML=w?'<div class="mwr">'+ic(w,34)+'<div class="mwc"><b class="mid">'+w.temp+"\u00b0</b><small>"+NAMES[kind(w.code)]+(w.city?" - "+w.city:"")+"</small></div></div>":"";
$("eb").innerHTML=b?'<div class="mwr">'+bt(b,1.5)+'<div class="mwc"><b class="mid">'+b.level+"%</b><small>"+(b.charging?"Charging":"On battery")+"</small></div></div>":"";
tick();fit();
if(b&&prevCh!==null&&prevCh!==b.charging){clearTimeout(flash);setOpen(true);flash=setTimeout(function(){flash=0;if(!pinned&&!hover)setOpen(false)},3200)}
if(b)prevCh=b.charging}
setInterval(tick,1000);tick();
I.addEventListener("mouseenter",function(){hover=true;setOpen(true)});
I.addEventListener("mouseleave",function(){hover=false;if(!pinned&&!flash)setOpen(false)});
I.addEventListener("click",function(){pinned=!pinned;setOpen(pinned||hover)});
if(document.fonts&&document.fonts.ready)document.fonts.ready.then(fit);
fit();

/* ---------- messages from the shell ---------- */
addEventListener("message",function(e){var d=e.data;if(!d||d.type!=="mw-state")return;
if(d.vars){for(var k in d.vars)document.documentElement.style.setProperty(k,d.vars[k]);rgb=hex(d.vars["--mw-accent"])}
S.bat=d.bat;S.wx=d.wx;render()});
parent.postMessage({type:"mw-ready"},"*");
})();
`;

const enhanceHome = (html: string) => {
	const vars = Object.entries(themeVars())
		.map(([k, v]) => `${k}:${v}`)
		.join(";");
	const inject =
		`<style>:root{${vars}}${HOME_CSS}</style>` +
		HOME_HTML +
		"<script>" +
		HOME_JS +
		"<\/script>";
	return /<\/body>/i.test(html)
		? html.replace(/<\/body>/i, () => inject + "</body>")
		: html + inject;
};

const toDataUrl = (html: string) => {
	let bin = "";
	new TextEncoder().encode(html).forEach((c) => (bin += String.fromCharCode(c)));
	return `data:text/html;charset=utf-8;base64,${btoa(bin)}`;
};

const buildHomeSrc = () => {
	let h = homepage;
	h = h.replaceAll("{{SCRAMJET_VERSION}}", String(versionInfo.version));
	h = h.replaceAll("{{SCRAMJET_BUILD}}", String(versionInfo.build));
	h = h.replaceAll(
		"{{SCRAMJET_DATE_PRETTY}}",
		new Date(versionInfo.date).toLocaleString(undefined, {
			dateStyle: "short",
			timeStyle: "short",
		})
	);
	return toDataUrl(enhanceHome(h));
};

/* ---------- omnibox ---------- */
export const Omnibox: Component = function (cx) {
	const navigate = () => {
		let url: string;
		try {
			url = normalizeHomeUrl(browserState.url);
		} catch (e) {
			console.error("navigate failed:", e);
			return;
		}
		browserState.url = url;
		demoSettingsStore.homeUrl = browserState.url;
		browserState.frame?.go(browserState.url);
	};
	return (
		<form
			class="url-form"
			on:submit={(e: SubmitEvent) => {
				e.preventDefault();
				navigate();
			}}
		>
			<div class="browser-omnibox-shell">
				<div class="omnibox-nav">
					<button
						type="button"
						class="nav-btn"
						aria-label="Back"
						on:click={() => browserState.frame?.back()}
					>
						<span class="material-symbols-outlined">arrow_back</span>
					</button>
					<button
						type="button"
						class="nav-btn"
						aria-label="Forward"
						on:click={() => browserState.frame?.forward()}
					>
						<span class="material-symbols-outlined">arrow_forward</span>
					</button>
					<button
						type="button"
						class="nav-btn"
						aria-label="Reload"
						on:click={() => browserState.frame?.reload()}
					>
						<span class="material-symbols-outlined">refresh</span>
					</button>
					<button
						type="button"
						class="nav-btn"
						aria-label="Home"
						on:click={() => home.go()}
					>
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
						on:input={(e: Event) =>
							(browserState.url = (e.target as HTMLInputElement).value)
						}
						spellcheck="false"
						placeholder="Search or enter address"
					/>
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
		padding: 6px 10px 8px;
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

/* ---------- browser view ---------- */
const BrowserView: Component<
	{
		active: boolean;
	},
	{},
	{
		frameel: HTMLIFrameElement;
	}
> = function (cx) {
	cx.mount = async () => {
		await controller.wait();

		let urlWatcher = new UrlWatcherPlugin((url) => {
			browserState.url = url;
			browserState.title = tabTitleFor(url);
			document.title = `${browserState.title} - Minason Web`;
		});
		let catchEscapedLinks = new CatchEscapedLinksPlugin(
			(url) =>
				new URL(`/?goto=${encodeURIComponent(url.href)}`, location.origin)
		);
		browserState.frame = controller.createFrame(this.frameel, {
			plugins: [cachePlugin, urlWatcher, catchEscapedLinks],
		});

		// push theme + battery + weather into the homepage island/grid
		const push = () =>
			this.frameel.contentWindow?.postMessage(
				{ type: "mw-state", vars: themeVars(), bat: svc.bat, wx: svc.wx },
				"*"
			);
		svc.listeners.add(push);
		window.addEventListener("mw-theme", push);
		window.addEventListener("message", (e) => {
			if (
				e.source === this.frameel.contentWindow &&
				e.data?.type === "mw-ready"
			)
				push();
		});
		this.frameel.addEventListener("load", push);
		startServices();

		home.go = () => {
			browserState.url = "";
			browserState.title = "New tab";
			document.title = "Minason Web v2";
			this.frameel.src = buildHomeSrc();
		};
		this.frameel.src = buildHomeSrc();

		let goto = new URL(location.href).searchParams.get("goto");
		if (goto) {
			browserState.frame?.go(goto);
			history.replaceState(null, "", location.href.split("?")[0]);
		}
	};

	return (
		<div
			class={use(this.active).map(
				(active) => `tab-panel browser-view ${active ? "active" : ""}`
			)}
		>
			<iframe this={use(this.frameel)}></iframe>
		</div>
	);
};

BrowserView.style = css`
	:scope {
		flex: 1;
		width: 100%;
		min-width: 0;
		min-height: 0;
		display: none;
		flex-direction: column;
	}
	:scope.active {
		display: flex;
	}

	iframe {
		background: transparent;
		flex: 1;
		border: none;
	}
`;

export default BrowserView;
