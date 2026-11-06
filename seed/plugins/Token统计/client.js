/**
 * Token 统计的前端：设置里的一行入口 + 一整页用量面板。
 *
 * 入口走 `rail.item` 插槽（设置页的 `.set-tools` 里画成一行）；页面走 `app.page` 插槽 ——
 * 它是**一整屏**，和「后台任务」并列，不是盖在聊天上的浮层：打开时侧栏、纸、右栏都让位。
 * 开关在界面状态里（`store.pluginView`），Esc 由外壳统一收回聊天。
 *
 * 两份数据都来自后端那一条 `GET /api/p/tokens?days=…`，这里只排版，不算账。
 *
 * 版式借 dsh-context 的 Context Insights：KPI 条 → 每日用量柱 → 8 周热力图 →
 * 按人 / 按模型两张账。Solo 只有「按调用的 token 与成本」，没有上下文组成，所以
 * 不画环形图、不假装知道系统提示词占了多少。
 */
export default {
	id: "Token统计",

	style: `
		.tk {
			display: flex; flex-direction: column;
			height: 100%; min-width: 0; min-height: 0;
			background: var(--ground);
		}
		.tk-head {
			display: flex; align-items: center; gap: 10px;
			min-height: 60px; padding: 8px 16px;
		}
		/* 插件页面靠自己的抬头回去（宿主不再另浮一颗返回）：两端都画。 */
		.tk-back {
			display: grid; place-items: center;
			width: 36px; height: 36px; padding: 0;
			border: 0; border-radius: 10px; background: transparent;
			color: var(--ink-3); cursor: pointer; flex: none;
		}
		@media (max-width: 640px) {
			.tk-head { padding-left: 8px; }
			/* 一行放不下：副标题先让位，留着时间切换。 */
			.tk-head p { display: none; }
		}
		.tk-back:hover { background: var(--hover); color: var(--ink); }
		.tk-head h2 { margin: 0; font-size: 16px; line-height: 22px; font-weight: 600; }
		.tk-head p { margin: 0; font-size: 12px; line-height: 16px; color: var(--ink-3); }
		.tk-grow { flex: 1 1 auto; }
		.tk-ranges { display: flex; gap: 2px; padding: 3px; border-radius: 9px; background: var(--raised); flex: none; }
		.tk-range {
			height: 28px; padding: 0 11px; border: 0; border-radius: 7px;
			background: transparent; color: var(--ink-3); white-space: nowrap;
			font: inherit; font-size: 12.5px; cursor: pointer;
		}
		.tk-range:hover { color: var(--ink-2); }
		.tk-range[data-on="true"] {
			background: var(--field); color: var(--ink);
			box-shadow: 0 0 0 0.5px var(--line), 0 1px 2px rgb(0 0 0 / 0.06);
		}
		.tk-body { flex: 1 1 auto; overflow: auto; padding: 24px clamp(20px, 4vw, 40px) 48px; }
		.tk-inner { width: 100%; max-width: 1080px; margin: 0 auto; }
		.tk-loading, .tk-empty {
			display: grid; place-items: center; min-height: 280px; padding: 24px;
			color: var(--ink-3); font-size: 13px; text-align: center; line-height: 22px;
		}
		.tk-error { color: var(--danger, #ec1313); }
		.tk-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
		.tk-kpi {
			padding: 14px 16px 13px; border: 0.5px solid var(--line);
			border-radius: 12px; background: var(--ground); min-width: 0;
		}
		.tk-kpi b {
			display: block; font-size: 24px; line-height: 30px; font-weight: 600;
			letter-spacing: -0.02em; font-variant-numeric: tabular-nums;
			white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
		}
		.tk-kpi span { display: block; margin-top: 2px; font-size: 12px; line-height: 16px; color: var(--ink-3); }
		.tk-meta { margin: 12px 0 0; font-size: 12px; line-height: 18px; color: var(--ink-3); }
		.tk-sec { margin-top: 24px; }
		.tk-sec-head { display: flex; align-items: baseline; gap: 8px; margin: 0 0 10px; }
		.tk-sec-head h3 { margin: 0; font-size: 13px; line-height: 18px; font-weight: 600; }
		.tk-sec-head span { font-size: 12px; line-height: 18px; color: var(--ink-3); }
		.tk-chart {
			padding: 14px 16px 10px; border: 0.5px solid var(--line);
			border-radius: 12px; background: var(--ground);
		}
		.tk-bars { display: flex; align-items: flex-end; gap: 2px; height: 132px; overflow-x: auto; overflow-y: hidden; }
		.tk-col {
			flex: 1 1 0; min-width: 5px; height: 100%;
			display: flex; flex-direction: column; justify-content: flex-end;
		}
		.tk-bar {
			width: 100%; min-height: 2px; border-radius: 3px 3px 1px 1px;
			background: var(--accent); opacity: 0.82; transition: opacity 120ms ease;
		}
		.tk-col:hover .tk-bar { opacity: 1; }
		.tk-col[data-zero="true"] .tk-bar { background: var(--line); opacity: 1; }
		.tk-axis { display: flex; gap: 2px; margin-top: 6px; }
		.tk-axis span {
			flex: 1 1 0; min-width: 5px; font-size: 10px; line-height: 14px;
			color: var(--ink-3); text-align: center; white-space: nowrap; overflow: hidden;
		}
		.tk-heat {
			display: grid; grid-auto-flow: column; grid-template-rows: repeat(7, 11px);
			gap: 3px; overflow-x: auto; padding: 2px 0;
		}
		.tk-cell { width: 11px; height: 11px; border-radius: 2.5px; background: var(--rule); }
		.tk-cell[data-level="1"] { background: color-mix(in oklab, var(--accent) 26%, transparent); }
		.tk-cell[data-level="2"] { background: color-mix(in oklab, var(--accent) 48%, transparent); }
		.tk-cell[data-level="3"] { background: color-mix(in oklab, var(--accent) 72%, transparent); }
		.tk-cell[data-level="4"] { background: var(--accent); }
		.tk-legend { display: flex; align-items: center; gap: 4px; margin-top: 8px; font-size: 11px; color: var(--ink-3); }
		.tk-legend i { width: 11px; height: 11px; border-radius: 2.5px; background: var(--rule); }
		.tk-legend i[data-level="1"] { background: color-mix(in oklab, var(--accent) 26%, transparent); }
		.tk-legend i[data-level="2"] { background: color-mix(in oklab, var(--accent) 48%, transparent); }
		.tk-legend i[data-level="3"] { background: color-mix(in oklab, var(--accent) 72%, transparent); }
		.tk-legend i[data-level="4"] { background: var(--accent); }
		.tk-tables { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
		@media (max-width: 820px) { .tk-tables { grid-template-columns: 1fr; } }
		.tk-card { border: 0.5px solid var(--line); border-radius: 12px; background: var(--ground); overflow: hidden; }
		.tk-row {
			display: grid; grid-template-columns: minmax(0, 1fr) 78px 62px 64px;
			align-items: center; gap: 8px; padding: 9px 14px;
			border-top: 0.5px solid var(--rule); font-size: 12.5px; line-height: 18px;
		}
		.tk-row[data-head="true"] { border-top: 0; color: var(--ink-3); font-size: 11.5px; }
		.tk-row > span { text-align: right; font-variant-numeric: tabular-nums; }
		.tk-row > span:first-child { text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink); }
		.tk-row[data-head="true"] > span:first-child { color: var(--ink-3); }
	`,

	apply(ui) {
		const { h, React, register, store, useStore } = ui;
		const { useEffect, useState } = React;
		const SLUG = "Token统计";

		function compact(value) {
			const n = Number(value) || 0;
			if (n >= 100000000) return `${(n / 100000000).toFixed(1)} 亿`;
			if (n >= 10000) return `${(n / 10000).toFixed(1)} 万`;
			return n.toLocaleString("zh-CN");
		}

		function money(value) {
			const n = Number(value) || 0;
			if (n === 0) return "$0";
			return n >= 0.01 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`;
		}

		function percent(value) {
			return `${((Number(value) || 0) * 100).toFixed(1)}%`;
		}

		function duration(ms) {
			const minutes = Math.round((Number(ms) || 0) / 60000);
			if (minutes < 60) return `${String(minutes)} 分钟`;
			return `${(minutes / 60).toFixed(1)} 小时`;
		}

		/** 柱状图：每根柱一句话的悬停说明，日期只标稀疏的几格。 */
		function Chart({ daily }) {
			const max = daily.reduce((top, day) => Math.max(top, day.tokens), 0);
			const step = daily.length <= 14 ? 1 : Math.ceil(daily.length / 10);
			const label = (date) => `${date.slice(5)}`;
			return h(
				"div",
				{ className: "tk-chart" },
				h(
					"div",
					{ className: "tk-bars" },
					daily.map((day) =>
						h(
							"div",
							{
								key: day.date,
								className: "tk-col",
								"data-zero": day.tokens === 0 ? "true" : "false",
								title: `${day.date} · ${compact(day.tokens)} token · ${money(day.cost)} · ${String(day.requests)} 次调用`,
							},
							h("div", {
								className: "tk-bar",
								style: { height: max === 0 ? "2px" : `${Math.max(1.5, (day.tokens / max) * 100)}%` },
							}),
						),
					),
				),
				h(
					"div",
					{ className: "tk-axis" },
					daily.map((day, index) =>
						h("span", { key: day.date }, index % step === 0 || index === daily.length - 1 ? label(day.date) : ""),
					),
				),
			);
		}

		function Heatmap({ heatmap }) {
			const max = heatmap.reduce((top, day) => Math.max(top, day.tokens), 0);
			const level = (tokens) => {
				if (tokens === 0 || max === 0) return 0;
				return Math.min(4, 1 + Math.floor((tokens / max) * 3.999));
			};
			// 第一格对齐到周一：`getDay()` 是 0=周日。
			const lead = (new Date(`${heatmap[0].date}T00:00:00`).getDay() + 6) % 7;
			const pad = Array.from({ length: lead }, (_, index) => h("i", { key: `pad-${String(index)}`, className: "tk-cell" }));
			return h(
				"div",
				null,
				h(
					"div",
					{ className: "tk-heat" },
					pad,
					heatmap.map((day) =>
						h("i", {
							key: day.date,
							className: "tk-cell",
							"data-level": String(level(day.tokens)),
							title: `${day.date} · ${compact(day.tokens)} token`,
						}),
					),
				),
				h(
					"div",
					{ className: "tk-legend" },
					h("span", null, "少"),
					[0, 1, 2, 3, 4].map((n) => h("i", { key: n, "data-level": String(n) })),
					h("span", null, "多"),
				),
			);
		}

		function Table({ title, rows, head }) {
			return h(
				"div",
				{ className: "tk-card" },
				h("div", { className: "tk-row", "data-head": "true" }, head.map((text, index) => h("span", { key: text }, index === 0 ? title : text))),
				rows.map((row) =>
					h(
						"div",
						{ key: row.key, className: "tk-row" },
						h("span", { title: row.key }, row.key),
						h("span", null, compact(row.tokens)),
						h("span", null, percent(row.cacheRate)),
						h("span", null, money(row.cost)),
					),
				),
			);
		}

		function Page() {
			const [days, setDays] = useState(7);
			const [data, setData] = useState(undefined);
			const [error, setError] = useState(undefined);

			useEffect(() => {
				let cancelled = false;
				setError(undefined);
				fetch(`/api/p/tokens?days=${String(days)}`)
					.then(async (response) => {
						const payload = await response.json().catch(() => ({}));
						if (!response.ok) throw new Error(payload.error ?? `接口返回 ${String(response.status)}`);
						return payload;
					})
					.then((payload) => {
						if (!cancelled) setData(payload);
					})
					.catch((reason) => {
						if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
					});
				return () => {
					cancelled = true;
				};
			}, [days]);

			const totals = data?.totals;
			const inputTokens = totals === undefined ? 0 : totals.input + totals.cache + totals.write;
			const ranges = [
				[7, "7 天"],
				[30, "30 天"],
				[0, "全部"],
			];

			return h(
				"section",
				{ className: "tk", "aria-label": "Token 用量" },
				h(
					"div",
					{ className: "tk-head" },
					h(
						"button",
						{ type: "button", className: "tk-back", "aria-label": "回到聊天", onClick: () => store.closePluginView() },
						h(
							"svg",
							{ width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" },
							h("path", { d: "M15 6l-6 6 6 6" }),
						),
					),
					h("div", null, h("h2", null, "Token 用量"), h("p", null, "本机审计日志 · 按模型调用记账")),
					h("span", { className: "tk-grow" }),
					h(
						"div",
						{ className: "tk-ranges", role: "group", "aria-label": "时间范围" },
						ranges.map(([value, text]) =>
							h(
								"button",
								{
									key: value,
									type: "button",
									className: "tk-range",
									"data-on": days === value ? "true" : "false",
									onClick: () => setDays(value),
								},
								text,
							),
						),
					),
				),
				h(
					"div",
					{ className: "tk-body" },
					h(
						"div",
						{ className: "tk-inner" },
						error !== undefined
							? h("div", { className: "tk-empty tk-error" }, `没读到用量：${error}`)
							: totals === undefined
								? h("div", { className: "tk-loading" }, "正在算账…")
								: data.empty
									? h(
											"div",
											{ className: "tk-empty" },
											"还没有模型调用记录。和任何人说一句话，这里就有数了。",
										)
									: h(
											React.Fragment,
											null,
											h(
												"div",
												{ className: "tk-kpis" },
												h("div", { className: "tk-kpi" }, h("b", null, compact(totals.tokens)), h("span", null, "计费 Token")),
												h("div", { className: "tk-kpi" }, h("b", null, compact(inputTokens)), h("span", null, "输入（含缓存）")),
												h("div", { className: "tk-kpi" }, h("b", null, compact(totals.output)), h("span", null, "输出")),
												h("div", { className: "tk-kpi" }, h("b", null, percent(totals.cacheRate)), h("span", null, "缓存命中率")),
												h("div", { className: "tk-kpi" }, h("b", null, money(totals.cost)), h("span", null, "预估成本")),
											),
											h(
												"p",
												{ className: "tk-meta" },
												`${String(totals.requests)} 次模型调用 · 耗时 ${duration(totals.ms)} · 缓存读 ${compact(totals.cache)} / 写 ${compact(totals.write)}`,
											),
											h(
												"div",
												{ className: "tk-sec" },
												h("div", { className: "tk-sec-head" }, h("h3", null, "每日用量"), h("span", null, `${data.range.from} → ${data.range.to}`)),
												h(Chart, { daily: data.daily }),
											),
											h(
												"div",
												{ className: "tk-sec" },
												h("div", { className: "tk-sec-head" }, h("h3", null, "活动热力图"), h("span", null, "最近 8 周")),
												h(Heatmap, { heatmap: data.heatmap }),
											),
											h(
												"div",
												{ className: "tk-sec tk-tables" },
												h(Table, { title: "按人", rows: data.people, head: ["按人", "Token", "命中", "成本"] }),
												h(Table, { title: "按模型", rows: data.models, head: ["按模型", "Token", "命中", "成本"] }),
											),
										),
					),
				),
			);
		}

		function RailEntry() {
			const active = useStore((state) => state.pluginView === SLUG);
			return h(
				"button",
				{
					type: "button",
					className: "rail-item",
					id: "rail-tokens",
					"data-tip": "Token 用量",
					"aria-label": "Token 用量",
					"aria-current": active ? "true" : "false",
					onClick: () => store.openPluginView(SLUG),
				},
				h(
					"svg",
					{ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round" },
					h("path", { d: "M4 20V10" }),
					h("path", { d: "M10 20V4" }),
					h("path", { d: "M16 20v-7" }),
					h("path", { d: "M21 20V8" }),
				),
			);
		}

		register("rail.item", { id: "entry", component: RailEntry });
		register("app.page", { id: "page", component: Page });
	},
};
