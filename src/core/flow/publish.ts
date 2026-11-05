/**
 * `publish`：一条新消息的一生。**后端主线就读这一个函数。**
 *
 * 固定顺序（每一步都有它非在不可的理由）：
 *
 * 1. **读快照** —— 收件人、未读摘要都要按「这条消息之前」的样子算；
 * 2. **落盘** —— `store.append`，seq 自愈与路径式 push 在 `channel/write.ts`；
 * 3. **算人** —— `note` / `wake: false` 直接不叫人；`wakeTo` 跳过策略；
 *    其余交给策略链（内置规则在 `defaults/router.ts`，插件策略排在它前面）；
 * 4. **校验** —— 任何策略只能提议，非成员 / 我 / 发件人自己 / 重复目标在这里滤掉；
 * 5. **扇出** —— `runner.fanOut`：逐条入队、合并排队项、记 wake、等结算；
 * 6. **钩子** —— 投递之后、**闸门之外**：插件慢或抛错都不该占着频道写入的串行闸。
 *
 * 闸门包住 1–5：这是 ADR-073 留下的那条「读—算—提交」串行。它保护的不是 commit
 * 本身（底座 group commit 已经按文档排队），而是 commit 之前的读和随后的算。
 */
import type { Context } from "../runtime/index.ts";
import type { Flow, FlowPorts } from "./ports.ts";
import type { PublishInput, PublishResult } from "./types.ts";
import { routeFactsOf } from "./defaults/router.ts";
import { resolvePlan } from "./policies.ts";
import { validatePlan } from "./validate.ts";

/** 发布还要把 `settle` 递给投递：没答上来的留痕走同一个入口。 */
export type PublishPorts = FlowPorts & { readonly settle: Flow["settle"] };

export function createPublish(ports: PublishPorts): (input: PublishInput, ctx: Context) => Promise<PublishResult> {
	return async (input, ctx) => {
		const result = await ports.gate.publish(async (): Promise<PublishResult> => {
			const snapshot = await ports.store.read(input.channelId, ctx);
			if (snapshot === undefined) throw new Error(`频道不存在：${input.channelId}`);
			const appended = await ports.store.append(input, ctx);
			if (appended === undefined) throw new Error(`频道不存在：${input.channelId}`);
			const { channel, message } = appended;
			// 投递的空结果也是结果：调用方拿到的形状永远一致。
			const empty = (): PublishResult => ({
				channel,
				message,
				delivery: { delivered: [], failed: [], skipped: [] },
			});

			// `note` 默认谁也不叫（系统留痕）；显式给了 `wakeTo` 才叫 —— 后台命令跑完，
			// 起跑的那个人得回来看结果，否则这条结果只是躺在频道里。
			if (input.wake === false || (input.kind === "note" && input.wakeTo === undefined)) return empty();

			// `wakeTo` 是最高优先级：系统知道该叫谁，就不再问策略。
			const plan =
				input.wakeTo === undefined
					? await resolvePlan(routeFactsOf(snapshot.state, channel, message), ports.routers, ctx)
					: { targets: [...input.wakeTo], reason: "wakeTo" };
			const checked = validatePlan(plan, channel, message);
			if (checked.targets.length === 0) return empty();

			const delivery = await ports.runner.fanOut({
				state: snapshot.state,
				channel,
				message,
				plan: checked,
				ctx,
				settle: ports.settle,
			});
			return { channel, message, delivery };
		});

		if (ports.hooks !== undefined) {
			try {
				await ports.hooks.afterPublish(result.message, input.channelId, ctx);
			} catch (error) {
				// 钩子是「听消息」，不是投递的一部分：它坏了不能让已经落盘的消息报失败。
				console.warn(
					`[flow] afterPublish 失败：${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		return result;
	};
}
