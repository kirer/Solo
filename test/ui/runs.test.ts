/**
 * 「按人」的轮次表：折叠帧不能把已经读到的步骤冲掉。
 *
 * 这一条防的是一次真实回归 —— 面板每 2 秒轮询一次、每次都是不带 `steps` 的折叠帧，
 * 一次覆盖就把展开的步骤树打回「还没读到」，于是屏幕上反复闪「正在读这一轮的过程…」。
 */
import { describe, expect, it } from "vitest";
import type { Turn } from "../../ui/app/src/api/types.ts";
import { upsertRun } from "../../ui/app/src/state/store.ts";

const turn = (patch: Partial<Turn> = {}): Turn => ({
	channelId: "dm:owner-linyue",
	seq: 3,
	slug: "linyue",
	label: "林越",
	status: "done",
	startedAt: 1_000,
	stepCount: 2,
	summary: "读了一个文件",
	...patch,
});

describe("upsertRun", () => {
	it("折叠帧（没有 steps）不清掉已经读到的步骤", () => {
		const steps = [{ id: "s1", kind: "read", title: "读 src/app.ts", status: "done", at: 0 }] as Turn["steps"];
		const runs = upsertRun(new Map(), turn({ steps }));
		const merged = upsertRun(runs, turn()).get("linyue")?.[0];
		expect(merged?.steps).toEqual(steps);
		expect(merged?.status).toBe("done");
	});

	it("带 steps 的新帧照旧覆盖（SSE 的实时步骤要能进来）", () => {
		const first = [{ id: "s1", kind: "read", title: "读 src/app.ts", status: "done", at: 0 }] as Turn["steps"];
		const last = [{ id: "s2", kind: "run", title: "跑 npm test", status: "running", at: 1 }] as Turn["steps"];
		const runs = upsertRun(new Map(), turn({ steps: first }));
		const merged = upsertRun(runs, turn({ steps: last, status: "running" })).get("linyue")?.[0];
		expect(merged?.steps).toEqual(last);
	});
});
