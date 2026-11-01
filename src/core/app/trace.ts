/**
 * 一轮的轨迹：把**会话条目**翻成界面能画的一串步骤。
 *
 * 三条纪律：
 * 1. **不落库。** 轨迹是会话条目的投影，频道文档与 SQLite 里都不多一个字段。
 *    想看一轮干了什么，读它的条目；条目被压缩回收了，就说 `null`。
 * 2. **这里是纯函数。** 输入条目数组，输出 `ViewTurn`；怎么读会话在 `read.ts`。
 * 3. **拿不到就不画。** 没有耗时的步骤不编一个耗时，没有 diff 的不画 diff ——
 *    界面上每个数字都要有出处（AGENTS §2 第 6 条）。
 */
import type { EntryRecord } from "../runtime/index.ts";
import type { ViewStep, ViewTurn } from "../view/dto.ts";

/** 单轮步骤上限。超出的截断并在轮上标 `truncated`。 */
const MAX_STEPS = 200;
/** 单步输出上限（字节）。尾部写一行「共 N 行，已截断」。 */
const MAX_OUTPUT = 8 * 1024;
/** 思考 / 说话正文上限。 */
const MAX_TEXT = 4 * 1024;

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 剥掉 ANSI 转义：控制字符进了输出区就是一片乱码。 */
export function stripAnsi(text: string): string {
	// eslint-disable-next-line no-control-regex
	return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

/** 截断到 `limit` 字节（按行切，避免把一个多字节字符劈成两半）。 */
function clipText(text: string, limit: number): { text: string; truncated: boolean } {
	if (text.length <= limit) return { text, truncated: false };
	const cut = text.slice(0, limit);
	const lastBreak = cut.lastIndexOf("\n");
	return { text: lastBreak > limit * 0.6 ? cut.slice(0, lastBreak) : cut, truncated: true };
}

/** 工具结果里真正给模型看的文字（图片块跳过）。 */
function resultText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		const item = asObject(block);
		if (item === undefined) continue;
		if (item["type"] === "text") {
			const text = asString(item["text"]);
			if (text !== undefined) parts.push(text);
		}
	}
	return parts.join("\n");
}

/** 这个工具调用在这一行上怎么写。 */
function titleOf(name: string, args: Json): string {
	switch (name) {
		case "run": {
			const command = asString(args["command"]) ?? "";
			return `运行 ${command}`;
		}
		case "file": {
			const path = asString(args["path"]) ?? "";
			const action = asString(args["action"]) ?? "read";
			return action === "write" ? `写了 ${path}` : `读了 ${path}`;
		}
		case "chats":
			return "翻了频道记录";
		case "read_history":
			return "读了更早的消息";
		case "remember":
			return "记了一条";
		case "hire":
			return `招了 ${asString(args["name"]) ?? asString(args["slug"]) ?? "一个人"}`;
		default:
			return name;
	}
}

/** 不知道 / 不该画成步骤的工具返回 `undefined`（`say` 就是：它是消息，不是过程）。 */
function kindOf(name: string, args: Json): ViewStep["kind"] | undefined {
	switch (name) {
		case "run":
			return "run";
		case "file":
			return (asString(args["action"]) ?? "read") === "write" ? "file-write" : "file-read";
		case "say":
			return undefined;
		case "chats":
			return "chats";
		case "read_history":
			return "history";
		case "remember":
			return "remember";
		case "hire":
			return "hire";
		default:
			return "tool";
	}
}

export type TurnFacts = {
	readonly channelId: string;
	/** 触发这一轮的消息 seq。 */
	readonly seq: number;
	readonly slug: string;
	readonly label: string;
	readonly startedAt: number;
	readonly endedAt?: number;
	readonly replySeq?: number;
	/** 会话此刻还在跑这一轮。 */
	readonly live: boolean;
	/** 一轮被截断（步骤超过上限）。 */
	readonly truncated?: true;
};

/**
 * 把一段条目翻成一轮。
 *
 * `entries` 必须是**这一轮自己的**条目（从触发它的 `core.channel` 之后到下一条之前），
 * 切分在 `read.ts` 做 —— 那里才知道频道文档里哪条消息唤醒了谁。
 */
