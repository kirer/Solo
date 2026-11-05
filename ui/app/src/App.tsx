/**
 * 外壳：三列 + 头部 + 全部浮层。
 *
 * 这里只做「装配」和少量跨组件的东西（主题落地、键盘、浮层互斥）。
 * 任何一条消息长什么样，去 `stream/`；任何一条频道长什么样，去 `sidebar/`。
 */

import { useCallback, useEffect, useState } from "react";
import type { Attachment } from "./api/types.ts";
import { Composer } from "./composer/Composer.tsx";
import { useToasts } from "./hooks/useToasts.ts";
import { useChannelStream, useOrgStream } from "./hooks/useStreams.ts";
import { NeedMenu, Overlays } from "./panels/Overlays.tsx";
import { PluginsPage } from "./panels/PluginsPage.tsx";
import { SettingsPage } from "./panels/SettingsPage.tsx";
import { RightPanel } from "./panels/RightPanel.tsx";
import { SetupPage } from "./panels/SetupPage.tsx";
import { Sidebar } from "./sidebar/Sidebar.tsx";
import { Slot } from "./plugin/Slot.tsx";
import { AttachmentPreview } from "./stream/AttachmentPreview.tsx";
import { Starters } from "./stream/Starters.tsx";
import { Stream } from "./stream/Stream.tsx";
import { Titlebar } from "./titlebar/Titlebar.tsx";
import {
	closePluginView,
	closeTasks,
	openChannel,
	setNeedMenu,
	setNewGroup,
	setPluginSheet,
	setResetOpen,
	setRestartOpen,
	setRight,
	setSettings,
} from "./state/store.ts";
import { useStore } from "./state/useStore.ts";
import { clockTime, headParts, type ChannelHead } from "./lib/format.ts";
import type { ChannelKind } from "./api/types.ts";

