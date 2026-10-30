/**
 * 外壳：三列 + 头部 + 全部浮层。
 *
 * 这里只做「装配」和少量跨组件的东西（主题落地、键盘、浮层互斥）。
 * 任何一条消息长什么样，去 `stream/`；任何一条频道长什么样，去 `sidebar/`。
 */

import { useCallback, useEffect, useState } from "react";
import { Composer } from "./composer/Composer.tsx";
import { useToasts } from "./hooks/useToasts.ts";
import { useChannelStream, useOrgStream } from "./hooks/useStreams.ts";
import { MemoryDrawer } from "./panels/MemoryDrawer.tsx";
import { Overlays } from "./panels/Overlays.tsx";
import { RightPanel } from "./panels/RightPanel.tsx";
import { Sidebar } from "./sidebar/Sidebar.tsx";
import { Stream } from "./stream/Stream.tsx";
import {
	openChannel,
	refreshLists,
	setNeedMenu,
	setRight,
	setSettings,
	setTeam,
} from "./state/store.ts";
import { useStore } from "./state/useStore.ts";
import { clockTime } from "./lib/format.ts";
import type { ChannelKind } from "./api/types.ts";

export function App(): JSX.Element {
	const ready = useStore((state) => state.ready);
	const company = useStore((state) => state.company);
	const channels = useStore((state) => state.channels);
	const detail = useStore((state) => state.detail);
	const side = useStore((state) => state.side);
	const layout = useStore((state) => state.layout);
	const theme = useStore((state) => state.theme);
	const right = useStore((state) => state.right);
	const conn = useStore((state) => state.conn);
	const attentionUnread = useStore((state) => state.attentionUnread);
	const needMenu = useStore((state) => state.needMenu);
	const settings = useStore((state) => state.settings);
	const team = useStore((state) => state.team);
	const presence = useStore((state) => state.presence);

	const { toasts, toast } = useToasts();
	const [image, setImage] = useState<string | null>(null);

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
		localStorage.setItem("ai-company.theme", theme);
		media.addEventListener("change", apply);
		return () => media.removeEventListener("change", apply);
	}, [theme]);

	useEffect(() => {
		document.body.dataset["layout"] = layout;
		localStorage.setItem("ai-company.layout", layout);
	}, [layout]);

	useEffect(() => {
		document.body.dataset["side"] = side;
		localStorage.setItem("ai-company.side", side);
	}, [side]);

	/* 键盘只在「没在打字」时接管：Tab 顺序之外不再多抢一个键。 */
	const closeTop = useCallback((): boolean => {
		if (settings) return setSettings(false), true;
		if (team) return setTeam(false), true;
		if (needMenu) return setNeedMenu(false), true;
		if (right.open) return setRight({ open: false }), true;
		return false;
	}, [settings, team, needMenu, right.open]);

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
	const sub = channel === null ? "" : headSub(channel.kind, channel.team, channel.leadLabel, members.length);
	const running = [...presence.values()].some((entry) => entry.state === "thinking" || entry.state === "working");

	return (
		<div
			className="frame"
			data-side={side}
			data-right={right.open ? "open" : "closed"}
		>
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
						{channel?.title ?? company}
					</h2>
					{sub === "" ? null : (
						<span className="sheet-sub" id="pane-sub">
							{sub}
						</span>
					)}
					<span className="sheet-grow" />
					{conn.ok ? null : (
						<span className="conn" id="conn" data-ok="false">
							连不上，{clockTime(conn.lastOkAt)} 最后一次成功
						</span>
					)}
					<button
						type="button"
						className="need"
						id="unread-total"
						data-zero={attentionUnread === 0 ? "true" : "false"}
						aria-label={`${String(attentionUnread)} 件需要你处理`}
						onClick={() => setNeedMenu(!needMenu)}
					>
						{attentionUnread} 件找你
					</button>
					<button
						type="button"
						className="icon-btn"
						id="team-btn"
						aria-label="团队"
						title="团队"
						onClick={() => setTeam(true)}
					>
						<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
							<circle cx="9" cy="8" r="3.2" />
							<path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
							<path d="M16 5.5a3.2 3.2 0 0 1 0 6" />
							<path d="M17.5 13.6A5 5 0 0 1 21 18.5" />
						</svg>
					</button>
					<button
						type="button"
						className="icon-btn"
						id="settings-btn"
						aria-label="设置"
						title="设置"
						onClick={() => setSettings(true)}
					>
						<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
							<circle cx="12" cy="12" r="3" />
							<path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.11a1.7 1.7 0 0 0-2.9-1.2l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 3 15H3a2 2 0 1 1 0-4h.11a1.7 1.7 0 0 0 1.2-2.9l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 3.09V3a2 2 0 1 1 4 0v.11a1.7 1.7 0 0 0 2.9 1.2l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0 1.2 2.9H21a2 2 0 1 1 0 4h-.11a1.7 1.7 0 0 0-1.49.96z" />
						</svg>
					</button>
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
				</div>

				{channel === null ? (
					<div className="sheet-blank">
						<div className="blank-mark">Solo</div>
						<p className="blank-text">
							{channels.length === 0 ? "还没有会话。" : "左边选一个会话。"}
							{running ? "现在有人在做活。" : ""}
						</p>
						<button type="button" className="blank-btn" onClick={() => void refreshLists()}>
							刷新
						</button>
					</div>
				) : (
					<Stream onImage={setImage} />
				)}

				<Composer toast={toast} />
			</main>

			<RightPanel />

			<Overlays toasts={toasts} />

			<MemoryDrawer toast={toast} />

			{image === null ? null : (
				<div className="lightbox" id="lightbox" role="dialog" aria-modal="true" onClick={() => setImage(null)}>
					<img id="lightbox-img" src={image} alt="" />
				</div>
			)}
		</div>
	);
}

/** 顶栏副标题：私聊只写名字（和谁），群聊才补充团队/管理员/人数。 */
function headSub(kind: ChannelKind, team: string | undefined, leadLabel: string | undefined, count: number): string {
	if (kind === "dm") return "";
	const bits = [team, leadLabel === undefined ? undefined : `团队管理员 ${leadLabel}`, `${String(count)} 人`];
	return bits.filter((bit) => bit !== undefined && bit !== "").join(" · ");
}
