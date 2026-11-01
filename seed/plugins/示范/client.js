/**
 * 示范插件的前端一半：浏览器原生 ESM，不经过构建。
 *
 * 写入方（宿主）递给它一个 `ui`：`h`（= `React.createElement`）、`React`、现有的接口
 * 客户端 `api`、界面状态 `store` / `useStore`、以及 `register(slot, cell)`。
 * 它只知道自己这几个格子，看不到别的插件。
 *
 * 改完这个文件刷新页面即生效 —— 不用 `npm run ui:build`，那是给 Solo 自己的界面用的。
 */
export default {
	id: "示范",

	// 插件自己的样式。宿主插进 <head>，随插件卸载一起消失（刷新页面即清）。
	style: `
		.pv-demo-time {
			padding: 4px 10px;
			font: inherit;
			font-size: 12px;
			color: var(--muted, #888);
			font-variant-numeric: tabular-nums;
		}
		.pv-demo-pill {
			display: inline-flex;
			align-items: center;
			flex: none;
			height: 26px;
			padding: 0 8px;
			border-radius: 7px;
			background: var(--hover, rgb(127 127 127 / 0.12));
			font-size: 11px;
			color: var(--muted, #888);
			white-space: nowrap;
		}
		.pv-demo-list { display: flex; flex-direction: column; gap: 10px; padding: 4px 2px; }
		.pv-demo-item { display: flex; flex-direction: column; gap: 2px; }
		.pv-demo-name { font-size: 13px; font-weight: 600; }
		.pv-demo-desc { font-size: 12px; color: var(--muted, #888); line-height: 1.5; }
	`,

	apply(ui) {
		const { h, React } = ui;

		/** 左栏底部：本机时间。三十秒跳一次，不做秒针 —— 侧栏不是钟表。 */
		function ClockRow() {
			const [now, setNow] = React.useState(() => new Date());
			React.useEffect(() => {
				const timer = window.setInterval(() => setNow(new Date()), 30_000);
				return () => window.clearInterval(timer);
			}, []);
			return h("div", { className: "pv-demo-time" }, `示范插件 · ${now.toTimeString().slice(0, 5)}`);
		}

		/** 右栏页签：把 `/api/plugins` 原样列出来，让人看清这一版的插件系统装上了什么。 */
		function PluginList() {
			const [plugins, setPlugins] = React.useState(null);
			React.useEffect(() => {
				let live = true;
				fetch("/api/plugins")
					.then((response) => response.json())
					.then((data) => live && setPlugins(data.plugins ?? []))
					.catch(() => live && setPlugins([]));
				return () => {
					live = false;
				};
			}, []);

			if (plugins === null) return h("div", { className: "pv-demo-desc" }, "读插件清单…");
			if (plugins.length === 0) return h("div", { className: "pv-demo-desc" }, "还没有插件。");
			return h(
				"div",
				{ className: "pv-demo-list" },
				plugins.map((plugin) =>
					h(
						"div",
						{ className: "pv-demo-item", key: plugin.slug },
						h("span", { className: "pv-demo-name" }, plugin.name ?? plugin.slug),
						h(
							"span",
							{ className: "pv-demo-desc" },
							plugin.error ?? plugin.description ?? (plugin.enabled ? "" : "已关闭"),
						),
					),
				),
			);
		}

		/**
		 * 输入框右侧：当前在哪个频道。
		 *
		 * 这是「插件读得到界面状态」的最小示范：`ui.useStore` 就是宿主自己的那个订阅钩子，
		 * 所以频道一切换它就跟着变，不需要插件自己去拉接口。
		 */
		function ChannelPill() {
			const title = ui.useStore((state) => state.detail?.channel.title ?? "");
			if (title === "") return null;
			return h("span", { className: "pv-demo-pill", title: "来自示范插件 · composer.actions" }, title);
		}

		ui.register("sidebar.footer", { id: "clock", component: ClockRow });
		ui.register("composer.actions", { id: "channel", component: ChannelPill });
		ui.register("rightPanel.tab", { id: "plugins", label: "插件", order: 200, component: PluginList });
	},
};
