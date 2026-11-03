/**
 * 真正的浮层：拉群、找你清单、toast。
 *
 * 设置 / 通讯录 / 插件不在这里 —— 它们是应用的第二屏（`SettingsPage` / `TeamPage` /
 * `PluginsPage`），点左列那一格换一整屏，不盖在聊天上（docs/DESIGN.md §1.5）。
 *
 * 规矩只有一条：**同一时刻只开一个**。状态由 store 的 `setNeedMenu`/`setNewGroup`
 * 互斥，这里只负责画。找你清单（`NeedMenu`）由 `App.tsx` 放进顶栏按钮的
 * `.menu-anchor` 里 —— 它要贴着按钮长，挂在根节点上就只剩猜坐标这一条路。
 */

import { useState } from "react";
import { avatarSvg } from "../lib/avatar.ts";
import { relTime } from "../lib/format.ts";
import { makeGroup, openChannel, setNeedMenu, setNewGroup } from "../state/store.ts";
import { useStore } from "../state/useStore.ts";

export function Overlays(props: {
	toasts: readonly { id: number; text: string; tone: "info" | "error" }[];
}): JSX.Element {
	const newGroup = useStore((state) => state.newGroup);

	return (
		<>
			{newGroup ? <GroupSheet /> : null}
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


/**
 * 「N 件找你」那张卡。
 *
 * 它不在这里渲染，而是由 `App.tsx` 放进顶栏那颗按钮旁边的 `.menu-anchor` 里 ——
 * 菜单要贴着按钮长（见 `shell.css` 的 `.need-menu`），放在根节点上只能靠猜坐标。
 * 状态仍在 `store` 里，和拉群 / 各屏互斥。
 */
export function NeedMenu(): JSX.Element | null {
	const needMenu = useStore((state) => state.needMenu);
	const attention = useStore((state) => state.attention);
	if (!needMenu) return null;
	return (
		<div className="menu need-menu pop-menu" id="need-menu" role="menu">
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
					{attention.length > 12 ? <p className="need-more">还有 {attention.length - 12} 条</p> : null}
				</>
			)}
		</div>
	);
}

const PRESENCE_TEXT: Record<string, string> = {
	idle: "待命",
	thinking: "在想",
	working: "在做",
	asleep: "睡了",
};

export function presenceOfActor(presence: Map<string, { state: string; at: number }>, slug: string): { state: string; label: string } {
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

/* ── 拉群 ────────────────────────────────────────────────────────────── */

/**
 * 拉群：起个名字、点几个人。我自己一定在里面（服务端加），所以至少再点一个人。
 *
 * 群没有档案，也没有负责人 —— 它只是「这些人一起说话」的房间；团队才是有 README 的群
 * （ADR-063）。建完直接进去，不留在浮层里看结果。
 */
function GroupSheet(): JSX.Element {
	const people = useStore((state) => state.people);
	const [title, setTitle] = useState("");
	const [picked, setPicked] = useState<readonly string[]>([]);
	const [problem, setProblem] = useState<string | undefined>(undefined);
	const [busy, setBusy] = useState(false);
	const ready = title.trim() !== "" && picked.length > 0 && !busy;

	const toggle = (slug: string): void => {
		setPicked((current) =>
			current.includes(slug) ? current.filter((item) => item !== slug) : [...current, slug],
		);
	};

	return (
		<section
			className="team"
			id="group"
			role="dialog"
			aria-modal="true"
			aria-label="拉群"
			onClick={() => setNewGroup(false)}
		>
			<div
				className="team-panel"
				onClick={(event) => {
					event.stopPropagation();
				}}
			>
				<div className="team-head">
					<h2>拉群</h2>
					<button type="button" className="icon-btn" aria-label="关闭" onClick={() => setNewGroup(false)}>
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
							<path d="M6 6l12 12M18 6 6 18" />
						</svg>
					</button>
				</div>
				<div className="team-list">
					<form
						className="group-form"
						onSubmit={(event) => {
							event.preventDefault();
							if (!ready) return;
							setBusy(true);
							setProblem(undefined);
							makeGroup(title.trim(), picked)
								.catch((error: Error) => {
									setProblem(error.message);
								})
								.finally(() => {
									setBusy(false);
								});
						}}
					>
						<label className="group-field">
							<span className="group-label">群名</span>
							<input
								className="group-input"
								value={title}
								maxLength={40}
								placeholder="比如：首页改版"
								autoFocus
								onChange={(event) => {
									setTitle(event.target.value);
								}}
							/>
						</label>
						<div className="group-field">
							<span className="group-label">
								谁在里面
								<span className="group-count">{picked.length === 0 ? "还没选" : `加上你 ${String(picked.length + 1)} 人`}</span>
							</span>
							<div className="group-people">
								{people.map((actor) => {
									const on = picked.includes(actor.slug);
									return (
										<button
											type="button"
											key={actor.slug}
											className="crew"
											data-on={on}
											role="checkbox"
											aria-checked={on}
											onClick={() => {
												toggle(actor.slug);
											}}
										>
											<span
												className="crew-av"
												dangerouslySetInnerHTML={{
													__html: avatarSvg({ slug: actor.slug, name: actor.label, size: 32, state: "idle" }),
												}}
											/>
											<span className="crew-main">
												<span className="crew-name">{actor.label}</span>
												<span className="crew-sub">{actor.title}</span>
											</span>
											<span className="group-check" aria-hidden="true">
												{on ? (
													<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
														<path d="M5 12.5 10 17.5 19 7" />
													</svg>
												) : null}
											</span>
										</button>
									);
								})}
							</div>
						</div>
						{problem === undefined ? null : <p className="settings-problem">{problem}</p>}
						<div className="group-actions">
							<span className="group-hint">你在群里，不用选自己。</span>
							<button type="submit" className="group-submit" disabled={!ready}>
								{busy ? "正在建…" : "建群"}
							</button>
						</div>
					</form>
				</div>
			</div>
		</section>
	);
}

/* ── 团队 ────────────────────────────────────────────────────────────── */

