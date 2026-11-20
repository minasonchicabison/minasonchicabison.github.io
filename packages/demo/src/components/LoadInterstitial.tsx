import { css, type Component } from "dreamland/core";
const LoadInterstitial: Component<{
	status: string;
}> = function () {
	return (
		<dialog class="signin">
			<h1>minason web</h1>
			<p>{use(this.status)}</p>
		</dialog>
	);
};

LoadInterstitial.style = css`
	:scope {
		width: min(420px, 84vw);
		padding: 28px 24px;
		border: 1px solid rgba(255, 255, 255, 0.14);
		border-radius: 28px;
		text-align: center;
		color: #ececf6;
		background: rgba(24, 24, 40, 0.6);
		backdrop-filter: blur(30px) saturate(190%);
		-webkit-backdrop-filter: blur(30px) saturate(190%);
		box-shadow:
			inset 0 1px 0 rgba(255, 255, 255, 0.16),
			0 28px 70px rgba(0, 0, 0, 0.55);
		font-family: "Manrope Variable", Manrope, system-ui, sans-serif;
	}
	h1 {
		margin: 0 0 8px;
		font-weight: 300;
		font-size: 2em;
		letter-spacing: -0.04em;
	}
	p {
		margin: 0;
		font-size: 0.85em;
		color: #9a9ab4;
	}
	:modal[open] {
		animation: fade 0.4s ease normal;
	}
	:modal::backdrop {
		background: rgba(8, 8, 16, 0.55);
		backdrop-filter: blur(6px);
	}
`;

export default LoadInterstitial;
