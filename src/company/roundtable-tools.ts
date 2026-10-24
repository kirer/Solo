/**
 * 圆桌讨论的两个工具：`roundtable`（开会）与 `roundtable_minutes`（查纪要）。
 *
 * 与 `management-tools.ts` 的分工：
 * - 本文件只负责**模型能看见的入口**：参数校验、把结果渲染成模型可读的文本；
 * - 会议本身的机制（持久化、并行、超时、收口）在 `roundtable.ts`。
 *
 * 依赖注入只要求 `runtime`，因为圆桌的会话句柄全部由任务运行时提供；
 * `registry` 可选，用于**首次使用时自愈式注册**任务能力包（老库/漏装也能跑）。
 */
import { defineTool, Type, type CompanyRuntime, type Registry } from "../runtime/index.ts";
import {
	readRoundtableMinutes,
	roundtableExtension,
	runRoundtable,
	type RoundtableOutcome,
} from "./roundtable.ts";
import { ROLE_LABELS, type ManagementRole } from "./docs.ts";

/** 圆桌工具的实现依赖。 */
export type RoundtableToolDependencies = {
	readonly runtime: CompanyRuntime;
	/** 能力注册表：给了就在首次调用时确保圆桌任务已注册（幂等）。 */
	readonly registry?: Registry;
	/** 单个参与者的默认超时（毫秒），默认 120s。 */
	readonly timeoutMs?: number;
};

/** 圆桌工具集合。 */
export type RoundtableToolset = {
	readonly roundtable: ReturnType<typeof defineTool>;
	readonly roundtableMinutes: ReturnType<typeof defineTool>;
};

/**
 * 把圆桌的任务定义装进注册表（幂等）。
 *
 * 单独导出，方便装配层在**不构造工具**的场景（例如只跑恢复）里也能补注册。
 */
export function installRoundtableTasks(registry: Registry | undefined): void {
	if (registry === undefined) return;
	registry.install(roundtableExtension());
}

/** 构造圆桌工具。 */
export function createRoundtableTools(deps: RoundtableToolDependencies): RoundtableToolset {
	// 任务定义必须能被注册表解析，否则任务会以 missing_task 受阻——
	// 尤其是「开会途中重启」：老库里已经有 app.roundtable 任务，定义却没注册，
	// 它就会永久受阻。所以这里**构造时就注册**（装配层每次启动都会构造工具）。
	// 注册按名字替换，幂等。
	installRoundtableTasks(deps.registry);

	const roundtable = defineTool({
		name: "roundtable",
		description: [
			"开一次圆桌讨论：让几位管理层各自独立给出判断，再汇总成纪要。",
			"什么时候用：需要多个视角拍板、或你不想替别人做职能内的判断时（技术/成本/需求/排期之间的取舍）。",
			"第 1 轮各人独立作答、互不可见；rounds=2 时第 2 轮会把第 1 轮汇总回投，要求「保留/修正/反对+理由」。",
			"每个参与者独立超时（默认 120s），答不上来只标缺席，不会拖住整场会；全体缺席也会给出纪要。",
			"返回：谁说了什么、谁缺席、共识与分歧、结论建议。会议本身很慢（分钟级），不要在同一轮里重复开。",
		].join(""),
		parameters: Type.Object({
			topic: Type.String({ description: "议题：要讨论什么，一句话说清" }),
			roles: Type.Optional(
				Type.Array(Type.String(), {
					description: "参与者岗位，可选 ceo/cto/cfo/cpo/coo/cmo/chro；默认 [cto, cfo, cpo, coo]，你自己会被自动跳过",
				}),
			),
			rounds: Type.Optional(
				Type.Integer({ description: "轮数：1（只要独立意见，默认）或 2（再让大家对彼此意见表态）" }),
			),
			question: Type.Optional(Type.String({ description: "要大家拍板的具体问题（比议题更聚焦）" })),
			timeoutMs: Type.Optional(
				Type.Integer({ description: "单个参与者的超时毫秒数，默认 120000；一般不用传" }),
			),
		}),
		execute: async (args, api) => {
			const outcome = await runRoundtable(deps.runtime, {
				topic: args.topic,
				...(args.roles === undefined ? {} : { roles: args.roles }),
				...(args.rounds === undefined ? {} : { rounds: args.rounds }),
				...(args.question === undefined ? {} : { question: args.question }),
				...(args.timeoutMs === undefined && deps.timeoutMs === undefined
					? {}
					: { timeoutMs: args.timeoutMs ?? deps.timeoutMs }),
				fromConversationId: Number(api.conversationId),
				from: "主持人",
			});
			return text(renderOutcome(outcome));
		},
	});

	const roundtableMinutes = defineTool({
		name: "roundtable_minutes",
		description:
			"查圆桌讨论的完整纪要（谁说了什么、谁缺席、立场分布、结论）。不传 id 就取最近一次；纪要持久化，重启后也能查。",
		parameters: Type.Object({
			id: Type.Optional(Type.String({ description: "讨论编号，如 rt:3:0；不传取最近一次" })),
		}),
		execute: async (args) => {
			return text(await readRoundtableMinutes(deps.runtime, args.id));
		},
	});

	return { roundtable, roundtableMinutes };
}

/**
 * 把结果渲染成模型可读的文本。
 *
 * 契约要求「返回结构化纪要摘要（谁说了什么、共识、分歧、结论建议）」——
 * 纪要正文已经包含这些，这里只在前面补一行状态，避免模型误以为会议一定成功。
 */
function renderOutcome(outcome: RoundtableOutcome): string {
	const header = outcome.ok
		? `圆桌讨论已完成（${outcome.id}）。`
		: `圆桌讨论未完整完成（${outcome.id}，${reasonLabel(outcome.reason)}）。以下是已拿到的部分：`;

	const counts =
		outcome.absent.length === 0
			? ""
			: `\n缺席：${outcome.absent.map(roleLabel).join("、")}（不影响其余结论，纪要里已标注）。`;

	return [header, counts, "", outcome.minutes].filter((line) => line !== "").join("\n");
}

function reasonLabel(reason: string | undefined): string {
	switch (reason) {
		case "timeout":
			return "已达总时长上限";
		case "aborted":
			return "被中断";
		case "failed":
			return "失败";
		case "no-participant":
			return "没有可用参与者";
		case "empty-topic":
			return "议题为空";
		default:
			return reason ?? "未知原因";
	}
}

/** 岗位 → 中文显示名（给模型看的文本用显示名，不是 slug）。 */
function roleLabel(role: string): string {
	return ROLE_LABELS[role as ManagementRole] ?? role.toUpperCase();
}

/** 包成模型可读的文本结果。 */
function text(value: string) {
	return { output: [{ type: "text" as const, text: value }] };
}
