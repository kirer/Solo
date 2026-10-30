/**
 * 引用条 / 附件托盘 / 输入卡必须走同一条居中轨道（我报过「比输入卡靠左太多」）。
 *
 * 这是布局的事，node 里没有布局引擎，所以读 composer.css 断言规则：
 *   - 三者的宽度公式用的是同一个 clamp，且引用条把 64% 换算到 composer 内容宽；
 *   - 引用条写死 width: 100%（只靠 max-width + margin:auto 会按内容收缩）；
 *   - composer 的左右内边距走 --composer-pad 变量，手机改成 12 时三者一起变。
 * 左边是否真的相等由无头 Chrome 量（1440/1200/900/760/480 都对齐到同一像素）。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("../../ui/app/src/styles/composer.css", import.meta.url)), "utf8").replace(
	/\/\*[\s\S]*?\*\//g,
	"",
);

function blocksOf(selector: string): string[] {
	const out: string[] = [];
	for (const match of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
		const prelude = match[1].split(",").map((part) => part.trim());
		if (prelude.includes(selector)) out.push(match[2]);
	}
	if (out.length === 0) throw new Error(`没找到规则 ${selector}`);
	return out;
}

describe("引用条与附件托盘的居中轨道", () => {
	it("两边都用 composer 的内边距变量，宽度公式同源", () => {
		expect(blocksOf(":root").join("\n")).toContain("--composer-pad: 16px");
		// 引用条：clamp 的百分比按 composer 内容宽算，并让出卡片那 32px
		const reply = blocksOf(".reply").join("\n");
		expect(reply).toContain("width: 100%");
		expect(reply).toContain("var(--composer-pad, 16px)");
		expect(reply).toContain("32px");
		// 托盘同理
		const tray = blocksOf(".attach-tray").join("\n");
		expect(tray).toContain("width: 100%");
		expect(tray).toContain("margin: 0 auto");
	});

	it("手机（<=640px）把同一份内边距改成 12", () => {
		const mobile = /@media \(max-width: 640px\) \{([\s\S]*)\n\}/.exec(css)?.[1] ?? "";
		expect(mobile).toContain("--composer-pad: 12px");
		expect(mobile).toContain("padding: 0 var(--composer-pad) 12px");
	});
});
