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
		height: 100vh;
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
	}
	.tab-bar {
		display: flex;
		align-items: center;
	}
`;
export default App;
