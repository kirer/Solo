/**
 * 刚装好的第一屏：还没别人时，给三句能直接发出去的话（稿子 12）。
 *
 * 只在这个组织里**一个人都没有**（只剩助理）时出现。点了就是替我发这条消息 ——
 * 走的是和输入框同一条 `send`，不是另一套发消息逻辑。
 */

import { useState } from "react";
import { send } from "../state/store.ts";
import { useStore } from "../state/useStore.ts";
import type { State } from "../state/store.ts";

const STARTERS: readonly { text: string; icon: JSX.Element }[] = [
	{
		text: "建一个产品团队，先把官网落地页做出来",
		icon: <path d="M4 7h16M4 12h10M4 17h13" />,
	},
	{
		text: "招两个人：一个写文案，一个做排版",
		icon: (
			<>
				<circle cx="12" cy="8.2" r="3.4" />
				<path d="M5 20c.6-3.6 3.5-5.6 7-5.6s6.4 2 7 5.6" />
			</>
		),
	},
	{
		text: "先聊聊这东西平时怎么用",
		icon: (
			<>
				<circle cx="12" cy="12" r="8" />
				<path d="M12 8v4.5l3 2" />
			</>
		),
	},
];

/** `people` 里只有助理 = 还没有别人。 */
const onlyAssistant = (state: State): boolean => state.people.every((person) => person.assistant === true);

export function Starters(props: { toast: (text: string, tone?: "info" | "error") => void }): JSX.Element | null {
	const alone = useStore(onlyAssistant);
	const [busy, setBusy] = useState(false);
	if (!alone) return null;

	async function pick(text: string): Promise<void> {
		if (busy) return;
		setBusy(true);
		try {
			await send(text);
		} catch (error) {
			props.toast(error instanceof Error ? error.message : "没发出去", "error");
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="starters">
			{STARTERS.map((item) => (
				<button type="button" key={item.text} className="starter" disabled={busy} onClick={() => void pick(item.text)}>
					<span className="starter-ic">
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
							{item.icon}
						</svg>
					</span>
					{item.text}
					<span className="starter-arrow" aria-hidden="true">
						<svg width="7" height="12" viewBox="0 0 8 13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
							<path d="m1.5 1.5 5 5-5 5" />
						</svg>
					</span>
				</button>
			))}
		</div>
	);
}
