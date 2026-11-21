import { css, type Component } from "dreamland/core";
import BrowserView, { Omnibox } from "./pages/BrowserView";

const App: Component = function () {
	return (
		<div>
			<div class="top-bar">
				{/* row 1: tabs (filled in by BrowserView) */}
				<div class="tab-bar">
					<div id="mw-tabs"></div>
				</div>
				{/* row 2: nav + address + actions */}
				<Omnibox />
			</div>
			<BrowserView />
		</div>
	);
};

App.style = css`
	@import url("https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20,400,0,0");

	:scope {
		width: 100vw;
		width: 100%;
		height: 100vh;
		height: 100dvh;
		min-width: 0;
		min-height: 0;
		display: flex;
		flex-direction: column;
		margin: 0;
		overflow: hidden;
		position: absolute;
		top: 0;
		left: 0;
		padding: 0;
		background: transparent;
		box-sizing: border-box;
	}
	.material-symbols-outlined {
		font-family: "Material Symbols Outlined";
		font-weight: normal;
		font-style: normal;
		font-size: 11px;
		line-height: 1;
		letter-spacing: normal;
		text-transform: none;
		display: inline-block;
		white-space: nowrap;
		word-wrap: normal;
		direction: ltr;
		-webkit-font-smoothing: antialiased;
	}
	.top-bar {
		display: flex;
		flex-direction: column;
		align-items: stretch;
		flex: none;
		width: 100%;
		min-width: 0;
	}
	.tab-bar {
		display: flex;
		align-items: center;
		width: 100%;
		min-width: 0;
		overflow: hidden;
	}
	@media (max-width: 760px) {
		.top-bar { gap: 2px; }
		.tab-bar { min-height: 30px; }
	}
	@media (max-height: 640px) {
		.top-bar { gap: 1px; }
	}
`;
export default App;
