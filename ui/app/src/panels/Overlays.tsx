/**
 * 全部浮层：设置、找你清单、团队、toast。
 *
 * 灯箱不在这里：图片放大在 `App.tsx`（它拿的是 `Stream` 的 `onImage`）。
 *
 * 规矩只有一条：**同一时刻只开一个**。三处状态（settings/team/needMenu）由
 * `store` 的 `setSettings`/`setTeam`/`setNeedMenu` 互斥，这里只负责画。
 */

import { avatarSvg } from "../lib/avatar.ts";
import { relTime } from "../lib/format.ts";
import { openChannel, setLayout, setNeedMenu, setSettings, setTeam, setTheme } from "../state/store.ts";
import { useStore } from "../state/useStore.ts";
import type { Layout, Theme } from "../state/store.ts";

export function Overlays(props: {
	toasts: readonly { id: number; text: string; tone: "info" | "error" }[];
}): JSX.Element {
	const settings = useStore((state) => state.settings);
	const team = useStore((state) => state.team);
	const needMenu = useStore((state) => state.needMenu);
	const layout = useStore((state) => state.layout);
	const theme = useStore((state) => state.theme);
	const attention = useStore((state) => state.attention);

	return (
		<>
			{settings ? <SettingsSheet layout={layout} theme={theme} /> : null}
			{team ? <TeamSheet /> : null}
			{needMenu ? (
				<div className="need-menu pop-menu" id="need-menu" role="menu">
					{attention.length === 0 ? (
						<p className="need-empty">没有需要你处理的事。</p>
					) : (
						<>
							{attention.slice(0, 12).map((item) => (
								<button
									type="button"
									key={`${item.channelId}-${String(item.seq)}`}
									className="need-item"
									role="menuitem"
									data-read={item.read ? "true" : "false"}
									data-need={`${item.channelId}|${String(item.seq)}`}
									onClick={() => {
										setNeedMenu(false);
										void openChannel(item.channelId).then(() => {
											window.setTimeout(() => highlight(item.seq), 160);
										});
									}}
								>
									<span className="need-where">
										{item.channelTitle} · {item.fromLabel}
									</span>
									<span className="need-time">{relTime(item.at)}</span>
									<span className="need-text">{item.excerpt}</span>
								</button>
							))}
							{attention.length > 12 ? (
								<p className="need-more">还有 {attention.length - 12} 条</p>
							) : null}
						</>
					)}
				</div>
			) : null}
			<div id="toast-root" className="app-toasts">
				{props.toasts.map((toast) => (
					<div key={toast.id} className="chat-toast" data-tone={toast.tone}>
						{toast.text}
					</div>
				))}
			</div>
		</>
	);
}

const PRESENCE_TEXT: Record<string, string> = {
	idle: "待命",
	thinking: "在想",
	working: "在做",
	asleep: "睡了",
};

function presenceOfActor(presence: Map<string, { state: string; at: number }>, slug: string): { state: string; label: string } {
	const state = presence.get(slug)?.state ?? "asleep";
	return { state, label: PRESENCE_TEXT[state] ?? "待命" };
}

function highlight(seq: number): void {
	const node = document.querySelector<HTMLElement>(`.feed .row[data-seq="${String(seq)}"]`);
	if (node === null) return;
	node.scrollIntoView({ block: "center", behavior: "smooth" });
	node.dataset["hl"] = "true";
	window.setTimeout(() => {
		delete node.dataset["hl"];
	}, 1200);
}

/* ── 设置 ────────────────────────────────────────────────────────────── */

const LAYOUTS: readonly { value: Layout; text: string; hint: string; icon: JSX.Element }[] = [
	{
		value: "flat",
		text: "平铺",
		hint: "一列到底，扫读快",
		icon: (
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
				<path d="M4 7h10M4 12h16M4 17h12" />
				<circle cx="18.5" cy="7" r="1.2" fill="currentColor" stroke="none" />
			</svg>
		),
	},
	{
		value: "bubble",
		text: "气泡",
		hint: "你靠右，别人靠左",
		icon: (
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
				<rect x="3" y="5" width="11" height="6" rx="3" />
				<rect x="10" y="13" width="11" height="6" rx="3" />
			</svg>
		),
	},
];

