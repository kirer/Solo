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
	},
};
