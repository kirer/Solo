/**
 * 内置浏览器：盖在聊天上的一整张页，看消息里点到的东西。
 *
 * 为什么要有：模型答问题时贴的链接，点一下就跳去系统浏览器，回来还得自己找位置。
 * 这里开一个能关的页 —— 地址栏可改、可刷新、随时能交回系统浏览器。
 *
 * 两条边界：
 * - **站内不进来**：Solo 自己的地址不给内嵌（同源页面嵌进来能碰到宿主），直接提示。
 * - **内嵌是站点给的**：`X-Frame-Options` / `frame-ancestors` 拒绝内嵌的站点只会白屏，
 *   所以「系统浏览器」那颗键一直在，不用等人发现。
 */
import { useEffect, useState } from "react";
import { closeBrowser } from "../state/store.ts";

/** 能不能内嵌：Solo 自己不行（同源 + `allow-same-origin` 等于没沙箱）。 */
function embeddableUrl(url: string): boolean {
	try {
		return new URL(url).origin !== location.origin;
	} catch {
		return false;
	}
}

export function Browser(props: { readonly url: string }): JSX.Element {
	const [draft, setDraft] = useState(props.url);
	const [loaded, setLoaded] = useState(props.url);
	const [nonce, setNonce] = useState(0);

	useEffect(() => {
		setDraft(props.url);
		setLoaded(props.url);
	}, [props.url]);

	const embeddable = embeddableUrl(loaded);

	function go(url: string): void {
		const trimmed = url.trim();
		if (trimmed === "") return;
		const next = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
		setDraft(next);
		setLoaded(next);
	}

	return (
		<div className="overlay browser-veil" role="dialog" aria-label="内置浏览器">
			<section className="browser">
				<header className="browser-head">
					<button type="button" className="browser-icon" aria-label="关掉" title="关掉" onClick={closeBrowser}>
						<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
							<path d="M15 6l-6 6 6 6" />
						</svg>
					</button>
					<form
						className="browser-addr"
						onSubmit={(event) => {
							event.preventDefault();
							go(draft);
						}}
					>
						<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
							<circle cx="12" cy="12" r="8.5" />
							<path d="M3.5 12h17M12 3.5c2.4 2.4 3.6 5.3 3.6 8.5S14.4 18.1 12 20.5c-2.4-2.4-3.6-5.3-3.6-8.5S9.6 5.9 12 3.5Z" />
						</svg>
						<input
							value={draft}
							onChange={(event) => setDraft(event.target.value)}
							spellCheck={false}
							autoCapitalize="off"
							autoCorrect="off"
							aria-label="地址"
						/>
					</form>
					<button
						type="button"
						className="browser-icon"
						aria-label="刷新"
						title="刷新"
						onClick={() => setNonce((n) => n + 1)}
					>
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
							<path d="M19 12a7 7 0 1 1-2.1-5" />
							<path d="M19.5 4.5V9H15" />
						</svg>
					</button>
					<button
						type="button"
						className="browser-out"
						onClick={() => window.open(loaded, "_blank", "noopener,noreferrer")}
						title="交回系统浏览器"
					>
						系统浏览器
					</button>
				</header>
				{embeddable ? (
					<iframe
						key={nonce}
						className="browser-frame"
						src={loaded}
						title={loaded}
						referrerPolicy="no-referrer"
						sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
					/>
				) : (
					<p className="browser-blocked">Solo 自己的页面不能内嵌。要在这里看，请点「系统浏览器」。</p>
				)}
			</section>
		</div>
	);
}