export function buildTurn(entries: readonly EntryRecord[], facts: TurnFacts): ViewTurn {
	const steps: ViewStep[] = [];
	/** toolCallId → 步骤下标。工具结果回来时按它并进前一个调用。 */
	const open = new Map<string, number>();
	let truncated = facts.truncated === true;

	const push = (step: ViewStep): void => {
		if (steps.length >= MAX_STEPS) {
			truncated = true;
			return;
		}
		steps.push(step);
	};

	for (const entry of entries) {
		const message = asObject(entry.model?.[0]);
		if (message === undefined) continue;

		if (entry.kind === "pi.assistant" && message["role"] === "assistant") {
			const blocks = Array.isArray(message["content"]) ? message["content"] : [];
			const stamp = asNumber(message["timestamp"]);
			for (const block of blocks) {
				const item = asObject(block);
				if (item === undefined) continue;
				const type = item["type"];

				if (type === "thinking") {
					const thinking = asString(item["thinking"]) ?? "";
					if (thinking.trim() === "") continue;
					// 连续的 thinking 合并成一条：一轮里可能出现十几次，逐条画就是噪音。
					const last = steps[steps.length - 1];
					if (last !== undefined && last.kind === "think") {
						const merged = `${last.text ?? ""}\n\n${thinking}`.trim();
						const clipped = clipText(merged, MAX_TEXT);
						last.text = clipped.text;
						continue;
					}
					const clipped = clipText(thinking.trim(), MAX_TEXT);
					push({ id: `${String(entry.id)}:think:${String(steps.length)}`, kind: "think", title: "思考", status: "ok", text: clipped.text });
					continue;
				}

				// 说话不进过程：正文本身就是频道里的那条消息（没有 `say` 调用时由结算后的收尾补发）。
				// 过程只答「他做了什么」，说出口的话在消息流里看。
				if (type === "text") continue;

				if (type === "toolCall") {
					const name = asString(item["name"]) ?? "tool";
					const callId = asString(item["id"]) ?? `${String(entry.id)}:${String(steps.length)}`;
					const args = asObject(item["arguments"]) ?? {};
					const kind = kindOf(name, args);
					// `say` 落成频道里的消息：说话不进过程。
					if (kind === undefined) continue;
					const step: ViewStep = {
						id: callId,
						kind,
						title: titleOf(name, args),
						status: "running",
					};
					if (kind === "run") step.command = asString(args["command"]) ?? "";
					if (kind === "file-read" || kind === "file-write") step.path = asString(args["path"]) ?? "";
					if (kind === "file-write") {
						const content = asString(args["content"]) ?? "";
						step.added = content === "" ? 0 : content.split("\n").length;
					}
					if (kind === "tool") step.tool = name;
					if (stamp !== undefined) step.startedAt = stamp;
					push(step);
					open.set(callId, steps.length - 1);
				}
			}
			continue;
		}

		if (entry.kind === "pi.tool-result" && message["role"] === "toolResult") {
			const callId = asString(message["toolCallId"]);
			const index = callId === undefined ? undefined : open.get(callId);
			if (index === undefined) continue;
			const step = steps[index];
			if (step === undefined) continue;
			const isError = message["isError"] === true;
			step.status = isError ? "failed" : "ok";
			const stamp = asNumber(message["timestamp"]);
			if (stamp !== undefined && step.startedAt !== undefined) step.ms = Math.max(0, stamp - step.startedAt);
			const text = stripAnsi(resultText(message["content"])).trim();
			if (step.kind === "run") {
				const clipped = clipText(text, MAX_OUTPUT);
				step.output = clipped.text;
				if (clipped.truncated) {
					step.truncated = true;
					step.output = `${clipped.text}\n… 共 ${String(text.split("\n").length)} 行，已截断`;
				}
				const exit = /退出码\s*(-?\d+)/.exec(text);
				if (exit !== null) step.exitCode = Number(exit[1]);
			}
			open.delete(callId!);
		}
	}

	// 一轮已经结束了，还挂着「进行中」的步骤 = 那次调用没回来（中断 / 进程重启）。
	if (!facts.live) {
		for (const step of steps) {
			if (step.status === "running") step.status = "failed";
		}
	}

	const status: ViewTurn["status"] = facts.replySeq !== undefined ? "done" : facts.live ? "running" : "aborted";

	return {
		channelId: facts.channelId,
		seq: facts.seq,
		slug: facts.slug,
		label: facts.label,
		status,
		startedAt: facts.startedAt,
		...(facts.endedAt === undefined ? {} : { endedAt: facts.endedAt }),
		...(facts.replySeq === undefined ? {} : { replySeq: facts.replySeq }),
		stepCount: steps.length,
		summary: summaryOf(steps, facts),
		...(truncated ? { truncated: true as const } : {}),
		steps,
	};
}

/** 折叠行右端那句确定性摘要：运行 N 条命令 · 读了 N 个文件 · 写了 N 个文件。 */
export function summaryOf(steps: readonly ViewStep[], facts: Pick<TurnFacts, "startedAt" | "endedAt">): string {
	const runs = steps.filter((step) => step.kind === "run").length;
	const reads = steps.filter((step) => step.kind === "file-read").length;
	const writes = steps.filter((step) => step.kind === "file-write").length;
	const bits = [
		runs === 0 ? undefined : `运行 ${String(runs)} 条命令`,
		reads === 0 ? undefined : `读了 ${String(reads)} 个文件`,
		writes === 0 ? undefined : `写了 ${String(writes)} 个文件`,
	].filter((bit) => bit !== undefined);
	if (bits.length > 0) return bits.join(" · ");
	const seconds = facts.endedAt === undefined ? undefined : Math.max(0, Math.round((facts.endedAt - facts.startedAt) / 1000));
	return seconds === undefined || seconds === 0 ? "想了一会儿" : `想了 ${String(seconds)}s`;
}

/**
 * 折叠态只带摘要，不带步骤 —— 一屏十几轮，每轮八步，光 JSON 就够重了。
 *
 * 展开时前端再按 `seq` + `slug` 拉一次带 `steps` 的完整版。
 */
export function withoutSteps(turn: ViewTurn): ViewTurn {
	const { steps: _steps, ...rest } = turn;
	return rest;
}

/**
 * 推送用的瘦身版：每步输出最多 2 KB。
 *
 * 理由：SSE 不该搬 8 KB 的终端输出。真要读全文，点开那一步时再拉 `GET /turn`。
 */
export function slimTurn(turn: ViewTurn, limit = 2 * 1024): ViewTurn {
	if (turn.steps === undefined) return turn;
	return {
		...turn,
		steps: turn.steps.map((step) => {
			if (step.output === undefined || step.output.length <= limit) return step;
			return { ...step, output: `${step.output.slice(0, limit)}\n… 已截断`, truncated: true };
		}),
	};
}
