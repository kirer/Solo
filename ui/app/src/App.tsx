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
import { TeamPage } from "./panels/TeamPage.tsx";
import { TasksPanel } from "./panels/TasksPanel.tsx";
import { RightPanel } from "./panels/RightPanel.tsx";
import { Rail } from "./sidebar/Rail.tsx";
import { Sidebar } from "./sidebar/Sidebar.tsx";
import { Slot } from "./plugin/Slot.tsx";
import { AttachmentPreview } from "./stream/AttachmentPreview.tsx";
import { Stream } from "./stream/Stream.tsx";
import {
	closePluginView,
	closeTasks,
	openChannel,
	openWithPerson,
	setNeedMenu,
	setNewGroup,
	setPluginSheet,
	setRight,
	setSettings,
	setTeam,
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
	const side = useStore((state) => state.side);
	const theme = useStore((state) => state.theme);
	const right = useStore((state) => state.right);
	const conn = useStore((state) => state.conn);
	const attentionUnread = useStore((state) => state.attentionUnread);
	const needMenu = useStore((state) => state.needMenu);
	const settings = useStore((state) => state.settings);
	const team = useStore((state) => state.team);
	const pluginSheet = useStore((state) => state.pluginSheet);
	const newGroup = useStore((state) => state.newGroup);
	const tasksOpen = useStore((state) => state.tasks.open);
	const pluginView = useStore((state) => state.pluginView);

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
		};
		apply();
		localStorage.setItem("solo.theme", theme);
		media.addEventListener("change", apply);
		return () => media.removeEventListener("change", apply);
	}, [theme]);

	useEffect(() => {
		document.body.dataset["side"] = side;
		localStorage.setItem("solo.side", side);
	}, [side]);

	/* 键盘只在「没在打字」时接管：Tab 顺序之外不再多抢一个键。 */
	const closeTop = useCallback((): boolean => {
		if (pluginView !== null) return closePluginView(), true;
		if (tasksOpen) return closeTasks(), true;
		if (settings) return setSettings(false), true;
		if (team) return setTeam(false), true;
		if (newGroup) return setNewGroup(false), true;
		if (pluginSheet) return setPluginSheet(false), true;
		if (needMenu) return setNeedMenu(false), true;
		if (right.open) return setRight({ open: false }), true;
		return false;
	}, [pluginView, tasksOpen, settings, team, newGroup, pluginSheet, needMenu, right.open]);

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

	if (!ready) {
		return (
			<div className="frame boot">
				<div className="boot-mark">Solo</div>
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

	/**
	 * 现在在哪一屏 —— **只算一次**，`data-view` 和下面按屏画的那几行都读它。
	 * 分开判断过一次：状态里两屏同时开着时，页面叠着画、互相压住（实测踩过，
	 * 后台任务和插件页叠成一张）。谁先谁后写在这里，别处不再各判一次。
	 */
	const view: "plugin" | "tasks" | "team" | "plugins" | "settings" | "chat" =
		pluginView !== null
			? "plugin"
			: tasksOpen
				? "tasks"
				: team
					? "team"
					: pluginSheet
						? "plugins"
						: settings
							? "settings"
							: "chat";

	return (
		<div
			className="frame"
			data-side={side}
			data-right={right.open ? "open" : "closed"}
			data-view={view}
		>
			{/* 最左一列：应用级导航。聊天与后台任务是两屏，共用这一列（docs/DESIGN.md §2.9）。 */}
			<Rail />

			<Sidebar />

			<main className="sheet">
				<div className="sheet-head">
					<button
						type="button"
						className="icon-btn sheet-back"
						id="back"
						aria-label="返回频道列表"
						onClick={() => openChannel(null)}
					>
						<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
							<path d="M15 6l-6 6 6 6" />
						</svg>
					</button>
					<h2 className="pane-title" id="pane-title">
						{channel?.title ?? workspaceName}
					</h2>
					{sub === "" ? null : (
						<span className="sheet-sub" id="pane-sub">
							{sub}
						</span>
					)}
					<span className="sheet-grow" />
					{/* 插槽：顶栏右侧按钮之前。 */}
					<Slot name="topbar.actions" />
					{conn.ok ? null : (
						<span className="conn" id="conn" data-ok="false">
							连不上，{clockTime(conn.lastOkAt)} 最后一次成功
						</span>
					)}
					{channel === null ? (
						assistant === undefined ? null : (
							<button
								type="button"
								className="find-assistant"
								id="find-assistant"
								onClick={() => void openWithPerson(assistant.slug)}
							>
								找助理
							</button>
						)
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
								aria-label="详情"
								title="详情"
								aria-pressed={right.open}
								onClick={() => setRight({ open: !right.open })}
							>
								<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
									<rect x="3" y="4" width="18" height="16" rx="2.5" />
									<path d="M14 4v16" />
								</svg>
							</button>
						</>
					)}
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

				{channel === null ? null : <Composer toast={toast} />}
			</main>

			<RightPanel />

			{/* 第二屏：任务不再是盖在聊天上的抽屉，它自己占满中栏与右栏。 */}
			<TasksPanel />

			{/* 通讯录 / 插件 / 设置：同样是整屏的一页，不盖浮层（docs/DESIGN.md §1.5）。
			   都读 `view`，同一时刻只画一处。 */}
			{view === "team" ? <TeamPage /> : null}
			{view === "plugins" ? <PluginsPage /> : null}
			{view === "settings" ? <SettingsPage theme={theme} /> : null}

			{/* 第三块整屏：插件占的一页（`app.page` 插槽）。和任务屏一样让出聊天三列。 */}
			{view === "plugin" ? (
				<section className="plugin-page" aria-label="插件页面">
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
