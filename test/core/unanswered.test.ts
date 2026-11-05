import { SEED_TEXT } from "./catalog.ts";
import { describe, expect, test } from "vitest";
import { clipFailureDetail, reasonText, renderUnanswered, watchSettled } from "../../src/core/channel/unanswered.ts";

// `detail` 来自底座的 `JsonValue`：字符串是常态，对象也要能压成一行。

function submission(result: () => Promise<{ status: string; reason?: string; detail?: string; answer?: unknown }>) {
	return { wait: async () => result() };
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("结算原因翻成人话", () => {
	test("no_model 说清是配置问题，不是他偷懒", () => {
		expect(reasonText("no_model", SEED_TEXT)).toContain("没有可用的模型");
		expect(reasonText("no_model", SEED_TEXT)).toContain("settings.json");
	});

	test("见过的那几个各自翻译", () => {
		expect(reasonText("aborted", SEED_TEXT)).toBe("这一轮被中断了");
		expect(reasonText("run_failed", SEED_TEXT)).toBe("这一轮跑失败了");
		expect(reasonText("model_error", SEED_TEXT)).toContain("调模型失败");
		expect(reasonText("interrupted", SEED_TEXT)).toContain("重启");
		expect(reasonText("restart_limit", SEED_TEXT)).toContain("放弃");
		expect(reasonText("nothing_to_answer", SEED_TEXT)).toContain("没有需要回答");
		expect(reasonText("turn_limit", SEED_TEXT)).toContain("轮数");
		expect(reasonText("faulted", SEED_TEXT)).toContain("异常");
		expect(reasonText("orphaned", SEED_TEXT)).toContain("找不到");
		expect(reasonText("reset", SEED_TEXT)).toContain("重置");
		expect(reasonText("restart", SEED_TEXT)).toContain("重启");
		expect(reasonText(undefined, SEED_TEXT)).toBe("没有说明原因");
		expect(reasonText("", SEED_TEXT)).toBe("没有说明原因");
	});

	test("没见过的原样贴出来 —— 编一句「未知错误」等于把唯一线索丢掉", () => {
		expect(reasonText("quota_exhausted", SEED_TEXT)).toBe("quota_exhausted");
	});
});

describe("频道里的那一行留痕", () => {
	test("带序号、名字、原因", () => {
		expect(renderUnanswered(93, "知言", "no_model", SEED_TEXT)).toBe(
			"#93 叫了 @知言，但他这一轮没答上来：没有可用的模型（还没配，或 `settings.json` 的 `defaultModel` 指向了不存在的模型）——去「设置 → 模型」看一眼。",
		);
	});

	test("带细节：压成一行、截到 200 字，附在原因后面", () => {
		expect(renderUnanswered(1, "林越", "model_error", SEED_TEXT, "gateway\n  502")).toBe(
			"#1 叫了 @林越，但他这一轮没答上来：调模型失败（网关拒了这次请求，通常是模型名、额度或网关本身的问题）（gateway 502）。",
		);
		expect(renderUnanswered(1, "林越", "model_error", SEED_TEXT, "")).not.toContain("（）");
	});

	test("细节截断：只留前 200 字，别把频道写爆", () => {
		expect(clipFailureDetail("x".repeat(500))?.length).toBe(201);
		expect(clipFailureDetail("  ")).toBeUndefined();
		expect(clipFailureDetail(undefined)).toBeUndefined();
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

	test("unanswered 的细节不丢（模型错误正文是排查的唯一线索）", async () => {
		let detail: string | undefined;
		watchSettled(submission(async () => ({ status: "unanswered", reason: "model_error", detail: "502" })), async (settled) => {
			detail = settled.status === "unanswered" ? settled.detail : undefined;
		});
		await settled();
		expect(detail).toBe("502");
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
