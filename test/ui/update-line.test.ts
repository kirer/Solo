/**
 * 设置页「检查更新」那行字（Solo #2409 ②，验收第六条）：失败必须真显示原因，
 * 别让「检查更新没连上」只活在日志里。
 */
import { describe, expect, it } from "vitest";
import { updateLine, type UpdateStatus } from "../../ui/app/src/panels/update-line.ts";

const failed = (message?: string): UpdateStatus => ({ at: 1_700_000_000_000, ok: false, ...(message === undefined ? {} : { message }) });
const passed = (): UpdateStatus => ({ at: 1_700_000_000_000, ok: true });

describe("检查更新那行字", () => {
	it("自动检查失败：显示壳报上来的那句人话", () => {
		expect(updateLine({ desktop: true, version: "2.9.17", status: failed("检查更新没连上，稍后重试") })).toBe(
			"检查更新没连上，稍后重试",
		);
		expect(updateLine({ desktop: true, version: "2.9.17", status: failed("检查更新没连上（GitHub 限流），稍后重试") })).toBe(
			"检查更新没连上（GitHub 限流），稍后重试",
		);
	});

	it("失败但没带话：兜底一句，绝不留空", () => {
		expect(updateLine({ desktop: true, version: "2.9.17", status: failed() })).toBe("检查更新失败，稍后重试");
	});

	it("查通了 / 没查过：还是原来那句（当前版本 / 有新版本会提示下载）", () => {
		expect(updateLine({ desktop: true, version: "2.9.18", status: passed() })).toBe("当前版本 2.9.18");
		expect(updateLine({ desktop: true, version: "2.9.18", status: null })).toBe("当前版本 2.9.18");
		expect(updateLine({ desktop: true, version: "", status: null })).toBe("有新版本会提示下载");
	});

	it("失败之后又查通了：那行字跟着变回来（失败不许粘住）", () => {
		expect(updateLine({ desktop: true, version: "2.9.18", status: failed("检查更新没连上，稍后重试") })).toBe(
			"检查更新没连上，稍后重试",
		);
		expect(updateLine({ desktop: true, version: "2.9.18", status: passed() })).toBe("当前版本 2.9.18");
	});

	it("浏览器里没有这段桥：只说网页版没有自动更新", () => {
		expect(updateLine({ desktop: false, version: "", status: failed("检查更新没连上，稍后重试") })).toBe(
			"网页版没有自动更新，桌面版才有",
		);
	});
});
