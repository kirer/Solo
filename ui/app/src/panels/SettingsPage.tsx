/**
 * 设置：桌面上是一张弹窗（v6 稿子 D05 / D07），窄窗口里铺满整屏。
 *
 * 外观、插件自己注册的分区（如「模型」）、插件、用量、代理、数据 —— 全在一条滚动线上，
 * 每件事一张卡；插件那一节收起时只占一行。
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { getPreferences, savePreferences, saveWorkDirs } from "../api/client.ts";
import { Fold } from "../lib/fold.tsx";
import { cellsOf } from "../plugin/registry.ts";
import { SLOT_MARK, Slot } from "../plugin/Slot.tsx";
import { useStore } from "../state/useStore.ts";
import { PluginsPage } from "./PluginsPage.tsx";
import { setPluginSheet, setResetOpen, setSettings, setTheme } from "../state/store.ts";
import type { Theme } from "../state/store.ts";

const THEMES: readonly { value: Theme; text: string }[] = [
	{ value: "system", text: "跟随系统" },
	{ value: "light", text: "浅色" },
	{ value: "dark", text: "深色" },
];

function CloseIcon(): JSX.Element {
	return (
		<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
			<path d="m6 6 12 12M18 6 6 18" />
		</svg>
	);
}

function Chevron(props: { up?: boolean }): JSX.Element {
	return (
		<span className={props.up === true ? "set-chev chev-up" : "set-chev"} aria-hidden="true">
			<svg width="8" height="13" viewBox="0 0 8 13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
				<path d="m1.5 1.5 5 5-5 5" />
			</svg>
		</span>
	);
}

/** 行首的图标：27 的方块里一枚 16 的线稿（稿子 05 的 `.sico`）。 */
function RowIcon(props: { children: ReactNode }): JSX.Element {
	return (
		<span className="set-ico" aria-hidden="true">
			{props.children}
		</span>
	);
}

const IconPlugin = (): JSX.Element => (
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
		<path d="M10 4h4v2.2a2 2 0 1 0 4 0V4h2v6h-2.2a2 2 0 1 0 0 4H20v6h-6v-2.2a2 2 0 1 0-4 0V20H4v-6h2.2a2 2 0 1 0 0-4H4V4h6z" />
	</svg>
);

const IconUpdate = (): JSX.Element => (
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
		<path d="M12 4v10" />
		<path d="m8.5 10.5 3.5 3.5 3.5-3.5" />
		<path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
	</svg>
);

const IconTheme = (): JSX.Element => (
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
		<circle cx="12" cy="12" r="8" />
		<path d="M12 4v16a8 8 0 0 0 0-16Z" fill="currentColor" stroke="none" opacity=".55" />
	</svg>
);

const IconDatabase = (): JSX.Element => (
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
		<ellipse cx="12" cy="6" rx="7" ry="3" />
		<path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6" />
		<path d="M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3" />
	</svg>
);

/** 一张卡：若干行，行间一条从图标右边起的细线。 */
function Group(props: { children: ReactNode }): JSX.Element {
	return (
		<section className="set-group">
			<div className="set-card">{props.children}</div>
		</section>
	);
}

