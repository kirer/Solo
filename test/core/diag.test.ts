import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDiag, formatRuntimeReport } from "../../src/app/diag.ts";
import { toRuntimeReport } from "../../src/core/runtime/open.ts";

const dirs: string[] = [];

function workspace(): string {
	const dir = mkdtempSync(join(tmpdir(), "diag-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const TASK = { id: "t-1" as never, kind: "generation", conversationId: 7 as never };

describe("运行报告：底座 → 可落盘的形状", () => {
	it("把任务与错误摊平，堆栈只留三行", () => {
		const error = new Error("storage reset");
		error.stack = "a\nb\nc\nd\ne";
		const report = toRuntimeReport({ kind: "task_faulted", task: TASK, reason: "restart_limit", error });
		expect(report.type).toBe("task_faulted");
		expect(report.message).toBe("storage reset");
		expect(report.stack).toBe("a\nb\nc");
		expect(report.task).toEqual({ id: "t-1", kind: "generation", conversationId: 7 });
		expect(report.reason).toBe("restart_limit");
		// 时间戳必须是可解析的 ISO：日志要按时间读。
		expect(Number.isNaN(Date.parse(report.at))).toBe(false);
	});

	it("没有错误对象的报告（task_interrupted）也不炸", () => {
		const report = toRuntimeReport({ kind: "task_interrupted", task: TASK, reason: "restart_limit", restarts: 5, error: undefined });
		expect(report.message).toBeUndefined();
		expect(report.stack).toBeUndefined();
		expect(report.type).toBe("task_interrupted");
		expect(report.restarts).toBe(5);
	});

	it("宿主回调报告带上回调名", () => {
		const report = toRuntimeReport({ kind: "host_error", callback: "models", error: new Error("boom") });
		expect(report.callback).toBe("models");
	});
});

describe("运行报告的格式化（纯函数）", () => {
	it("带上任务和原因，能直接贴给人看", () => {
		const text = formatRuntimeReport({
			type: "task_faulted",
			at: "2026-01-01T00:00:00.000Z",
			message: "重启超限",
			task: { id: "t-1", kind: "generation", conversationId: 7 },
			reason: "restart_limit",
		});
		expect(text).toContain("任务抛出异常");
		expect(text).toContain("`generation`#t-1");
		expect(text).toContain("restart_limit");
		expect(text).toContain("重启超限");
	});

	it("task_interrupted 按 reason 分文案：连续超限 vs 单次打断", () => {
		const base = {
			type: "task_interrupted",
			at: "2026-01-01T00:00:00.000Z",
			task: { id: "t-1", kind: "generation", conversationId: 7 },
			restarts: 5,
		};
		const limited = formatRuntimeReport({ ...base, reason: "restart_limit" });
		expect(limited).toContain("连续重启超限");
		expect(limited).toContain("连续 5 次");
		const interrupted = formatRuntimeReport({ ...base, reason: "interrupted", restarts: 1 });
		expect(interrupted).toContain("任务被重启打断，已结束");
		expect(interrupted).not.toContain("超限");
		expect(interrupted).toContain("连续 1 次");
	});

	it("没有附加信息时只给一句人话", () => {
		expect(formatRuntimeReport({ type: "storage_failed", at: "2026-01-01T00:00:00.000Z" })).toBe(
			"底座的会话失败（storage 等致命错误）",
		);
	});

	it("没见过的种类退回原名，不编造", () => {
		expect(formatRuntimeReport({ type: "brand_new", at: "2026-01-01T00:00:00.000Z" })).toBe("brand_new");
	});
});

describe("落盘与 /api/diag 看到的最近一条", () => {
	it("写进 logs/runtime.jsonl", async () => {
		const root = workspace();
		const diag = createDiag(join(root, "logs"));
		diag.recordRuntimeReport({
			type: "task_interrupted",
			at: "2026-01-01T00:00:00.000Z",
			task: { id: "t-2", kind: "generation", conversationId: 3 },
		});
		const file = join(root, "logs", "runtime.jsonl");
		await vi.waitFor(() => {
			expect(readFileSync(file, "utf8")).toContain('"type":"task_interrupted"');
		});
	});

	it("最近一条跳过 task_outdated（每次启动都会有的正常现象）", async () => {
		const root = workspace();
		const diag = createDiag(join(root, "logs"));
		diag.recordRuntimeReport({ type: "task_outdated", at: "2026-01-01T00:00:00.000Z" });
		expect(diag.lastReport()).toBeUndefined();
		diag.recordRuntimeReport({
			type: "task_faulted",
			at: "2026-01-01T00:00:01.000Z",
			message: "restart limit",
			reason: "restart_limit",
		});
		expect(diag.lastReport()?.type).toBe("task_faulted");
		expect(diag.lastReport()?.text).toContain("restart_limit");
		// 落盘是异步的：等它写完再让 afterEach 删目录，否则 rm 会撞上 ENOTEMPTY
		await vi.waitFor(() => {
			expect(readFileSync(join(root, "logs", "runtime.jsonl"), "utf8")).toContain("restart_limit");
		});
	});

	it("超长的报告被截到单条上限以内（不静默丢字段）", async () => {
		const root = workspace();
		const diag = createDiag(join(root, "logs"));
		diag.recordRuntimeReport({
			type: "extension_error",
			at: "2026-01-01T00:00:00.000Z",
			message: "x".repeat(20_000),
		});
		const file = join(root, "logs", "runtime.jsonl");
		await vi.waitFor(() => {
			expect(readFileSync(file, "utf8")).toContain("截断");
		});
		expect(readFileSync(file, "utf8").trim().length).toBeLessThan(4 * 1024 + 256);
	});

	it("工作区不可写也不抛（报告只是诊断）", () => {
		const diag = createDiag("/dev/null/not-a-directory");
		expect(() => diag.recordRuntimeReport({ type: "listener_error", at: "2026-01-01T00:00:00.000Z" })).not.toThrow();
		expect(diag.lastReport()?.type).toBe("listener_error");
	});
});
