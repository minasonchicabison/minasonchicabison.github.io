import { createStore } from "dreamland/core";

export type AvailableTransports = "libcurl" | "epoxy";

// Tried in order; the first one that answers is used. Add your own servers here.
export const WISP_URLS = [
	"wss://byod.abstracteducation.loan/stream/534141f4509ce83f5bd805d11df1d7ce5d30a6679fd4c27dbf28fc7c2fb4a710/",
	"wss://artemata.it/stream/534141f4509ce83f5bd805d11df1d7ce5d30a6679fd4c27dbf28fc7c2fb4a710/",
];

// Libcurl is the default engine; Epoxy remains available as an alternate.
export const demoSettingsStore = createStore(
	{
		transport: "libcurl" as AvailableTransports,
		wispUrl: WISP_URLS[0],
	},
	{
		ident: "minason-web-v2-settings",
		backing: "localstorage",
		autosave: "auto",
	}
);