export function SettingsPage(props: { theme: Theme; leaving?: boolean }): JSX.Element {
	// 插件分区在挂载前就注册完了（`main.tsx` 先 `bootPlugins()`），这里不订阅。
	const cells = cellsOf("settings.section").filter((cell) => cell.component !== undefined);
	// 三层共用**同一张弹窗**：清单（648）→ 插件清单 / 插件页（1040）只是换里面那一层，
	// 壳不重挂，宽高才谈得上过渡（ADR-106）。
	const pluginsOpen = useStore((state) => state.pluginSheet);
	const pluginPage = useStore((state) => state.pluginView);
	const level: "list" | "plugins" | "page" = pluginsOpen ? "plugins" : pluginPage === null ? "list" : "page";
	const wide = level !== "list";

	const frame = useRef<HTMLDivElement>(null);
	const size = useRef<{ w: number; h: number } | null>(null);
	// 高度动画跑着的时候又来了变化：先记下，等这一趟落定再补一次，别把动画来回掐断。
	const moving = useRef(false);
	const dirty = useRef(false);
	const label = level === "plugins" ? "插件" : level === "page" ? "插件页面" : "设置";

	const still = (): boolean => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

	/** 记下当前尺寸；和上一次不同就从上一次补间过来（WAAPI FLIP，motion.css 允许的唯一写法）。 */
	const settle = useRef((width: boolean) => {
		const el = frame.current;
		if (el === null) return;
		const rect = el.getBoundingClientRect();
		const next = { w: rect.width, h: rect.height };
		const from = size.current;
		size.current = next;
		if (from === null) return;
		if (Math.abs(from.w - next.w) < 1 && Math.abs(from.h - next.h) < 1) return;
		if (still()) return;
		moving.current = true;
		const keyframes = width
			? [
					{ width: `${String(from.w)}px`, height: `${String(from.h)}px` },
					{ width: `${String(next.w)}px`, height: `${String(next.h)}px` },
				]
			: [{ height: `${String(from.h)}px` }, { height: `${String(next.h)}px` }];
		const animation = el.animate(keyframes, { duration: 220, easing: "cubic-bezier(0.2, 0.7, 0.3, 1)" });
		animation.addEventListener("finish", () => {
			moving.current = false;
			if (!dirty.current) return;
			dirty.current = false;
			// 动画期间内容又变过：按落定后的真实高度再补一次。
			settle.current(false);
		});
	});

	// 换层：宽度要一起补（648 ↔ 800）。高度也在这里补第一下。
	useLayoutEffect(() => {
		settle.current(true);
	}, [level]);

	// 同一层里内容变高变矮（插件数据落地、渠道切换、折叠展开）：只补高度。
	// 监听 DOM 变异而不是订阅某个状态 —— 插件页是别人的代码，宿主不知道它在什么时候换了内容。
	useEffect(() => {
		const el = frame.current;
		const inner = el?.querySelector(".modal-level");
		if (el === null || inner === null || inner === undefined) return;
		let raf = 0;
		const poke = (): void => {
			cancelAnimationFrame(raf);
			raf = requestAnimationFrame(() => {
				if (moving.current) {
					dirty.current = true;
					return;
				}
				settle.current(false);
			});
		};
		const observer = new MutationObserver(poke);
		observer.observe(inner, { childList: true, subtree: true, characterData: true, attributes: true });
		window.addEventListener("resize", poke);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", poke);
			cancelAnimationFrame(raf);
		};
	}, [level]);

	return (
		<div
			className="overlay"
			data-leaving={props.leaving === true ? "true" : "false"}
			role="presentation"
			onMouseDown={(event) => {
				if (event.target === event.currentTarget) setSettings(false);
			}}
		>
			<div
				ref={frame}
				className={wide ? "modal modal-wide" : "modal"}
				data-level={level}
				role="dialog"
				aria-modal="true"
				aria-label={label}
			>
				{/* 换一层就重挂一次，配一点透明度：内容跟着尺寸一起换，而不是先跳再淡。 */}
				<div className="modal-level" data-level={level} key={level}>
					{level === "plugins" ? (
						<PluginsPage />
					) : level === "page" ? (
						<div className="modal-body modal-flush">
							<Slot name="app.page" />
						</div>
					) : (
						<>
							<header className="modal-head">
								{/* 窄窗口里这张弹窗就是整页：出口是左上角那颗返回（和对话页一样）；
								    宽窗口里才用右上角那颗 ✕。两个都在，CSS 按宽度留一个。 */}
								<button type="button" className="icon-btn modal-back" aria-label="返回对话" onClick={() => setSettings(false)}>
									<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
										<path d="M14.5 5.5 8 12l6.5 6.5" />
									</svg>
								</button>
								<span className="modal-title">设置</span>
								<button type="button" className="icon-btn modal-close" aria-label="关闭" onClick={() => setSettings(false)}>
									<CloseIcon />
								</button>
							</header>

							<div className="modal-body">
								<div className="set-body">
									<Group>
										<ThemeRow theme={props.theme} />
									</Group>

									{/* 插件自己注册的一节（`settings.section`）：收成一行，放在「插件」上面。 */}
									{cells.length === 0 ? null : (
										<Group>
											{SLOT_MARK ? <div className="slot-mark" data-slot="settings.section" /> : null}
											{cells.map((cell) => {
												const Component = cell.component;
												return Component === undefined ? null : (
													<div className="set-cell" key={cell.id}>
														<Component />
													</div>
												);
											})}
										</Group>
									)}

									<Group>
										<button type="button" className="set-row" onClick={() => setPluginSheet(true)}>
											<RowIcon>
												<IconPlugin />
											</RowIcon>
											<span className="set-main">
												<span className="set-label">插件</span>
												<span className="set-desc">装一个插件就是放一个文件夹，装完当场生效</span>
											</span>
											<Chevron />
										</button>
										{/* 插件注册的应用级入口（`app.entry`）：落在设置里，一行一个（手机上也只有这一处）。 */}
										<div className="set-tools">
											<Slot name="app.entry" />
										</div>
									</Group>

									<Group>
										<UpdateCheckRow />
										<UpdateProxyRow />
										<WorkDirsRow />
									</Group>

									<Group>
										<LicenseRow />
									</Group>

									<Group>
										<DataRow />
									</Group>
								</div>
							</div>
						</>
					)}
				</div>
			</div>
		</div>
	);
}

