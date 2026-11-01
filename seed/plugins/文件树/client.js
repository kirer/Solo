/**
 * 文件树的前端一半：右栏一个「文件」页签，左树右预览（窄栏里上下排）。
 *
 * 只读。工作区由后端按当前频道算好（私聊 → 那个人的，团队频道 → 团队的），
 * 这里只请求 `/api/p/files/tree` 与 `/api/p/files/preview`。
 *
 * 所有文件都是**文本**或 data URL 或沙箱 iframe：HTML 永远不进当前文档（`sandbox=""`
 * 连脚本都不给跑），图片是 data URL（发不出请求，也拿不到 cookie）。
 */
export default {
	id: "文件树",

	style: `
		.pv-files { display: flex; flex-direction: column; gap: 8px; min-height: 0; flex: 1 1 auto; }
		.pv-files-meta { font-size: 11px; color: var(--muted, #888); }
		.pv-files-tree {
			display: flex; flex-direction: column; gap: 1px;
			max-height: 46%; overflow: auto;
			padding: 4px 0; border-bottom: 1px solid var(--line, rgb(127 127 127 / 0.16));
		}
		.pv-files-row {
			display: flex; align-items: center; gap: 6px;
			padding: 3px 6px; border: 0; border-radius: 6px;
			background: none; color: inherit; font: inherit; font-size: 12px;
			text-align: left; cursor: pointer; white-space: nowrap;
		}
		.pv-files-row:hover { background: var(--hover, rgb(127 127 127 / 0.12)); }
		.pv-files-row[data-active="true"] { background: var(--active, rgb(127 127 127 / 0.18)); }
		.pv-files-row[data-dir="true"] { color: var(--muted, #888); }
		.pv-files-caret { width: 12px; flex: none; color: var(--muted, #888); }
		.pv-files-name { overflow: hidden; text-overflow: ellipsis; }
		.pv-files-preview { flex: 1 1 auto; min-height: 0; overflow: auto; }
		.pv-files-preview pre {
			margin: 0; padding: 8px; border-radius: 8px;
			background: var(--hover, rgb(127 127 127 / 0.1));
			font-family: var(--mono, ui-monospace, monospace); font-size: 11.5px; line-height: 1.6;
			white-space: pre-wrap; word-break: break-word;
		}
		.pv-files-preview img { display: block; max-width: 100%; border-radius: 8px; }
		.pv-files-preview iframe {
			width: 100%; height: 100%; min-height: 320px; border: 1px solid var(--line, rgb(127 127 127 / 0.16));
			border-radius: 8px; background: #fff;
		}
		.pv-files-empty { padding: 12px 4px; font-size: 12px; line-height: 1.7; color: var(--muted, #888); }
		.pv-files-err { padding: 8px; font-size: 12px; color: var(--danger, #c33); }
	`,

	apply(ui) {
		const { h, React } = ui;

		async function getJson(url) {
			const response = await fetch(url);
			if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
			return response.json();
		}

		function FilesTab() {
			const channelId = ui.useStore((state) => state.currentId);
			const [tree, setTree] = React.useState(null);
			const [open, setOpen] = React.useState({});
			const [picked, setPicked] = React.useState(null);
			const [file, setFile] = React.useState(null);
			const [error, setError] = React.useState("");

			React.useEffect(() => {
				setTree(null);
				setPicked(null);
				setFile(null);
				setError("");
				if (channelId === null) return undefined;
				let live = true;
				getJson(`/api/p/files/tree?channel=${encodeURIComponent(channelId)}`)
					.then((data) => live && setTree(data))
					.catch((reason) => live && setError(String(reason)));
				return () => {
					live = false;
				};
			}, [channelId]);

			function pick(path) {
				setPicked(path);
				setFile(null);
				setError("");
				getJson(
					`/api/p/files/preview?channel=${encodeURIComponent(channelId ?? "")}&path=${encodeURIComponent(path)}`,
				)
					.then(setFile)
					.catch((reason) => setError(String(reason)));
			}

			function rows(entries, depth) {
				const out = [];
				for (const entry of entries ?? []) {
					const isOpen = open[entry.path] === true;
					out.push(
						h(
							"button",
							{
								type: "button",
								key: entry.path,
								className: "pv-files-row",
								"data-dir": entry.dir ? "true" : undefined,
								"data-active": !entry.dir && picked === entry.path ? "true" : undefined,
								style: { paddingLeft: `${String(6 + depth * 12)}px` },
								title: entry.path,
								onClick: () =>
									entry.dir
										? setOpen((current) => ({ ...current, [entry.path]: current[entry.path] !== true }))
										: pick(entry.path),
							},
							h("span", { className: "pv-files-caret" }, entry.dir ? (isOpen ? "▾" : "▸") : ""),
							h("span", { className: "pv-files-name" }, entry.name),
						),
					);
					if (entry.dir && isOpen) out.push(...rows(entry.children, depth + 1));
				}
				return out;
			}

			function preview() {
				if (file === null) return null;
				if (file.kind === "image") return h("img", { src: file.dataUrl, alt: file.name });
				if (file.kind === "html") {
					// `sandbox=""`：不给脚本、不给同源 —— 预览一个不知道从哪来的 HTML 也不越权。
					return h("iframe", { sandbox: "", srcDoc: file.text, title: file.name });
				}
				if (file.kind === "binary") {
					return h("div", { className: "pv-files-empty" }, `${file.name} 是二进制文件（${String(file.bytes)} 字节），不预览。`);
				}
				if (file.kind === "error") return h("div", { className: "pv-files-err" }, file.text);
				// markdown 也只画原文：这个页签不引 markdown 渲染器，原文比半套渲染更可信。
				return h("pre", null, file.text);
			}

			if (channelId === null) return h("div", { className: "pv-files-empty" }, "先选一个频道。");
			if (tree === null) return h("div", { className: "pv-files-empty" }, error === "" ? "读文件…" : error);
			if (tree.kind === "none") {
				return h(
					"div",
					{ className: "pv-files-empty" },
					"这个频道没有工作区。私聊看那个人的 workspace/，团队频道看团队的 workspace/；全员频道没有。",
				);
			}
			if ((tree.entries ?? []).length === 0) {
				return h("div", { className: "pv-files-empty" }, `${tree.label} 的工作区还是空的。`);
			}
			return h(
				"div",
				{ className: "pv-files" },
				h("div", { className: "pv-files-meta" }, tree.label),
				h("div", { className: "pv-files-tree" }, rows(tree.entries, 0)),
				h(
					"div",
					{ className: "pv-files-preview" },
					error === "" ? null : h("div", { className: "pv-files-err" }, error),
					preview(),
					picked === null ? h("div", { className: "pv-files-empty" }, "点一个文件看内容。") : null,
				),
			);
		}

		ui.register("rightPanel.tab", { id: "files", label: "文件", order: 50, component: FilesTab });
	},
};
