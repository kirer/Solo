/**
 * 一轮的唤醒记录：**他刚被谁叫醒、手上的活属于哪儿**。
 *
 * 这是「一轮」这个概念的账本，不属于投递机制。单独一个文件是为了让
 * `channel/roster.ts` 能只依赖这份纯数据，而不把整个投递链拉进来。
 *
 * 只做两件事：定义形状、把名册里存着的值读回来（旧形状的迁移也在这份里，读的时候
 * 已经全是两层）。
 */
import { declareBookkeeping } from "../bookkeeping.ts";

/**
 * durable 收尾任务的 kind（定义在 `turn/report.ts`）。
 *
 * 登记成账务：投递判断「他手上还有活吗」时会跳过它。收尾是系统账务，不是模型还在
 * 干活 —— 不跳过的话，答完到终态提交之间的几毫秒里来的下一条消息会被当成「插话」，
 * 模型只答一句就收手，工具活整个丢掉（实测 2026-11-05 三次 live 里丢了 2–3 项）。
 */
export const TURN_REPORT_TASK = "core.turn-report";
declareBookkeeping(TURN_REPORT_TASK);

/** 一条消息在某个频道里的位置。 */
export type WakeTarget = {
	readonly channelId: string;
	readonly seq: number;
	readonly from: string;
	readonly at: number;
};

/**
 * 「刚被谁在哪个频道叫醒」，拆成两层。工具用它决定「默认在哪儿回话」。
 *
 * - `reply`：**这一句**该回哪儿。私聊插话时它指向私聊。
 * - `task`：他**手上那件活**属于哪儿。私聊插话不覆盖它 —— 否则插话结束，
 *   团队频道的结论就再也回不去了（ADR-099）。
 *
 * 没被打断时两者相同。
 */
export type WakeRecord = {
	readonly reply: WakeTarget;
	readonly task: WakeTarget;
};

function targetOf(raw: unknown): WakeTarget | undefined {
	if (raw === null || typeof raw !== "object") return undefined;
	const value = raw as Record<string, unknown>;
	const { channelId, seq, from, at } = value;
	if (typeof channelId !== "string" || typeof seq !== "number" || typeof from !== "string" || typeof at !== "number") {
		return undefined;
	}
	return { channelId, seq, from, at };
}

/** 把名册里存着的那份唤醒记录读成两层。只认迁移后的形状。 */
export function parseWake(raw: unknown): WakeRecord | undefined {
	if (raw === null || typeof raw !== "object") return undefined;
	const value = raw as Record<string, unknown>;
	const reply = targetOf(value.reply);
	const task = targetOf(value.task);
	return reply === undefined || task === undefined ? undefined : { reply, task };
}

/**
 * 名册 v1 → v2 的迁移：把平铺的旧唤醒记录拆成 `reply` / `task`。
 *
 * v1 写的是 `{channelId, seq, from, at}`，那时还没有「私聊插话不覆盖手头的活」
 * （ADR-099），所以两层指向同一条。迁移后读的代码只认两层形状。
 */
export function migrateWake(raw: unknown): WakeRecord | undefined {
	const layered = parseWake(raw);
	if (layered !== undefined) return layered;
	const legacy = targetOf(raw);
	return legacy === undefined ? undefined : { reply: legacy, task: legacy };
}