function ThemeRow(props: { theme: Theme }): JSX.Element {
	return (
		<div className="set-row is-static">
			<RowIcon>
				<IconTheme />
			</RowIcon>
			<span className="set-main">
				<span className="set-label">主题</span>
			</span>
			<div className="seg" id="theme-options">
				{THEMES.map((item) => (
					<button
						type="button"
						key={item.value}
						className="seg-item"
						data-theme-mode={item.value}
						aria-checked={props.theme === item.value}
						onClick={() => setTheme(item.value)}
					>
						{item.text}
					</button>
				))}
			</div>
		</div>
	);
}

/**
 * 检查更新：真正干活的是桌面壳（清单验签 → 下载 → 进程外替换，ADR-029），
 * 这里只按一下，结果由壳弹原生对话框说（「已经是最新版本」/「有新版本 x」）。
 * 同时显示壳报上来的当前版本；浏览器里没有那段桥，这一行只说明一句。
 */
function UpdateCheckRow(): JSX.Element {
	const [version, setVersion] = useState("");
	const desktop = typeof window !== "undefined" && window.soloDesktop !== undefined;

	useEffect(() => {
		if (!desktop) return;
		let alive = true;
		window.soloDesktop
			?.version?.()
			.then((value) => {
				if (alive) setVersion(value);
			})
			.catch(() => undefined);
		return () => {
			alive = false;
		};
	}, [desktop]);

	return (
		<div className="set-row is-static">
			<RowIcon>
				<IconUpdate />
			</RowIcon>
			<span className="set-main">
				<span className="set-label">检查更新</span>
				<span className="set-desc">
					{desktop ? (version === "" ? "有新版本会提示下载" : `当前版本 ${version}`) : "网页版没有自动更新，桌面版才有"}
				</span>
			</span>
			{desktop ? (
				<button type="button" className="set-action" onClick={() => window.soloDesktop?.menu("check-updates")}>
					检查
				</button>
			) : null}
		</div>
	);
}

/**
 * 更新代理：桌面版下载新版安装包时走它（GitHub 直连经常不通）。
 *
 * 平时收成一行（只显示当前地址），点开才出输入框和「保存」（v6 稿子 05 / D07）。
 * 只影响「下载更新」这一条路 —— 模型调用不走这个代理（用户明确要求的边界）。
 * 存进 `settings.json` 的 `updateProxy`，桌面壳每次检查更新前读一遍，所以不用重启。
 */
