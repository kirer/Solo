/**
 * 更新弹窗里「这一版改了什么」那一段的排版：单条截断、条数、整段上限、换行压平。
 * 纯函数，不碰清单、不碰窗口 —— 连线（`updates.ts` 把那一段塞进 `detail`）另测。
 *
 * 验收标准见 `teams/Solo/workspace/2.9.15-更新弹窗-验收标准.md` 第四节。
 */
import { describe, expect, it } from "vitest";
import { formatNotes, versionDetail } from "../../desktop/src/update-notes.ts";

const one = "去掉悬浮球上的转圈弧";

const lines = (text: string): string[] => text.split("\n");
const count = (text: string): number => Array.from(text).length;

describe("排「这一版改了什么」", () => {
	it("没有内容时返回空串，调用方退回旧文案", () => {
		expect(formatNotes([])).toBe("");
		expect(formatNotes(["", "   ", "\n\t"])).toBe("");
	});

	it("一条就一行，前面带引导句和圆点", () => {
		expect(formatNotes([one])).toBe(`这一版改了什么：\n· ${one}`);
	});

	it("按原顺序显示，一条不多一条不少", () => {
		expect(formatNotes(["第一件事", "第二件事", "第三件事"])).toBe(
			"这一版改了什么：\n· 第一件事\n· 第二件事\n· 第三件事",
		);
	});

	it("空白条目丢掉，不占一行", () => {
		expect(formatNotes(["  第一件事  ", "", "第二件事"])).toBe("这一版改了什么：\n· 第一件事\n· 第二件事");
	});
});

describe("单条太长怎么截", () => {
	it("正好 60 个字不动", () => {
		const note = "字".repeat(60);
		expect(formatNotes([note])).toBe(`这一版改了什么：\n· ${note}`);
	});

	it("61 个字截成 57 个字加省略号", () => {
		const note = "字".repeat(61);
		expect(formatNotes([note])).toBe(`这一版改了什么：\n· ${"字".repeat(57)}…`);
	});

	it("200 个字：只留一条，结尾是省略号，后面的字不出现", () => {
		const note = `开头${"中".repeat(196)}尾巴`;
		const [heading, item] = lines(formatNotes([note]));
		expect(heading).toBe("这一版改了什么：");
		expect(item).toBe(`· ${`开头${"中".repeat(55)}`}…`);
		expect(item?.endsWith("…")).toBe(true);
		expect(item?.includes("尾巴")).toBe(false);
	});

	it("中文按一个字算，不按 UTF-16 长度算", () => {
		// 60 个汉字是 60 个字（UTF-16 长度也是 60），60 个 emoji 才算得出来区别。
		const note = "🙂".repeat(60);
		expect(formatNotes([note])).toBe(`这一版改了什么：\n· ${note}`);
	});
});

describe("条数太多怎么收", () => {
	it("正好 5 条：全显示，不加「还有」", () => {
		const notes = ["一", "二", "三", "四", "五"];
		const body = lines(formatNotes(notes));
		expect(body.length).toBe(6);
		expect(body.some((line) => line.includes("还有"))).toBe(false);
	});

	it("6 条：显示 5 条加一行「还有 1 条」", () => {
		const notes = ["一", "二", "三", "四", "五", "六"];
		const body = lines(formatNotes(notes));
		expect(body.length).toBe(7);
		expect(body[6]).toBe("· …还有 1 条，见 Release 页面");
		expect(body.includes("· 六")).toBe(false);
	});

	it("8 条各 200 字：5 条 + 「还有 3 条」，每条不超 58 字，整段不超 600 字", () => {
		const long = "改".repeat(200);
		const notes = Array.from({ length: 8 }, (_, index) => `第${index + 1}条${long}`);
		const block = formatNotes(notes);
		const body = lines(block);

		expect(body[0]).toBe("这一版改了什么：");
		expect(body.length).toBe(7);
		expect(body[6]).toBe("· …还有 3 条，见 Release 页面");
		for (const line of body.slice(1, 6)) {
			expect(line.startsWith("· ")).toBe(true);
			expect(count(line.slice(2))).toBeLessThanOrEqual(58);
			expect(line.endsWith("…")).toBe(true);
		}
		expect(count(block)).toBeLessThanOrEqual(600);
	});
});

describe("条目里的换行和制表符", () => {
	it("压成一行，不留空行", () => {
		expect(formatNotes(["第一行\n\n第二行\t第三行"])).toBe("这一版改了什么：\n· 第一行 第二行 第三行");
	});

	it("首尾空白剪掉", () => {
		expect(formatNotes(["  两头有空格  "])).toBe("这一版改了什么：\n· 两头有空格");
	});
});

describe("整段上限", () => {
	it("极端情况（5 条都顶到上限）整段仍在 600 字以内", () => {
		const note = "满".repeat(200);
		const block = formatNotes([note, note, note, note, note]);
		expect(count(block)).toBeLessThanOrEqual(600);
		expect(lines(block).length).toBe(6);
	});
});

describe("弹窗 detail 的拼法", () => {
	it("没有 notes 时逐字等于加这一版之前的文案", () => {
		expect(versionDetail("2.9.15", [])).toBe("当前是 2.9.15。现在下载吗？下载完会再问一次要不要重启安装。");
		expect(versionDetail("2.9.15", ["", "  "])).toBe(
			"当前是 2.9.15。现在下载吗？下载完会再问一次要不要重启安装。",
		);
	});

	it("有 notes 时四段齐、顺序对、看不到 JSON 痕迹", () => {
		const detail = versionDetail("2.9.15", ["去掉转圈弧", "更新弹窗显示这一版改了什么", "修一件事"]);
		expect(detail.startsWith("当前是 2.9.15。")).toBe(true);
		expect(detail.endsWith("现在下载吗？下载完会再问一次要不要重启安装。")).toBe(true);
		const order = ["这一版改了什么：", "去掉转圈弧", "更新弹窗显示这一版改了什么", "修一件事"].map((part) =>
			detail.indexOf(part),
		);
		expect(order.every((index, at) => index >= 0 && (at === 0 || index > (order[at - 1] ?? -1)))).toBe(true);
		for (const trace of ['["', '"]', '{"', '\\"']) expect(detail.includes(trace)).toBe(false);
	});
});
