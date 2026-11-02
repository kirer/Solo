/**
 * 审计：每一次工具调用、每一次模型回复，往 `<userRoot>/logs/tools.jsonl` 写一行。
 *
 * 为什么用钩子而不是写在工具里：工具只看得见自己跑成功的那一次。失败的、被拦下的、
 * 框架自己生成的错误结果，工具里一个字都留不下。而排查「他为什么不说话了」的时候，
 * 第一句话永远是「他调了什么、花了多久、模型为什么停」—— 这三件事以前只能靠猜。
 *
 * 钩子**只读不改**：不拦调用、不改结果、不改提示词。要拦的地方（密钥、路径越界、
 * 建团队权限）留在工具里，那里有 workspaceRoot 和名册，钩子拿不到。
 */
import { join } from "node:path";
import { GenerationTask, ToolTask, hook, type HookRegistration } from "../core/runtime/index.ts";
import { appendJsonLine } from "../core/runtime/io.ts";

/** 单文件上限；满了轮转成 `.1`（只留一代，审计不是数据仓库）。 */
const AUDIT_FILE_LIMIT = 5 * 1024 * 1024;

export type AuditDeps = {
	/** 日志目录（`<userRoot>/logs/`）。 */
	readonly logsRoot: string;
	/** 会话 id → 人的 slug。日志里写 id 没人看得懂，写「苏禾」才看得懂。 */
	readonly slugOf: (conversationId: number) => string | undefined;
};

/**
 * 两个钩子：工具与生成。装在哪，就审计哪 —— 我们只装给 `core-tools`，
 * 而它是每个会话都选的扩展。
 */
export function auditHooks(deps: AuditDeps): readonly HookRegistration[] {
	const file = join(deps.logsRoot, "tools.jsonl");
	/** 工具开始的时刻，按 `callId` 记；`afterTool` 取用时删掉，不攒。 */
	const started = new Map<string, number>();

	const write = (line: Record<string, unknown>): void => {
		// 审计不能反过来影响调用：写失败（磁盘满、权限）就丢掉这一行。
		void appendJsonLine(file, line, { rotateAt: AUDIT_FILE_LIMIT }).catch(() => undefined);
	};

	const who = (conversationId: number): Record<string, unknown> => {
		const slug = deps.slugOf(conversationId);
		return { conversation: conversationId, ...(slug === undefined ? {} : { who: slug }) };
	};

	const tools = hook(ToolTask, {
		beforeTool(call) {
			started.set(call.id, Date.now());
			return undefined;
		},
		afterTool(call, result, api) {
			const at = started.get(call.id);
			started.delete(call.id);
			write({
				at: new Date().toISOString(),
				kind: "tool",
				...who(Number(api.conversationId)),
				tool: call.name,
				ok: result.isError !== true,
				...(at === undefined ? {} : { ms: Date.now() - at }),
			});
			// 不改结果：返回 undefined 就是「照原样提交」。
			return undefined;
		},
	});

	const generation = hook(GenerationTask, {
		afterResponse(message, api) {
			write({
				at: new Date().toISOString(),
				kind: "model",
				...who(Number(api.conversationId)),
				model: message.model,
				stop: message.stopReason,
				...(message.durationMs === undefined ? {} : { ms: message.durationMs }),
				in: message.usage.input,
				out: message.usage.output,
				cache: message.usage.cacheRead,
				cost: message.usage.cost.total,
			});
		},
	});

	return [tools, generation];
}
