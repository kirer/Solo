import { describe, expect, test } from "vitest";
import { reasonText, renderUnanswered, watchSettled } from "../../src/core/channel/unanswered.ts";

function submission(result: () => Promise<{ status: string; reason?: string; answer?: unknown }>) {
	return { wait: async () => result() };
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("结算原因翻成人话", () => {
	test("no_model 说清是配置问题，不是他偷懒", () => {
		expect(reasonText("no_model")).toContain("模型引用对不上");
		expect(reasonText("no_model")).toContain("settings.json");
	});

	test("见过的那几个各自翻译", () => {
		expect(reasonText("aborted")).toBe("这一轮被中断了");
		expect(reasonText("run_failed")).toBe("这一轮跑失败了");
		expect(reasonText("model_error")).toContain("调模型失败");
		expect(reasonText(undefined)).toBe("没有说明原因");
		expect(reasonText("")).toBe("没有说明原因");
	});

	test("没见过的原样贴出来 —— 编一句「未知错误」等于把唯一线索丢掉", () => {
		expect(reasonText("quota_exhausted")).toBe("quota_exhausted");
	});
});

describe("频道里的那一行留痕", () => {
	test("带序号、名字、原因", () => {
		expect(renderUnanswered(93, "知言", "no_model")).toBe(
			"#93 叫了 @知言，但他这一轮没答上来：模型引用对不上（`settings.json` 的 `defaultModel` 指向了不存在的模型）。",
		);
	});
});

describe("后台等结算", () => {
	test("unanswered 才留痕，且只留一次", async () => {
		const seen: (string | undefined)[] = [];
		let calls = 0;
		watchSettled(submission(async () => ({ status: "unanswered", reason: "no_model" })), async (settled) => {
			calls += 1;
			seen.push(settled.status === "unanswered" ? settled.reason : "?");
		});
		await settled();
		await settled();
		expect(calls).toBe(1);
		expect(seen).toEqual(["no_model"]);
	});

	test("done 会回调，并带上答案条目 id（收尾靠它取正文）", async () => {
		let answer: unknown;
		watchSettled(submission(async () => ({ status: "done", answer: 42 })), async (settled) => {
			answer = settled.status === "done" ? settled.answer : undefined;
		});
		await settled();
		expect(answer).toBe(42);
	});

	test("等待自己失败（库关了、进程在退）不往外抛", async () => {
		let called = false;
		expect(() => {
			watchSettled(
				submission(async () => {
					throw new Error("database is closed");
				}),
				async () => {
					called = true;
				},
			);
		}).not.toThrow();
		await settled();
		expect(called).toBe(false);
	});

	test("底层没给可等待的提交时什么都不做（留痕是附加物，不能拖垮投递）", async () => {
		expect(() => watchSettled(undefined as never, async () => undefined)).not.toThrow();
	});

	test("留痕写失败不炸投递", async () => {
		await expect(
			(async () => {
				watchSettled(submission(async () => ({ status: "unanswered", reason: "x" })), async () => {
					throw new Error("写不进去");
				});
				await settled();
			})(),
		).resolves.toBeUndefined();
	});
});
