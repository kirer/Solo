/**
 * 运行时事件落盘（src/server/event-log.ts）的单元测试。
 *
 * 覆盖：
 * - 追加写入文件、格式含 ISO 时间戳与事件前缀
 * - 超过大小阈值时轮转成 .log.1，且只保留一份历史
 * - 落盘路径不可写时**不抛异常**（业务不能被日志拖死），且仍写 stderr
 */
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
	configureEventLog,
	defaultEventLogPath,
	describeReport,
	eventLogPath,
	writeEvent,
} from "../../src/server/event-log.ts";

let dirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "event-log-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	// 复位全局配置，避免测试间串味
	configureEventLog({ path: "", maxBytes: 5 * 1024 * 1024 });
	vi.restoreAllMocks();
});

describe("event-log", () => {
	test("追加写入含时间戳与事件前缀", () => {
		const dir = tempDir();
		const path = join(dir, "nested", "app.log");
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		configureEventLog({ path });
		writeEvent("[任务受阻]", "42 (pi.tool)");
		writeEvent("[自愈]", "运行时已重新打开");

		const text = readFileSync(path, "utf8");
		expect(text).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[任务受阻\] 42 \(pi\.tool\)$/m);
		expect(text).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[自愈\] 运行时已重新打开$/m);
		// 双写：终端仍然看得到
		expect(stderr).toHaveBeenCalled();
	});

	test("超过阈值时轮转为 .1 且只保留一份历史", () => {
		const dir = tempDir();
		const path = join(dir, "app.log");
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		// 阈值很小，写第一行时就会触发轮转（文件已达上限）
		configureEventLog({ path, maxBytes: 10 });
		writeEvent("[任务出错]", "first");
		writeEvent("[任务出错]", "second");

		expect(existsSync(`${path}.1`)).toBe(true);
		// 轮转后 .1 里是「第一行之后、第二次写入之前」的内容；主文件继续有新内容
		expect(readFileSync(path, "utf8")).toContain("second");
		expect(stderr).toHaveBeenCalled();
	});

	test("落盘失败不抛异常，也不阻塞业务", () => {
		const dir = tempDir();
		// 把「文件」位置先做成目录，令 appendFileSync 必然失败
		const blocking = join(dir, "app.log");
		writeFileSync(join(dir, "placeholder"), "", "utf8");
		// 用 mkdir 造一个同名目录
		rmSync(blocking, { force: true });
		// 触发一个真正不可写的路径：指向目录
		configureEventLog({ path: blocking, maxBytes: 5 * 1024 * 1024 });
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		expect(() => writeEvent("[运行时失效]", "boom")).not.toThrow();
		expect(stderr).toHaveBeenCalled();
	});

	test("默认路径位于 workspace/logs/app.log", () => {
		expect(defaultEventLogPath("/repo")).toBe(join("/repo", "workspace", "logs", "app.log"));
	});

	test("未配置时只走 stderr，不落盘", () => {
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		configureEventLog({ path: "" });
		expect(eventLogPath()).toBe("");
		writeEvent("[自愈]", "noop");
		expect(stderr).toHaveBeenCalled();
	});
});

describe("describeReport（main.ts onReport 的实际映射）", () => {
	test("四类关键事件映射到正确的前缀与正文", () => {
		expect(describeReport({ kind: "runtime-failed", error: new Error("boom") })).toEqual({
			tag: "[运行时失效]",
			rest: "Error: boom",
		});
		expect(describeReport({ kind: "task-parked", taskId: "42", taskKind: "pi.tool" })).toEqual({
			tag: "[任务受阻]",
			rest: "42 (pi.tool)",
		});
		expect(describeReport({ kind: "task-failed", taskId: "7", taskKind: "pi.tool", error: "x" })).toEqual({
			tag: "[任务出错]",
			rest: "7: x",
		});
		expect(describeReport({ kind: "extension-failed", extension: "escalation", error: "x" })).toEqual({
			tag: "[能力包出错]",
			rest: "escalation",
		});
	});

	test("other / 未知类型不落盘（保持原行为）", () => {
		expect(describeReport({ kind: "other", error: "ignored" })).toBeUndefined();
		expect(describeReport({ kind: "something-new" })).toBeUndefined();
	});
});
