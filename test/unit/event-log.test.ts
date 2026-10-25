/**
 * 运行时事件落盘（src/server/event-log.ts）的单元测试。
 *
 * 覆盖：
 * - 追加写入文件、格式含 ISO 时间戳与事件前缀
 * - 超过大小阈值时轮转成 .log.1，且只保留一份历史
 * - 落盘路径不可写时**不抛异常**（业务不能被日志拖死），且仍写 stderr
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
	configureEventLog,
	defaultEventLogPath,
	describeReport,
	eventLogPath,
	formatError,
	topStackFrames,
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
		// D-03：落盘成功后**不再**双写 stderr。launchd 的 StandardErrorPath 就是
		// server.err.log，旧实现把同一行又写 stderr，才导致 app.log 与 server.err.log
		// 逐字节相同（md5 70ec0a1d…）。现在 app.log 是事件正本，stderr 只留异常。
		expect(stderr).not.toHaveBeenCalled();
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
		// 落盘成功，不双写 stderr（同上，D-03）
		expect(stderr).not.toHaveBeenCalled();
	});

	test("落盘失败不抛异常，也不阻塞业务", () => {
		const dir = tempDir();
		// 真造一个不可写目标：把 app.log 做成**已存在的目录**，appendFileSync 必然 EISDIR。
		// （旧版这里只 rmSync 掉占位文件、并没有 mkdir，于是追加其实成功了，
		//   测试靠的是另一条路径碰巧写了 stderr——断言与意图不符。）
		const blocking = join(dir, "app.log");
		mkdirSync(blocking, { recursive: true });
		configureEventLog({ path: blocking, maxBytes: 5 * 1024 * 1024 });
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		expect(() => writeEvent("[运行时失效]", "boom")).not.toThrow();
		// 落盘失败时 stderr 是唯一的出口：事件本身 + 失败原因都要打出来
		expect(stderr).toHaveBeenCalled();
		const written = stderr.mock.calls.map((call) => String(call[0])).join("");
		expect(written).toContain("boom");
		expect(written).toContain("[日志落盘失败]");
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
		// D-03/D-04：Error 现在会带上堆栈前几帧，所以这里只断言前缀 + message，
		// 不再断言「恰好等于 String(error)」——那正是把信息丢掉的旧行为。
		const runtimeFailed = describeReport({ kind: "runtime-failed", error: new Error("boom") });
		expect(runtimeFailed?.tag).toBe("[运行时失效]");
		expect(runtimeFailed?.rest).toContain("Error: boom");
		expect(describeReport({ kind: "task-parked", taskId: "42", taskKind: "pi.tool" })).toEqual({
			tag: "[任务受阻]",
			rest: "42 (pi.tool)",
		});
		// task-failed 现在带 taskKind（光看 taskId 分不清是模型失败还是工具失败）
		expect(describeReport({ kind: "task-failed", taskId: "7", taskKind: "pi.tool", error: "x" })).toEqual({
			tag: "[任务出错]",
			rest: "7 (pi.tool): x",
		});
		// 能力包出错：原来只打 extension 名、把 error 完全丢了，现在带上原因
		expect(describeReport({ kind: "extension-failed", extension: "escalation", error: "x" })).toEqual({
			tag: "[能力包出错]",
			rest: "escalation: x",
		});
	});

	test("other / 未知类型不落盘（保持原行为）", () => {
		expect(describeReport({ kind: "other", error: "ignored" })).toBeUndefined();
		expect(describeReport({ kind: "something-new" })).toBeUndefined();
	});
});

/**
 * D-03 回归：错误日志必须带 message 与堆栈前几帧。
 *
 * 真实证据：`workspace/logs/app.log` 13 行全是
 *   `2026-10-25T06:34:51.417Z [任务出错] 271: Tool read threw`
 * ——只有任务号 + 一句类型化文案，没有 error.message、没有堆栈、没有上下文。
 * 而库里其实存着真实原因（task 271 的工具结果带
 * `diagnostics[0].message = "EISDIR: illegal operation on a directory, read"`），
 * 是日志层把它丢掉的。
 */
describe("formatError / describeReport：带上 message 与堆栈前几帧（D-03/D-04）", () => {
	test("Error 实例：输出 name+message 与前 3 帧堆栈", () => {
		const error = new Error("EISDIR: illegal operation on a directory, read");
		const text = formatError(error);
		expect(text).toContain("Error: EISDIR: illegal operation on a directory, read");
		// 堆栈帧被压成一行（单行格式，不打乱 grep）
		expect(text).not.toContain("\n");
		expect(text).toMatch(/\(?.*:\d+:\d+/); // 至少一帧有 file:line:col
	});

	test("纯字符串错误（run-failure.ts 的实际传参形态）原样可用，不被 JSON 包一层", () => {
		expect(formatError("Tool read threw")).toBe("Tool read threw");
	});

	test("task-failed 日志带上 taskKind 与原因，不再只有 taskId", () => {
		const event = describeReport({
			kind: "task-failed",
			taskId: "271",
			taskKind: "pi.tool",
			error: "EISDIR: illegal operation on a directory, read",
		});
		expect(event).toEqual({
			tag: "[任务出错]",
			rest: "271 (pi.tool): EISDIR: illegal operation on a directory, read",
		});
	});

	test("堆栈帧数受限（默认 3 帧），避免单行无限膨胀", () => {
		const error = new Error("boom");
		// 伪造一条 10 帧的堆栈
		error.stack = [
			"Error: boom",
			...Array.from({ length: 10 }, (_, index) => `    at frame${index} (/src/a.ts:${index + 1}:1)`),
		].join("\n");
		const frames = topStackFrames(error.stack);
		expect(frames).toHaveLength(3);
		expect(frames[0]).toBe("frame0 (/src/a.ts:1:1)");
		// 落盘那一行里只剩 3 个 `at ` 变成的分隔符
		expect(formatError(error).split("<-")).toHaveLength(3);
	});

	test("端到端：写进 app.log 的那一行真的能搜到原因", () => {
		const dir = tempDir();
		const path = join(dir, "app.log");
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		configureEventLog({ path });

		const event = describeReport({
			kind: "task-failed",
			taskId: "271",
			taskKind: "pi.tool",
			error: new Error("EISDIR: illegal operation on a directory, read"),
		});
		expect(event).toBeDefined();
		writeEvent(event!.tag, event!.rest);

		const text = readFileSync(path, "utf8");
		expect(text).toContain("[任务出错]");
		expect(text).toContain("EISDIR: illegal operation on a directory, read");
		expect(text).toContain("pi.tool");
		// 落盘成功后不再重复写 stderr（见下一条）
		expect(stderr).not.toHaveBeenCalled();
	});

	test("落盘成功时不再双写 stderr（app.log 与 server.err.log 内容相同就是这里造成的）", () => {
		const dir = tempDir();
		const path = join(dir, "app.log");
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		configureEventLog({ path });

		writeEvent("[任务受阻]", "42 (pi.tool)");
		writeEvent("[自愈]", "运行时已重新打开");

		// 正本只有 app.log；stderr（launchd 的 StandardErrorPath → server.err.log）不再收到同一行
		expect(readFileSync(path, "utf8")).toContain("[任务受阻]");
		expect(stderr).not.toHaveBeenCalled();
	});
});
