/**
 * IM 机器人的前端：在「设置」里多一节「IM 机器人」。
 *
 * 只做清单和表单：读 `GET /api/p/im`，改完 `POST /api/p/im/bots`。真正的连接在
 * 后端（`plugin.js`）：Telegram 主动拉取、Webhook 收发，页面关掉也照跑。
 *
 * 版式跟着设置页：一条设置一行，卡片只画边框；机器人收起成一行，点开才展开表单。
 */
export default {
	id: "IM机器人",

	style: `
		.im { display: flex; flex-direction: column; margin: -12px -14px; }
		.im-head {
			display: flex; align-items: center; gap: 10px;
			padding: 14px 14px 12px;
			box-shadow: 0 0.5px 0 var(--line);
		}
		.im-head-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
		.im-head-main b { font-size: 14px; font-weight: 500; color: var(--ink); }
		.im-head-main span { font-size: 12px; line-height: 16px; color: var(--ink-3); }
		.im-head .im-add { margin-left: auto; flex: none; white-space: nowrap; }
		.im-body { padding: 12px 14px 14px; display: flex; flex-direction: column; gap: 10px; }
		.im-note {
			margin: 0; padding: 9px 11px; border-radius: 9px;
			background: var(--hover); color: var(--ink-3);
			font-size: 12px; line-height: 18px;
		}
		.im-empty { padding: 18px 2px 10px; color: var(--ink-3); font-size: 13px; line-height: 20px; }
		.im-card { border: 0.5px solid var(--line); border-radius: 12px; background: var(--ground); }
		.im-row {
			display: flex; align-items: center; gap: 10px; width: 100%;
			min-height: 52px; padding: 0 12px 0 14px;
			border: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer;
		}
		.im-row:hover { background: var(--hover); }
		.im-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ink-3); flex: none; }
		.im-dot[data-status="running"] { background: #3fa66b; }
		.im-dot[data-status="error"] { background: var(--danger, #ec1313); }
		.im-dot[data-status="starting"] { background: #d99b2b; }
		.im-name { font-size: 14px; font-weight: 500; color: var(--ink); }
		.im-tag {
			display: inline-flex; align-items: center; height: 22px; padding: 0 8px;
			border-radius: 6px; background: var(--hover); color: var(--ink-3);
			font-size: 11px; font-family: ui-monospace, monospace;
		}
		.im-status { margin-left: auto; font-size: 12px; color: var(--ink-3); max-width: 46%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.im-status[data-tone="error"] { color: var(--danger, #ec1313); }
		.im-chev { flex: none; color: var(--ink-3); transition: transform 160ms cubic-bezier(0.32, 0.72, 0, 1); }
		.im-card[data-open="true"] .im-chev { transform: rotate(90deg); }
		.im-form { padding: 4px 14px 14px; display: flex; flex-direction: column; gap: 10px; }
		.im-field { display: flex; flex-direction: column; gap: 5px; }
		.im-field > span { font-size: 12px; color: var(--ink-3); }
		.im-input, .im-select {
			height: 34px; padding: 0 10px; min-width: 0;
			border: 0.5px solid var(--line); border-radius: 9px;
			background: var(--ground); color: var(--ink); font: inherit; font-size: 13px;
		}
		.im-input:focus, .im-select:focus { outline: none; border-color: color-mix(in oklab, var(--ink) 28%, var(--line)); }
		.im-two { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
		@media (max-width: 560px) { .im-two { grid-template-columns: 1fr; } }
		.im-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding-top: 2px; }
		.im-btn {
			height: 32px; padding: 0 12px; border: 0.5px solid var(--line); border-radius: 9px;
			background: var(--ground); color: var(--ink); font: inherit; font-size: 12.5px; cursor: pointer;
		}
		.im-btn:hover { background: var(--hover); }
		.im-btn[data-primary="true"] { background: var(--ink); border-color: var(--ink); color: var(--ground); }
		.im-btn[data-danger="true"] { color: var(--danger, #ec1313); }
		.im-btn:disabled { opacity: 0.5; cursor: default; }
		.im-check { display: inline-flex; align-items: center; gap: 7px; font-size: 13px; color: var(--ink-2); }
		.im-msg { margin: 0; font-size: 12px; line-height: 18px; color: var(--ink-3); }
		.im-msg[data-tone="error"] { color: var(--danger, #ec1313); }
		.im-msg[data-tone="ok"] { color: #3fa66b; }
		.im-chats { display: flex; flex-wrap: wrap; gap: 6px; }
		.im-chat {
			padding: 3px 8px; border-radius: 6px; background: var(--hover);
			color: var(--ink-3); font-size: 11.5px;
		}
		.im-code {
			padding: 8px 10px; border-radius: 8px; background: var(--raised);
			color: var(--ink-2); font-size: 11.5px; line-height: 17px;
			font-family: ui-monospace, monospace; word-break: break-all;
		}
	`,

	apply(ui) {
		const { h, React, register } = ui;
		const { useEffect, useState } = React;

		async function call(path, body) {
			const response = await fetch(path, {
				...(body === undefined
					? {}
					: { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
			});
			const data = await response.json().catch(() => ({}));
			if (!response.ok) throw new Error(data.error ?? `HTTP ${String(response.status)}`);
			return data;
		}

		const blank = {
			id: "",
			name: "",
			platform: "telegram",
			token: "",
			webhookUrl: "",
			mode: "mention",
			allow: "",
			enabled: true,
		};

		const statusText = (bot) => {
			if (!bot.enabled) return "已停用";
			if (bot.status === "running") return bot.detail === "" ? "运行中" : `运行中 · ${bot.detail}`;
			if (bot.status === "starting") return "正在连…";
			if (bot.status === "error") return bot.lastError === "" ? "连不上" : bot.lastError;
			return bot.status;
		};

		function Card(props) {
			const { bot, open, onToggle } = props;
			const [form, setForm] = useState(null);
			const [busy, setBusy] = useState(false);
			const [msg, setMsg] = useState({ text: "", tone: "" });
			const editing = form ?? {
				id: bot.id,
				name: bot.name,
				platform: bot.platform,
				token: "",
				webhookUrl: bot.webhookUrl,
				mode: bot.mode,
				allow: bot.allow.join(", "),
				enabled: bot.enabled,
			};
			const set = (patch) => setForm({ ...editing, ...patch });

			const save = () => {
				setBusy(true);
				setMsg({ text: "", tone: "" });
				call("/api/p/im/bots", {
					id: bot.id,
					name: editing.name,
					platform: editing.platform,
					token: editing.token,
					webhookUrl: editing.webhookUrl,
					mode: editing.mode,
					allow: editing.allow.split(/[,，\s]+/).filter(Boolean),
					enabled: editing.enabled,
				})
					.then(() => {
						setForm(null);
						setMsg({ text: "已保存，连接状态见下面这一行。", tone: "ok" });
						props.onChanged();
					})
					.catch((error) => setMsg({ text: error.message, tone: "error" }))
					.finally(() => setBusy(false));
			};

			const test = () => {
				setBusy(true);
				setMsg({ text: "", tone: "" });
				call(`/api/p/im/bots/${encodeURIComponent(bot.id)}/test`, {})
					.then((data) => setMsg({ text: `测试消息已发到「${data.label}」`, tone: "ok" }))
					.catch((error) => setMsg({ text: error.message, tone: "error" }))
					.finally(() => setBusy(false));
			};

			const remove = () => {
				if (!window.confirm(`删掉「${bot.name}」？凭据一起删，不能恢复。`)) return;
				setBusy(true);
				call(`/api/p/im/bots/${encodeURIComponent(bot.id)}/delete`, {})
					.then(() => props.onChanged())
					.catch((error) => setMsg({ text: error.message, tone: "error" }))
					.finally(() => setBusy(false));
			};

			return h(
				"div",
				{ className: "im-card", "data-open": open ? "true" : "false" },
				h(
					"button",
					{ type: "button", className: "im-row", onClick: onToggle, "aria-expanded": open },
					h("span", { className: "im-dot", "data-status": bot.enabled ? bot.status : "stopped" }),
					h("span", { className: "im-name" }, bot.name),
					h("span", { className: "im-tag" }, bot.platform === "telegram" ? "Telegram" : "Webhook"),
					h(
						"span",
						{
							className: "im-status",
							"data-tone": bot.enabled && bot.status === "error" ? "error" : "",
							title: bot.lastError,
						},
						statusText(bot),
					),
					h(
						"svg",
						{ className: "im-chev", width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" },
						h("path", { d: "m9 6 6 6-6 6" }),
					),
				),
				!open
					? null
					: h(
							"div",
							{ className: "im-form" },
							h(
								"div",
								{ className: "im-two" },
								h(
									"label",
									{ className: "im-field" },
									h("span", null, "名字"),
									h("input", {
										className: "im-input",
										value: editing.name,
										placeholder: "我的 Telegram",
										onChange: (event) => set({ name: event.target.value }),
									}),
								),
								h(
									"label",
									{ className: "im-field" },
									h("span", null, "渠道"),
									h(
										"select",
										{
											className: "im-select",
											value: editing.platform,
											onChange: (event) => set({ platform: event.target.value }),
										},
										h("option", { value: "telegram" }, "Telegram"),
										h("option", { value: "webhook" }, "Webhook（飞书 / 钉钉 / 企业微信）"),
									),
								),
							),
							editing.platform === "telegram"
								? h(
										"label",
										{ className: "im-field" },
										h("span", null, "Bot Token"),
										h("input", {
											className: "im-input",
											type: "password",
											value: editing.token,
											placeholder: bot.tokenHint === "" ? "123456:ABC…" : `已保存（尾号 ${bot.tokenHint.slice(-4)}），留空不改`,
											onChange: (event) => set({ token: event.target.value }),
										}),
									)
								: h(
										"label",
										{ className: "im-field" },
										h("span", null, "Webhook 地址（发消息用）"),
										h("input", {
											className: "im-input",
											value: editing.webhookUrl,
											placeholder: "https://open.feishu.cn/open-apis/bot/v2/hook/…",
											onChange: (event) => set({ webhookUrl: event.target.value }),
										}),
									),
							editing.platform === "webhook"
								? h(
										"div",
										{ className: "im-field" },
										h("span", null, "收消息的地址（让你的接入方往这里 POST）"),
										h(
											"div",
											{ className: "im-code" },
											`${window.location.origin}/api/p/im/in/${bot.id}?token=<这个机器人的 Token>`,
										),
										h("input", {
											className: "im-input",
											type: "password",
											value: editing.token,
											placeholder: bot.tokenHint === "" ? "设一个接入口令" : `已保存（尾号 ${bot.tokenHint.slice(-4)}），留空不改`,
											onChange: (event) => set({ token: event.target.value }),
										}),
										h("span", { className: "im-msg" }, "正文：{ chatId, userId, name, chatTitle, text }"),
									)
								: null,
							h(
								"div",
								{ className: "im-two" },
								h(
									"label",
									{ className: "im-field" },
									h("span", null, "群聊里怎么触发"),
									h(
										"select",
										{
											className: "im-select",
											value: editing.mode,
											onChange: (event) => set({ mode: event.target.value }),
										},
										h("option", { value: "mention" }, "被 @ 或回复机器人时才回"),
										h("option", { value: "all" }, "所有消息都回"),
									),
								),
								h(
									"label",
									{ className: "im-field" },
									h("span", null, "私聊白名单（留空 = 谁都能聊）"),
									h("input", {
										className: "im-input",
										value: editing.allow,
										placeholder: "逗号分隔的用户 id",
										onChange: (event) => set({ allow: event.target.value }),
									}),
								),
							),
							bot.chats.length === 0
								? null
								: h(
										"div",
										{ className: "im-field" },
										h("span", null, "最近说过话的聊天"),
										h(
											"div",
											{ className: "im-chats" },
											bot.chats.map((chat) => h("span", { className: "im-chat", key: chat.id }, chat.label)),
										),
									),
							h(
								"div",
								{ className: "im-actions" },
								h("button", { type: "button", className: "im-btn", "data-primary": "true", disabled: busy, onClick: save }, "保存"),
								h("button", { type: "button", className: "im-btn", disabled: busy, onClick: test }, "发条测试消息"),
								h(
									"label",
									{ className: "im-check" },
									h("input", {
										type: "checkbox",
										checked: editing.enabled,
										onChange: (event) => set({ enabled: event.target.checked }),
									}),
									"启用",
								),
								h(
									"button",
									{ type: "button", className: "im-btn", "data-danger": "true", disabled: busy, onClick: remove, style: { marginLeft: "auto" } },
									"删除",
								),
							),
							msg.text === "" ? null : h("p", { className: "im-msg", "data-tone": msg.tone }, msg.text),
						),
			);
		}

		function AddForm(props) {
			const [form, setForm] = useState(blank);
			const [busy, setBusy] = useState(false);
			const [error, setError] = useState("");
			const set = (patch) => setForm({ ...form, ...patch });
			const save = () => {
				setBusy(true);
				setError("");
				call("/api/p/im/bots", {
					name: form.name,
					platform: form.platform,
					token: form.token,
					webhookUrl: form.webhookUrl,
					mode: form.mode,
					allow: form.allow.split(/[,，\s]+/).filter(Boolean),
					enabled: true,
				})
					.then(() => props.onDone())
					.catch((err) => setError(err.message))
					.finally(() => setBusy(false));
			};
			return h(
				"div",
				{ className: "im-card", "data-open": "true" },
				h(
					"div",
					{ className: "im-form" },
					h(
						"div",
						{ className: "im-two" },
						h(
							"label",
							{ className: "im-field" },
							h("span", null, "名字"),
							h("input", {
								className: "im-input",
								value: form.name,
								placeholder: "给这个机器人起个名字",
								onChange: (event) => set({ name: event.target.value }),
							}),
						),
						h(
							"label",
							{ className: "im-field" },
							h("span", null, "渠道"),
							h(
								"select",
								{ className: "im-select", value: form.platform, onChange: (event) => set({ platform: event.target.value }) },
								h("option", { value: "telegram" }, "Telegram"),
								h("option", { value: "webhook" }, "Webhook（飞书 / 钉钉 / 企业微信）"),
							),
						),
					),
					form.platform === "telegram"
						? h(
								"label",
								{ className: "im-field" },
								h("span", null, "Bot Token（@BotFather 给的）"),
								h("input", {
									className: "im-input",
									value: form.token,
									placeholder: "123456:ABC…",
									onChange: (event) => set({ token: event.target.value }),
								}),
							)
						: h(
								"div",
								null,
								h(
									"label",
									{ className: "im-field" },
									h("span", null, "Webhook 地址（发消息用）"),
									h("input", {
										className: "im-input",
										value: form.webhookUrl,
										placeholder: "https://…",
										onChange: (event) => set({ webhookUrl: event.target.value }),
									}),
								),
								h(
									"label",
									{ className: "im-field" },
									h("span", null, "接入口令（对方 POST 回来时要带上）"),
									h("input", {
										className: "im-input",
										type: "password",
										value: form.token,
										placeholder: "设一个只有你和对方知道的口令",
										onChange: (event) => set({ token: event.target.value }),
									}),
								),
							),
					h(
						"div",
						{ className: "im-actions" },
						h("button", { type: "button", className: "im-btn", "data-primary": "true", disabled: busy, onClick: save }, "添加"),
						h("button", { type: "button", className: "im-btn", disabled: busy, onClick: props.onDone }, "取消"),
					),
					error === "" ? null : h("p", { className: "im-msg", "data-tone": "error" }, error),
				),
			);
		}

		function ImSettings() {
			const [data, setData] = useState(null);
			const [error, setError] = useState("");
			const [openId, setOpenId] = useState("");
			const [adding, setAdding] = useState(false);

			const load = () => {
				call("/api/p/im")
					.then((body) => setData(body))
					.catch((err) => setError(err.message));
			};
			useEffect(load, []);

			return h(
				"div",
				{ className: "im" },
				h(
					"div",
					{ className: "im-head" },
					h(
						"div",
						{ className: "im-head-main" },
						h("b", null, "IM 机器人"),
						h("span", null, "IM 里的消息进助理私聊，助理的回复送回原聊天"),
					),
					h(
						"button",
						{ type: "button", className: "im-btn im-add", onClick: () => setAdding(true), disabled: adding },
						"添加机器人",
					),
				),
				h(
					"div",
					{ className: "im-body" },
					data === null
						? h("p", { className: "im-empty" }, error === "" ? "读取中…" : error)
						: h(
								React.Fragment,
								null,
								data.assistant === null
									? h("p", { className: "im-msg", "data-tone": "error" }, "还没找到助理私聊：先在 Solo 里和助理说一句话，再回来。")
									: h(
											"p",
											{ className: "im-note" },
											`所有机器人都接到「${data.assistant.name}」这条私聊。一条回复会送回最近说话的那个聊天（两分钟内）；只收文字。`,
										),
								data.bots.length === 0 && !adding
									? h("p", { className: "im-empty" }, "还没有机器人。点右上角「添加机器人」，Telegram 只要一个 Bot Token。")
									: null,
								data.bots.map((bot) =>
									h(Card, {
										key: bot.id,
										bot,
										open: openId === bot.id,
										onToggle: () => setOpenId(openId === bot.id ? "" : bot.id),
										onChanged: load,
									}),
								),
								adding
									? h(AddForm, {
											onDone: () => {
												setAdding(false);
												load();
											},
										})
									: null,
							),
				),
			);
		}

		/** 左栏那一格的小图标：一个对话气泡 + 天线。 */
		const icon = h(
			"svg",
			{ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round" },
			h("path", { d: "M20 11.5a7.5 7.5 0 0 1-11 6.7L4 19.5l1.4-4.2A7.5 7.5 0 1 1 20 11.5Z" }),
			h("path", { d: "M9 11h6" }),
			h("path", { d: "M9 8.5h4" }),
		);

		register("settings.section", { id: "im-bots", label: "IM 机器人", icon, component: ImSettings });
	},
};
