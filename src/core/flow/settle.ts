/**
 * `settle`：一轮结束后的两种结算，一个入口。
 *
 * ```
 * done        有答案 → 读快照、取答案条目 → 问收尾策略 → 需要就补发（照常叫醒人）
 * unanswered  没产出 → 往频道里留一行痕（谁、哪条、为什么）
 * ```
 *
 * 补发就是一次**正常的 `publish`**：落盘、算人、扇出、插件钩子全都走主线的同一条路，
 * 所以「补发要叫醒被 @ 的人」不需要在这里再写一遍。
 *
 * 顺序与锁：`repost` 闸包住「读答案 → 判重 → 补发」，补发内部再取 `publish` 闸。
 * 反过来的路径不存在（`publish` 从不取 `repost`），所以不会死锁。这条闸必须
 * **整个进程一份**：两条提交同时结算会并发跑两次收尾，都快照到「频道里还没有这句」，
 * 于是同一句话发两遍（实测 2026-11-02 周楠 #15/#16、苏黎 #17/#18）。
 *
 * 判断本身在 `defaults/settle.ts`（纯函数 + `defaultSettler`）；这里只做机械的事。
 */
import type { Context } from "../runtime/index.ts";
import type { MentionRoster } from "../channel/mentions.ts";
import { answerEntry, finalTextOf, saidLast } from "./defaults/settle.ts";
import type { Flow, FlowGates, MessageStore, Settler } from "./ports.ts";

export type SettleDeps = {
	readonly store: MessageStore;
	readonly settler: Settler;
	/** 补发就是一次 publish：主线只有这一条写盘—算人—扇出的路。 */
	readonly publish: Flow["publish"];
	/** 补发时 `@我` 要按名册落成 `owner`，不能存字面 token。 */
	readonly roster?: () => Promise<MentionRoster>;
	readonly gate: FlowGates["repost"];
};

export function createSettle(deps: SettleDeps): Flow["settle"] {
	return async (event, ctx: Context): Promise<void> => {
		if (event.kind === "unanswered") {
			// 「叫了他，但他这一轮一个字都没说出来」：频道里至少能看出他回答了没。
			await deps.store.note({ channelId: event.channelId, text: event.text, at: Date.now() }, ctx);
			return;
		}

		await deps.gate(async () => {
			const state = await deps.store.snapshot(ctx);
			const { entry, page } = await answerEntry(event.entries, event.answer, ctx);
			const trimmed = finalTextOf(entry)?.trim();
			const decision = await deps.settler.decide(
				{
					slug: event.slug,
					wake: event.wake,
					state,
					...(trimmed === undefined ? {} : { text: trimmed }),
					saidLast: saidLast(page, entry),
				},
				ctx,
			);

			if (decision.kind === "silent") {
				// 不补也要留痕：live 里「提交 done 但频道里一个字没有」得能分清是没说话还是我们主动吞了。
				if (decision.reason === "no-entry") {
					console.log(`[turn] ${event.slug} 不补发：会话里找不到这段正文`);
				} else if (decision.reason === "pass") {
					console.log(`[turn] ${event.slug} 不补发：[PASS] 或空正文`);
				}
				return;
			}

			// 读名册失败也别把结论丢了：退回字面 token，投递那边还有兜底。
			const roster = deps.roster === undefined ? undefined : await deps.roster().catch(() => undefined);
			try {
				const written = await deps.publish(
					{
						channelId: decision.channelId,
						from: event.slug,
						text: decision.text,
						at: Date.now(),
						...(roster === undefined ? {} : { roster }),
					},
					ctx,
				);
				// 留一行日志：这一条是系统替它发的，不是它自己说的。查「谁替我回了」时靠这行定位。
				console.log(
					`[turn] ${event.slug} 答在会话里但没说出来，已补发到 ${decision.channelId}（唤醒自 #${event.wake.reply.seq}；落成 #${written.message.seq}「${written.message.text.slice(0, 20)}」）`,
				);
			} catch (error) {
				// 补发失败 = 内容丢了（他没 `say`，正文只在这个条目里）。必须留一行能被 live 数到的日志。
				console.warn(
					`[turn] ${event.slug} 答在会话里但补发失败：${error instanceof Error ? error.message : String(error)}`,
				);
			}
		});
	};
}
