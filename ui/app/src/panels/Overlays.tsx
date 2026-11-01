/**
 * 全部浮层：设置、找你清单、团队、toast。
 *
 * 灯箱不在这里：图片放大在 `App.tsx`（它拿的是 `Stream` 的 `onImage`）。
 *
 * 规矩只有一条：**同一时刻只开一个**。三处状态（settings/team/needMenu）由
 * `store` 的 `setSettings`/`setTeam`/`setPluginSheet`/`setNeedMenu` 互斥，这里只负责画。
 *
 * 唯一一个不在这里挂的：找你清单（`NeedMenu`）由 `App.tsx` 放进顶栏按钮的
 * `.menu-anchor` 里 —— 它要贴着按钮长，挂在根节点上就只剩猜坐标这一条路。
 */

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { getPlugins, installPlugin, removePlugin, setPluginEnabled } from "../api/client.ts";
import type { Plugin } from "../api/types.ts";
import { avatarSvg } from "../lib/avatar.ts";
import { cellsOf } from "../plugin/registry.ts";
import { relTime } from "../lib/format.ts";
import { openChannel, openWithPerson, setNeedMenu, setPluginSheet, setSettings, setTeam, setTheme } from "../state/store.ts";
import { useStore } from "../state/useStore.ts";
import type { Theme } from "../state/store.ts";

export function Overlays(props: {
	toasts: readonly { id: number; text: string; tone: "info" | "error" }[];
}): JSX.Element {
	const settings = useStore((state) => state.settings);
	const team = useStore((state) => state.team);
	const pluginSheet = useStore((state) => state.pluginSheet);
	const theme = useStore((state) => state.theme);

	return (
		<>
			{settings ? <SettingsSheet theme={theme} /> : null}
			{team ? <TeamSheet /> : null}
			{pluginSheet ? <PluginSheet /> : null}
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
 * 状态仍在 `store` 里，与设置 / 团队浮层互斥。
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

const THEMES: readonly { value: Theme; text: string; icon: JSX.Element }[] = [
	{
		value: "system",
		text: "跟随系统",
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
		icon: (
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
				<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" />
			</svg>
		),
	},
];

/** 左栏「外观」那一格的图标：半个圆 = 明暗。 */
function AppearanceIcon(): JSX.Element {
	return (
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
			<circle cx="12" cy="12" r="7.5" />
			<path d="M12 4.5a7.5 7.5 0 0 1 0 15z" fill="currentColor" stroke="none" />
		</svg>
	);
}

/**
 * 设置：**左边一列分区，右边是选中那一区的详情**（DESIGN §1.5）。
 *
 * 顶栏横跨两栏（标题 + 关闭），下面才分家 —— 和多数桌面应用的设置一样：
 * 分区名在左、内容在右，标题不跟着每个分区重复。
 *
 * 内置分区只有「外观」；插件往 `settings.section` 里注册的每一格都是一格分区，
 * 名字取 `label`、图标取 `icon`。分区多了也还找得到东西。
 */
function SettingsSheet(props: { theme: Theme }): JSX.Element {
	// 插件分区在挂载前就注册完了（`main.tsx` 先 `bootPlugins()`），这里不订阅。
	const cells = cellsOf("settings.section");
	const sections: readonly { id: string; label: string; icon?: ReactNode }[] = [
		{ id: "appearance", label: "外观", icon: <AppearanceIcon /> },
		...cells.map((cell) => ({ id: cell.id, label: cell.label ?? cell.id, icon: cell.icon })),
	];
	const [current, setCurrent] = useState("appearance");
	const active = sections.find((section) => section.id === current) ?? sections[0]!;
	const cell = cells.find((item) => item.id === active.id);

	return (
		<section
			className="settings"
			id="settings"
			role="dialog"
			aria-modal="true"
			aria-label="设置"
			onClick={() => setSettings(false)}
		>
			<div
				className="settings-panel"
				onClick={(event) => {
					event.stopPropagation();
				}}
			>
				<div className="settings-head">
					<h1 className="settings-title">设置</h1>
					<span className="sheet-grow" />
					<button type="button" className="icon-btn" aria-label="关闭" onClick={() => setSettings(false)}>
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
							<path d="M6 6l12 12M18 6 6 18" />
						</svg>
					</button>
				</div>
				<div className="settings-cols">
					<nav className="settings-nav" aria-label="设置分区">
						<div className="settings-nav-list" role="tablist" aria-orientation="vertical">
							{sections.map((section) => (
								<button
									type="button"
									key={section.id}
									role="tab"
									className="settings-nav-item"
									aria-selected={active.id === section.id}
									onClick={() => setCurrent(section.id)}
								>
									{/* 没有图标也留这一格：几行字得对在同一条竖线上。 */}
									<span className="settings-nav-ico">{section.icon ?? null}</span>
									{section.label}
								</button>
							))}
						</div>
					</nav>
					<div className="settings-main">
						{/* key 变了才重放入场：换分区是「同一块地方换了一份内容」。 */}
						<div className="settings-body" key={active.id}>
							<h2 className="settings-h2">{active.label}</h2>
							{cell === undefined || active.id === "appearance" ? <AppearanceSection theme={props.theme} /> : <cell.component />}
						</div>
					</div>
				</div>
			</div>
		</section>
	);
}

function AppearanceSection(props: { theme: Theme }): JSX.Element {
	return (
		<>
			<p className="settings-desc">深色在晚上不刺眼，浅色在白天更清楚。</p>
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
					</button>
				))}
			</div>
		</>
	);
}

