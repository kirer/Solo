/**
 * Token 统计的前端：设置里的一行入口 + 一整页用量面板。
 *
 * 入口走 `app.entry` 插槽（设置页的 `.set-tools` 里画成一行）；页面走 `app.page` 插槽 ——
 * 外壳把它摆成一张 800 宽的弹窗（窄窗口铺满），底下的对话还在（v6 稿子 D14）。
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
			background: var(--frame);
		}
		.tk-head {
			display: flex; flex: none; align-items: center; gap: 8px;
			min-height: 62px; padding: 0 14px 0 18px;
			border-bottom: 0.5px solid var(--rule);
		}
		/* 插件页面靠自己的抬头回去（宿主不再另浮一颗返回）：两端都画。 */
		.tk-back {
			display: grid; place-items: center;
			width: 28px; height: 28px; padding: 0;
			border: 0; border-radius: 8px; background: transparent;
			color: var(--ink-3); cursor: pointer; flex: none;
		}
		.tk-back:hover { background: var(--hover); color: var(--ink); }
		.tk-head h2 { margin: 0; font-size: 15px; line-height: 21px; font-weight: 600; }
		.tk-head p { margin: 1px 0 0; font-size: 11px; line-height: 15px; color: var(--ink-3); }
		.tk-grow { flex: 1 1 auto; }
		/* 这一页只写一份，按**自己占多宽**排（容器查询）：设置那张 800 弹窗里是宽的，
		   右栏 348、手机上 375 是窄的，两边看同一段 CSS，不靠宿主告诉它「我在哪」。 */
		.tk { container-type: inline-size; }
		/* 右栏的标题条已经写着「Token 用量」，这一页在哪儿由宿主决定：那一层的抬头不重复写。 */
		.tk-head[data-host="panel"] h2 { display: none; }
		.tk-ranges { display: flex; gap: 2px; padding: 3px; border-radius: 9px; background: var(--raised); flex: none; }
		.tk-range {
			height: 28px; padding: 0 11px; border: 0; border-radius: 7px;
			background: transparent; color: var(--ink-3); white-space: nowrap;
			font: inherit; font-size: 12.5px; cursor: pointer;
			transition: background-color 120ms ease, color 120ms ease, box-shadow 120ms ease;
		}
		.tk-range:hover { color: var(--ink-2); }
		.tk-range[data-on="true"] {
			background: var(--field); color: var(--ink);
			box-shadow: 0 0 0 0.5px var(--line), 0 1px 2px rgb(0 0 0 / 0.06);
		}
		.tk-body { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 18px clamp(16px, 3vw, 32px) 26px; }
		.tk-inner { width: 100%; max-width: 860px; margin: 0 auto; }
		.tk-empty {
			display: grid; place-items: center; min-height: 280px; padding: 24px;
			color: var(--ink-3); font-size: 13px; text-align: center; line-height: 22px;
		}
		.tk-error { color: var(--danger, #ec1313); }
		.tk-kpis {
			display: grid; grid-template-columns: repeat(6, minmax(0, 1fr));
			gap: 0.5px; overflow: hidden; border-radius: 14px;
			background: var(--rule); box-shadow: 0 0 0 0.5px var(--rule);
		}
		.tk-kpi { display: flex; flex-direction: column; gap: 1px; min-width: 0; padding: 12px 14px; background: var(--card); }
		.tk-kpi b {
			font-size: 16.5px; line-height: 22px; font-weight: 600;
			letter-spacing: -0.01em; font-variant-numeric: tabular-nums;
			white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
		}
		.tk-kpi span { font-size: 10.5px; line-height: 14px; color: var(--ink-3); }
		.tk-meta { margin: 9px 0 0; font-size: 11px; line-height: 16px; color: var(--ink-3); }
		.tk-sec { margin-top: 24px; }
		.tk-sec-head { display: flex; align-items: baseline; gap: 8px; margin: 0 0 10px; }
		.tk-sec-head h3 { margin: 0; font-size: 13px; line-height: 18px; font-weight: 600; }
		.tk-sec-head span {
			margin-left: auto; color: var(--ink-3);
			font-family: var(--mono); font-size: 9.5px; line-height: 14px;
		}
		.tk-chart { padding: 14px 16px 10px; border-radius: 12px; background: var(--card); box-shadow: 0 0 0 0.5px var(--rule); }
		.tk-bars { display: flex; align-items: flex-end; gap: 4px; height: 128px; overflow-x: auto; overflow-y: hidden; }
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
		.tk-axis { display: flex; gap: 4px; margin-top: 6px; }
		.tk-axis span {
			flex: 1 1 0; min-width: 5px;
			font-family: var(--mono); font-size: 8.5px; line-height: 11px;
			color: var(--ink-3); text-align: center; white-space: nowrap; overflow: hidden;
		}
		.tk-heat {
			display: grid; grid-template-columns: repeat(8, 24px); grid-template-rows: repeat(7, 24px);
			justify-content: space-between; gap: 4px; overflow-x: auto; padding: 2px 0;
		}
		.tk-cell { width: 24px; height: 24px; border-radius: 2.5px; background: var(--rule); }
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
		.tk-bottom {
			display: grid; grid-template-columns: minmax(0, 0.82fr) minmax(0, 1.09fr) minmax(0, 1.09fr);
			gap: 16px; align-items: start;
		}
		.tk-card { border-radius: 12px; background: var(--card); box-shadow: 0 0 0 0.5px var(--rule); overflow: hidden; }
		.tk-heat-card { padding: 14px; }
		.tk-row {
			display: grid; grid-template-columns: minmax(0, 1fr) 52px 42px 46px;
			align-items: center; gap: 6px; padding: 8px 12px;
			border-top: 0.5px solid var(--rule); font-size: 12.5px; line-height: 18px;
		}
		.tk-row[data-head="true"] { border-top: 0; color: var(--ink-3); font-size: 10.5px; }
		.tk-row > span { text-align: right; font-variant-numeric: tabular-nums; color: var(--ink-2); }
		.tk-row > span:first-child { text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink); }
		.tk-row[data-head="true"] > span { color: var(--ink-3); }
		.tk-who { display: flex; align-items: center; gap: 7px; min-width: 0; }
		.tk-who img { flex: none; width: 18px; height: 18px; border-radius: 50%; }
		.tk-who span { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
		/* 资料页最底下一格（rightPanel.bottom，稿子 D10）：宿主不给内边距，卡片自己带。 */
		.tk-me-card {
			margin: 16px 12px 0; border-radius: 14px; overflow: hidden;
			background: var(--card); box-shadow: inset 0 0 0 0.5px var(--rule);
			animation: expand-in 220ms var(--ease-line) both;
		}
		.tk-me { padding: 11px 14px 0; }
		.tk-me-head { display: flex; align-items: baseline; gap: 6px; }
		.tk-me-head .slabel { font-size: 13.5px; font-weight: 500; }
		.tk-me-head .sval { margin-left: auto; font-family: var(--mono); font-size: 10px; color: var(--ink-3); }
		.tk-me-bars { display: flex; align-items: flex-end; gap: 3px; height: 30px; margin: 9px 0; }
		.tk-me-bars i { flex: 1; border-radius: 2px 2px 1px 1px; background: var(--accent); opacity: 0.75; }
		.tk-me-bars i[data-zero="true"] { background: var(--rule); opacity: 1; }
		.tk-me-stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; padding-bottom: 9px; }
		.tk-me-stats b {
			display: block; font-size: 12.5px; font-weight: 600; line-height: 17px;
			font-variant-numeric: tabular-nums;
		}
		.tk-me-stats span { display: block; color: var(--ink-3); font-size: 10px; line-height: 14px; }
		.tk-me-foot {
			display: flex; align-items: center; width: calc(100% + 28px); margin: 0 -14px;
			padding: 9px 14px; border: 0; border-top: 0.5px solid var(--rule);
			background: none; color: var(--ink-3); font: inherit; font-size: 11.5px; line-height: 16px;
			text-align: left; cursor: pointer;
		}
		.tk-me-foot:hover { color: var(--ink-2); }
		.tk-me-foot svg { margin-left: auto; flex: none; }
		@media (max-width: 900px) {
			.tk-head { min-height: 56px; padding: 0 12px; }
			.tk-head p { display: none; }
			.tk-body { padding: 8px 0 22px; }
			.tk-inner { padding: 0 16px; }
			.tk-kpis { grid-template-columns: repeat(3, minmax(0, 1fr)); }
			.tk-sec { margin-top: 20px; }
			.tk-bars { height: 74px; gap: 3px; }
			.tk-bottom { grid-template-columns: minmax(0, 1fr); gap: 20px; }
			/* 手机上不放 8 周热力图：窄屏里会糊成一片，「谁花了多少」更要紧（DESIGN §13.11）。 */
			.tk-heat-sec { display: none; }
		}
		@container (max-width: 620px) {
			.tk-head { min-height: 0; padding: 8px 12px; gap: 6px 8px; flex-wrap: wrap; }
			.tk-head p, .tk-head .tk-grow { display: none; }
			.tk-head .tk-ranges { margin-left: auto; }
			.tk-range { height: 26px; padding: 0 8px; font-size: 12px; }
			.tk-body { padding: 14px 14px 22px; }
			.tk-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
			.tk-sec { margin-top: 20px; }
			.tk-bars { height: 74px; gap: 3px; }
			/* 三段（热力图 / 按人 / 按模型）竖着排：并排时每张只有一百来像素，数字全被切。 */
			.tk-bottom { grid-template-columns: minmax(0, 1fr); gap: 20px; }
		}
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
				{ className: "tk-card tk-heat-card" },
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

		function Table({ title, note, rows, head }) {
			return h(
				"div",
				null,
				h("div", { className: "tk-sec-head" }, h("h3", null, title), h("span", null, note)),
				h(
					"div",
					{ className: "tk-card" },
					h("div", { className: "tk-row", "data-head": "true" }, head.map((text) => h("span", { key: text }, text))),
					rows.map((row) =>
						h(
							"div",
							{ key: row.key, className: "tk-row" },
							h(
								"span",
								{ title: row.key },
								title === "按人"
									? h(
											"span",
											{ className: "tk-who" },
											h("img", { src: `/api/avatar/${encodeURIComponent(row.key)}?size=36`, alt: "" }),
											h("span", null, row.key),
										)
									: row.key,
							),
							h("span", null, compact(row.tokens)),
							h("span", null, percent(row.cacheRate)),
							h("span", null, money(row.cost)),
						),
					),
				),
			);
		}

		/**
		 * 数据没到之前先把骨架摆出来：和真内容用同一套类，高度一模一样。
		 * 否则弹窗先按「正在算账…」那么矮落定，数据一到再「啪」地涨成七百多 —— 就是那一下闪。
		 * 格子数是照着真内容排的（热力图 62 格 = 8 行、柱状图 7 根、表 3 行），差一两行也由
		 * 热力图那张卡托住（下排 align-items: start，高度取最高那张）。
		 */
		function Skeleton() {
			const bars = [0, 1, 2, 3, 4, 5, 6];
			const cells = Array.from({ length: 62 }, (_, index) => index);
			const kpis = ["计费 Token", "输入（含缓存）", "输出", "缓存命中率", "预估成本", "模型调用"];
			const table = (title) =>
				h(
					"div",
					null,
					h("div", { className: "tk-sec-head" }, h("h3", null, title), h("span", null, "计费 Token")),
					h(
						"div",
						{ className: "tk-card" },
						h("div", { className: "tk-row", "data-head": "true" }, ["人", "Token", "命中", "成本"].map((text) => h("span", { key: text }, text))),
						[0, 1, 2].map((row) => h("div", { key: row, className: "tk-row" }, [0, 1, 2, 3].map((cell) => h("span", { key: cell }, "—")))),
					),
				);
			return h(
				React.Fragment,
				null,
				h(
					"div",
					{ className: "tk-kpis" },
					kpis.map((label) => h("div", { key: label, className: "tk-kpi" }, h("b", null, "—"), h("span", null, label))),
				),
				h("p", { className: "tk-meta" }, "正在算账…"),
				h(
					"div",
					{ className: "tk-sec" },
					h("div", { className: "tk-sec-head" }, h("h3", null, "每日用量")),
					h(
						"div",
						{ className: "tk-chart" },
						h(
							"div",
							{ className: "tk-bars" },
							bars.map((index) => h("div", { key: index, className: "tk-col", "data-zero": "true" }, h("div", { className: "tk-bar" }))),
						),
						// 轴上的空标签要给一个不换行空格：空 span 没有行盒，骨架会矮 11px。
						h("div", { className: "tk-axis" }, bars.map((index) => h("span", { key: index }, " "))),
					),
				),
				h(
					"div",
					{ className: "tk-sec tk-bottom" },
					h(
						"div",
						{ className: "tk-heat-sec" },
						h("div", { className: "tk-sec-head" }, h("h3", null, "活动热力图"), h("span", null, "最近 8 周")),
						h(
							"div",
							{ className: "tk-card tk-heat-card" },
							h("div", { className: "tk-heat" }, cells.map((index) => h("i", { key: index, className: "tk-cell" }))),
							h(
								"div",
								{ className: "tk-legend" },
								h("span", null, "少"),
								[0, 1, 2, 3, 4].map((n) => h("i", { key: n, "data-level": String(n) })),
								h("span", null, "多"),
							),
						),
					),
					table("按人"),
					table("按模型"),
				),
			);
		}

		function Page() {
			// 两次打开这一页：设置弹窗里（整页）或右栏里推入的那一层。右栏里出口是右栏的返回键。
			const inPanel = useStore((state) => state.rightPage === SLUG);
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
					{ className: "tk-head", "data-host": inPanel ? "panel" : "modal" },
					inPanel
						? null
						: h(
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
								? h(Skeleton)
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
												h("div", { className: "tk-kpi" }, h("b", null, String(totals.requests)), h("span", null, "模型调用")),
											),
											h(
												"p",
												{ className: "tk-meta" },
												`耗时 ${duration(totals.ms)} · 缓存读 ${compact(totals.cache)} / 写 ${compact(totals.write)}`,
											),
											h(
												"div",
												{ className: "tk-sec" },
												h("div", { className: "tk-sec-head" }, h("h3", null, "每日用量"), h("span", null, `${data.range.from} → ${data.range.to}`)),
												h(Chart, { daily: data.daily }),
											),
											h(
												"div",
												{ className: "tk-sec tk-bottom" },
												h(
													"div",
													{ className: "tk-heat-sec" },
													h("div", { className: "tk-sec-head" }, h("h3", null, "活动热力图"), h("span", null, "最近 8 周")),
													h(Heatmap, { heatmap: data.heatmap }),
												),
												h(Table, { title: "按人", note: "计费 Token", rows: data.people, head: ["人", "Token", "命中", "成本"] }),
												h(Table, { title: "按模型", note: "计费 Token", rows: data.models, head: ["模型", "Token", "命中", "成本"] }),
											),
										),
					),
				),
			);
		}

		/**
		 * 资料页最底下一格：**这个人的**近 7 天用量（稿子 D10）。
		 * 谁被打开就查谁（`who` 是 slug）；团队频道和后台任务那一态不画。
		 */
		function PersonUsage() {
			const person = useStore((state) => state.person);
			const detail = useStore((state) => state.detail);
			const tasksOpen = useStore((state) => state.tasks.open);
			const who =
				person !== null
					? person.slug
					: detail !== null && detail.channel.kind === "dm"
						? (detail.members.find((member) => member.label === detail.channel.title)?.slug ?? "")
						: "";
			const [data, setData] = useState(undefined);

			useEffect(() => {
				if (who === "") return;
				let cancelled = false;
				setData(undefined);
				fetch(`/api/p/tokens?days=7&who=${encodeURIComponent(who)}`)
					.then((response) => (response.ok ? response.json() : undefined))
					.then((payload) => {
						if (!cancelled) setData(payload);
					})
					.catch(() => {
						if (!cancelled) setData(undefined);
					});
				return () => {
					cancelled = true;
				};
			}, [who]);

			const mine = data?.person;
			if (tasksOpen || who === "" || mine === undefined || mine.totals.requests === 0) return null;
			const max = mine.daily.reduce((top, day) => Math.max(top, day.tokens), 0);

			return h(
				"div",
				{ className: "tk-me-card" },
				h(
					"div",
					{ className: "tk-me" },
					h(
						"div",
						{ className: "tk-me-head" },
						h("span", { className: "slabel" }, "Token 用量"),
						h("span", { className: "sval" }, "近 7 天"),
					),
					h(
						"div",
						{ className: "tk-me-bars" },
						mine.daily.map((day) =>
							h("i", {
								key: day.date,
								"data-zero": day.tokens === 0 ? "true" : "false",
								style: { height: max === 0 ? "2px" : `${String(Math.max(4, (day.tokens / max) * 100))}%` },
								title: `${day.date} · ${compact(day.tokens)} token`,
							}),
						),
					),
					h(
						"div",
						{ className: "tk-me-stats" },
						h("div", null, h("b", null, compact(mine.totals.tokens)), h("span", null, "Token")),
						h("div", null, h("b", null, money(mine.totals.cost)), h("span", null, "成本")),
						h("div", null, h("b", null, percent(mine.totals.cacheRate)), h("span", null, "缓存命中")),
					),
					h(
						"button",
						{ type: "button", className: "tk-me-foot", onClick: () => store.openRightPage(SLUG) },
						`${String(mine.totals.requests)} 次调用 · 在 Token 统计里看全部`,
						h(
							"svg",
							{ width: 8, height: 13, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round" },
							h("path", { d: "m9 5 6 7-6 7" }),
						),
					),
				),
			);
		}

		function EntryRow() {
			const active = useStore((state) => state.pluginView === SLUG);
			return h(
				"button",
				{
					type: "button",
					className: "app-entry",
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

		register("app.entry", { id: "entry", component: EntryRow });
		register("app.page", { id: "page", label: "Token 用量", component: Page });
		register("rightPanel.bottom", { id: "usage", component: PersonUsage });
	},
};
