/**
 * 工作台：和对话并排的一整列，上面一排标签页（`dock` 插槽）。
 *
 * 形状照 agent harness 的右栏：**文件树和文件内容各是一页**，不是左右分栏 ——
 * 点一个文件就多一个标签页，点「+」是开始页（工作区文件 / 浏览器），
 * 正文里点到的外链也开成一个浏览器页签。
 *
 * 只读。工作区由后端按当前频道算好（私聊 → 那个人的，团队频道 → 团队的），
 * 这里只请求 `/api/p/files/tree` 与 `/api/p/files/preview`。
 *
 * 预览一律安全：markdown 走宿主那套「先转义再拼」的渲染器；HTML 进 `sandbox=""`
 * 的 iframe（连脚本都不给跑，也拿不到当前页的同源）；图片是 data URL（发不出请求，
 * 也带不上 cookie）。二进制不猜，只说一句人话。
 */
export default {
	id: "文件树",

	style: `
		.dk {
			display: flex; flex-direction: column; height: 100%; min-width: 0; min-height: 0;
			background: var(--frame);
		}

		/* ── 标签页条 ─────────────────────────────────────────────── */
		.dk-tabs {
			display: flex; flex: none; align-items: center; gap: 6px;
			height: 46px; padding: 0 8px 0 10px;
			border-bottom: 0.5px solid var(--rule);
		}
		.dk-strip {
			display: flex; flex: 1 1 auto; align-items: center; gap: 2px;
			min-width: 0; overflow-x: auto; scrollbar-width: none;
		}
		.dk-strip::-webkit-scrollbar { display: none; }
		.dk-tab {
			display: flex; align-items: center; gap: 7px; flex: none;
			max-width: 190px; height: 30px; padding: 0 9px;
			border-radius: 8px; color: var(--ink-3); font-size: 12.5px; line-height: 18px;
			cursor: pointer; user-select: none;
			transition: background-color 120ms ease, color 120ms ease;
		}
		.dk-tab:hover { background: var(--hover); color: var(--ink-2); }
		.dk-tab[data-on="true"] { background: var(--active); color: var(--ink); }
		.dk-tab > svg { flex: none; opacity: 0.8; }
		.dk-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.dk-x {
			display: grid; place-items: center; flex: none;
			width: 16px; height: 16px; padding: 0; margin-right: -3px;
			border: 0; border-radius: 5px; background: transparent;
			color: var(--ink-3); font: inherit; font-size: 13px; line-height: 1; cursor: pointer;
		}
		.dk-x:hover { background: var(--active); color: var(--ink); }
		.dk-plus, .dk-fold {
			display: grid; place-items: center; flex: none;
			width: 28px; height: 28px; padding: 0;
			border: 0; border-radius: 8px; background: transparent;
			color: var(--ink-3); cursor: pointer;
			transition: background-color 120ms ease, color 120ms ease;
		}
		.dk-plus:hover, .dk-fold:hover { background: var(--hover); color: var(--ink); }

		.dk-body { flex: 1 1 auto; min-height: 0; display: flex; }
		.dk-pane { display: flex; flex-direction: column; flex: 1 1 auto; min-width: 0; min-height: 0; }

		/* ── 路径行（文件树 / 文件页共用） ──────────────────────────── */
		.dk-crumb {
			display: flex; flex: none; align-items: center; gap: 8px;
			height: 38px; padding: 0 8px 0 16px;
			border-bottom: 0.5px solid var(--rule);
		}
		.dk-path {
			flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
			font-family: var(--mono); font-size: 10.5px; line-height: 16px; color: var(--ink-3);
			direction: rtl; text-align: left; unicode-bidi: plaintext;
		}
		.dk-badge {
			flex: none; height: 19px; padding: 0 7px;
			border-radius: 6px; background: var(--accent-dim); color: var(--accent);
			font-size: 10px; line-height: 19px; letter-spacing: 0.02em;
		}
		.dk-meta { flex: none; font-family: var(--mono); font-size: 10px; line-height: 15px; color: var(--ink-3); }
		.dk-ic {
			display: grid; place-items: center; flex: none;
			width: 26px; height: 26px; padding: 0;
			border: 0; border-radius: 7px; background: transparent;
			color: var(--ink-3); cursor: pointer;
			transition: background-color 120ms ease, color 120ms ease;
		}
		.dk-ic:hover { background: var(--hover); color: var(--ink); }
		.dk-ic[data-on="true"] { color: var(--accent); }

		/* ── 文件树 ───────────────────────────────────────────────── */
		.dk-tree { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 6px 8px 18px; }
		.dk-row {
			display: flex; align-items: center; gap: 6px; width: 100%;
			min-height: 30px; padding: 4px 8px;
			border: 0; border-radius: 7px; background: none;
			color: var(--ink-2); font: inherit; font-size: 12.5px; line-height: 18px;
			text-align: left; cursor: pointer;
			transition: background-color 120ms ease, color 120ms ease;
		}
		.dk-row:hover { background: var(--hover); color: var(--ink); }
		.dk-row[data-active="true"] { background: var(--active); color: var(--ink); }
		.dk-caret {
			display: grid; place-items: center; flex: none;
			width: 12px; height: 12px; color: var(--ink-3);
			transition: transform 140ms var(--ease-line, ease);
		}
		.dk-caret[data-open="true"] { transform: rotate(90deg); }
		.dk-ico { display: grid; place-items: center; flex: none; color: var(--ink-3); }
		.dk-row[data-active="true"] .dk-ico, .dk-row[data-dir="true"] .dk-ico { color: var(--ink-3); }
		.dk-row[data-active="true"] .dk-ico { color: var(--accent); }
		.dk-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.dk-hint { padding: 20px 16px; font-size: 12.5px; line-height: 20px; color: var(--ink-3); }

		/* ── 文件内容 ─────────────────────────────────────────────── */
		.dk-doc { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 26px 40px 40px; }
		.dk-doc > * { max-width: 760px; margin-left: auto; margin-right: auto; }
		.dk-doc .md { font-size: 13.5px; line-height: 22px; color: var(--ink-2); }
		.dk-code {
			margin: 0; color: var(--ink-2);
			font-family: var(--mono); font-size: 12px; line-height: 1.7;
			white-space: pre-wrap; overflow-wrap: anywhere;
		}
		.dk-img { display: block; max-width: 100%; margin: 0 auto; border-radius: 10px; box-shadow: 0 0 0 0.5px var(--rule); }
		.dk-frame { display: block; width: 100%; height: 100%; min-height: 420px; border: 0; border-radius: 10px; background: #fff; box-shadow: 0 0 0 0.5px var(--rule); }
		.dk-err { padding: 10px 12px; border-radius: 8px; background: color-mix(in oklab, var(--danger) 10%, transparent); color: var(--danger); font-size: 12.5px; line-height: 19px; }

		/* ── 浏览器 ───────────────────────────────────────────────── */
		.dk-url {
			display: flex; flex: none; align-items: center; gap: 4px;
			height: 44px; padding: 0 10px;
			border-bottom: 0.5px solid var(--rule);
		}
		.dk-addr {
			display: flex; flex: 1 1 auto; align-items: center; gap: 8px; min-width: 0;
			height: 30px; padding: 0 11px; margin: 0 4px;
			border-radius: 8px; background: var(--raised); color: var(--ink-3);
		}
		.dk-addr:focus-within { box-shadow: inset 0 0 0 2px var(--accent-dim); }
		.dk-addr input {
			flex: 1 1 auto; min-width: 0; height: 100%; border: 0; background: none;
			color: var(--ink-2); font-family: var(--mono); font-size: 11.5px; outline: none;
		}
		.dk-frame-wrap { flex: 1 1 auto; min-height: 0; background: #fff; }
		.dk-frame-wrap > iframe,
		.dk-frame-wrap > webview { display: flex; width: 100%; height: 100%; border: 0; background: #fff; }
		.dk-note {
			margin: 0; padding: 8px 14px; border-bottom: 0.5px solid var(--rule);
			color: var(--ink-3); font-size: 11.5px; line-height: 1.5;
		}

		/* ── 开始页 ───────────────────────────────────────────────── */
		.dk-start { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 56px 40px; }
		.dk-start-mark { display: grid; place-items: center; width: 48px; height: 48px; margin: 0 auto 28px; color: var(--ink-3); opacity: 0.7; }
		.dk-start-list { display: flex; flex-direction: column; gap: 10px; max-width: 520px; margin: 0 auto; }
		.dk-act {
			display: flex; align-items: center; gap: 14px; width: 100%;
			padding: 13px 16px; border: 0; border-radius: 13px;
			background: var(--raised); color: var(--ink); font: inherit; font-size: 14px;
			text-align: left; cursor: pointer;
			transition: background-color 130ms ease, transform 130ms var(--ease-pop, ease);
		}
		.dk-act:hover { background: var(--hover); }
		.dk-act:active { transform: scale(0.99); }
		.dk-act-ico {
			display: grid; place-items: center; flex: none;
			width: 34px; height: 34px; border-radius: 9px;
			background: var(--accent-dim); color: var(--accent);
		}
		.dk-act-sub { display: block; margin-top: 1px; font-size: 11.5px; line-height: 16px; color: var(--ink-3); }

		/* ── 窄屏：工作台铺满 ─────────────────────────────────────── */
		@media (max-width: 900px) {
			.dk-tabs { height: 44px; }
			.dk-doc { padding: 18px 18px 32px; }
			.dk-start { padding: 40px 18px; }
		}
	`,

	apply(ui) {
		const { h, React, store, useStore, markdown } = ui;
		const { useEffect, useState } = React;
		const SLUG = "文件树";
		const FILES = "files";
		const START = "start";
		const WEB = "browser";
		/**
		 * 桌面壳（Electron）里 `<webview>` 是注册过的，浏览器里不是。
		 * iframe 挡不住 `X-Frame-Options`（百度、GitHub 都拒），webview 是独立进程，
		 * 不受这一条限制 —— 所以桌面里用它，浏览器里退回 iframe 并把话说清楚。
		 */
		const HAS_WEBVIEW = (() => {
			try {
				return typeof customElements !== "undefined" && customElements.get("webview") !== undefined;
			} catch {
				return false;
			}
		})();
		/** 活着的 webview：标签 id → 元素（前进 / 后退 / 刷新直接问它）。 */
		const guests = new Map();
		const guestSync = new WeakMap();

		async function getJson(url) {
			const response = await fetch(url);
			const payload = await response.json().catch(() => ({}));
			if (!response.ok) throw new Error(payload.error ?? `HTTP ${String(response.status)}`);
			return payload;
		}

		function bytes(value) {
			const n = Number(value) || 0;
			if (n < 1024) return `${String(n)} B`;
			if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
			return `${(n / 1024 / 1024).toFixed(1)} MB`;
		}

		function stamp(value) {
			const date = new Date(Number(value) || 0);
			const pad = (part) => String(part).padStart(2, "0");
			return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
		}

		function baseName(path) {
			const parts = String(path).split("/");
			return parts[parts.length - 1] ?? path;
		}

		function hostOf(url) {
			try {
				return new URL(url).host || url;
			} catch {
				return url;
			}
		}

		/** 统一的小图标：一条线画出来的轮廓，不引图标库。 */
		function Glyph(props) {
			const paths = {
				chevron: h("path", { key: "p", d: "M9 5.5l6 6.5-6 6.5" }),
				folder: h("path", { key: "p", d: "M3.5 6.5A1.5 1.5 0 0 1 5 5h3.6l1.8 2.2H19a1.5 1.5 0 0 1 1.5 1.5v8.8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5Z" }),
				file: [
					h("path", { key: "a", d: "M6 3.5h7L18.5 9v11.5h-12Z" }),
					h("path", { key: "b", d: "M13 3.5V9h5.5" }),
				],
				plus: [h("path", { key: "a", d: "M12 5.5v13M5.5 12h13" })],
				close: [h("path", { key: "a", d: "M6.5 6.5l11 11M17.5 6.5l-11 11" })],
				refresh: [h("path", { key: "a", d: "M19 12a7 7 0 1 1-2.1-5" }), h("path", { key: "b", d: "M19.5 4.5V9H15" })],
				back: h("path", { key: "p", d: "M15 6l-6 6 6 6" }),
				forward: h("path", { key: "p", d: "M9 6l6 6-6 6" }),
				external: [h("path", { key: "a", d: "M14 4.5h5.5V10" }), h("path", { key: "b", d: "M19 5l-8 8" }), h("path", { key: "c", d: "M18 14.5v4A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6h4" })],
				globe: [h("circle", { key: "a", cx: 12, cy: 12, r: 8 }), h("path", { key: "b", d: "M4 12h16M12 4c2.2 2.3 3.3 5 3.3 8s-1.1 5.7-3.3 8c-2.2-2.3-3.3-5-3.3-8S9.8 6.3 12 4Z" })],
				compass: [h("circle", { key: "a", cx: 12, cy: 12, r: 8.5 }), h("path", { key: "b", d: "M15.2 8.8l-1.6 4.4-4.4 1.6 1.6-4.4Z" })],
				fold: h("path", { key: "p", d: "M13 6l-5 6 5 6" }),
			};
			return h(
				"svg",
				{ width: props.size ?? 14, height: props.size ?? 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: props.weight ?? 1.6, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" },
				paths[props.name],
			);
		}

		function Workbench() {
			const channelId = useStore((state) => state.currentId);
			const wanted = useStore((state) => state.browser);

			const [tabs, setTabs] = useState([{ id: FILES, kind: FILES, title: "文件" }]);
			const [active, setActive] = useState(FILES);

			const [tree, setTree] = useState(null);
			const [treeError, setTreeError] = useState("");
			const [reload, setReload] = useState(0);
			const [open, setOpen] = useState({});

			/** 换频道：树重读，文件页签全关（那是另一个人的工作区）。 */
			useEffect(() => {
				setTree(null);
				setTreeError("");
				setOpen({});
				setTabs((current) => current.filter((tab) => tab.kind === FILES || tab.kind === START || tab.kind === WEB));
				if (channelId === null) return undefined;
				let live = true;
				getJson(`/api/p/files/tree?channel=${encodeURIComponent(channelId)}`)
					.then((data) => live && setTree(data))
					.catch((reason) => live && setTreeError(String(reason)));
				return () => {
					live = false;
				};
			}, [channelId, reload]);

			/** 正文里点到外链：开成浏览器页签（宿主已经把 dock 打开了）。 */
			useEffect(() => {
				if (wanted === null || wanted === undefined || wanted === "") return;
				openWeb(wanted);
				store.closeBrowser();
			}, [wanted]);

			function patchTab(id, change) {
				setTabs((current) => current.map((tab) => (tab.id === id ? { ...tab, ...change } : tab)));
			}

			function closeTab(id) {
				const index = tabs.findIndex((tab) => tab.id === id);
				const rest = tabs.filter((tab) => tab.id !== id);
				if (rest.length === 0) {
					setTabs([{ id: FILES, kind: FILES, title: "文件" }]);
					setActive(FILES);
					return;
				}
				setTabs(rest);
				if (active === id) setActive(rest[Math.max(0, index - 1)]?.id ?? rest[0].id);
			}

			function openFile(path) {
				const id = `file:${path}`;
				const exists = tabs.some((tab) => tab.id === id);
				if (exists) {
					setActive(id);
					return;
				}
				const tab = { id, kind: "file", path, title: baseName(path), data: null, error: "", busy: true };
				setTabs((current) => [...current, tab]);
				setActive(id);
				getJson(`/api/p/files/preview?channel=${encodeURIComponent(channelId ?? "")}&path=${encodeURIComponent(path)}`)
					.then((data) => patchTab(id, { data, busy: false }))
					.catch((reason) => patchTab(id, { error: String(reason), busy: false }));
			}

			function openStart() {
				const exists = tabs.some((tab) => tab.id === START);
				if (!exists) setTabs((current) => [...current, { id: START, kind: START, title: "开始" }]);
				setActive(START);
			}

			function openWeb(url) {
				const exists = tabs.some((tab) => tab.id === WEB);
				const tab = { id: WEB, kind: WEB, title: hostOf(url) || "浏览器", url, history: [url], index: 0, nonce: 0 };
				if (exists) {
					setTabs((current) => current.map((item) => (item.id === WEB ? { ...item, ...tab } : item)));
				} else {
					setTabs((current) => [...current, tab]);
				}
				setActive(WEB);
			}

			function goWeb(tab, url) {
				const next = url.trim() === "" ? "" : /^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`;
				if (next === "") return;
				const history = [...tab.history.slice(0, tab.index + 1), next];
				patchTab(tab.id, { url: next, history, index: history.length - 1, title: hostOf(next), nonce: (tab.nonce ?? 0) + 1 });
			}

			function walkWeb(tab, step) {
				const view = guests.get(tab.id);
				// webview 有自己的历史栈：问它，别和这边的数组各走各的。
				if (view !== undefined) {
					if (step < 0) view.goBack();
					else view.goForward();
					return;
				}
				const index = tab.index + step;
				if (index < 0 || index >= tab.history.length) return;
				patchTab(tab.id, { index, url: tab.history[index], title: hostOf(tab.history[index]) });
			}

			function reloadWeb(tab) {
				const view = guests.get(tab.id);
				if (view !== undefined) {
					view.reload();
					return;
				}
				patchTab(tab.id, { nonce: (tab.nonce ?? 0) + 1 });
			}

			/** webview 挂上 / 卸下：地址栏跟着它自己走（页内跳转也算）。 */
			function attachGuest(id, node) {
				if (node === null) {
					const view = guests.get(id);
					if (view === undefined) return;
					const sync = guestSync.get(view);
					if (sync !== undefined) {
						view.removeEventListener("did-navigate", sync);
						view.removeEventListener("did-navigate-in-page", sync);
					}
					guests.delete(id);
					return;
				}
				if (guests.get(id) === node) return;
				guests.set(id, node);
				const sync = (event) => {
					const url = typeof event.url === "string" && event.url !== "" ? event.url : (node.getURL?.() ?? "");
					if (url === "" || url === node.dataset["soloUrl"]) return;
					node.dataset["soloUrl"] = url;
					patchTab(id, { url, title: hostOf(url) || "浏览器" });
				};
				guestSync.set(node, sync);
				node.addEventListener("did-navigate", sync);
				node.addEventListener("did-navigate-in-page", sync);
			}

			function rows(entries, depth) {
				const out = [];
				for (const entry of entries ?? []) {
					const isOpen = open[entry.path] === true;
					const on = tabs.some((tab) => tab.id === `file:${entry.path}`) && active === `file:${entry.path}`;
					out.push(
						h(
							"button",
							{
								type: "button",
								key: entry.path,
								className: "dk-row",
								"data-dir": entry.dir ? "true" : undefined,
								"data-active": on ? "true" : undefined,
								style: { paddingLeft: `${String(8 + depth * 14)}px` },
								title: entry.path,
								onClick: () =>
									entry.dir
										? setOpen((current) => ({ ...current, [entry.path]: current[entry.path] !== true }))
										: openFile(entry.path),
							},
							h("span", { className: "dk-caret", "data-open": entry.dir ? String(isOpen) : undefined }, entry.dir ? h(Glyph, { name: "chevron", size: 11, weight: 2 }) : null),
							h("span", { className: "dk-ico" }, h(Glyph, { name: entry.dir ? "folder" : "file", size: 14 })),
							h("span", { className: "dk-name" }, entry.name),
						),
					);
					if (entry.dir && isOpen) out.push(...rows(entry.children, depth + 1));
				}
				return out;
			}

			function fileBody(tab) {
				if (tab.busy === true) return h("p", { className: "dk-hint" }, "读文件…");
				if (tab.error !== "") return h("div", { className: "dk-err" }, tab.error);
				const data = tab.data;
				if (data === null || data === undefined) return h("p", { className: "dk-hint" }, "没读到内容。");
				if (data.kind === "error") return h("div", { className: "dk-err" }, data.text);
				if (data.kind === "image") return h("img", { className: "dk-img", src: data.dataUrl, alt: data.name });
				if (data.kind === "html") {
					// `sandbox=""`：不给脚本、不给同源 —— 预览一个不知道从哪来的 HTML 也不越权。
					return h("iframe", { className: "dk-frame", sandbox: "", srcDoc: data.text, title: data.name });
				}
				if (data.kind === "markdown") {
					return h("div", { className: "md", dangerouslySetInnerHTML: { __html: markdown(data.text) } });
				}
				if (data.kind === "binary") return h("p", { className: "dk-hint" }, `${data.name} 是二进制文件（${bytes(data.size)}），不预览。`);
				return h("pre", { className: "dk-code" }, data.text);
			}

			function badgeOf(tab) {
				const data = tab.data;
				if (data === null || data === undefined) return "";
				if (data.kind === "markdown") return "Markdown";
				if (data.kind === "html") return "HTML";
				if (data.kind === "image") return "图片";
				if (data.kind === "text") return "文本";
				return "";
			}

			function filesPane() {
				const scope = tree === null || tree.kind !== "tree" ? "" : tree.root ?? tree.label ?? "";
				return h(
					"div",
					{ className: "dk-pane" },
					h(
						"div",
						{ className: "dk-crumb" },
						h("span", { className: "dk-path", title: scope }, scope === "" ? "工作区" : scope),
						h("button", { type: "button", className: "dk-ic", title: "刷新", "aria-label": "刷新", onClick: () => setReload((n) => n + 1) }, h(Glyph, { name: "refresh", size: 14 })),
					),
					h(
						"div",
						{ className: "dk-tree" },
						tree === null
							? h("p", { className: "dk-hint" }, treeError === "" ? "读目录…" : treeError)
							: tree.kind === "none"
								? h("p", { className: "dk-hint" }, "这个频道没有工作区。私聊看那个人的 workspace/，团队频道看团队的 workspace/；全员频道没有。")
								: (tree.entries ?? []).length === 0
									? h("p", { className: "dk-hint" }, `${tree.label} 的工作区还是空的。`)
									: rows(tree.entries, 0),
					),
				);
			}

			function filePane(tab) {
				const data = tab.data;
				const meta = data === null || data === undefined ? "" : [data.size === undefined ? "" : bytes(data.size), data.mtime === undefined ? "" : stamp(data.mtime)].filter((part) => part !== "").join(" · ");
				return h(
					"div",
					{ className: "dk-pane" },
					h(
						"div",
						{ className: "dk-crumb" },
						h("span", { className: "dk-path", title: tab.path }, tab.path),
						meta === "" ? null : h("span", { className: "dk-meta" }, meta),
						badgeOf(tab) === "" ? null : h("span", { className: "dk-badge" }, badgeOf(tab)),
					),
					h("div", { className: "dk-doc" }, fileBody(tab)),
				);
			}

			function webPane(tab) {
				const sameOrigin = (() => {
					try {
						return new URL(tab.url).origin === location.origin;
					} catch {
						return false;
					}
				})();
				return h(
					"div",
					{ className: "dk-pane" },
					h(
						"div",
						{ className: "dk-url" },
						h("button", { type: "button", className: "dk-ic", title: "后退", "aria-label": "后退", disabled: !HAS_WEBVIEW && tab.index <= 0, onClick: () => walkWeb(tab, -1) }, h(Glyph, { name: "back", size: 16 })),
						h("button", { type: "button", className: "dk-ic", title: "前进", "aria-label": "前进", disabled: !HAS_WEBVIEW && tab.index >= tab.history.length - 1, onClick: () => walkWeb(tab, 1) }, h(Glyph, { name: "forward", size: 16 })),
						h("button", { type: "button", className: "dk-ic", title: "刷新", "aria-label": "刷新", onClick: () => reloadWeb(tab) }, h(Glyph, { name: "refresh", size: 15 })),
						h(
							"form",
							{
								className: "dk-addr",
								onSubmit: (event) => {
									event.preventDefault();
									goWeb(tab, event.target.elements.url.value);
								},
							},
							h("input", { name: "url", defaultValue: tab.url, key: tab.url, spellCheck: false, autoCapitalize: "off", autoCorrect: "off", "aria-label": "地址" }),
						),
						h("button", { type: "button", className: "dk-ic", title: "在系统浏览器打开", "aria-label": "在系统浏览器打开", onClick: () => window.open(tab.url, "_blank", "noopener,noreferrer") }, h(Glyph, { name: "external", size: 15 })),
					),
					HAS_WEBVIEW
						? null
						: h("p", { className: "dk-note" }, "网页版只能内嵌 iframe：百度、GitHub 这类站点会拒绝被嵌，白屏是它拦的。桌面版里用内置浏览器能正常打开。"),
					h(
						"div",
						{ className: "dk-frame-wrap" },
						sameOrigin
							? h("p", { className: "dk-hint" }, "Solo 自己的页面不能内嵌。要在这里看，请点右上「在系统浏览器打开」。")
							: tab.url === ""
								? h("p", { className: "dk-hint" }, "在上面输入一个地址，回车打开。")
								: HAS_WEBVIEW
									? h("webview", {
											key: `wv:${tab.nonce ?? 0}`,
											className: "dk-frame",
											src: tab.url,
											partition: "persist:solo-browser",
											ref: (node) => attachGuest(tab.id, node),
										})
									: h("iframe", {
											key: tab.nonce ?? 0,
											src: tab.url,
											title: tab.url,
											referrerPolicy: "no-referrer",
											sandbox: "allow-scripts allow-same-origin allow-forms allow-popups",
										}),
					),
				);
			}

			function startPane() {
				const acts = [
					{ key: "files", icon: "folder", label: "工作区文件", sub: "看这个频道的工作区", run: () => setActive(FILES) },
					{ key: "web", icon: "globe", label: "浏览器", sub: "输入一个地址，在 Solo 里看", run: () => openWeb("") },
				];
				return h(
					"div",
					{ className: "dk-start" },
					h("div", { className: "dk-start-mark" }, h(Glyph, { name: "compass", size: 40, weight: 1.2 })),
					h(
						"div",
						{ className: "dk-start-list" },
						acts.map((act) =>
							h(
								"button",
								{ type: "button", key: act.key, className: "dk-act", onClick: act.run },
								h("span", { className: "dk-act-ico" }, h(Glyph, { name: act.icon, size: 17 })),
								h("span", null, act.label, h("span", { className: "dk-act-sub" }, act.sub)),
							),
						),
					),
				);
			}

			const tab = tabs.find((item) => item.id === active) ?? tabs[0];
			return h(
				"section",
				{ className: "dk", "aria-label": "工作台" },
				h(
					"header",
					{ className: "dk-tabs" },
					h(
						"div",
						{ className: "dk-strip", role: "tablist" },
						tabs.map((item) =>
							h(
								"div",
								{
									key: item.id,
									className: "dk-tab",
									role: "tab",
									tabIndex: 0,
									"aria-selected": active === item.id ? "true" : "false",
									"data-on": active === item.id ? "true" : "false",
									title: item.kind === "file" ? item.path : item.title,
									onClick: () => setActive(item.id),
									onKeyDown: (event) => {
										if (event.key === "Enter" || event.key === " ") setActive(item.id);
									},
								},
								h(Glyph, { name: item.kind === WEB ? "globe" : item.kind === START ? "compass" : item.kind === FILES ? "folder" : "file", size: 13 }),
								h("span", { className: "dk-title" }, item.title),
								item.kind === FILES
									? null
									: h(
											"button",
											{
												type: "button",
												className: "dk-x",
												"aria-label": `关掉 ${item.title}`,
												onClick: (event) => {
													event.stopPropagation();
													closeTab(item.id);
												},
											},
											h(Glyph, { name: "close", size: 10, weight: 2 }),
										),
							),
						),
						h("button", { type: "button", className: "dk-plus", title: "开始", "aria-label": "开始", onClick: openStart }, h(Glyph, { name: "plus", size: 15 })),
					),
					h("button", { type: "button", className: "dk-fold", title: "收起工作台", "aria-label": "收起工作台", onClick: () => store.closeDock() }, h(Glyph, { name: "fold", size: 16 })),
				),
				h("div", { className: "dk-body" }, tab === undefined ? null : tab.kind === FILES ? filesPane() : tab.kind === "file" ? filePane(tab) : tab.kind === WEB ? webPane(tab) : startPane()),
			);
		}

		ui.register("rightPanel.tab", {
			id: "files",
			label: "工作空间",
			order: 50,
			onOpen: () => store.openDock(SLUG),
		});
		ui.register("dock", { id: "workbench", component: Workbench });
	},
};
