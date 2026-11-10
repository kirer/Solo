/**
 * 插件页：左边是文件夹，右边是选中那个的全部（v6 稿子 D11 / 24）。
 *
 * 一个文件夹一个插件，装 / 卸就是建 / 删那个文件夹。
 * 后端部分（工具 / 提示词 / 接口）**当场生效**：内核写完文件就重装一遍插件（ADR-026）。
 * 但前端入口只在界面启动时 `import` 一次，所以带 `client.js` 的插件装完要问一句
 * 「要不要重启」——不重启的话它的页签、按钮不会出现。
 */

import { useEffect, useState } from "react";
import {
	getPluginPermissions,
	getPlugins,
	grantPluginPermissions,
	getRemovedPlugins,
	installPlugin,
	removePlugin,
	restorePlugin,
	setPluginEnabled,
	type PluginPermissionAsk,
} from "../api/client.ts";
import type { Plugin } from "../api/types.ts";
import { setPluginSheet, setRestartOpen } from "../state/store.ts";

/** 「它带来了什么」压成一行。全是空的时候说「只有一份说明」。 */
function bringsText(brings: NonNullable<Plugin["brings"]>): string {
	const parts = [
		brings.tools.length === 0 ? undefined : `工具 ${brings.tools.join("、")}`,
		brings.prompt ? "一段提示词" : undefined,
		brings.routes === 0 ? undefined : `${String(brings.routes)} 条接口`,
		brings.listens ? "听消息" : undefined,
		brings.policies === 0 ? undefined : `${String(brings.policies)} 条分发策略`,
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

/**
 * 插件清单。开在设置的弹窗里（`embedded`）：同一个容器、同一层浮层，
 * 返回落回设置的清单；× 关的是整个设置。
 */
export function PluginsPage(): JSX.Element {
	const [plugins, setPlugins] = useState<readonly Plugin[] | undefined>(undefined);
	const [problem, setProblem] = useState<string | undefined>(undefined);
	const [picked, setPicked] = useState<PickedFolder | undefined>(undefined);
	const [selected, setSelected] = useState<string | undefined>(undefined);
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

	/**
	 * 自己删掉的出厂插件。
	 *
	 * 删掉之后不偷偷塞回来（播种只补「意外丢失」那种），所以这里得有一个明确的
	 * 装回入口 —— 否则老板哪天真想用了就死在那儿。清单变化后重读一次。
	 */
	const [removed, setRemoved] = useState<readonly string[]>([]);
	const reloadRemoved = (): void => {
		getRemovedPlugins()
			.then((body) => setRemoved(body.removed))
			.catch(() => setRemoved([]));
	};
	useEffect(reloadRemoved, [plugins]);

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

	const list = plugins ?? [];
	const current = list.find((plugin) => plugin.slug === selected) ?? list[0];

	/**
	 * 当前这个插件还要问人的权限。**默认全不给**：没列的、没批的，插件调了就抛错。
	 *
	 * 只在这个插件**声明了权限**时才去问后端（大多数插件一条都不要）。`canSystem` false
	 * （网页版、或这一页不是从本机打开的）时不显示批准按钮 —— 批了也不会有本机效果。
	 */
	const [ask, setAsk] = useState<{ pending: PluginPermissionAsk[]; canSystem: boolean } | undefined>(undefined);
	const askOf = current?.slug;
	const declares = current?.permissions !== undefined;
	useEffect(() => {
		if (askOf === undefined || !declares) {
			setAsk(undefined);
			return;
		}
		let live = true;
		getPluginPermissions(askOf)
			.then((body) => {
				if (live) setAsk(body);
			})
			.catch(() => {
				if (live) setAsk(undefined);
			});
		return () => {
			live = false;
		};
	}, [askOf, declares, current?.permissions?.granted.join(",")]);

	// 只画「弹窗里面那一层」：外面的 `.overlay` / `.modal` 归宿主（设置那张，ADR-106）。
	return (
		<>
				<header className="modal-head">
					<button type="button" className="icon-btn" id="plugins-back" aria-label="返回设置" onClick={() => setPluginSheet(false)}>
						<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
							<path d="M14.5 5.5 8 12l6.5 6.5" />
						</svg>
					</button>
					<h1 className="modal-title">插件</h1>
					<span className="head-grow" />
					<label className="pl-add" title="装一个插件（选它的文件夹）">
						<span className="sr-only">选一个插件文件夹装进来</span>
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
							<path d="M12 5.5v13M5.5 12h13" />
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
								const files = event.target.files;
								if (files === null || files.length === 0) return;
								readFolder(files)
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

				<div className="modal-body modal-flush">
					<div className="pl-body">
						<aside className="pl-list" aria-label="插件清单">
							{picked === undefined ? null : (
								<button type="button" className="pl-item" data-on="true" onClick={() => setSelected(undefined)}>
									<span className="n">装「{picked.slug}」<i className="dot" /></span>
									<span className="s">{picked.files.length} 个文件 · 还没装</span>
								</button>
							)}
							{plugins === undefined ? <p className="page-hint">正在读插件…</p> : null}
							{plugins !== undefined && list.length === 0 && picked === undefined ? (
								<p className="page-hint">还没有插件。</p>
							) : null}
							{list.map((plugin) => (
								<button
									type="button"
									key={plugin.slug}
									className="pl-item"
									data-on={current?.slug === plugin.slug ? "true" : "false"}
									onClick={() => setSelected(plugin.slug)}
								>
									<span className="n">
										{plugin.name}
										<i className="dot" data-off={plugin.enabled ? "false" : "true"} />
									</span>
									<span className="s">
										{plugin.brings !== undefined ? bringsText(plugin.brings) : plugin.enabled ? "还没装上" : "关着"}
									</span>
								</button>
							))}
							{removed.length === 0 ? null : (
								<div className="pl-removed">
									<p className="pl-removed-head">已删掉的出厂插件</p>
									{/* 一个个按钮，不放主列表里：它们不在盘上，混进清单会让人以为还装着。 */}
									{removed.map((name) => (
										<button
											type="button"
											key={name}
											className="pl-removed-item"
											title={`把「${name}」装回来`}
											onClick={() => {
												apply(restorePlugin(name), (next) => {
													const back = next.find((plugin) => plugin.slug === name);
													if (back?.client === true && back.error === undefined) setRestartOpen(back.name);
												});
											}}
										>
											{name}
											<span className="pl-removed-btn">装回来</span>
										</button>
									))}
								</div>
							)}
						</aside>

						<section className="pl-detail" aria-label="插件详情">
							<div className="pl-in">
								{problem === undefined ? null : <p className="settings-problem">{problem}</p>}

								{picked === undefined ? null : (
									<div className="plugin-card">
										<div className="plugin-head">
											<span className="plugin-name">装「{picked.slug}」</span>
										</div>
										<p className="plugin-desc" title={picked.files.map((file) => file.path).join("\n")}>
											选了 {picked.files.length} 个文件。装完后端当场生效；带前端的插件会问你要不要重开界面。
										</p>
										<div className="plugin-foot">
											<span className="note">装之前先看一眼目录：插件跑在本机进程里。</span>
											<button
												type="button"
												className="plugin-install-btn"
												onClick={() => {
													const slug = picked.slug;
													apply(installPlugin(slug, picked.files), (next) => {
														const installed = next.find((plugin) => plugin.slug === slug);
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
									</div>
								)}

								{current === undefined ? null : (
									<div className="plugin-card">
										<div className="plugin-head">
											<span className="plugin-name">{current.name}</span>
											{current.slug === current.name ? null : <span className="plugin-slug">{current.slug}</span>}
											<button
												type="button"
												className="plugin-switch"
												data-on={current.enabled ? "true" : "false"}
												role="switch"
												aria-checked={current.enabled}
												aria-label={`${current.enabled ? "关掉" : "打开"} ${current.name}`}
												onClick={() => apply(setPluginEnabled(current.slug, !current.enabled))}
											>
												<span className="knob" />
											</button>
										</div>
										<p className="plugin-desc">{current.description === "" ? "没有说明" : current.description}</p>
										<dl className="plugin-facts">
											<dt>带来</dt>
											<dd>
												{current.brings !== undefined
													? bringsText(current.brings)
													: current.enabled
														? "还没装上 · 看一眼日志里的 [plugin]"
														: "关着，不干活"}
											</dd>
											<dt>目录</dt>
											<dd className="mono">plugins/{current.slug}/</dd>
										</dl>
										{current.error === undefined ? null : <p className="settings-problem">{current.error}</p>}

										{current.permissions === undefined ? null : (
											<div className="plugin-perms" aria-label="系统权限">
												<div className="plugin-perms-head">
													<span>系统权限</span>
													<span className="note">
														{current.permissions.pending.length === 0 ? "都批过了" : "默认全不给：没批的那几条，它调了只会报错"}
													</span>
												</div>
												<ul>
													{current.permissions.declared.map((action) => {
														const pending = current.permissions?.pending.includes(action) === true;
														const detail = ask?.pending.find((item) => item.action === action);
														return (
															<li key={action} data-pending={pending ? "true" : "false"}>
																<span className="what">{detail?.label ?? action}</span>
																<span className="why">{detail?.detail ?? ""}</span>
																<span className="state">{pending ? "还没批" : "已批准"}</span>
															</li>
														);
													})}
												</ul>
												<div className="plugin-perms-foot">
													{ask?.canSystem === false ? (
														<span className="note">这个宿主做不了系统动作（网页版，或者你这页不是从本机打开的）</span>
													) : (
														<>
															<button
																type="button"
																className="plugin-perms-grant"
																disabled={current.permissions.pending.length === 0}
																onClick={() =>
																	apply(
																		grantPluginPermissions(current.slug, current.permissions?.declared ?? []),
																	)
																}
															>
																全部批准（{current.permissions.pending.length} 条待批）
															</button>
															<button
																type="button"
																className="plugin-perms-grant"
																data-variant="quiet"
																disabled={current.permissions.granted.length === 0}
																onClick={() => apply(grantPluginPermissions(current.slug, []))}
															>
																收回全部
															</button>
														</>
													)}
												</div>
											</div>
										)}

										<div className="plugin-foot">
											<span className="note">
												{current.enabled ? "后端已生效；前端入口随界面启动装载" : "关着：后端与前端入口都不干活"}
											</span>
											<button
												type="button"
												className="plugin-remove"
												data-armed={armed === current.slug ? "true" : "false"}
												aria-label={armed === current.slug ? `确认删掉 ${current.name}` : `删掉 ${current.name}`}
												onClick={() => {
													// 删的是磁盘上的代码，找不回来 —— 同一个按钮点两次才算数。
													if (armed !== current.slug) {
														setArmed(current.slug);
														return;
													}
													setArmed(undefined);
													apply(removePlugin(current.slug));
												}}
											>
												{armed === current.slug ? "再点一次就删掉" : "删除"}
											</button>
										</div>
									</div>
								)}

								<p className="page-hint">装一个插件就是选一个文件夹。插件跑在本机进程里，只装自己信得过的。</p>
							</div>
						</section>
					</div>
				</div>
		</>
	);
}
