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
import type { SettleResult } from "./types.ts";

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
	return async (event, ctx: Context): Promise<SettleResult> => {
		if (event.kind === "unanswered") {
			// 「叫了他，但他这一轮一个字都没说出来」：频道里至少能看出他回答了没。
			await deps.store.note({ channelId: event.channelId, text: event.text, at: Date.now() }, ctx);
			return { kind: "silent", reason: "unanswered" };
		}

		return deps.gate(async (): Promise<SettleResult> => {
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
				return { kind: "silent", reason: decision.reason };
			}

			// 策略只能提议：频道在不在、他是不是成员、正文空不空，core 再核一遍。
			// 默认收尾本来就查这些；插件替换收尾之后，这一道不能少（ADR-080）。
			const target = state.channels[decision.channelId];
			if (target === undefined || !target.members.includes(event.slug) || decision.text.trim() === "") {
				const error = `收尾提议被丢弃：${event.slug} 不能往 ${decision.channelId} 发`;
				console.warn(`[flow] ${error}`);
				return { kind: "failed", error };
			}

			// 同一条答案会被**多条提交**各结算一次（报到 + 投递、投递 + 后台命令跑完）。
			// 判据是答案条目 id，不是正文：两个人真说了同一句话（「在。」）不该互相吞掉。
			// 这是 core 的不变量，不交给策略 —— 插件换了收尾也必须只补一次（ADR-080）。
			const sourceEntry = entry === undefined ? undefined : String(entry.id);
			if (
				sourceEntry !== undefined &&
				(state.messages[decision.channelId] ?? []).some((item) => item.sourceEntry === sourceEntry)
			) {
				return { kind: "silent", reason: "duplicate" };
			}

			// 补发也是正常发言：`@我` 必须按名册落成 slug，不能存字面 token。
			// 名册读不出来就退回字面 token 照发 —— 丢一句的代价远大于叫错人。
			const roster = deps.roster === undefined ? undefined : await deps.roster().catch(() => undefined);
			try {
				const written = await deps.publish(
					{
						channelId: decision.channelId,
						from: event.slug,
						text: decision.text,
						at: Date.now(),
						...(sourceEntry === undefined ? {} : { sourceEntry }),
						...(roster === undefined ? {} : { roster }),
					},
					ctx,
				);
				// 留一行日志：这一条是系统替它发的，不是它自己说的。查「谁替我回了」时靠这行定位。
				console.log(
					`[turn] ${event.slug} 答在会话里但没说出来，已补发到 ${decision.channelId}（唤醒自 #${event.wake.reply.seq}；落成 #${written.message.seq}「${written.message.text.slice(0, 20)}」）`,
				);
				return { kind: "reposted", message: written.message };
			} catch (error) {
				// 补发失败 = 内容丢了（他没 `say`，正文只在这个条目里）。结果交给 durable 收尾，
				// 让它把这件任务记成 failed —— 不能报 completed，否则「补没补上」永远查不出来。
				const message = error instanceof Error ? error.message : String(error);
				console.warn(`[turn] ${event.slug} 答在会话里但补发失败：${message}`);
				return { kind: "failed", error: message };
			}
		});
	};
}
