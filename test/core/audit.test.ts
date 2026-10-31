/**
 * 审计钩子：工具调用与模型回复各留一行。
 *
 * 直接调 `handlers`，不经过 harness —— 这里要钉的是**形状**（写什么、什么时候写、
 * 失败会不会反噬），不是底座的调度。真正的「钩子会不会被触发」由 `npm run live` 看。
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { auditHooks } from "../../src/core/app/audit.ts";

const dirs: string[] = [];

function workspace(): string {
	const dir = mkdtempSync(join(tmpdir(), "audit-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Handlers = {
	beforeTool(call: unknown, api: unknown): unknown;
	afterTool(call: unknown, result: unknown, api: unknown): unknown;
	afterResponse(message: unknown, api: unknown): void;
};

const api = { conversationId: 7 };
const call = { id: "call-1", name: "say", arguments: {} };

/** 写是 fire-and-forget：等到这一行出现为止，而不是睡一个固定毫秒数。 */
async function lines(file: string): Promise<Record<string, unknown>[]> {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		try {
			const text = readFileSync(file, "utf8");
			if (text.trim() !== "") return text.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
		} catch {
			// 文件还没建出来。
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`没有写出审计行：${file}`);
}

describe("审计钩子", () => {
	it("一次工具调用写一行：谁、哪个工具、成没成、多久", async () => {
		const root = workspace();
		const [tools] = auditHooks({ workspaceRoot: root, slugOf: () => "苏禾" });
		const handlers = tools.handlers as Handlers;

		handlers.beforeTool(call, api);
		expect(handlers.afterTool(call, { isError: false }, api)).toBeUndefined();

		const [line] = await lines(join(root, "logs", "tools.jsonl"));
		expect(line).toMatchObject({ kind: "tool", who: "苏禾", conversation: 7, tool: "say", ok: true });
		expect(typeof line?.ms).toBe("number");
		expect(Number.isNaN(Date.parse(String(line?.at)))).toBe(false);
	});

	it("失败的结果标成 ok: false", async () => {
		const root = workspace();
		const [tools] = auditHooks({ workspaceRoot: root, slugOf: () => "苏禾" });
		const handlers = tools.handlers as Handlers;

		handlers.afterTool(call, { isError: true }, api);

		const [line] = await lines(join(root, "logs", "tools.jsonl"));
		expect(line?.ok).toBe(false);
		// 没走过 beforeTool 就没有耗时，但不能写成 NaN。
		expect(line).not.toHaveProperty("ms");
	});

	it("认不出是谁也照写，只是没有 who", async () => {
		const root = workspace();
		const [tools] = auditHooks({ workspaceRoot: root, slugOf: () => undefined });
		const handlers = tools.handlers as Handlers;

		handlers.afterTool(call, { isError: false }, api);

		const [line] = await lines(join(root, "logs", "tools.jsonl"));
		expect(line).not.toHaveProperty("who");
		expect(line?.conversation).toBe(7);
	});

	it("一次模型回复写一行：模型、停止原因、耗时、token", async () => {
		const root = workspace();
		const [, generation] = auditHooks({ workspaceRoot: root, slugOf: () => "知言" });
		const handlers = generation.handlers as Handlers;

		handlers.afterResponse(
			{
				model: "claude-sonnet-5-5",
				stopReason: "toolUse",
				durationMs: 1234,
				usage: { input: 100, output: 20, cacheRead: 900, cost: { total: 0.012 } },
			},
			api,
		);

		const [line] = await lines(join(root, "logs", "tools.jsonl"));
		expect(line).toMatchObject({
			kind: "model",
			who: "知言",
			model: "claude-sonnet-5-5",
			stop: "toolUse",
			ms: 1234,
			in: 100,
			out: 20,
			cache: 900,
			cost: 0.012,
		});
	});
});