const THEMES: readonly { value: Theme; text: string; hint: string; icon: JSX.Element }[] = [
	{
		value: "system",
		text: "跟随系统",
		hint: "系统变我就变",
		icon: (
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
				<circle cx="12" cy="12" r="7" />
				<path d="M12 5a7 7 0 0 0 0 14z" fill="currentColor" stroke="none" />
			</svg>
		),
	},
	{
		value: "light",
		text: "浅色",
		hint: "",
		icon: (
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
				<circle cx="12" cy="12" r="4" />
				<path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4" />
			</svg>
		),
	},
	{
		value: "dark",
		text: "深色",
		hint: "",
		icon: (
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
				<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" />
			</svg>
		),
	},
];

function SettingsSheet(props: { layout: Layout; theme: Theme }): JSX.Element {
	return (
		<section className="settings" id="settings" role="dialog" aria-modal="true" aria-label="设置">
			<div
				className="settings-panel"
				onClick={(event) => {
					event.stopPropagation();
				}}
			>
				<div className="settings-head">
					<h2>设置</h2>
					<button type="button" className="icon-btn" aria-label="关闭" onClick={() => setSettings(false)}>
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
							<path d="M6 6l12 12M18 6 6 18" />
						</svg>
					</button>
				</div>
				<div className="settings-body">
					<div className="settings-section">
						<h3>消息布局</h3>
						<p className="settings-hint">平铺适合扫读，气泡分得清谁在说。</p>
						<div className="settings-options is-two" id="layout-options">
							{LAYOUTS.map((item) => (
								<button
									type="button"
									key={item.value}
									className="opt"
									data-layout={item.value}
									aria-checked={props.layout === item.value}
									onClick={() => setLayout(item.value)}
								>
									<span className="opt-ico">{item.icon}</span>
									<span className="opt-text">{item.text}</span>
									{item.hint === "" ? null : <span className="opt-hint">{item.hint}</span>}
									<span className="opt-tick" aria-hidden="true">
										✓
									</span>
								</button>
							))}
						</div>
					</div>
					<div className="settings-section">
						<h3>外观</h3>
						<p className="settings-hint">深色在晚上不刺眼，浅色在白天更清楚。</p>
						<div className="settings-options is-three" id="theme-options">
							{THEMES.map((item) => (
								<button
									type="button"
									key={item.value}
									className="opt"
									data-theme-mode={item.value}
									aria-checked={props.theme === item.value}
									onClick={() => setTheme(item.value)}
								>
									<span className="opt-ico">{item.icon}</span>
									<span className="opt-text">{item.text}</span>
									{item.hint === "" ? null : <span className="opt-hint">{item.hint}</span>}
									<span className="opt-tick" aria-hidden="true">
										✓
									</span>
								</button>
							))}
						</div>
					</div>
				</div>
			</div>
		</section>
	);
}

/* ── 团队 ────────────────────────────────────────────────────────────── */

function TeamSheet(): JSX.Element {
	const people = useStore((state) => state.people);
	const presence = useStore((state) => state.presence);

	return (
		<section className="team" id="team" role="dialog" aria-modal="true" aria-label="团队">
			<div className="team-panel" id="team-panel">
				<div className="team-head">
					<h2>
						团队 <span className="team-count" id="team-count">{people.length}</span>
					</h2>
					<button type="button" className="icon-btn" aria-label="关闭" onClick={() => setTeam(false)}>
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
							<path d="M6 6l12 12M18 6 6 18" />
						</svg>
					</button>
				</div>
				<div className="team-list" id="team-list">
					{people.map((actor) => {
						const look = presenceOfActor(presence, actor.slug);
						return (
							<div key={actor.slug} className="crew">
								<span
									className="crew-av"
									dangerouslySetInnerHTML={{
										__html: avatarSvg({ slug: actor.slug, name: actor.label, size: 32, state: "idle" }),
									}}
								/>
								<span className="crew-main">
									<span className="crew-name">{actor.label}</span>
									<span className="crew-sub">
										{actor.title}
										{actor.team === undefined ? "" : ` · ${actor.team}`}
									</span>
								</span>
								<span className="crew-state" data-state={look.state}>
									{look.label}
								</span>
							</div>
						);
					})}
				</div>
				<div className="team-foot">共 {people.length} 人</div>
			</div>
		</section>
	);
}