function UpdateProxyRow(): JSX.Element {
	const [open, setOpen] = useState(false);
	const [value, setValue] = useState("");
	const [saved, setSaved] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let alive = true;
		getPreferences()
			.then((prefs) => {
				if (!alive) return;
				setValue(prefs.updateProxy);
				setSaved(prefs.updateProxy);
			})
			.catch(() => undefined);
		return () => {
			alive = false;
		};
	}, []);

	const commit = async (): Promise<void> => {
		if (busy || value.trim() === saved) return;
		setBusy(true);
		setError(null);
		try {
			const prefs = await savePreferences(value.trim());
			setValue(prefs.updateProxy);
			setSaved(prefs.updateProxy);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(false);
		}
	};

	const shown = saved === "" ? "未设置" : saved.replace(/^https?:\/\//, "");

	return (
		<div className="set-proxy">
			<button type="button" className="set-row" aria-expanded={open} onClick={() => setOpen(!open)}>
				<RowIcon>
					<IconUpdate />
				</RowIcon>
				<span className="set-main">
					<span className="set-label">更新代理</span>
					<span className="set-desc">只用于桌面版下载新版安装包</span>
				</span>
				<span className="set-proxy-value">{shown}</span>
				<Chevron up={open} />
			</button>
			<Fold open={open}>
				<div className="set-proxy-body">
					<div className="set-proxy-field">
						<input
							className="setup-input"
							type="text"
							inputMode="url"
							autoComplete="off"
							spellCheck={false}
							aria-label="更新代理"
							placeholder="http://127.0.0.1:7890"
							value={value}
							onChange={(event) => setValue(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter") void commit();
							}}
						/>
						<button
							type="button"
							className="set-save"
							disabled={busy || value.trim() === saved}
							onClick={() => void commit()}
						>
							保存
						</button>
					</div>
					{error === null ? null : (
						<p className="set-note" data-error="true">
							{error}
						</p>
					)}
				</div>
			</Fold>
		</div>
	);
}

const IconFolder = (): JSX.Element => (
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
		<path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4l2 2.5h8A1.5 1.5 0 0 1 20.5 10v7A1.5 1.5 0 0 1 19 18.5H5A1.5 1.5 0 0 1 3.5 17z" />
	</svg>
);

/**
 * 工作目录：让 `file` / `search` 能去两个根以外的地方干活（我自己的代码仓库）。
 *
 * 这是安全边界的开口，所以入口只在这里、只认用户亲手加的绝对路径（ADR-126）。
 * 加 / 删都**当场写盘**，下一次工具调用就生效，不用重启 —— 工具侧每次现读
 * `settings.json` 的 `workDirs`。
 */