/* ── 插件 ────────────────────────────────────────────────────────────── */

/** 「它带来了什么」压成一行。全是空的时候说「只有一份说明」。 */
function bringsText(brings: NonNullable<Plugin["brings"]>): string {
	const parts = [
		brings.tools.length === 0 ? undefined : `工具 ${brings.tools.join("、")}`,
		brings.prompt ? "一段提示词" : undefined,
		brings.routes === 0 ? undefined : `${String(brings.routes)} 条接口`,
		brings.listens ? "听消息" : undefined,
	].filter((part) => part !== undefined);
	return parts.length === 0 ? "只有一份说明" : `带来：${parts.join(" · ")}`;
}

/** 一个已经选好、还没装上去的插件文件夹。`path` 是相对文件夹根的路径。 */
type PickedFolder = { readonly slug: string; readonly files: readonly { path: string; base64: string }[] };

/**
 * 把用户在文件夹选择框里点中的那一坨文件读成一个可以发出去的东西。
 *
 * 浏览器只给 `webkitRelativePath`（`my-plugin/plugin.md`），这里砍掉第一段当 slug、剩下的当相对路径。
 * base64 是给服务端落二进制用的：插件里可能有图片，按文本传会坏。
 */
async function readFolder(list: FileList): Promise<PickedFolder> {
	const entries = [...list];
	const first = entries[0]?.webkitRelativePath ?? "";
	if (first === "" || !first.includes("/")) throw new Error("浏览器没给出文件夹路径，换一个文件夹再试");
	const slug = first.split("/")[0] ?? "";
	const files = await Promise.all(
		entries.map(async (file) => {
			const bytes = new Uint8Array(await file.arrayBuffer());
			let binary = "";
			for (let i = 0; i < bytes.length; i += 0x8000) {
				binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
			}
			return { path: file.webkitRelativePath.split("/").slice(1).join("/"), base64: btoa(binary) };
		}),
	);
	return { slug, files };
}

/**
 * 插件浮层：一个文件夹一个插件，装 / 卸就是建 / 删那个文件夹。
 *
 * 三个动作都**当场生效**：内核写完文件就重装一遍插件（ADR-026），不用重启。
 * 所以这里不再写「重启后生效」——说了反而让人以为要等。
 */
