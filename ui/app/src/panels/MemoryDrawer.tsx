/**
 * 记忆抽屉：看某个人记了什么、加一条、删一条。
 *
 * 为什么是一个抽屉而不是右栏的一个 tab：老板点「记忆」时通常正在跟这个人说话，
 * 抽屉盖住右半屏仍看得见对话；换成 tab 会把详情挤走，看完还得切回来。
 *
 * 三条硬规矩：
 * 1. **一条一行一行地列**，不折叠成「共 N 条」——记忆的价值在于句子本身。
 * 2. 删除要二次确认，但**不加输入框**：`window.confirm` 就够了，多一个输入框是
 *    把「删一条笔记」当成「删库」。
 * 3. 加一条失败（超长 / 像密钥 / 空）时把后端那句中文原样显示出来 ——
 *    那是唯一能让老板知道「为什么没记上」的东西。
 */

import { useCallback, useEffect, useState } from "react";
import { getPersonMemory, editPersonMemory } from "../api/client.ts";
import type { MemoryEntry, PersonMemory } from "../api/types.ts";
import { clockTime, dayLabel } from "../lib/format.ts";
import { closeMemory } from "../state/store.ts";
import { useStore } from "../state/useStore.ts";

export function MemoryDrawer(props: { toast: (text: string, tone?: "info" | "error") => void }): JSX.Element | null {
	const target = useStore((state) => state.memoryPerson);
	const [data, setData] = useState<PersonMemory | null>(null);
	const [draft, setDraft] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");

	const refresh = useCallback(async (slug: string) => {
		setError("");
		try {
			setData(await getPersonMemory(slug));
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "读不到记忆");
		}
	}, []);

	useEffect(() => {
		setData(null);
		setDraft("");
		if (target !== null) void refresh(target.slug);
	}, [target, refresh]);

	useEffect(() => {
		if (target === null) return;
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape") {
				event.stopPropagation();
				closeMemory();
			}
		};
		document.addEventListener("keydown", onKey, true);
		return () => document.removeEventListener("keydown", onKey, true);
	}, [target]);

	if (target === null) return null;

	const entries = data?.entries ?? [];

	const add = async (): Promise<void> => {
		const text = draft.trim();
		if (text === "" || busy) return;
		setBusy(true);
		setError("");
		try {
			await editPersonMemory(target.slug, { op: "add", text });
			setDraft("");
			await refresh(target.slug);
			props.toast("记下了");
		} catch (reason) {
			const message = reason instanceof Error ? reason.message : "没记上";
			setError(message);
			props.toast(message, "error");
		} finally {
			setBusy(false);
		}
	};

	const forget = async (entry: MemoryEntry): Promise<void> => {
		if (busy) return;
		if (!window.confirm(`删掉这条？\n\n${entry.heading}\n${entry.body.slice(0, 80)}`)) return;
		setBusy(true);
		setError("");
		try {
			await editPersonMemory(target.slug, { op: "forget", heading: entry.heading });
			await refresh(target.slug);
			props.toast("删掉了");
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "没删掉");
		} finally {
			setBusy(false);
		}
	};

	return (
		<>
			<div className="memory-scrim" onClick={() => closeMemory()} />
			<aside className="memory" id="memory" role="dialog" aria-modal="true" aria-label={`${target.label} 的记忆`}>
				<div className="memory-head">
					<span className="memory-title">
						{target.label} 的记忆 <span className="memory-count">{entries.length}</span>
					</span>
					<button type="button" className="icon-btn" aria-label="关闭" onClick={() => closeMemory()}>
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
							<path d="M6 6l12 12M18 6 6 18" />
						</svg>
					</button>
				</div>

				<div className="memory-body">
					{error === "" ? null : <p className="memory-error">{error}</p>}
					{data === null ? (
						<p className="memory-empty">正在读…</p>
					) : entries.length === 0 ? (
						<p className="memory-empty">还没有记忆。下面写一条，下一条消息就生效。</p>
					) : (
						entries.map((entry) => (
							<div className="memory-entry" key={entry.heading}>
								<div className="memory-entry-head">
									<span className="memory-heading">{entry.heading}</span>
									<button
										type="button"
										className="memory-del"
										aria-label={`删掉 ${entry.heading}`}
										title="删掉这条"
										disabled={busy}
										onClick={() => void forget(entry)}
									>
										删除
									</button>
								</div>
								{stampOf(entry) === undefined ? null : <p className="memory-stamp">{stampOf(entry)}</p>}
								<div className="memory-lines">
									{entry.body
										.split("\n")
										.filter((line) => line.trim() !== "")
										.map((line, index) => (
											<p className="memory-line" key={`${String(index)}-${line.slice(0, 12)}`}>
												{line.replace(/^\s*[-*]\s*/, "")}
											</p>
										))}
								</div>
							</div>
						))
					)}
				</div>

				<div className="memory-foot">
					<textarea
						className="memory-input"
						id="memory-input"
						rows={3}
						value={draft}
						placeholder="记一条：他做事的方式、你纠正过他的地方、下次别再犯的…"
						onChange={(event) => setDraft(event.target.value)}
						onKeyDown={(event) => {
							if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
								event.preventDefault();
								void add();
							}
						}}
					/>
					<div className="memory-actions">
						<span className="memory-hint">一条不超过 300 字，写要点不写过程</span>
						<button
							type="button"
							className="memory-add"
							id="memory-add"
							disabled={busy || draft.trim() === ""}
							onClick={() => void add()}
						>
							记下
						</button>
					</div>
				</div>
			</aside>
		</>
	);
}

/** 一行「10-27 03:12 · 老板改过」。没有日志时返回 undefined，界面就不画这一行。 */
function stampOf(entry: MemoryEntry): string | undefined {
	if (entry.at === null) return undefined;
	const at = Date.parse(entry.at);
	if (Number.isNaN(at)) return undefined;
	const who = entry.by === "human" ? "老板" : entry.by === "remember" ? "他自己" : "agent";
	const what = entry.op === "edit" ? "改过" : "记下";
	return `${dayLabel(at)} ${clockTime(at)} · ${who}${what}`;
}