function WorkDirsRow(): JSX.Element {
	const [open, setOpen] = useState(false);
	const [dirs, setDirs] = useState<readonly string[]>([]);
	const [value, setValue] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let alive = true;
		getPreferences()
			.then((prefs) => {
				if (alive) setDirs(prefs.workDirs);
			})
			.catch(() => undefined);
		return () => {
			alive = false;
		};
	}, []);

	const commit = async (next: readonly string[]): Promise<boolean> => {
		if (busy) return false;
		setBusy(true);
		setError(null);
		try {
			const prefs = await saveWorkDirs(next);
			setDirs(prefs.workDirs);
			return true;
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
			return false;
		} finally {
			setBusy(false);
		}
	};

	const add = async (): Promise<void> => {
		const path = value.trim();
		if (path === "" || busy) return;
		if (await commit([...dirs, path])) setValue("");
	};

	return (
		<div className="set-proxy">
			<button type="button" className="set-row" aria-expanded={open} onClick={() => setOpen(!open)}>
				<RowIcon>
					<IconFolder />
				</RowIcon>
				<span className="set-main">
					<span className="set-label">工作目录</span>
					<span className="set-desc">让工具能读写两个根以外的目录，比如你的代码仓库</span>
				</span>
				<span className="set-proxy-value">{dirs.length === 0 ? "未设置" : `${String(dirs.length)} 个`}</span>
				<Chevron up={open} />
			</button>
			<Fold open={open}>
				<div className="set-proxy-body">
					{dirs.length > 0 ? (
						<ul className="set-dirs">
							{dirs.map((dir) => (
								<li className="set-dir" key={dir}>
									<span className="set-dir-path" title={dir}>
										{dir}
									</span>
									<button
										type="button"
										className="set-dir-remove"
										aria-label={`移除 ${dir}`}
										disabled={busy}
										onClick={() => void commit(dirs.filter((item) => item !== dir))}
									>
										移除
									</button>
								</li>
							))}
						</ul>
					) : null}
					<div className="set-proxy-field">
						<input
							className="setup-input"
							type="text"
							autoComplete="off"
							spellCheck={false}
							aria-label="工作目录"
							placeholder="/Users/你/code"
							value={value}
							onChange={(event) => setValue(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter") void add();
							}}
						/>
						<button type="button" className="set-save" disabled={busy || value.trim() === ""} onClick={() => void add()}>
							添加
						</button>
					</div>
					<p className="set-note">工具只会用它收到的显式路径进这些目录；密钥文件和数据库始终不开放。</p>
					{error === null ? null : (
						<p className="set-note" data-error="true">
							{error}
						</p>
					)}
				</div>
			</Fold>
		</div>
	);
}

/**
 * 第三方声明：随包发出去的那些组件各自的许可。
 *
 * **为什么要有这一栏**：`docs/THIRD-PARTY.md` 与 `seed/legal/THIRD-PARTY.md` 都在包里，
 * 但没人会去翻 `Resources/app/`。文件在、却看不到，等于没给。
 *
 * 内容由 `scripts/third-party.ts` 在 `ui:build` 之前从 `docs/THIRD-PARTY.md` 拷进来，
 * **这里不手抄**，改声明只改那一份。
 */
function LicenseRow(): JSX.Element {
	const [open, setOpen] = useState(false);
	const [text, setText] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!open || text !== null || error !== null) return;
		let alive = true;
		// 同源的静态文件：桌面版和网页版走的是同一条路，不用桥。
		fetch("/THIRD-PARTY.md")
			.then((response) => {
				if (!response.ok) throw new Error(`取不到第三方声明（HTTP ${String(response.status)}）`);
				return response.text();
			})
			.then((value) => {
				if (alive) setText(value);
			})
			.catch((reason: unknown) => {
				if (alive) setError(reason instanceof Error ? reason.message : String(reason));
			});
		return () => {
			alive = false;
		};
	}, [open, text, error]);

	return (
		<div className="set-proxy">
			<button type="button" className="set-row" aria-expanded={open} onClick={() => setOpen(!open)}>
				<RowIcon>
					<IconUpdate />
				</RowIcon>
				<span className="set-main">
					<span className="set-label">第三方声明</span>
					<span className="set-desc">用到的组件与各自的许可协议</span>
				</span>
				<Chevron up={open} />
			</button>
			<Fold open={open}>
				<div className="set-license-body">
					{error !== null ? (
						<p className="set-note" data-error="true">
							{error}
						</p>
					) : text === null ? (
						<p className="set-note">正在读…</p>
					) : (
						<pre className="set-license-text">{text}</pre>
					)}
				</div>
			</Fold>
		</div>
	);
}

/** 数据：只有一件事 —— 清空一切、回到刚装好的样子。确认浮层在 `Overlays.tsx`。 */
function DataRow(): JSX.Element {
	return (
		<button type="button" className="set-row is-danger" onClick={() => setResetOpen(true)}>
			<RowIcon>
				<IconDatabase />
			</RowIcon>
			<span className="set-main">
				<span className="set-label">重置所有数据</span>
				<span className="set-desc">成员、团队、聊天、记忆、技能、附件、日志和模型配置都会删掉</span>
			</span>
			<Chevron />
		</button>
	);
}