function PluginSheet(): JSX.Element {
	const [plugins, setPlugins] = useState<readonly Plugin[] | undefined>(undefined);
	const [problem, setProblem] = useState<string | undefined>(undefined);
	const [picked, setPicked] = useState<PickedFolder | undefined>(undefined);
	/** 哪一个的「删除」已经点过一次（第二次才真删）。 */
	const [armed, setArmed] = useState<string | undefined>(undefined);

	// 举起来的那一下会自己放下：别让它一直摆在那儿等人误点第二下。
	useEffect(() => {
		if (armed === undefined) return undefined;
		const timer = setTimeout(() => setArmed(undefined), 4000);
		return () => clearTimeout(timer);
	}, [armed]);

	useEffect(() => {
		getPlugins()
			.then((body) => {
				setPlugins(body.plugins);
			})
			.catch((error: Error) => {
				setProblem(error.message);
			});
	}, []);

	/** 三个动作长得一样：拿回新的清单，失败就把后端那句中文摆出来。 */
	const apply = (action: Promise<{ plugins: Plugin[] }>): void => {
		action
			.then((body) => {
				setPlugins(body.plugins);
				setProblem(undefined);
			})
			.catch((error: Error) => {
				setProblem(error.message);
			});
	};

	return (
		<section
			className="team"
			id="plugins"
			role="dialog"
			aria-modal="true"
			aria-label="插件"
			onClick={() => setPluginSheet(false)}
		>
			<div
				className="team-panel"
				onClick={(event) => {
					event.stopPropagation();
				}}
			>
				<div className="team-head">
					<h2>
						插件 <span className="team-count">{plugins?.length ?? 0}</span>
					</h2>
					<button type="button" className="icon-btn" aria-label="关闭" onClick={() => setPluginSheet(false)}>
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
							<path d="M6 6l12 12M18 6 6 18" />
						</svg>
					</button>
				</div>
				<div className="team-list">
					<p className="settings-hint">
						一个文件夹就是一个插件（workspace/plugins/&lt;名字&gt;/）。装、卸、开关当场生效，不用重启；
						插件的代码跑在本机进程里，等于给了它全部权限 —— 只装自己信得过的。
					</p>
					{problem === undefined ? null : <p className="settings-problem">{problem}</p>}
					<div className="plugins-list" id="plugins-list">
						{plugins === undefined ? (
							<p className="settings-hint">正在读插件…</p>
						) : plugins.length === 0 ? (
							<p className="settings-hint">还没有插件。下面选一个插件文件夹装进来。</p>
						) : (
							plugins.map((plugin) => (
								<div className="plugin-row" key={plugin.slug} data-enabled={plugin.enabled}>
									<div className="plugin-main">
										<span className="plugin-name">
											{plugin.name}
											{plugin.slug === plugin.name ? null : <span className="plugin-slug">{plugin.slug}</span>}
										</span>
										<span className="plugin-desc">{plugin.description === "" ? "没有说明" : plugin.description}</span>
										{plugin.error === undefined ? null : <span className="plugin-error">{plugin.error}</span>}
										{plugin.brings !== undefined ? (
											<span className="plugin-brings">{bringsText(plugin.brings)}</span>
										) : plugin.enabled && plugin.error === undefined ? (
											// 开着却没带上东西、也没有报错：多半是后端入口还没跑完，重装一次就来。
											<span className="plugin-brings">还没装上 · 看一眼日志里的 [plugin]</span>
										) : null}
									</div>
									<button
										type="button"
										className="plugin-remove"
										data-armed={armed === plugin.slug}
										aria-label={armed === plugin.slug ? `确认删掉 ${plugin.name}` : `删掉 ${plugin.name}`}
										title={
											armed === plugin.slug
												? "再点一次就删掉，找不回来"
												: "删掉这个插件（连同它的代码）"
										}
										onClick={() => {
											// 删的是磁盘上的代码，找不回来 —— 同一个按钮点两次才算数。
											// 不用 `window.confirm`：桌面壳里那个对话框会被吞掉，点了像没反应（实测踩过）。
											if (armed !== plugin.slug) {
												setArmed(plugin.slug);
												return;
											}
											setArmed(undefined);
											apply(removePlugin(plugin.slug));
										}}
									>
										{armed === plugin.slug ? "确认删除" : "删除"}
									</button>
									<button
										type="button"
										className="plugin-switch"
										role="switch"
										aria-checked={plugin.enabled}
										aria-label={`${plugin.enabled ? "关掉" : "打开"} ${plugin.name}`}
										onClick={() => {
											apply(setPluginEnabled(plugin.slug, !plugin.enabled));
										}}
									>
										<span className="plugin-knob" />
									</button>
								</div>
							))
						)}
					</div>
					<div className="plugin-install">
						<label className="plugin-pick">
							<span className="plugin-pick-btn">选择插件文件夹…</span>
							<input
								type="file"
								multiple
								ref={(node) => {
									// `webkitdirectory` 不是标准 React 属性，只能挂到 DOM 上：有了它浏览器才让人选**文件夹**。
									if (node !== null) node.setAttribute("webkitdirectory", "");
								}}
								onChange={(event) => {
									const list = event.target.files;
									if (list === null || list.length === 0) return;
									readFolder(list)
										.then((folder) => {
											setPicked(folder);
											setProblem(undefined);
										})
										.catch((error: Error) => {
											setPicked(undefined);
											setProblem(error.message);
										});
									// 允许同一个文件夹再选一次（否则第二次选它不触发 onChange）。
									event.target.value = "";
								}}
							/>
						</label>
						{picked === undefined ? null : (
							<>
								<span className="plugin-picked" title={picked.files.map((file) => file.path).join("\n")}>
									已选「{picked.slug}」（{picked.files.length} 个文件）
								</span>
								<button
									type="button"
									className="plugin-install-btn"
									onClick={() => {
										apply(installPlugin(picked.slug, picked.files));
										setPicked(undefined);
									}}
								>
									安装
								</button>
							</>
						)}
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
		<section className="team" id="team" role="dialog" aria-modal="true" aria-label="团队" onClick={() => setTeam(false)}>
			<div
				className="team-panel"
				id="team-panel"
				onClick={(event) => {
					event.stopPropagation();
				}}
			>
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
							<button
								type="button"
								key={actor.slug}
								className="crew"
								title={`和 ${actor.label} 私聊`}
								onClick={() => {
									setTeam(false);
									void openWithPerson(actor.slug);
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
									<span className="crew-sub">
										{actor.title}
									</span>
								</span>
								<span className="crew-state" data-state={look.state}>
									{look.label}
								</span>
							</button>
						);
					})}
				</div>
			</div>
		</section>
	);
}

