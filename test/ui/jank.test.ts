import { describe, expect, it } from "vitest";
import { classifyJank, mark } from "../../ui/app/src/lib/jank.ts";

describe("classifyJank", () => {
	it("页面不可见时帧间隔没有意义", () => {
		expect(classifyJank({ gapMs: 21_600, visibility: "hidden", sinceVisibility: 21_700 })).toBe("hidden");
	});

	it("间隔比切回前台的时间还长，说明跨了一次隐藏/唤醒", () => {
		expect(classifyJank({ gapMs: 21_600, visibility: "visible", sinceVisibility: 900 })).toBe("resumed");
	});

	it("前台连着跑才是真卡", () => {
		expect(classifyJank({ gapMs: 900, visibility: "visible", sinceVisibility: 60_000 })).toBe("foreground");
	});

	it("不传参数时不炸（缺省 gap 为 0 → foreground）", () => {
		expect(classifyJank()).toBe("foreground");
		expect(classifyJank({})).toBe("foreground");
	});
});

describe("mark", () => {
	it("返回的函数可重复调用，只有第一次生效", () => {
		const end = mark("sse:apply");
		end();
		// 再调一次不该抛、也不该改变状态（这里只验幂等不抛）
		expect(() => {
			end();
			end();
		}).not.toThrow();
	});
});