export function App(): JSX.Element {
	const ready = useStore((state) => state.ready);
	const workspaceName = useStore((state) => state.workspaceName);
	const channels = useStore((state) => state.channels);
	const detail = useStore((state) => state.detail);
	const people = useStore((state) => state.people);
	const theme = useStore((state) => state.theme);
	const right = useStore((state) => state.right);
	const conn = useStore((state) => state.conn);
	const attentionUnread = useStore((state) => state.attentionUnread);
	const needMenu = useStore((state) => state.needMenu);
	const settings = useStore((state) => state.settings);
	const pluginSheet = useStore((state) => state.pluginSheet);
	const newGroup = useStore((state) => state.newGroup);
	const resetOpen = useStore((state) => state.resetOpen);
	const restartOpen = useStore((state) => state.restartOpen);
	const tasksOpen = useStore((state) => state.tasks.open);
	const pluginView = useStore((state) => state.pluginView);
	const setupStep = useStore((state) => state.setupStep);

	const { toasts, toast } = useToasts();
	const [image, setImage] = useState<string | null>(null);
	const [file, setFile] = useState<Attachment | null>(null);

	useOrgStream();
	useChannelStream();

	/* 主题：`system` 时跟 `prefers-color-scheme` 走，只在键盘态显示焦点环。 */
	useEffect(() => {
		const root = document.documentElement;
		const media = window.matchMedia("(prefers-color-scheme: dark)");
		const apply = (): void => {
			const resolved = theme === "system" ? (media.matches ? "dark" : "light") : theme;
			root.dataset["theme"] = resolved;
			root.style.colorScheme = resolved;
			// Windows 的系统窗口按钮也换色（浏览器 / macOS 上没有这座桥，`?.` 跳过）。
			window.soloDesktop?.setTheme(resolved);
		};
		apply();
		localStorage.setItem("solo.theme", theme);
		media.addEventListener("change", apply);
		return () => media.removeEventListener("change", apply);
	}, [theme]);

	/* 键盘只在「没在打字」时接管：Tab 顺序之外不再多抢一个键。 */
	const closeTop = useCallback((): boolean => {
		if (resetOpen) return setResetOpen(false), true;
		if (restartOpen !== null) return setRestartOpen(null), true;
		if (pluginView !== null) return closePluginView(), true;
		if (tasksOpen) return closeTasks(), true;
		if (settings) return setSettings(false), true;
		if (newGroup) return setNewGroup(false), true;
		if (pluginSheet) return setPluginSheet(false), true;
		if (needMenu) return setNeedMenu(false), true;
		if (right.open) return setRight({ open: false }), true;
		return false;
	}, [resetOpen, restartOpen, pluginView, tasksOpen, settings, newGroup, pluginSheet, needMenu, right.open]);

	useEffect(() => {
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape") {
				if (closeTop()) event.preventDefault();
				return;
			}
			// ⌘/Ctrl+K 打开「找你」
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
				event.preventDefault();
				setNeedMenu(true);
			}
		};
		const onModality = (event: Event): void => {
			const keyboard = event instanceof KeyboardEvent && event.key === "Tab";
			document.documentElement.dataset["inputModality"] = keyboard ? "keyboard" : "pointer";
		};
		document.addEventListener("keydown", onKey);
		document.addEventListener("keydown", onModality, true);
		document.addEventListener("mousedown", onModality, true);
		return () => {
			document.removeEventListener("keydown", onKey);
			document.removeEventListener("keydown", onModality, true);
			document.removeEventListener("mousedown", onModality, true);
		};
	}, [closeTop]);

	// 手机：进频道是「第二屏」，靠 body[data-pane] 切。
	useEffect(() => {
		document.body.dataset["pane"] = detail === null ? "list" : "chat";
	}, [detail]);

	// 桌面壳里 Windows 的标题带要跨整窗；它只在 `?shell=desktop&platform=win32` 下存在。
	const windowsShell =
		document.documentElement.dataset["shell"] === "desktop" && document.documentElement.dataset["os"] === "win32";

	if (!ready) {
		return (
			<div className="frame boot">
				{windowsShell ? <Titlebar /> : null}
				<div className="boot-mark">Solo</div>
			</div>
		);
	}

	// 第一次打开（稿子 10 / 11）：一台机器上一只模型都没有时，先接上模型再进来。
	// 这一屏不画列表、不画输入框 —— 它只做一件事。
	if (setupStep !== null) {
		return (
			<div className="frame">
				{windowsShell ? <Titlebar /> : null}
				<SetupPage />
			</div>
		);
	}

	const channel = detail?.channel ?? null;
	const members = detail?.members ?? [];
	// 私聊的副标题是他本人的职务（频道标题就是他的显示名）；群聊是团队 / 人数。
	const peerTitle =
		channel === null || channel.kind !== "dm"
			? ""
			: (people.find((person) => person.label === channel.title)?.title ?? "");
	// 群聊的副标题：团队在干什么 · 团队名 · 人数，能拿到哪段写哪段（`headParts` 已经按这个顺序拼）。
	// 人数用 `channel.memberCount`，和侧栏同一个数 —— 拿 `members.length` 会少掉不在名册里的人。
	const parts = peerTitle !== "" ? [peerTitle] : channel === null ? [] : headSub(channel, members.length);
	const sub = parts.join(" · ");
	// 没选频道时顶栏只剩「找助理」：空屏要有一个明确的下一步，助理就是那个入口。
	const assistant = people.find((person) => person.assistant === true);
	// 和助理的私聊就是首屏（稿子 01）：没有返回，门是「对话 / 设置」两颗。
	const assistantChat =
		channel !== null && channel.kind === "dm" && assistant !== undefined && channel.title === assistant.label;

	/**
	 * 现在在哪一屏 —— **只算一次**，`data-view` 和下面按屏画的那几行都读它。
	 * 分开判断过一次：状态里两屏同时开着时，页面叠着画、互相压住（实测踩过，
	 * 后台任务和插件页叠成一张）。谁先谁后写在这里，别处不再各判一次。
	 */
	// 后台任务不是一屏：桌面上它是右栏的一态（§13.3），手机上是 `.detail` 铺满整屏。
	const view: "plugin" | "plugins" | "settings" | "chat" =
		pluginView !== null ? "plugin" : pluginSheet ? "plugins" : settings ? "settings" : "chat";

	return (
		<div className="frame" data-view={view}>
			{/* Windows 桌面壳的标题带（菜单 + 拖拽把手）；别的平台这里是空的。 */}
			{windowsShell ? <Titlebar /> : null}

			{/* 一屏只有一件事：列表（Sidebar）或对话（sheet），由 body[data-pane] 切。
			    这是手机稿的骨架，桌面上也照这个来（§13.1）—— 不再有最左导航和中右分栏。 */}
			<Sidebar />

			<main className="sheet">
				<div className="sheet-head">
					{/* 三格：左门、居中的名字、右门。名字必须真居中（稿子 01 / 04），
					    所以左右各占一列 1fr —— 右边多一颗按钮也不会把名字挤偏。 */}
					<div className="sheet-head-left">
						{assistantChat ? null : (
							<button
								type="button"
								className="icon-btn sheet-back"
								id="back"
								aria-label="返回对话列表"
								onClick={() => void openChannel(null)}
							>
								<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
									<path d="M14.5 5.5 8 12l6.5 6.5" />
								</svg>
							</button>
						)}
					</div>
					<div className="sheet-head-main">
						<h2 className="pane-title" id="pane-title">
							{channel?.title ?? workspaceName}
						</h2>
						{/* 助理是首屏（稿子 01）：抬头只有名字，没有状态行。 */}
						{sub === "" || assistantChat ? null : (
							<span className="sheet-sub" id="pane-sub">
								<i className="presence-dot" aria-hidden="true" />
								{sub}
							</span>
						)}
					</div>
					<div className="sheet-head-right">
					{/* 插槽：顶栏右侧按钮之前。 */}
					<Slot name="topbar.actions" />
					{conn.ok ? null : (
						<span className="conn" id="conn" data-ok="false">
							连不上，{clockTime(conn.lastOkAt)} 最后一次成功
						</span>
					)}
					{assistantChat ? (
						<>
							<button
								type="button"
								className="icon-btn"
								id="list-btn"
								aria-label="对话"
								title="对话"
								onClick={() => void openChannel(null)}
							>
								<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
									<path d="M20.5 11.6c0 3.9-3.8 7-8.5 7-1 0-2-.15-2.9-.42L4 20l1.3-3.9A6.5 6.5 0 0 1 3.5 11.6c0-3.9 3.8-7 8.5-7s8.5 3.1 8.5 7Z" />
								</svg>
							</button>
							<button
								type="button"
								className="icon-btn"
								id="sheet-settings"
								aria-label="设置"
								title="设置"
								onClick={() => setSettings(true)}
							>
								<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
									<path d="M4 7.5h9.5M18 7.5h2M4 16.5h3.5M12 16.5h8" />
									<circle cx="15.8" cy="7.5" r="2.2" />
									<circle cx="9.8" cy="16.5" r="2.2" />
								</svg>
							</button>
						</>
					) : (
						<>
							<div className="menu-anchor need-anchor">
								<button
									type="button"
									className="need"
									id="unread-total"
									data-zero={attentionUnread === 0 ? "true" : "false"}
									aria-expanded={needMenu}
									aria-label={`${String(attentionUnread)} 件需要你处理`}
									onClick={() => setNeedMenu(!needMenu)}
								>
									{attentionUnread} 件找你
								</button>
								<NeedMenu />
							</div>
							<button
								type="button"
								className="icon-btn"
								id="detail-btn"
								aria-label="资料与后台任务"
								title="资料与后台任务"
								aria-pressed={right.open}
								onClick={() => setRight({ open: !right.open })}
							>
								<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
									<circle cx="12" cy="8.2" r="3.6" />
									<path d="M5 20c.6-3.6 3.5-5.6 7-5.6s6.4 2 7 5.6" />
								</svg>
							</button>
						</>
					)}
					</div>
				</div>

				{channel === null ? (
					<div className="sheet-blank">
						<div className="blank-mark" aria-hidden="true">
							<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
								<path d="M12 3v18M4.5 7.5 12 12l7.5-4.5M4.5 16.5 12 12l7.5 4.5" />
							</svg>
						</div>
						<p className="blank-title">{channels.length === 0 ? "还没有会话" : "挑一个会话"}</p>
						<p className="blank-hint">
							{channels.length === 0 ? "从右上角找助理，让他建人、开团队。" : "左边点一个，或者从右上角找助理。"}
						</p>
					</div>
				) : (
					<Stream onImage={setImage} onFile={setFile} />
				)}

				{/* 刚装好、还没别人时，输入框上方给三句能直接发的话（稿子 12）。 */}
				{channel === null ? null : <Starters toast={toast} />}

				{channel === null ? null : <Composer toast={toast} />}
			</main>

			{/* 右栏：资料，或它的一态「后台任务」（docs/DESIGN.md §13.2 / §13.3）。 */}
			<RightPanel />

			{/* 插件 / 设置：整屏的一页，不盖浮层（docs/DESIGN.md §1.5）。
			   都读 `view`，同一时刻只画一处。 */}
			{view === "plugins" ? <PluginsPage /> : null}
			{view === "settings" ? <SettingsPage theme={theme} /> : null}

			{/* 第三块整屏：插件占的一页（`app.page` 插槽）。和任务屏一样让出聊天三列。 */}
			{view === "plugin" ? (
				<section className="plugin-page" aria-label="插件页面">
					{/* 出口在插件自己画的 `.nav` 里（同一颗返回，不再另浮一颗）。 */}
					<Slot name="app.page" />
				</section>
			) : null}

			<Overlays toasts={toasts} />

			{/* 插槽：全屏浮层层 —— 插件要画自己的浮层就从这里进（和灯箱同层）。 */}
			<Slot name="overlays" />

			<AttachmentPreview file={file} onClose={() => setFile(null)} />

			{image === null ? null : (
				<div className="lightbox" id="lightbox" role="dialog" aria-modal="true" onClick={() => setImage(null)}>
					<img id="lightbox-img" src={image} alt="" />
				</div>
			)}
		</div>
	);
}

/**
 * 顶栏副标题：私聊不写（标题就是名字），群聊补充「在干什么 / 团队名 / 人数」。
 *
 * 团队名用频道的 `team`（服务端给的就是人能读的名字，不是目录 slug）；没有就不占位。
 */
function headSub(channel: ChannelHead & { kind: ChannelKind }, count: number): string[] {
	if (channel.kind === "dm") return [];
	return headParts({
		doing: channel.doing,
		team: channel.team,
		memberCount: channel.memberCount ?? count,
	});
}
