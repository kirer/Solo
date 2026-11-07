/**
 * 悬浮球：任何一屏都能直接跟助理说一句。
 *
 * 交互借 [dsh-orb-cordis](https://github.com/mini-yifan/dsh-orb-cordis) 的那颗球：
 * 贴右边、悬停展开、点击钉住、拖走、拖出右缘收成一条、右键菜单。但**不搬它的形态**——
 * Solo 里没有第二个 Electron 进程、没有 Computer Use，球只是一个浮着的「助理私聊」入口：
 * 说的是同一批消息，走的是同一条 `/api/channels/:id`，历史与已读都跟着那条私聊。
 *
 * 数据只有两处：频道列表 / 当前频道详情来自 `store`（SSE 在推）；不在当前频道时，
 * 面板打开期间按需 `api.getChannel` 拉一次，之后每 4 秒补一次。没有本地账本。
 *
 * 纯前端插件：不注册路由、不加工具、不另开会话。
 */

const SLUG = "悬浮球";
const PREF_KEY = "solo.orb";
/** 球的直径（px）。拖动与贴边的计算都用它。 */
const BALL = 46;
/** 拖过右缘多近算「贴边」。 */
const DOCK_AT = 12;

/** 位置与贴边状态记在本机：换个屏幕再打开，球还在你放下的地方。 */
function readPrefs() {
	try {
		const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(PREF_KEY);
		if (raw === null) return { right: 18, top: null, docked: false };
		const value = JSON.parse(raw);
		return {
			right: Number.isFinite(value?.right) ? value.right : 18,
			top: Number.isFinite(value?.top) ? value.top : null,
			docked: value?.docked === true,
		};
	} catch {
		return { right: 18, top: null, docked: false };
	}
}

function savePrefs(next) {
	try {
		if (typeof localStorage !== "undefined") localStorage.setItem(PREF_KEY, JSON.stringify(next));
	} catch {
		// 存不了就只在这次里生效，不影响用。
	}
}

function clamp(value, low, high) {
	return Math.min(high, Math.max(low, value));
}

