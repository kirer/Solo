/**
 * 查询参数解析：没带就是没带。
 *
 * 这条守的是一个真事故：`Number("")` 是 0，于是 `/api/people/:slug/turns` 不带 `to` 时
 * `to` 被兜成 0，窗口变空 —— 重启后私聊页的工作记录整片消失（运行中靠 SSE 帧撑着，
 * 所以只有重启才看得见）。
 */
import { describe, expect, it } from "vitest";
import { numberParam } from "../../src/interface/http/routes.ts";

const url = (query: string) => new URL(`http://x/api${query}`);

describe("numberParam", () => {
	it("没带参数 → undefined（不是 0）", () => {
		expect(numberParam(url("/people/a/turns"), "to")).toBeUndefined();
	});
	it("空串也当没带", () => {
		expect(numberParam(url("/people/a/turns?to="), "to")).toBeUndefined();
	});
	it("带 0 就是 0", () => {
		expect(numberParam(url("/people/a/turns?to=0"), "to")).toBe(0);
	});
	it("正常数字照读，非数字当没带", () => {
		expect(numberParam(url("/channels/x?from=12&limit=60"), "from")).toBe(12);
		expect(numberParam(url("/channels/x?limit=60"), "limit")).toBe(60);
		expect(numberParam(url("/channels/x?before=abc"), "before")).toBeUndefined();
	});
});
