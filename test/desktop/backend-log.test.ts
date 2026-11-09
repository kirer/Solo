/**
 * `core.log` 的每一行都要能对上时间，进程出事那一下要能看出「自己挂的」还是「被杀的」
 * （老板 2026-11-09 点名：这是唯一能判断的依据）。
 */
import { describe, expect, it } from "vitest";
import { createLineStamper, describeExit, describeLaunch, stamp } from "../../desktop/src/backend-log.ts";

/** 固定时刻：2026-11-09 13:47:02.318（本地时间）。 */
const AT = new Date(2026, 10, 9, 13, 47, 2, 318);

describe("时间戳", () => {
	it("本地时间，毫秒补三位", () => {
		expect(stamp(AT)).toBe("2026-11-09 13:47:02.318");
		// 个位数的月 / 日 / 时分秒都要补零，否则按行切出来对不齐。
		expect(stamp(new Date(2026, 0, 2, 3, 4, 5, 6))).toBe("2026-01-02 03:04:05.006");
	});
});

describe("逐行盖时间戳", () => {
	it("一块多行：每行一个时间戳", () => {
		const out: string[] = [];
		const stamper = createLineStamper((text) => out.push(text), () => AT);
		stamper.push("[core] 第一行\n[core] 第二行\n");
		expect(out).toEqual(["2026-11-09 13:47:02.318 [core] 第一行\n2026-11-09 13:47:02.318 [core] 第二行\n"]);
	});

	it("半行不切：等下一块补齐再盖，一行只留一个时间戳", () => {
		const out: string[] = [];
		const stamper = createLineStamper((text) => out.push(text), () => AT);
		stamper.push("[core] 这一行还没");
		expect(out).toEqual([]);
		stamper.push("写完\n");
		expect(out).toEqual(["2026-11-09 13:47:02.318 [core] 这一行还没写完\n"]);
	});

	it("流结束时没换行的半行也要落盘，不能丢", () => {
		const out: string[] = [];
		const stamper = createLineStamper((text) => out.push(text), () => AT);
		stamper.push("[core] 最后一行没有换行");
		stamper.flush();
		expect(out).toEqual(["2026-11-09 13:47:02.318 [core] 最后一行没有换行\n"]);
		// 再 flush 一次不该凭空多一行。
		stamper.flush();
		expect(out).toHaveLength(1);
	});
});

describe("退出那一行", () => {
	it("被杀：信号写出来", () => {
		const line = describeExit(null, "SIGKILL", false);
		expect(line).toContain("signal=SIGKILL");
		expect(line).toContain("被信号 SIGKILL 杀死");
	});

	it("自己退：退出码写出来，75 认成重置 / 重启", () => {
		expect(describeExit(75, null, false)).toContain("code=75");
		expect(describeExit(75, null, false)).toContain("重置 / 重启");
		expect(describeExit(1, null, false)).toContain("异常退出");
		expect(describeExit(0, null, false)).toContain("正常退出");
	});

	it("两个都取不到：说状态不明，不说正常", () => {
		expect(describeExit(null, null, false)).toContain("退出状态不明");
	});

	it("壳主动停的：不算异常", () => {
		expect(describeExit(null, "SIGTERM", true)).toContain("壳主动停的");
	});

	it("code 和 signal 两个字段永远都在（缺一个就不写「无」）", () => {
		expect(describeExit(1, null, false)).toContain("code=1 signal=无");
		expect(describeExit(null, "SIGSEGV", false)).toContain("code=无 signal=SIGSEGV");
	});
});

describe("启动那一行", () => {
	it("带上发起者、版本、pid、用户目录", () => {
		const line = describeLaunch({ reason: "菜单「重启」", version: "2.3.4", userRoot: "/Users/x/.solo", pid: 4321 });
		expect(line).toContain("发起者");
		expect(line).toContain("菜单「重启」");
		expect(line).toContain("2.3.4");
		expect(line).toContain("4321");
		expect(line).toContain("/Users/x/.solo");
	});
});