/** 一条消息的时间：一分钟内「刚刚」，一小时内「N 分钟前」，再久给时分。 */
function ago(at) {
	const gap = Date.now() - at;
	if (gap < 60_000) return "刚刚";
	if (gap < 3_600_000) return `${String(Math.floor(gap / 60_000))} 分钟前`;
	const date = new Date(at);
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export default {
	id: SLUG,

	style: `
		/* 整块浮在最上层：只有球和面板接事件，别的地方不挡点击。 */
		.orb { position: fixed; z-index: 70; pointer-events: none; }
		.orb-ball {
			pointer-events: auto;
			position: relative;
			display: grid; place-items: center;
			width: 46px; height: 46px; padding: 0;
			border: 0; border-radius: 50%;
			background:
				radial-gradient(120% 120% at 32% 26%, rgb(255 255 255 / 0.42), transparent 44%),
				radial-gradient(110% 110% at 70% 82%, color-mix(in oklab, var(--accent) 52%, transparent), transparent 62%),
				linear-gradient(158deg, color-mix(in oklab, var(--accent-solid) 42%, rgb(44 48 56)), rgb(13 15 19));
			box-shadow: inset 0 1px 1px rgb(255 255 255 / 0.28), 0 10px 26px rgb(0 0 0 / 0.28);
			cursor: grab; touch-action: none;
			transition: transform 160ms ease, box-shadow 160ms ease;
		}
		.orb-ball:hover { transform: scale(1.05); box-shadow: inset 0 1px 1px rgb(255 255 255 / 0.3), 0 14px 32px rgb(0 0 0 / 0.3); }
		.orb-ball:active { cursor: grabbing; }
		.orb[data-open="true"] .orb-ball { cursor: pointer; }
		/* 贴边：只留一条边。悬停滑出来，松手不动它就还回去 —— 和 dsh 那颗球一个意思。 */
		.orb[data-docked="true"] .orb-ball { transform: translateX(34px); }
		.orb[data-docked="true"] .orb-ball:hover { transform: none; }

		/* 球心的高光点：让眼睛认出这是「一颗球」，不是一枚按钮。 */
		.orb-core {
			width: 13px; height: 13px; border-radius: 50%;
			background: radial-gradient(circle at 35% 30%, rgb(255 255 255 / 0.95), rgb(255 255 255 / 0.25) 62%, transparent 70%);
			opacity: 0.85;
		}
		/* 正在跑：一圈转着的弧。只在这一轮里存在，结算即消失。 */
		.orb-ring {
			position: absolute; inset: -5px; border-radius: 50%;
			background: conic-gradient(from 0deg, transparent 0 190deg, var(--accent) 330deg, transparent 360deg);
			-webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 2px));
			mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 2px));
			animation: orb-spin 1.5s linear infinite;
			pointer-events: none;
		}
		@keyframes orb-spin { to { transform: rotate(360deg); } }
		.orb-badge {
			position: absolute; top: -3px; right: -3px;
			min-width: 17px; height: 17px; padding: 0 4px;
			border-radius: 999px; box-sizing: border-box;
			background: var(--accent-solid); color: var(--on-accent);
			font-size: 10px; line-height: 17px; font-weight: 600;
			font-variant-numeric: tabular-nums; text-align: center;
		}

		.orb-panel {
			pointer-events: auto;
			position: absolute; right: 54px; top: 0;
			display: flex; flex-direction: column;
			width: min(320px, calc(100vw - 84px));
			max-height: min(480px, calc(100dvh - 32px));
			background: var(--ground);
			border: 0.5px solid var(--line);
			border-radius: 16px;
			box-shadow: var(--shadow, 0 18px 48px rgb(0 0 0 / 0.22));
			overflow: hidden;
			animation: orb-in 140ms ease;
		}
		/* 球在下半屏时面板往上长，别探出窗口底。 */
		.orb[data-up="true"] .orb-panel { top: auto; bottom: 0; }
		@keyframes orb-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
		@media (prefers-reduced-motion: reduce) {
			.orb-ball, .orb-panel, .orb-ring { transition: none; animation: none; }
		}

		.orb-head {
			display: flex; flex: none; align-items: center; gap: 8px;
			padding: 10px 12px; border-bottom: 0.5px solid var(--rule);
		}
		.orb-state { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--ink-3); }
		.orb-state[data-busy="true"] { background: var(--live, var(--accent)); box-shadow: 0 0 0 3px var(--accent-dim); }
		.orb-who { display: flex; flex-direction: column; min-width: 0; }
		.orb-who b { font-size: 12.5px; line-height: 17px; font-weight: 600; color: var(--ink); }
		.orb-who span { font-size: 11px; line-height: 15px; color: var(--ink-3); }
		.orb-grow { flex: 1 1 auto; }
		.orb-ghost {
			flex: none; height: 26px; padding: 0 9px;
			border: 0; border-radius: 8px; background: transparent;
			color: var(--ink-3); font: inherit; font-size: 11.5px; cursor: pointer;
		}
		.orb-ghost:hover { background: var(--hover); color: var(--ink); }

		.orb-list {
			flex: 1 1 auto; min-height: 60px; overflow: auto;
			display: flex; flex-direction: column; gap: 10px;
			padding: 10px 12px;
		}
		.orb-msg { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
		.orb-msg[data-me="true"] { align-items: flex-end; }
		.orb-from { font-size: 10.5px; line-height: 14px; color: var(--ink-3); }
		.orb-text {
			margin: 0; max-width: 100%; max-height: 132px; overflow: auto;
			padding: 6px 9px; border-radius: 10px;
			background: var(--field); border: 0.5px solid var(--rule);
			color: var(--ink-2); font-size: 12.5px; line-height: 19px;
			white-space: pre-wrap; word-break: break-word;
		}
		.orb-msg[data-me="true"] .orb-text { background: var(--accent-dim); border-color: transparent; color: var(--ink); }
		.orb-empty { margin: auto; padding: 18px; color: var(--ink-3); font-size: 12px; line-height: 19px; text-align: center; }
		.orb-error { margin: 0; padding: 0 12px 8px; color: var(--danger); font-size: 11.5px; line-height: 16px; }

		.orb-form {
			display: flex; flex: none; align-items: flex-end; gap: 8px;
			padding: 9px 10px; border-top: 0.5px solid var(--rule);
		}
		.orb-input {
			flex: 1 1 auto; min-width: 0;
			min-height: 32px; max-height: 92px; resize: none;
			padding: 7px 9px; box-sizing: border-box;
			border: 0.5px solid var(--control); border-radius: 10px;
			background: var(--field); color: var(--ink);
			font: inherit; font-size: 12.5px; line-height: 18px;
		}
		.orb-input:focus { outline: none; border-color: var(--accent); }
		.orb-send {
			flex: none; height: 32px; padding: 0 12px;
			border: 0; border-radius: 9px;
			background: var(--accent-solid); color: var(--on-accent);
			font: inherit; font-size: 12.5px; cursor: pointer;
		}
		.orb-send:disabled { opacity: 0.45; cursor: default; }

		.orb-menu {
			pointer-events: auto;
			position: absolute; right: 54px; top: 0;
			min-width: 148px; padding: 5px;
			background: var(--ground); border: 0.5px solid var(--line);
			border-radius: 12px; box-shadow: var(--shadow, 0 18px 48px rgb(0 0 0 / 0.22));
		}
		.orb[data-up="true"] .orb-menu { top: auto; bottom: 0; }
		.orb-menu button {
			display: block; width: 100%; padding: 7px 9px;
			border: 0; border-radius: 8px; background: transparent;
			color: var(--ink); font: inherit; font-size: 12.5px; text-align: left; cursor: pointer;
		}
		.orb-menu button:hover { background: var(--hover); }
		.orb-menu button:disabled { color: var(--ink-3); cursor: default; }
		.orb-menu button:disabled:hover { background: transparent; }
	`,

	apply(ui) {
		const { h, React, api, store, useStore } = ui;
		const { useEffect, useRef, useState } = React;

		function Orb() {
			const people = useStore((state) => state.people);
			const channels = useStore((state) => state.channels);
			const currentId = useStore((state) => state.currentId);
			const liveDetail = useStore((state) => state.detail);
			const setupStep = useStore((state) => state.setupStep);

			const assistant = people.find((person) => person.assistant === true);
			const dm =
				assistant === undefined
					? undefined
					: channels.find((channel) => channel.kind === "dm" && channel.members.includes(assistant.slug));
			const dmId = dm?.id ?? null;

			const [prefs] = useState(readPrefs);
			const [right, setRight] = useState(prefs.right);
			const [top, setTop] = useState(() =>
				prefs.top ?? Math.round((typeof window === "undefined" ? 640 : window.innerHeight) * 0.36),
			);
			const [docked, setDocked] = useState(prefs.docked);
			const [open, setOpen] = useState(false);
			const [pinned, setPinned] = useState(false);
			const [menu, setMenu] = useState(false);
			const [draft, setDraft] = useState("");
			const [detail, setDetail] = useState(null);
			const [error, setError] = useState("");
			const [sending, setSending] = useState(false);

			const drag = useRef(null);
			const skipClick = useRef(false);
			const hoverTimer = useRef(0);
			const listRef = useRef(null);
			const menuRef = useRef(null);

			// 正在看的这条私聊：直接吃 store（SSE 在推）；别的频道才用自己拉的那份。
			const shown = currentId === dmId ? liveDetail : detail;
			const messages = (shown?.messages ?? []).filter((message) => message.kind === "chat").slice(-14);
			const activity = assistant?.activity;
			const busy = activity !== undefined;
			const unread = dm?.unread ?? 0;
			const up = typeof window !== "undefined" && top > window.innerHeight / 2;

			const cancelHover = () => {
				if (hoverTimer.current !== 0) {
					clearTimeout(hoverTimer.current);
					hoverTimer.current = 0;
				}
			};

			const closeAll = () => {
				cancelHover();
				setOpen(false);
				setPinned(false);
				setMenu(false);
			};

			// 打开期间补消息：正在看这条私聊时 store 已经在推，不用再拉。
			useEffect(() => {
				if (!open || dmId === null || currentId === dmId) return undefined;
				let alive = true;
				const pull = async () => {
					try {
						const next = await api.getChannel(dmId, 20);
						if (alive) setDetail(next);
					} catch {
						// 拉不到就保持上一次的样子，下一次再试。
					}
				};
				void pull();
				const timer = setInterval(() => void pull(), 4000);
				return () => {
					alive = false;
					clearInterval(timer);
				};
			}, [open, dmId, currentId]);

			// 新消息来了滚到底 —— 和聊天区同一条规矩：打开着才追。
			useEffect(() => {
				const node = listRef.current;
				if (open && node !== null) node.scrollTop = node.scrollHeight;
			}, [open, messages.length, dmId]);

			// Esc 收起；菜单开着时先收菜单。
			useEffect(() => {
				if (!open && !menu) return undefined;
				const onKey = (event) => {
					if (event.key !== "Escape") return;
					if (menu) setMenu(false);
					else closeAll();
				};
				document.addEventListener("keydown", onKey);
				return () => document.removeEventListener("keydown", onKey);
			}, [open, menu]);

			// 点别处收菜单。
			useEffect(() => {
				if (!menu) return undefined;
				const onDown = (event) => {
					if (menuRef.current !== null && !menuRef.current.contains(event.target)) setMenu(false);
				};
				document.addEventListener("pointerdown", onDown);
				return () => document.removeEventListener("pointerdown", onDown);
			}, [menu]);

			// 窗口变小了把球拉回可见范围（手机上转屏就会遇到）。
			useEffect(() => {
				const onResize = () => {
					if (typeof window === "undefined") return;
					setRight((value) => clamp(value, 0, Math.max(0, window.innerWidth - BALL - 8)));
					setTop((value) => clamp(value, 8, Math.max(8, window.innerHeight - BALL - 8)));
				};
				onResize();
				window.addEventListener("resize", onResize);
				return () => window.removeEventListener("resize", onResize);
			}, []);

			const enter = () => {
				cancelHover();
				if (docked || drag.current !== null) return;
				hoverTimer.current = window.setTimeout(() => setOpen(true), 160);
			};

			const leave = () => {
				cancelHover();
				if (pinned || drag.current !== null) return;
				hoverTimer.current = window.setTimeout(() => {
					setOpen(false);
					setMenu(false);
				}, 320);
			};

			const onPointerDown = (event) => {
				if (event.button !== 0) return;
				cancelHover();
				drag.current = {
					x: event.clientX,
					y: event.clientY,
					right,
					top,
					docked,
					moved: false,
					lastRight: right,
					lastTop: top,
				};
				skipClick.current = false;
				event.currentTarget.setPointerCapture?.(event.pointerId);
			};

			const onPointerMove = (event) => {
				const state = drag.current;
				if (state === null) return;
				const dx = event.clientX - state.x;
				const dy = event.clientY - state.y;
				if (!state.moved && Math.abs(dx) + Math.abs(dy) < 5) return;
				state.moved = true;
				const nextRight = clamp(state.right - dx, 0, Math.max(0, window.innerWidth - BALL - 8));
				const nextTop = clamp(state.top + dy, 8, Math.max(8, window.innerHeight - BALL - 8));
				state.lastRight = nextRight;
				state.lastTop = nextTop;
				setRight(nextRight);
				setTop(nextTop);
				// 从贴边状态拖出来一段就解贴。
				if (state.docked && nextRight > 64) {
					state.docked = false;
					setDocked(false);
				}
			};

			const onPointerUp = () => {
				const state = drag.current;
				drag.current = null;
				if (state === null || !state.moved) return;
				skipClick.current = true;
				const nextDocked = state.lastRight < DOCK_AT;
				setDocked(nextDocked);
				if (nextDocked) setRight(0);
				savePrefs({ right: nextDocked ? 0 : state.lastRight, top: state.lastTop, docked: nextDocked });
				setOpen(false);
				setPinned(false);
			};

			const onClick = () => {
				if (skipClick.current) {
					skipClick.current = false;
					return;
				}
				if (docked) {
					// 贴着边点一下 = 把它请出来，并钉住。
					setDocked(false);
					savePrefs({ right: 18, top, docked: false });
					setRight(18);
					setOpen(true);
					setPinned(true);
					return;
				}
				if (pinned) {
					setPinned(false);
					setOpen(false);
					return;
				}
				setPinned(true);
				setOpen(true);
			};

			const onContextMenu = (event) => {
				event.preventDefault();
				cancelHover();
				setOpen(true);
				setPinned(true);
				setMenu(true);
			};

			const toggleDock = () => {
				const next = !docked;
				setDocked(next);
				if (next) setRight(0);
				savePrefs({ right: next ? 0 : right, top, docked: next });
				setMenu(false);
				if (next) {
					setOpen(false);
					setPinned(false);
				}
			};

			const recenter = () => {
				const nextTop = Math.round(window.innerHeight * 0.36);
				setDocked(false);
				setRight(18);
				setTop(nextTop);
				savePrefs({ right: 18, top: nextTop, docked: false });
				setMenu(false);
			};

			const send = async () => {
				const text = draft.trim();
				if (text === "" || dmId === null || sending) return;
				setSending(true);
				setError("");
				try {
					await api.sendMessage(dmId, { text });
					setDraft("");
					if (currentId !== dmId) {
						const next = await api.getChannel(dmId, 20).catch(() => null);
						if (next !== null) setDetail(next);
					}
				} catch (error_) {
					setError(`没发出去：${error_ instanceof Error ? error_.message : String(error_)}`);
				} finally {
					setSending(false);
				}
			};

			if (setupStep !== null) return null;

			const ball = h(
				"button",
				{
					type: "button",
					className: "orb-ball",
					id: "orb-ball",
					"aria-label": unread > 0 ? `助理（${String(unread)} 条未读）` : "助理",
					"aria-expanded": open,
					"data-tip": "跟助理说一句",
					onClick,
					onPointerDown,
					onPointerMove,
					onPointerUp,
					onPointerCancel: onPointerUp,
					onContextMenu,
					onPointerEnter: enter,
					onPointerLeave: leave,
				},
				busy ? h("span", { className: "orb-ring", "aria-hidden": "true" }) : null,
				h("span", { className: "orb-core", "aria-hidden": "true" }),
				unread > 0 ? h("span", { className: "orb-badge" }, unread > 99 ? "99+" : String(unread)) : null,
			);

			const menuBox = menu
				? h(
						"div",
						{ className: "orb-menu", role: "menu", ref: menuRef },
						h(
							"button",
							{
								type: "button",
								role: "menuitem",
								disabled: dmId === null,
								onClick: () => {
									if (dmId === null) return;
									closeAll();
									void store.openChannel(dmId);
								},
							},
							"打开助理私聊",
						),
						h("button", { type: "button", role: "menuitem", onClick: toggleDock }, docked ? "从边上请出来" : "贴到右边收起"),
						h("button", { type: "button", role: "menuitem", onClick: recenter }, "回到默认位置"),
					)
				: null;

			const panel = open
				? h(
						"section",
						{
							className: "orb-panel",
							role: "dialog",
							"aria-label": "助理",
							onPointerEnter: enter,
							onPointerLeave: leave,
						},
						h(
							"header",
							{ className: "orb-head" },
							h("span", { className: "orb-state", "data-busy": busy ? "true" : "false", "aria-hidden": "true" }),
							h(
								"div",
								{ className: "orb-who" },
								h("b", null, assistant?.label ?? "助理"),
								h("span", null, activity === undefined ? "待命" : activity.state === "thinking" ? "在想" : "正在干活"),
							),
							h("span", { className: "orb-grow" }),
							dmId === null
								? null
								: h(
										"button",
										{
											type: "button",
											className: "orb-ghost",
											onClick: () => {
												closeAll();
												void store.openChannel(dmId);
											},
										},
										"打开",
									),
						),
						h(
							"div",
							{ className: "orb-list", ref: listRef },
							messages.length === 0
								? h(
										"p",
										{ className: "orb-empty" },
										dmId === null
											? "助理私聊还没建好 —— 打开一次助理就会建。"
											: "还没说过话。想到什么，直接说。",
									)
								: messages.map((message) =>
										h(
											"div",
											{ key: message.seq, className: "orb-msg", "data-me": message.fromSlug === "owner" ? "true" : "false" },
											h("span", { className: "orb-from" }, `${message.fromLabel} · ${ago(message.at)}`),
											h("p", { className: "orb-text" }, message.text),
										),
									),
						),
						error === "" ? null : h("p", { className: "orb-error" }, error),
						h(
							"div",
							{ className: "orb-form" },
							h("textarea", {
								className: "orb-input",
								rows: 1,
								placeholder: dmId === null ? "助理还没准备好" : "跟助理说一句…",
								value: draft,
								disabled: dmId === null,
								onChange: (event) => setDraft(event.target.value),
								onKeyDown: (event) => {
									if (event.key === "Enter" && !event.shiftKey) {
										event.preventDefault();
										void send();
									}
								},
							}),
							h(
								"button",
								{
									type: "button",
									className: "orb-send",
									disabled: dmId === null || sending || draft.trim() === "",
									onClick: () => void send(),
								},
								sending ? "…" : "发送",
							),
						),
					)
				: null;

			return h(
				"div",
				{
					className: "orb",
					"data-docked": docked ? "true" : "false",
					"data-open": open ? "true" : "false",
					"data-up": up ? "true" : "false",
					style: { right: `${String(right)}px`, top: `${String(top)}px` },
				},
				panel,
				menuBox,
				ball,
			);
		}

		ui.register("overlays", { id: "orb", component: Orb });
	},
};
