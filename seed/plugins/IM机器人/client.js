/**
 * IM 机器人的前端：设置里一行入口，点开是一整页（`app.entry` + `app.page`）。
 *
 * 版式借 dsh-im：左边一排渠道，右边是「已接入的机器人」卡片；卡片收起是一行，
 * 点开才展开表单。数据只有后端真有的那几样 —— 状态、最近收到、说过话的聊天、
 * 触发方式与白名单；dsh-im 卡片上的「模型 / 思考强度 / Agent Preset / 工作区」
 * 在 Solo 里不属于这个插件（模型是那个人自己的事，工作区是助理私聊的），不画。
 *
 * 真正的连接在后端（`plugin.js`）：Telegram 主动拉取、Webhook 收发，页面关掉也照跑。
 */
const SLUG = "IM机器人";

/** 能接的渠道。`brand` 不落盘：Webhook 是看地址认出来的，Telegram 看 platform。 */
const BRANDS = [
	{
		id: "telegram",
		name: "Telegram",
		platform: "telegram",
		color: "#229ed9",
		hint: "Bot Token（@BotFather 给的）",
		placeholder: "123456:ABC…",
	},
	{
		id: "feishu",
		name: "飞书",
		platform: "webhook",
		color: "#3370ff",
		hint: "自定义机器人 Webhook 地址",
		placeholder: "https://open.feishu.cn/open-apis/bot/v2/hook/…",
	},
	{
		id: "dingtalk",
		name: "钉钉",
		platform: "webhook",
		color: "#3296fa",
		hint: "自定义机器人 Webhook 地址",
		placeholder: "https://oapi.dingtalk.com/robot/send?access_token=…",
	},
	{
		id: "wecom",
		name: "企业微信",
		platform: "webhook",
		color: "#2aae67",
		hint: "群机器人 Webhook 地址",
		placeholder: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…",
	},
	{
		id: "custom",
		name: "自定义",
		platform: "webhook",
		color: "#6b7280",
		hint: "任意能收 JSON 的地址",
		placeholder: "https://…",
	},
];

function brandOf(bot) {
	if (bot.platform === "telegram") return "telegram";
	const url = bot.webhookUrl ?? "";
	if (url.includes("feishu.cn") || url.includes("larksuite")) return "feishu";
	if (url.includes("dingtalk.com")) return "dingtalk";
	if (url.includes("qyapi.weixin.qq.com")) return "wecom";
	return "custom";
}

function brandById(id) {
	return BRANDS.find((brand) => brand.id === id) ?? BRANDS[0];
}

const BRAND_PATHS = {
	telegram: "M21 4 3.6 10.8c-.7.3-.7 1.2 0 1.5l4.6 1.6 1.7 5.2c.2.7 1.1.8 1.5.2l2.5-3.2 4.6 3.4c.6.4 1.4.1 1.6-.6L23 4.9c.2-.8-.6-1.4-1.3-1.1Z",
	feishu: "M4.5 5.5h15v13h-15zM4.5 10h15M9 5.5v13",
	dingtalk: "M13 3 5 14h5l-1 7 8-11h-5l1-7Z",
	wecom: "M4 6h11a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H9l-4 3v-3H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2ZM19 9h1a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-1v2.5L16 18h-3",
	custom: "M10 13a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1M14 11a5 5 0 0 0-7.1 0l-2 2A5 5 0 0 0 12 20.1l1.1-1.1",
};

