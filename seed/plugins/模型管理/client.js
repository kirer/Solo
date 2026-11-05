/**
 * 模型管理的前端：在「设置」里多一节「模型」。
 *
 * 它只做表单：读 `GET /api/p/models` 拿到打码后的配置，改完 `POST /api/p/models` 写回
 * `<appRoot>/settings.json`，「获取可用模型」打一次 `POST /api/p/models/probe`。
 * 这里只写文件；写完之后内核会在下一次读模型时把它就地装进注册表（ADR-025），不用重启。
 *
 * 版式借的是设置页的公共样式（`.settings-row`，见 DESIGN §1.5）：
 * 一行一个设置、左标题右控件，卡片本身只画边框，不再自带标题；提供商收起成一行，
 * 点开才展开表单。
 */
export default {
	id: "模型管理",

	style: `
		/* 宿主那一格有 12/14 的内边距；这一条自己铺满整张卡，收起时就是一行设置。 */
		.pm { display: flex; flex-direction: column; margin: -12px -14px; }
		.pm-panel { padding: 0 14px 14px; }
		.pm-cur {
			margin-left: auto; overflow: hidden; max-width: 60%;
			font-size: 12.5px; line-height: 18px; color: var(--ink-3);
			text-overflow: ellipsis; white-space: nowrap;
		}
		/* 第一行自带一条上线：正文说明和设置行之间要有一条分界，不能只有行间线。 */
		/* 默认模型：一行放下，左标题右下拉（全屏设置里纵向空间最贵）。 */
		.pm-default { gap: 12px; padding: 2px 0 14px; box-shadow: 0 0.5px 0 var(--line); flex-wrap: nowrap; }
		.pm-default .settings-row-main { flex: 0 0 auto; }
		.pm-default .settings-row-ctl { flex: 1 1 auto; min-width: 0; }
		.pm-default .pm-select { width: 100%; max-width: none; }
		.pm-select {
			height: 36px; padding: 0 34px 0 12px; max-width: 280px;
			border: 0.5px solid var(--line); border-radius: 10px;
			background: var(--ground); color: var(--ink); font: inherit; font-size: 13px;
		}
		.pm-list { display: flex; flex-direction: column; gap: 10px; margin-top: 14px; }
		.pm-card {
			border: 0.5px solid var(--line); border-radius: 12px; background: var(--ground);
			transition: border-color 140ms ease;
		}
		.pm-card[data-open="true"] { border-color: color-mix(in oklab, var(--ink) 24%, var(--line)); }
		/* 收起时只有一行：名字 + 状态 + 展开箭头。整行可点。 */
		.pm-row {
			display: flex; align-items: center; gap: 10px; width: 100%;
			min-height: 52px; padding: 0 12px 0 16px;
			border: 0; background: transparent; color: inherit; font: inherit; text-align: left;
			cursor: pointer; transition: background-color 120ms ease;
		}
		.pm-row:hover { background: var(--hover); }
		.pm-chev { flex: none; color: var(--ink-3); transition: transform 160ms cubic-bezier(0.32, 0.72, 0, 1); }
		.pm-card[data-open="true"] .pm-chev { transform: rotate(90deg); }
		.pm-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ink-3); flex: none; }
		.pm-dot[data-ok="true"] { background: #3fa66b; }
		.pm-name { font-size: 14px; font-weight: 500; color: var(--ink); }
		.pm-tag {
			display: inline-flex; align-items: center; height: 22px; padding: 0 8px;
			border-radius: 6px; background: var(--hover); color: var(--ink-3);
			font-size: 11px; font-family: ui-monospace, monospace;
		}
		.pm-spacer { flex: 1 1 auto; }
		.pm-btn {
			height: 30px; padding: 0 12px; border: 0; border-radius: 8px;
			background: var(--hover); color: var(--ink-2);
			font: inherit; font-size: 13px; cursor: pointer; white-space: nowrap;
			transition: background-color 120ms ease, color 120ms ease;
		}
		.pm-btn:hover { background: color-mix(in oklab, var(--ink) 14%, transparent); color: var(--ink); }
		.pm-btn[data-tone="ghost"] { background: transparent; box-shadow: inset 0 0 0 0.5px var(--line); }
		.pm-btn[data-tone="primary"] { background: var(--ink); color: var(--field); }
		.pm-btn[data-tone="primary"]:hover { background: var(--ink); color: var(--field); opacity: .86; }
		.pm-btn[data-tone="danger"] { background: transparent; color: var(--danger, #d9534f); }
		.pm-btn[data-tone="danger"]:hover { background: color-mix(in oklab, var(--danger, #d9534f) 14%, transparent); }
		.pm-btn[data-tone="danger"][data-armed="true"] { background: color-mix(in oklab, var(--danger, #d9534f) 18%, transparent); }
		.pm-btn:disabled { opacity: .45; cursor: default; }
		/* 展开的编辑区是一张嵌进去的卡：和外面的行不是同一层，眼睛才分得清。 */
		.pm-body {
			display: flex; flex-direction: column; gap: 14px;
			margin: 0 10px 10px; padding: 16px;
			border-radius: 10px; background: color-mix(in oklab, var(--ink) 4%, transparent);
			animation: pm-drop 160ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
		}
		@keyframes pm-drop {
			from { opacity: 0; transform: translateY(-4px); }
			to { opacity: 1; transform: none; }
		}
		.pm-field { display: flex; flex-direction: column; gap: 6px; }
		.pm-label { font-size: 13px; line-height: 17px; color: var(--ink-3); }
		.pm-input {
			height: 36px; padding: 0 12px; border: 0.5px solid var(--line); border-radius: 10px;
			background: var(--field); color: var(--ink); font: inherit; font-size: 13px; min-width: 0;
		}
		.pm-input:focus, .pm-select:focus { outline: none; border-color: color-mix(in oklab, var(--ink) 40%, var(--line)); }
		.pm-chips { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
		.pm-row-inline .pm-btn { height: 36px; }
		.pm-chip {
			display: inline-flex; align-items: center; gap: 4px; height: 26px; padding: 0 4px 0 10px;
			border-radius: 999px; background: var(--hover);
			font-size: 12px; color: var(--ink-2); font-family: ui-monospace, monospace;
		}
		.pm-chip button { border: 0; background: transparent; color: inherit; cursor: pointer; padding: 0 4px; font-size: 13px; }
		.pm-chip button:hover { color: var(--danger, #d9534f); }
		.pm-pick { display: flex; flex-wrap: wrap; gap: 6px; }
		.pm-pick button {
			height: 26px; padding: 0 9px; border: 0.5px dashed color-mix(in oklab, var(--ink) 24%, transparent);
			border-radius: 999px; background: transparent; color: var(--ink-3);
			font: inherit; font-size: 11.5px; font-family: ui-monospace, monospace; cursor: pointer;
		}
		.pm-pick button:hover { color: var(--ink); border-color: color-mix(in oklab, var(--ink) 44%, transparent); }
		.pm-foot { display: flex; align-items: center; gap: 8px; }
		.pm-add {
			margin-top: 14px; height: 48px;
			border: 0.5px dashed color-mix(in oklab, var(--ink) 26%, transparent); border-radius: 12px;
			background: transparent; color: var(--ink-2); font: inherit; font-size: 13px; cursor: pointer;
			transition: background-color 120ms ease, color 120ms ease, border-color 120ms ease;
		}
		.pm-add:hover {
			background: var(--hover); color: var(--ink);
			border-color: color-mix(in oklab, var(--ink) 44%, transparent);
		}
		.pm-start {
			display: flex; align-items: center; gap: 16px; margin-top: 18px; padding: 14px 16px;
			border: 0.5px solid var(--line); border-radius: 12px; background: var(--ground);
		}
		.pm-start p { margin: 0; font-size: 12.5px; line-height: 18px; color: var(--ink-3); }
		.pm-msg { margin: 10px 0 0; font-size: 12.5px; line-height: 18px; color: var(--ink-3); }
		.pm-msg[data-tone="error"] { color: var(--danger, #d9534f); }
		/* 右栏详情最上面那一行：他此刻用哪只模型。 */
		.pm-person { display: flex; flex-direction: column; gap: 8px; margin: 0 0 18px; }
		.pm-person .detail-sec-head { margin: 0; }
		.pm-person .pm-select { width: 100%; max-width: none; }
		.pm-person .pm-msg { margin: 0; }
	`,

	apply(ui) {
		const { h, React } = ui;
		const { useState, useEffect, useCallback } = React;

		async function call(path, body) {
			const response = await fetch(path, {
				method: body === undefined ? "GET" : "POST",
				headers: { "content-type": "application/json" },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
			const payload = await response.json().catch(() => ({}));
			if (payload.error !== undefined) throw new Error(payload.error);
			if (!response.ok) throw new Error(`接口返回 ${response.status}`);
			return payload;
		}

		/** 服务端形状 → 表单形状：密钥不带原文，输入框留空就是「用已保存的」。 */
		const toDraft = (data) => ({
			source: data.source ?? "",
			suggested: data.suggested, // 只有清单为空时才有：照现在生效的那一路抄一份
			defaultModel: data.defaultModel ?? "",
			providers: (data.providers ?? []).map((provider) => ({
				id: provider.id,
				name: provider.name,
				baseUrl: provider.baseUrl,
				api: provider.api,
				apiKey: "",
				keyHint: provider.keyHint,
				hasKey: provider.hasKey,
				models: [...provider.models],
			})),
		});

		function ProviderCard(props) {
			const { draft, index, open, busy, onToggle, onPatch, onDrop, onSave, onCancel } = props;
			const provider = draft.providers[index];
			const [probe, setProbe] = useState({ busy: false, error: "", models: [] });
			const [adding, setAdding] = useState("");
			/** 「删除」点过一次才真的删：`window.confirm` 在桌面壳里会被吞掉，点了像没反应。 */
			const [armed, setArmed] = useState(false);

			const runProbe = useCallback(() => {
				setProbe({ busy: true, error: "", models: [] });
				call("/api/p/models/probe", {
					providerId: provider.id,
					baseUrl: provider.baseUrl,
					apiKey: provider.apiKey,
					api: provider.api,
				})
					.then((body) => setProbe({ busy: false, error: "", models: body.models ?? [] }))
					.catch((error) => setProbe({ busy: false, error: error.message, models: [] }));
			}, [provider.id, provider.baseUrl, provider.apiKey, provider.api]);

			const addModel = (id) => {
				const model = id.trim();
				if (model === "" || provider.models.includes(model)) return;
				onPatch(index, { models: [...provider.models, model] });
			};

			const field = (label, control) => h("label", { className: "pm-field" }, h("span", { className: "pm-label" }, label), control);

			return h(
				"div",
				{ className: "pm-card", "data-open": open ? "true" : "false" },
				h(
					"button",
					{ type: "button", className: "pm-row", "aria-expanded": open ? "true" : "false", onClick: onToggle },
					h("span", { className: "pm-dot", "data-ok": provider.hasKey || provider.apiKey !== "" ? "true" : "false" }),
					h("span", { className: "pm-name" }, provider.name || provider.id),
					provider.name === provider.id ? null : h("span", { className: "pm-tag" }, provider.id),
					h("span", { className: "pm-spacer" }),
					h(
						"svg",
						{ className: "pm-chev", width: 8, height: 13, viewBox: "0 0 8 13", fill: "none", stroke: "currentColor", "stroke-width": 1.6, "stroke-linecap": "round" },
						h("path", { d: "m1.5 1.5 5 5-5 5" }),
					),
				),
				open
					? h(
							"div",
							{ className: "pm-body" },
							field(
								"显示名称",
								h("input", {
									className: "pm-input",
									value: provider.name,
									onChange: (event) => onPatch(index, { name: event.target.value }),
								}),
							),
							field(
								"API 地址",
								h("input", {
									className: "pm-input",
									value: provider.baseUrl,
									placeholder: "http://127.0.0.1:3425/v1",
									onChange: (event) => onPatch(index, { baseUrl: event.target.value }),
								}),
							),
							field(
								"API 协议",
								h(
									"select",
									{
										className: "pm-select",
										value: provider.api,
										onChange: (event) => onPatch(index, { api: event.target.value }),
									},
									h("option", { value: "openai-responses" }, "OpenAI Responses"),
									h("option", { value: "openai" }, "OpenAI Chat Completions"),
									h("option", { value: "anthropic" }, "Anthropic Messages"),
								),
							),
							field(
								"API 密钥",
								h("input", {
									className: "pm-input",
									type: "password",
									autoComplete: "off",
									value: provider.apiKey,
									placeholder:
										provider.keyHint === undefined
											? "本地网关可留空，其它提供商必填"
											: `留空沿用已保存的密钥（${provider.keyHint}）`,
									onChange: (event) => onPatch(index, { apiKey: event.target.value }),
								}),
							),
							h(
								"div",
								{ className: "pm-field" },
								h("span", { className: "pm-label" }, "模型目录"),
								h(
									"div",
									{ className: "pm-chips" },
									provider.models.map((model) =>
										h(
											"span",
											{ className: "pm-chip", key: model },
											model,
											h(
												"button",
												{
													type: "button",
													"aria-label": `去掉 ${model}`,
													onClick: () => onPatch(index, { models: provider.models.filter((item) => item !== model) }),
												},
												"×",
											),
										),
									),
								),
								h(
									"div",
									{ className: "pm-chips pm-row-inline", style: { marginTop: "8px" } },
									h("input", {
										className: "pm-input",
										style: { width: "220px" },
										value: adding,
										placeholder: "手动加一个模型 id",
										onChange: (event) => setAdding(event.target.value),
										onKeyDown: (event) => {
											if (event.key !== "Enter") return;
											event.preventDefault();
											addModel(adding);
											setAdding("");
										},
									}),
									h(
										"button",
										{ type: "button", className: "pm-btn", "data-tone": "ghost", disabled: probe.busy, onClick: runProbe },
										probe.busy ? "正在拉…" : "获取可用模型",
									),
								),
								probe.error === "" ? null : h("span", { className: "pm-msg", "data-tone": "error" }, probe.error),
								probe.models.length === 0
									? null
									: h(
											"div",
											{ className: "pm-pick", style: { marginTop: "8px" } },
											probe.models
												.filter((model) => !provider.models.includes(model.id))
												.slice(0, 40)
												.map((model) =>
													h(
														"button",
														{ type: "button", key: model.id, title: "加进模型目录", onClick: () => addModel(model.id) },
														`+ ${model.id}`,
													),
												),
										),
							),
							h(
								"div",
								{ className: "pm-foot" },
								h(
									"button",
									{
										type: "button",
										className: "pm-btn",
										"data-tone": "danger",
										"data-armed": armed ? "true" : "false",
										onClick: () => {
											if (!armed) {
												setArmed(true);
												return;
											}
											setArmed(false);
											onDrop();
										},
									},
									armed ? "确认删除" : "删除",
								),
								h("span", { className: "pm-spacer" }),
								h("button", { type: "button", className: "pm-btn", "data-tone": "ghost", onClick: onCancel }, "取消"),
								h(
									"button",
									{ type: "button", className: "pm-btn", "data-tone": "primary", disabled: busy, onClick: onSave },
									busy ? "保存中…" : "保存",
								),
							),
						)
					: null,
			);
		}

		function ModelSettings() {
			const [draft, setDraft] = useState(null);
			/** 整个「模型」条目展开没有：收起时设置里只占一行。 */
			const [show, setShow] = useState(false);
			const [open, setOpen] = useState("");
			const [state, setState] = useState({ busy: false, error: "", done: "" });

			useEffect(() => {
				let live = true;
				call("/api/p/models")
					.then((data) => live && setDraft(toDraft(data)))
					.catch((error) => live && setState({ busy: false, error: error.message, done: "" }));
				return () => {
					live = false;
				};
			}, []);

			const patch = (index, change) => {
				setDraft((current) => ({
					...current,
					providers: current.providers.map((provider, at) => (at === index ? { ...provider, ...change } : provider)),
				}));
			};

			/** 写一次 settings.json。整份草稿一起提交，成功才回填服务端的那一份。 */
			const save = (target) =>
				call("/api/p/models", { defaultModel: target.defaultModel, providers: target.providers })
					.then((data) => {
						setDraft(toDraft(data));
						setState({ busy: false, error: "", done: "已写入 settings.json · 已生效" });
						return true;
					})
					.catch((error) => {
						setState({ busy: false, error: error.message, done: "" });
						return false;
					});

			const submit = (target) => {
				setState({ busy: true, error: "", done: "" });
				return save(target);
			};

			/** 取消 = 把草稿退回磁盘上的那一份（这一版的编辑都是整份提交，没有逐字段撤销）。 */
			const reload = () => {
				setOpen("");
				setState({ busy: false, error: "", done: "" });
				call("/api/p/models")
					.then((data) => setDraft(toDraft(data)))
					.catch((error) => setState({ busy: false, error: error.message, done: "" }));
			};

			const addProvider = () => {
				const taken = new Set(draft.providers.map((provider) => provider.id));
				let id = "provider";
				for (let n = 2; taken.has(id); n += 1) id = `provider${n}`;
				setDraft({
					...draft,
					providers: [
						...draft.providers,
						{
							id,
							name: id,
							baseUrl: "http://127.0.0.1:3425/v1",
							api: "openai-responses",
							apiKey: "",
							models: [],
						},
					],
				});
				setOpen(id);
			};

			const dropProvider = (index) => {
				const next = { ...draft, providers: draft.providers.filter((_, at) => at !== index) };
				setDraft(next);
				if (open === draft.providers[index].id) setOpen("");
				void submit(next);
			};

			// 清单为空时给一个起手：照现在生效的那一路先摆一份出来，改地址 / 换模型都从这上面改。
			const starter =
				draft !== null && draft.providers.length === 0 && draft.suggested !== undefined
					? h(
							"div",
							{ className: "pm-start" },
							h(
								"div",
								{ className: "pm-start-main" },
								h("p", null, "还没有配置模型。先用本地网关起手，或自己填一份。"),
							),
							h("span", { className: "pm-spacer" }),
							h(
								"button",
								{
									type: "button",
									className: "pm-btn",
									"data-tone": "ghost",
									style: { flex: "none" },
									onClick: () =>
										setDraft({
											...draft,
											providers: [{ ...draft.suggested, apiKey: "", models: [...draft.suggested.models] }],
											defaultModel: "",
										}),
								},
								"加一份本地网关",
							),
						)
					: null;

			const choices = (draft === null ? [] : draft.providers).flatMap((provider) =>
				provider.models.map((model) => ({
					value: `${provider.id}/${model}`,
					label: `${provider.name || provider.id} · ${model}`,
				})),
			);

			// 收起时那一行右边写现在生效的是哪只；展开才看得见表单。
			const current =
				draft === null
					? ""
					: draft.defaultModel === ""
						? "自动"
						: (choices.find((choice) => choice.value === draft.defaultModel)?.label ?? draft.defaultModel);

			const head = h(
				"button",
				{
					type: "button",
					className: "set-row",
					"aria-expanded": show ? "true" : "false",
					onClick: () => setShow(!show),
				},
				h("span", { className: "set-ico", "aria-hidden": "true" }, icon),
				h("span", { className: "set-main" }, h("span", { className: "set-label" }, "模型")),
				h("span", { className: "pm-cur" }, current),
				h(
					"span",
					{ className: "set-chev", "aria-hidden": "true" },
					h(
						"svg",
						{ width: 8, height: 13, viewBox: "0 0 8 13", fill: "none", stroke: "currentColor", "stroke-width": 1.6, "stroke-linecap": "round" },
						h("path", { d: "m1.5 1.5 5 5-5 5" }),
					),
				),
			);

			if (draft === null) {
				return h(
					"div",
					{ className: "pm" },
					head,
					state.error === "" ? null : h("p", { className: "pm-msg", "data-tone": "error" }, state.error),
				);
			}

			if (!show) return h("div", { className: "pm" }, head);

			return h(
				"div",
				{ className: "pm" },
				head,
				h(
					"div",
					{ className: "pm-panel" },
					h(
					"div",
					{ className: "settings-row pm-default" },
					h("div", { className: "settings-row-main" }, h("span", { className: "settings-row-label" }, "默认模型")),
					h(
						"div",
						{ className: "settings-row-ctl" },
						h(
							"select",
							{
								className: "pm-select",
								value: draft.defaultModel,
								disabled: state.busy,
								onChange: (event) => {
									// 下拉换了就写盘：这是「设置」，不是要记得保存的表单。
									const next = { ...draft, defaultModel: event.target.value };
									setDraft(next);
									void submit(next);
								},
							},
							h("option", { value: "" }, "自动（第一家第一个模型）"),
							choices.map((choice) => h("option", { key: choice.value, value: choice.value }, choice.label)),
						),
					),
				),
				starter,
				h(
					"div",
					{ className: "pm-list" },
					draft.providers.map((provider, index) =>
						h(ProviderCard, {
							key: provider.id,
							draft,
							index,
							open: open === provider.id,
							busy: state.busy,
							onToggle: () => setOpen(open === provider.id ? "" : provider.id),
							onPatch: patch,
							onDrop: () => dropProvider(index),
							onSave: () => {
								void submit(draft).then((ok) => {
									if (ok) setOpen("");
								});
							},
							onCancel: reload,
						}),
					),
				),
				h("button", { type: "button", className: "pm-add", onClick: addProvider }, "+ 添加模型提供商"),
				state.error === "" ? null : h("p", { className: "pm-msg", "data-tone": "error" }, state.error),
				state.done === "" ? null : h("p", { className: "pm-msg" }, state.done),
				),
			);
		}

		/**
		 * 右栏「详情」最上面那一行：他此刻用哪只模型，当场能换。
		 *
		 * 这一格挂在 `rightPanel.detail` 上，宿主不传 props（插槽只有组件），所以人在哪儿
		 * 从界面状态里读：个人档案页看 `person`，私聊详情页看 `detail` 里除我以外的那个成员。
		 * 换模型走 `/api/people/:slug/model`：服务端当场改会话，并记进 settings.json 的
		 * `agentModels`（重启也认）。空的选项 = 跟默认。
		 */
		function PersonModel() {
			const person = ui.useStore((state) => state.person);
			const detail = ui.useStore((state) => state.detail);
			const slug =
				person !== null
					? person.slug
					: detail !== null && detail.channel.kind === "dm"
						? (detail.members.find((member) => member.slug !== "owner")?.slug ?? "")
						: "";

			const [catalog, setCatalog] = useState(null);
			const [current, setCurrent] = useState("");
			const [configured, setConfigured] = useState(0);
			const [pending, setPending] = useState(0);
			const [state, setState] = useState({ busy: false, error: "" });

			useEffect(() => {
				if (slug === "") return undefined;
				let alive = true;
				setState({ busy: false, error: "" });
				// 可选项来自**装配好的注册表**（`/api/models`），不是 settings.json：
				// 文件里刚加的提供商，内核读这份清单时会先就地装进注册表（ADR-025），不用等重启。
				Promise.all([ui.api.getModels(), call("/api/p/models"), ui.api.getPerson(slug)])
					.then(([live, configured, profile]) => {
						if (!alive) return;
						setCatalog(live);
						// settings.json 里有、注册表里还没有的模型数：一行提示，别让人对着选不了的项发呆。
						const inFile = configured.providers.reduce((total, provider) => total + provider.models.length, 0);
						setConfigured(inFile);
						setPending(Math.max(0, inFile - live.models.length));
						setCurrent(profile.model ?? "");
					})
					.catch((error) => {
						if (alive) setState({ busy: false, error: error.message });
					});
				return () => {
					alive = false;
				};
			}, [slug]);

			if (slug === "" || catalog === null) return null;

			const choices = catalog.models.map((model) => ({ value: model, label: model }));
			const fallback = catalog.defaultModel;

			// 一个能用的都没有：分两种说清楚——真没配，和配了但没装上（地址 / 协议不对）。
			// 后者写成「还没有配置模型」会把人送去设置页白改一遍（实测被这么问过）。
			if (choices.length === 0) {
				return h(
					"div",
					{ className: "pm-person" },
					h("div", { className: "detail-sec-head" }, "模型"),
					h(
						"p",
						{ className: "pm-msg" },
						configured === 0
							? "还没有配置模型：在 设置 → 模型 里加一份，他才能回话。"
							: `settings.json 里配了 ${configured} 个模型，一个都没装上：看一眼 设置 → 模型 里的地址 / 协议。`,
					),
				);
			}

			const value = current === "" || current === fallback ? "" : current;
			// 模型被删了：老引用还挂在会话上，列出来让人能看见并换掉，而不是假装他跟着默认。
			const stale = value !== "" && !choices.some((choice) => choice.value === value);

			const pick = (next) => {
				setState({ busy: true, error: "" });
				ui.api
					.setPersonModel(slug, next)
					.then((body) => {
						setCurrent(body.model === "" ? fallback : body.model);
						setState({ busy: false, error: "" });
					})
					.catch((error) => setState({ busy: false, error: error.message }));
			};

			return h(
				"div",
				{ className: "pm-person" },
				h("div", { className: "detail-sec-head" }, "模型"),
				h(
					"select",
					{
						className: "pm-select",
						value,
						disabled: state.busy,
						"aria-label": "他用的模型",
						onChange: (event) => pick(event.target.value),
					},
					h("option", { value: "" }, `跟随默认${fallback === "" ? "" : `（${fallback}）`}`),
					stale ? h("option", { value }, `${value}（已不存在）`) : null,
					choices.map((choice) => h("option", { key: choice.value, value: choice.value }, choice.label)),
				),
				state.error === "" ? null : h("p", { className: "pm-msg", "data-tone": "error" }, state.error),
				// 文件里配了、注册表里没有：说明那一份没装上，而不是让它在下拉里出现然后 400。
				pending === 0
					? null
					: h("p", { className: "pm-msg" }, `settings.json 里还有 ${pending} 个模型没装上：看一眼 设置 → 模型 里的地址 / 协议。`),
			);
		}

		/** 左栏那一格的小图标：两层叠在一起的方块，像一份配置清单。 */
		const icon = h(
			"svg",
			{ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinejoin: "round" },
			h("path", { d: "M4 8.5 12 4l8 4.5-8 4.5z" }),
			h("path", { d: "m4 13 8 4.5 8-4.5" }),
		);

		ui.register("settings.section", { id: "models", label: "模型", icon, component: ModelSettings });
		// 私聊 / 人物档案的「详情」最上面：他用的模型。没有配置模型时它自己说清楚。
		ui.register("rightPanel.detail", { id: "person-model", component: PersonModel });
	},
};
