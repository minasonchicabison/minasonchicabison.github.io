// Turns dist-svg/index.svg.html (Vite output) into dist-svg/index.svg, the Lucide-style shell:
//   <svg><foreignObject><html xmlns=xhtml><head>..</head><body>..</body></html></foreignObject></svg>
// All other files (assets/, scramjet/, controller/, sw.js, icon.png) stay as sibling files.
// Usage (from packages/demo):  node scripts/make-svg.mjs [dist-svg]
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const dir = path.resolve(process.argv[2] || "dist-svg");
const htmlPath = path.join(dir, "index.svg.html");
if (!fs.existsSync(htmlPath)) {
	console.error("Missing " + htmlPath + ". Run the vite build first.");
	process.exit(1);
}
const html = fs.readFileSync(htmlPath, "utf8");

const cdata = (s) => "<![CDATA[" + s.replace(/\]\]>/g, "]]]]><![CDATA[>") + "]]>";
const escAttr = (v) =>
	v.replace(/&(?!amp;|lt;|gt;|quot;|#\d+;|#x[0-9a-f]+;)/gi, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

function parseAttrs(src) {
	const out = [];
	const re = /([^\s=\/>"']+)(?:\s*=\s*("([^"]*)"|'([^']*)'|[^\s>"']+))?/g;
	let m;
	while ((m = re.exec(src))) {
		const name = m[1];
		let val = m[3] ?? m[4] ?? (m[2] ? m[2] : name); // boolean attr -> name="name"
		out.push([name, val]);
	}
	return out;
}
const attrStr = (attrs) => attrs.map(([k, v]) => " " + k + '="' + escAttr(v) + '"').join("");
const getAttr = (attrs, k) => (attrs.find(([n]) => n.toLowerCase() === k) || [])[1];

const headHtml = (html.match(/<head[^>]*>([\s\S]*?)<\/head>/i) || [])[1];
const bodyM = html.match(/<body([^>]*)>([\s\S]*?)<\/body>/i);
if (!headHtml || !bodyM) throw new Error("Could not find <head> and <body> in index.svg.html");
const bodyAttrs = parseAttrs(bodyM[1]);
const bodyInner = bodyM[2].replace(/<script[\s\S]*?<\/script>/gi, "").replace(/\s+/g, "");
if (bodyInner !== '<divid="app"></div>') {
	throw new Error("Unexpected <body> content (expected only <div id=\"app\"></div>): " + bodyInner.slice(0, 200));
}
const bodyScripts = [...bodyM[2].matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];

const parts = [];
let moduleSrc = null;
const tok = /<(script|style)\b([^>]*)>([\s\S]*?)<\/\1>|<(meta|link)\b([^>]*?)\/?>|<title>([\s\S]*?)<\/title>/gi;
function handleScript(attrsRaw, body) {
	const attrs = parseAttrs(attrsRaw);
	const src = getAttr(attrs, "src");
	const type = (getAttr(attrs, "type") || "").toLowerCase();
	if (type === "module") {
		if (!src) throw new Error("Inline module scripts are not supported");
		if (moduleSrc) throw new Error("More than one module entry script");
		moduleSrc = src;
		return;
	}
	if (src) parts.push("<script" + attrStr(attrs.filter(([k]) => k.toLowerCase() !== "crossorigin")) + "></script>");
	else parts.push("<script>" + cdata(body) + "</script>");
}
let m;
while ((m = tok.exec(headHtml))) {
	if (m[1]) {
		if (m[1].toLowerCase() === "style") parts.push("<style>" + cdata(m[3]) + "</style>");
		else handleScript(m[2], m[3]);
	} else if (m[4]) {
		const attrs = parseAttrs(m[5]);
		const rel = (getAttr(attrs, "rel") || "").toLowerCase();
		if (rel === "modulepreload") continue;
		parts.push("<" + m[4].toLowerCase() + attrStr(attrs) + "/>");
	} else if (m[6] !== undefined) {
		parts.push("<title>" + m[6].replace(/&/g, "&amp;").replace(/</g, "&lt;") + "</title>");
	}
}
for (const s of bodyScripts) handleScript(s[1], s[2]);
if (!moduleSrc) throw new Error("No <script type=\"module\"> entry found");

// Document redirect shim: app code (and the dreamland UI lib) uses document.head/body/documentElement
// and document.createElement as if this were an HTML page. Inside an SVG document they are not.
const shim = `(function(){
var NS="http://www.w3.org/1999/xhtml",d=document,def=Object.defineProperty;
var root=d.getElementsByTagName("foreignObject")[0].firstElementChild;
def(d,"head",{get:function(){return root.querySelector("head")},configurable:true});
def(d,"body",{get:function(){return root.querySelector("body")},configurable:true});
def(d,"documentElement",{get:function(){return root},configurable:true});
var ce=d.createElement.bind(d),cens=d.createElementNS.bind(d);
d.createElement=function(t,o){return typeof t==="string"?cens(NS,t,o):ce(t,o)};
d.createElementNS=function(ns,q,o){return cens(ns==null?NS:ns,q,o)};

// SVG is an XML document, but the app builds its settings panels with HTML
// strings. Parse those strings with the HTML parser, then import the resulting
// XHTML nodes into this document so void tags and text such as "Ice & Fire"
// do not throw XML SyntaxErrors.
var ep=Element.prototype,desc;
while(ep&&!desc){desc=Object.getOwnPropertyDescriptor(ep,"innerHTML");if(!desc)ep=Object.getPrototypeOf(ep);}
if(ep&&desc&&desc.configurable&&desc.get&&desc.set){
def(ep,"innerHTML",{
  configurable:true,
  enumerable:desc.enumerable,
  get:function(){return desc.get.call(this)},
  set:function(markup){
    if(this.namespaceURI!==NS){desc.set.call(this,markup);return;}
    var parsed=new DOMParser().parseFromString(String(markup),"text/html");
    while(this.firstChild)this.removeChild(this.firstChild);
    var nodes=parsed.body.childNodes;
    for(var i=0;i<nodes.length;i++)this.appendChild(d.importNode(nodes[i],true));
  }
});
}
})();`;
const base = `html,body{margin:0;width:100%;height:100%;overflow:hidden}foreignObject{overflow:visible}`;
const entry =
	`import(${JSON.stringify(moduleSrc)}).catch(function(e){console.error(e);` +
	`var b=document.body;if(b)b.textContent="Failed to load Minason Web v2: "+(e&&e.message||e)});`;

const svg =
	`<?xml version="1.0" encoding="UTF-8"?>\n` +
	`<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">\n` +
	`<foreignObject width="100%" height="100%">\n` +
	`<html xmlns="http://www.w3.org/1999/xhtml" lang="en">\n<head>\n` +
	`<script>${cdata(shim)}</script>\n<style>${cdata(base)}</style>\n` +
	parts.join("\n") +
	`\n<script>${cdata(entry)}</script>\n</head>\n` +
	`<body${attrStr(bodyAttrs)}><div id="app"></div></body>\n</html>\n</foreignObject>\n</svg>\n`;

const outPath = path.join(dir, "index.svg");
fs.writeFileSync(outPath, svg);
fs.rmSync(htmlPath);
console.log("wrote " + outPath + " (" + svg.length + " bytes)");

// ---- checks ----
const x = spawnSync("xmllint", ["--noout", outPath], { encoding: "utf8" });
if (x.error) console.log("CHECK xmllint not installed: well-formedness NOT checked");
else if (x.status === 0) console.log("CHECK index.svg is well-formed XML");
else { console.error("CHECK index.svg is NOT well-formed:\n" + x.stderr); process.exitCode = 1; }

const need = ["sw.js", "scramjet/scramjet.js", "scramjet/scramjet.wasm", "controller/controller.api.js", "controller/controller.sw.js", "controller/controller.inject.js"];
for (const f of need) if (!fs.existsSync(path.join(dir, f))) { console.error("CHECK MISSING " + f); process.exitCode = 1; }

const leftovers = [/["'`]\/scramjet\//, /["'`]\/controller\//, /["'`]\/sw\.js/, /["'`]\/icon\.png/, /["'`]\/~\/sj\//];
const assetsDir = path.join(dir, "assets");
if (fs.existsSync(assetsDir))
	for (const f of fs.readdirSync(assetsDir).filter((n) => /\.(js|css)$/.test(n))) {
		const t = fs.readFileSync(path.join(assetsDir, f), "utf8");
		for (const re of leftovers) if (re.test(t)) console.warn("CHECK origin-absolute path " + re + " still present in assets/" + f);
	}

let total = 0;
(function walk(d) {
	for (const e of fs.readdirSync(d, { withFileTypes: true })) {
		const p = path.join(d, e.name);
		if (e.isDirectory()) walk(p);
		else {
			const s = fs.statSync(p).size;
			total += s;
			console.log(String(s).padStart(10) + "  " + path.relative(dir, p) + (s > 20e6 ? "   <-- over 20 MB (jsDelivr GitHub limit, from memory, unverified)" : ""));
		}
	}
})(dir);
console.log("total " + (total / 1e6).toFixed(2) + " MB");
