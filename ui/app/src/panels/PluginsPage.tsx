/**
 * 插件页：一列插件 + 右边选中那个的详情，和「后台任务」是同一套骨架。
 * 一个文件夹一个插件，装 / 卸就是建 / 删那个文件夹。
 *
 * 后端部分（工具 / 提示词 / 接口）**当场生效**：内核写完文件就重装一遍插件（ADR-026）。
 * 但前端入口只在界面启动时 `import` 一次，所以带 `client.js` 的插件装完要问一句
 * 「要不要重启」——不重启的话它的页签、按钮不会出现。
 *
 * 宽度：左栏 288px（和聊天列表一样），右边才是正文。清单长到几十个也认得过来，
 * 因为名字只占一列、开关和删除在正文里，不在每一行里挤三个东西。
 */

import { useEffect, useState } from "react";
import { getPlugins, installPlugin, removePlugin, setPluginEnabled } from "../api/client.ts";
import type { Plugin } from "../api/types.ts";
import { setRestartOpen } from "../state/store.ts";

/** 「它带来了什么」压成一行。全是空的时候说「只有一份说明」。 */
function bringsText(brings: NonNullable<Plugin["brings"]>): string {
	const parts = [
		brings.tools.length === 0 ? undefined : `工具 ${brings.tools.join("、")}`,
		brings.prompt ? "一段提示词" : undefined,
		brings.routes === 0 ? undefined : `${String(brings.routes)} 条接口`,
		brings.listens ? "听消息" : undefined,
	].filter((part) => part !== undefined);
	return parts.length === 0 ? "只有一份说明" : parts.join(" · ");
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

export function PluginsPage(): JSX.Element {
	const [plugins, setPlugins] = useState<readonly Plugin[] | undefined>(undefined);
	const [problem, setProblem] = useState<string | undefined>(undefined);
	const [picked, setPicked] = useState<PickedFolder | undefined>(undefined);
	/** 右栏现在看的是哪一个（按目录名记，重装之后还是它）。 */
	const [current, setCurrent] = useState<string | undefined>(undefined);
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
	const apply = (action: Promise<{ plugins: Plugin[] }>, after?: (plugins: readonly Plugin[]) => void): void => {
		action
			.then((body) => {
				setPlugins(body.plugins);
				setProblem(undefined);
				after?.(body.plugins);
			})
			.catch((error: Error) => {
				setProblem(error.message);
			});
	};

	// 没选过 / 选中的被删了：落在第一个上，右栏不留空。
	const active = plugins?.find((plugin) => plugin.slug === current) ?? plugins?.[0];

	return (
		<section className="page" id="page-plugins" aria-label="插件">
			<div className="page-side">
				<header className="page-side-head">
					<h2 className="page-title">
						插件 <span className="team-count">{plugins?.length ?? 0}</span>
					</h2>
					{/* 装插件就是给这一列加一格：那颗「+」和聊天标题旁的拉群同款、同位置。 */}
					<label className="icon-btn plugin-add" title="装一个插件（选它的文件夹）">
						<span className="sr-only">选一个插件文件夹装进来</span>
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
							<path d="M12 5v14M5 12h14" />
						</svg>
						<input
							type="file"
							multiple
							className="sr-only"
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
				</header>

				<div className="page-side-body">
					{/* 选好文件夹之后在这里确认：看清是哪个再按「安装」。 */}
					{picked === undefined ? null : (
						<div className="plugin-picked-row">
							<span className="plugin-picked" title={picked.files.map((file) => file.path).join("\n")}>
								已选「{picked.slug}」（{picked.files.length} 个文件）
							</span>
							<button
								type="button"
								className="plugin-install-btn"
								onClick={() => {
									const slug = picked.slug;
									apply(installPlugin(slug, picked.files), (list) => {
										const installed = list.find((plugin) => plugin.slug === slug);
										// 后端已经热装上了；带前端入口的才需要重开界面。
										if (installed?.client === true && installed.error === undefined) {
											setRestartOpen(installed.name);
										}
									});
									setPicked(undefined);
								}}
							>
								安装
							</button>
						</div>
					)}
					<div className="plugin-nav" id="plugins-list" role="listbox" aria-label="插件清单">
						{plugins === undefined ? (
							<p className="page-hint">正在读插件…</p>
						) : plugins.length === 0 ? (
							<p className="page-hint">还没有插件。</p>
						) : (
							plugins.map((plugin) => (
								<button
									type="button"
									key={plugin.slug}
									role="option"
									className="plugin-nav-item"
									aria-selected={active?.slug === plugin.slug}
									data-enabled={plugin.enabled}
									onClick={() => setCurrent(plugin.slug)}
								>
									<span className="plugin-nav-name">{plugin.name}</span>
									<span className="plugin-nav-state" data-on={plugin.enabled} aria-hidden="true" />
									<span className="sr-only">{plugin.enabled ? "开着" : "关着"}</span>
								</button>
							))
						)}
					</div>
				</div>
			</div>

			<div className="page-main">
				{active === undefined ? (
					<div className="page-main-blank">
						<p>
							{plugins === undefined
								? "正在读插件…"
								: "还没有插件。从标题右边那颗「+」选一个插件文件夹装进来 —— 插件跑在本机进程里，只装自己信得过的。"}
						</p>
					</div>
				) : (
					<>
						<header className="page-main-head">
							<h2 className="page-title">
								{active.name}
								{active.slug === active.name ? null : <span className="plugin-slug">{active.slug}</span>}
							</h2>
							<div className="page-main-acts">
								<button
									type="button"
									className="plugin-remove"
									data-armed={armed === active.slug}
									aria-label={armed === active.slug ? `确认删掉 ${active.name}` : `删掉 ${active.name}`}
									title={armed === active.slug ? "再点一次就删掉，找不回来" : "删掉这个插件（连同它的代码）"}
									onClick={() => {
										// 删的是磁盘上的代码，找不回来 —— 同一个按钮点两次才算数。
										// 不用 `window.confirm`：桌面壳里那个对话框会被吞掉，点了像没反应（实测踩过）。
										if (armed !== active.slug) {
											setArmed(active.slug);
											return;
										}
										setArmed(undefined);
										apply(removePlugin(active.slug));
									}}
								>
									{armed === active.slug ? "确认删除" : "删除"}
								</button>
								<button
									type="button"
									className="plugin-switch"
									role="switch"
									aria-checked={active.enabled}
									aria-label={`${active.enabled ? "关掉" : "打开"} ${active.name}`}
									onClick={() => {
										apply(setPluginEnabled(active.slug, !active.enabled));
									}}
								>
									<span className="plugin-knob" />
								</button>
							</div>
						</header>

						<div className="page-main-body">
							{problem === undefined ? null : <p className="settings-problem">{problem}</p>}
							<p className="plugin-detail-desc">{active.description === "" ? "没有说明" : active.description}</p>
							{active.error === undefined ? null : <p className="settings-problem">{active.error}</p>}
							<dl className="plugin-facts">
								<dt>带来</dt>
								<dd>
									{active.brings !== undefined
										? bringsText(active.brings)
										: active.enabled
											? "还没装上 · 看一眼日志里的 [plugin]"
											: "关着，不干活"}
								</dd>
								<dt>目录</dt>
								<dd className="plugin-detail-dir">plugins/{active.slug}/</dd>
							</dl>
						</div>
					</>
				)}
			</div>
		</section>
	);
}