function fmtTime(ms) {
	if (!ms) return "";
	const date = new Date(ms);
	const pad = (value) => String(value).padStart(2, "0");
	return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export default {
	id: SLUG,

	style: `
		.im {
			display: flex; flex-direction: column;
			height: 100%; min-width: 0; min-height: 0;
			background: var(--frame); container-type: inline-size;
		}
		.im-top {
			display: flex; flex: none; align-items: center; gap: 8px;
			min-height: 62px; padding: 0 14px 0 18px;
			border-bottom: 0.5px solid var(--rule);
		}
		.im-back {
			display: grid; place-items: center;
			width: 28px; height: 28px; padding: 0; flex: none;
			border: 0; border-radius: 8px; background: transparent;
			color: var(--ink-3); cursor: pointer;
		}
		.im-back:hover { background: var(--hover); color: var(--ink); }
		.im-top h2 { margin: 0; font-size: 15px; line-height: 21px; font-weight: 600; }
		.im-top p { margin: 1px 0 0; font-size: 11px; line-height: 15px; color: var(--ink-3); }
		.im-grow { flex: 1 1 auto; }
		.im-online {
			display: inline-flex; align-items: center; gap: 6px; flex: none;
			height: 28px; padding: 0 10px; border-radius: 8px;
			background: var(--raised); color: var(--ink-3);
			font-size: 11.5px; white-space: nowrap;
		}
		.im-online i { width: 6px; height: 6px; border-radius: 50%; background: #3fa66b; }
		.im-split { display: flex; flex: 1 1 auto; min-height: 0; }
		.im-rail {
			display: flex; flex-direction: column; gap: 2px; flex: none;
			width: 176px; padding: 12px 8px; overflow: auto;
			border-right: 0.5px solid var(--rule);
		}
		.im-rail-title {
			padding: 2px 8px 8px; font-size: 10.5px; letter-spacing: 0.04em;
			color: var(--ink-3); text-transform: uppercase;
		}
		.im-tab {
			display: flex; align-items: center; gap: 9px; width: 100%;
			min-height: 40px; padding: 0 9px; border: 0; border-radius: 9px;
			background: transparent; color: var(--ink-2); font: inherit; font-size: 13px;
			text-align: left; cursor: pointer;
		}
		.im-tab:hover { background: var(--hover); }
		.im-tab[data-on="true"] { background: var(--raised); color: var(--ink); }
		.im-tab b { font-weight: 500; }
		.im-main { flex: 1 1 auto; min-width: 0; min-height: 0; overflow: auto; padding: 16px clamp(14px, 2.4vw, 24px) 26px; }
		.im-main-head { display: flex; align-items: center; gap: 10px; margin: 0 0 12px; }
		.im-main-head h3 { margin: 0; font-size: 13px; line-height: 18px; font-weight: 600; }
		.im-main-head .im-add { margin-left: auto; flex: none; white-space: nowrap; }
		.im-note {
			margin: 0 0 12px; padding: 9px 11px; border-radius: 9px;
			background: var(--raised); color: var(--ink-3);
			font-size: 12px; line-height: 18px;
		}
		.im-empty { padding: 26px 2px; color: var(--ink-3); font-size: 13px; line-height: 21px; }
		.im-list { display: flex; flex-direction: column; gap: 10px; }
		.im-card { border-radius: 13px; background: var(--card); box-shadow: 0 0 0 0.5px var(--rule); overflow: hidden; }
		.im-row {
			display: flex; align-items: center; gap: 11px; width: 100%;
			min-height: 62px; padding: 10px 14px;
			border: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer;
		}
		.im-row:hover { background: var(--hover); }
		.im-logo { display: grid; place-items: center; flex: none; border-radius: 9px; }
		.im-title { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
		.im-title b { font-size: 14px; line-height: 19px; font-weight: 500; color: var(--ink); }
		.im-title span {
			font-size: 11.5px; line-height: 15px; color: var(--ink-3);
			font-family: var(--mono); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
		}
		.im-pill {
			display: inline-flex; align-items: center; gap: 6px; flex: none;
			margin-left: auto; height: 24px; padding: 0 9px; border-radius: 7px;
			background: var(--raised); color: var(--ink-3); font-size: 11.5px; white-space: nowrap;
		}
		.im-pill i { width: 6px; height: 6px; border-radius: 50%; background: var(--ink-3); }
		.im-pill[data-status="running"] i { background: #3fa66b; }
		.im-pill[data-status="starting"] i { background: #d99b2b; }
		.im-pill[data-status="error"] { color: var(--danger, #ec1313); }
		.im-pill[data-status="error"] i { background: var(--danger, #ec1313); }
		.im-when { flex: none; font-size: 11px; color: var(--ink-3); font-variant-numeric: tabular-nums; }
		.im-chev { flex: none; color: var(--ink-3); transition: transform 160ms cubic-bezier(0.32, 0.72, 0, 1); }
		.im-card[data-open="true"] .im-chev { transform: rotate(90deg); }
		.im-card-body { padding: 0 14px 14px; display: flex; flex-direction: column; gap: 12px; }
		.im-block {
			display: flex; flex-direction: column; gap: 8px;
			padding: 10px 12px; border-radius: 10px; background: var(--raised);
		}
		.im-kv { display: flex; align-items: baseline; gap: 12px; font-size: 12.5px; line-height: 18px; }
		.im-kv > span { flex: none; width: 74px; color: var(--ink-3); }
		.im-kv > b { font-weight: 500; color: var(--ink-2); min-width: 0; overflow: hidden; text-overflow: ellipsis; }
		.im-field { display: flex; flex-direction: column; gap: 5px; }
		.im-field > span { font-size: 12px; color: var(--ink-3); }
		.im-input, .im-select {
			height: 34px; padding: 0 10px; min-width: 0;
			border: 0.5px solid var(--line); border-radius: 9px;
			background: var(--field); color: var(--ink); font: inherit; font-size: 13px;
		}
		.im-input:focus, .im-select:focus { outline: none; border-color: color-mix(in oklab, var(--ink) 28%, var(--line)); }
		.im-two { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
		.im-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding-top: 2px; }
		.im-btn {
			height: 32px; padding: 0 12px; border: 0.5px solid var(--line); border-radius: 9px;
			background: var(--card); color: var(--ink); font: inherit; font-size: 12.5px; cursor: pointer;
			white-space: nowrap;
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
			padding: 3px 8px; border-radius: 6px; background: var(--field);
			color: var(--ink-3); font-size: 11.5px;
		}
		.im-code {
			padding: 8px 10px; border-radius: 8px; background: var(--raised);
			color: var(--ink-2); font-size: 11.5px; line-height: 17px;
			font-family: var(--mono); word-break: break-all;
		}
		/* 窄屏：左栏收成顶上一条横排渠道，卡片铺满。 */
		@container (max-width: 620px) {
			.im-top { min-height: 0; padding: 10px 12px; flex-wrap: wrap; gap: 6px 8px; }
			.im-top p, .im-top .im-grow { display: none; }
			.im-top .im-online { margin-left: auto; }
			.im-split { flex-direction: column; }
			.im-rail {
				flex-direction: row; width: auto; gap: 4px; padding: 8px 10px;
				overflow-x: auto; overflow-y: hidden;
				border-right: 0; border-bottom: 0.5px solid var(--rule);
			}
			.im-rail-title { display: none; }
			.im-tab { width: auto; flex: none; padding: 0 10px; }
			.im-main { padding: 12px 12px 22px; }
			.im-two { grid-template-columns: 1fr; }
			.im-when { display: none; }
			.im-kv > span { width: 64px; }
		}
	`,

	apply(ui) {
		const { h, React, register, store, useStore } = ui;
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

		/** 渠道图标：品牌色小方块 + 一条简单线稿（不搬别人的 logo）。 */
		function BrandIcon(props) {
			const { brand, size } = props;
			const px = size ?? 30;
			return h(
				"span",
				{
					className: "im-logo",
					style: { background: brandById(brand).color, width: `${String(px)}px`, height: `${String(px)}px` },
				},
				h(
					"svg",
					{ width: px * 0.56, height: px * 0.56, viewBox: "0 0 24 24", fill: "none", stroke: "#fff", strokeWidth: 1.9, strokeLinecap: "round", strokeLinejoin: "round" },
					h("path", { d: BRAND_PATHS[brand] ?? BRAND_PATHS.custom }),
				),
			);
		}

		const statusText = (bot) => {
			if (!bot.enabled) return "已停用";
			if (bot.status === "running") return "运行正常";
			if (bot.status === "starting") return "正在连…";
			if (bot.status === "error") return "连不上";
			return bot.status;
		};

		/** 卡片头上那一行灰字：凭据尾号，或者发消息的那个地址。 */
		const credential = (bot) => {
			if (bot.platform === "telegram") return bot.tokenHint === "" ? "还没填 Bot Token" : `Bot Token ${bot.tokenHint}`;
			if (bot.webhookUrl === "") return "还没填 Webhook 地址";
			return bot.webhookUrl.replace(/^https?:\/\//, "").split("?")[0];
		};

		function Fields(props) {
			const { brand, form, set, bot } = props;
			const placeholder = (value) => (bot?.tokenHint ? `已保存（尾号 ${bot.tokenHint.slice(-4)}），留空不改` : value);
			return h(
				React.Fragment,
				null,
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
							placeholder: brand.platform === "telegram" ? "我的 Telegram" : `我的${brand.name}机器人`,
							onChange: (event) => set({ name: event.target.value }),
						}),
					),
					h(
						"label",
						{ className: "im-field" },
						h("span", null, "群聊里怎么触发"),
						h(
							"select",
							{ className: "im-select", value: form.mode, onChange: (event) => set({ mode: event.target.value }) },
							h("option", { value: "mention" }, "被 @ 或回复机器人时才回"),
							h("option", { value: "all" }, "所有消息都回"),
						),
					),
				),
				brand.platform === "telegram"
					? h(
							"label",
							{ className: "im-field" },
							h("span", null, brand.hint),
							h("input", {
								className: "im-input",
								type: "password",
								value: form.token,
								placeholder: placeholder(brand.placeholder),
								onChange: (event) => set({ token: event.target.value }),
							}),
						)
					: h(
							React.Fragment,
							null,
							h(
								"label",
								{ className: "im-field" },
								h("span", null, `${brand.name} · ${brand.hint}`),
								h("input", {
									className: "im-input",
									value: form.webhookUrl,
									placeholder: brand.placeholder,
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
									placeholder: placeholder("设一个只有你和对方知道的口令"),
									onChange: (event) => set({ token: event.target.value }),
								}),
							),
						),
				h(
					"label",
					{ className: "im-field" },
					h("span", null, "私聊白名单（留空 = 谁都能聊）"),
					h("input", {
						className: "im-input",
						value: form.allow,
						placeholder: "逗号分隔的用户 id",
						onChange: (event) => set({ allow: event.target.value }),
					}),
				),
			);
		}

		function Card(props) {
			const { bot, assistant, assistantModel, open, onToggle, onChanged } = props;
			const [form, setForm] = useState(null);
			const [busy, setBusy] = useState(false);
			const [msg, setMsg] = useState({ text: "", tone: "" });
			const brand = brandById(brandOf(bot));
			const editing = form ?? {
				name: bot.name,
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
					platform: bot.platform,
					token: editing.token,
					webhookUrl: editing.webhookUrl,
					mode: editing.mode,
					allow: editing.allow.split(/[,，\s]+/).filter(Boolean),
					enabled: editing.enabled,
				})
					.then(() => {
						setForm(null);
						setMsg({ text: "已保存。", tone: "ok" });
						onChanged();
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
					.then(() => onChanged())
					.catch((error) => setMsg({ text: error.message, tone: "error" }))
					.finally(() => setBusy(false));
			};

			const lastChat = bot.chats[0];

			return h(
				"div",
				{ className: "im-card", "data-open": open ? "true" : "false" },
				h(
					"button",
					{ type: "button", className: "im-row", onClick: onToggle, "aria-expanded": open },
					h(BrandIcon, { brand: brand.id }),
					h(
						"span",
						{ className: "im-title" },
						h("b", null, bot.name),
						h("span", null, credential(bot)),
					),
					bot.lastInboundAt === 0 ? null : h("span", { className: "im-when" }, `最近收到 ${fmtTime(bot.lastInboundAt)}`),
					h(
						"span",
						{ className: "im-pill", "data-status": bot.enabled ? bot.status : "stopped", title: bot.lastError },
						h("i"),
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
							{ className: "im-card-body" },
							h(
								"div",
								{ className: "im-block" },
								h("div", { className: "im-kv" }, h("span", null, "当前私聊"), h("b", null, assistant === null ? "还没找到助理私聊" : `「${assistant.name}」`)),
								h(
									"div",
									{ className: "im-kv" },
									h("span", null, "助理模型"),
									h("b", null, assistantModel === "" ? "跟默认" : assistantModel),
								),
								h("div", { className: "im-kv" }, h("span", null, "回复窗口"), h("b", null, "最近说话的聊天 · 2 分钟内")),
								h(
									"div",
									{ className: "im-kv" },
									h("span", null, "最近说话"),
									h("b", null, lastChat === undefined ? "还没人说话" : `${lastChat.label} · ${fmtTime(lastChat.at)}`),
								),
								bot.lastError === "" ? null : h("div", { className: "im-kv" }, h("span", null, "上次出错"), h("b", { style: { color: "var(--danger, #ec1313)" } }, bot.lastError)),
								bot.detail === "" || bot.status !== "running" ? null : h("div", { className: "im-kv" }, h("span", null, "连接"), h("b", null, bot.detail)),
							),
							bot.chats.length <= 1
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
							h(Fields, { brand, form: editing, set, bot }),
							bot.platform === "webhook"
								? h(
										"div",
										{ className: "im-field" },
										h("span", null, "收消息的地址（让你的接入方往这里 POST）"),
										h(
											"div",
											{ className: "im-code" },
											`${window.location.origin}/api/p/im/in/${bot.id}?token=<接入口令>`,
										),
										h("span", { className: "im-msg" }, "正文：{ chatId, userId, name, chatTitle, text }"),
									)
								: null,
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

		function AddCard(props) {
			const brand = brandById(props.brandId);
			const [form, setForm] = useState({ name: "", token: "", webhookUrl: "", mode: "mention", allow: "" });
			const [busy, setBusy] = useState(false);
			const [error, setError] = useState("");
			const set = (patch) => setForm({ ...form, ...patch });
			const save = () => {
				setBusy(true);
				setError("");
				call("/api/p/im/bots", {
					name: form.name,
					platform: brand.platform,
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
					{ className: "im-card-body", style: { paddingTop: "14px" } },
					h(
						"div",
						{ className: "im-main-head", style: { margin: 0 } },
						h(BrandIcon, { brand: brand.id, size: 26 }),
						h("h3", null, `接入${brand.name}机器人`),
					),
					h(Fields, { brand, form, set, bot: null }),
					h(
						"div",
						{ className: "im-actions" },
						h("button", { type: "button", className: "im-btn", "data-primary": "true", disabled: busy, onClick: save }, "接入"),
						h("button", { type: "button", className: "im-btn", disabled: busy, onClick: props.onDone }, "取消"),
					),
					error === "" ? null : h("p", { className: "im-msg", "data-tone": "error" }, error),
				),
			);
		}

		function Page() {
			const inPanel = useStore((state) => state.rightPage === SLUG);
			const [data, setData] = useState(null);
			const [assistantModel, setAssistantModel] = useState("");
			const [error, setError] = useState("");
			const [brand, setBrand] = useState(BRANDS[0].id);
			const [adding, setAdding] = useState(false);
			const [openId, setOpenId] = useState("");

			const load = () => {
				call("/api/p/im")
					.then((body) => setData(body))
					.catch((err) => setError(err.message));
			};
			useEffect(load, []);
			// 卡片上那一行「助理模型」：助理自己用哪个模型（模型管理里改），只读。
			useEffect(() => {
				const slug = data?.assistant?.slug;
				if (slug === undefined) return;
				call(`/api/people/${encodeURIComponent(slug)}`)
					.then((profile) => setAssistantModel(profile.model ?? ""))
					.catch(() => setAssistantModel(""));
			}, [data]);

			const bots = data?.bots ?? [];
			const running = bots.filter((bot) => bot.enabled && bot.status === "running").length;
			const shown = bots.filter((bot) => brandOf(bot) === brand);

			return h(
				"section",
				{ className: "im", "aria-label": "IM 机器人" },
				h(
					"div",
					{ className: "im-top", "data-host": inPanel ? "panel" : "modal" },
					h(
						"button",
						{ type: "button", className: "im-back", "aria-label": "回到聊天", onClick: () => store.closePluginView() },
						h(
							"svg",
							{ width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" },
							h("path", { d: "M15 6l-6 6 6 6" }),
						),
					),
					h("div", null, h("h2", null, "IM 机器人"), h("p", null, "IM 里的消息进助理私聊，回复送回原聊天")),
					h("span", { className: "im-grow" }),
					bots.length === 0 ? null : h("span", { className: "im-online" }, h("i"), `${String(running)} / ${String(bots.length)} 在跑`),
				),
				h(
					"div",
					{ className: "im-split" },
					h(
						"nav",
						{ className: "im-rail", "aria-label": "渠道" },
						h("span", { className: "im-rail-title" }, "渠道"),
						BRANDS.map((item) =>
							h(
								"button",
								{
									key: item.id,
									type: "button",
									className: "im-tab",
									"data-on": brand === item.id ? "true" : "false",
									onClick: () => {
										setBrand(item.id);
										setAdding(false);
									},
								},
								h(BrandIcon, { brand: item.id, size: 22 }),
								h("b", null, item.name),
							),
						),
					),
					h(
						"div",
						{ className: "im-main" },
						h(
							"div",
							{ className: "im-main-head" },
							h("h3", null, "已接入的机器人"),
							h(
								"button",
								{ type: "button", className: "im-btn im-add", "data-primary": "true", onClick: () => setAdding(true), disabled: adding },
								"接入机器人",
							),
						),
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
									h(
										"div",
										{ className: "im-list" },
										adding ? h(AddCard, { brandId: brand, onDone: () => { setAdding(false); load(); } }) : null,
										shown.length === 0 && !adding
											? h(
													"p",
													{ className: "im-empty" },
													`还没有${brandById(brand).name}机器人。点右上角「接入机器人」${
														brand === "telegram" ? "，只要一个 Bot Token" : "，填它的 Webhook 地址"
													}。`,
												)
											: null,
										shown.map((bot) =>
											h(Card, {
												key: bot.id,
												bot,
												assistant: data.assistant,
												assistantModel,
												open: openId === bot.id,
												onToggle: () => setOpenId(openId === bot.id ? "" : bot.id),
												onChanged: load,
											}),
										),
									),
								),
					),
				),
			);
		}

		/** 设置页那一行入口：一个对话气泡 + 天线。 */
		function EntryRow() {
			const active = useStore((state) => state.pluginView === SLUG);
			return h(
				"button",
				{
					type: "button",
					className: "app-entry",
					id: "rail-im",
					"data-tip": "IM 机器人",
					"aria-label": "IM 机器人",
					"aria-current": active ? "true" : "false",
					onClick: () => store.openPluginView(SLUG),
				},
				h(
					"svg",
					{ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round" },
					h("path", { d: "M20 11.5a7.5 7.5 0 0 1-11 6.7L4 19.5l1.4-4.2A7.5 7.5 0 1 1 20 11.5Z" }),
					h("path", { d: "M9 11h6" }),
					h("path", { d: "M9 8.5h4" }),
				),
			);
		}

		register("app.entry", { id: "entry", component: EntryRow });
		register("app.page", { id: "page", label: "IM 机器人", component: Page });
	},
};
