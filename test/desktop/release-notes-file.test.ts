/**
 * 更新说明的唯一入口：`release-notes/<版本>.txt`。
 *
 * 以前发版那趟的 notes 是从 `feat` / `fix` 提交标题生成的，文案文件只在事后 `resign-notes`
 * 那条补救路上才生效 —— 于是「用户看到的是清单里的 notes」次次要手动重签（Solo 说过不许有第三次）。
 * 现在 `update-manifest.ts` 先读文件，读到就用，一行一件事原样保留。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { notesFromLines } from "../../scripts/update-manifest.ts";

const REPO = join(import.meta.dirname, "..", "..");

describe("notes 来自 release-notes/<版本>.txt", () => {
	it("人话原样保留：不按 feat / fix 过滤，只去空行和重复", () => {
		const lines = [
			"顶栏那颗任务板按钮真能点开了",
			"",
			"   ",
			"顶栏那颗任务板按钮真能点开了",
			"  悬浮球不再占着麦克风  ",
			"chore(版本): 2.9.22",
		];
		// 最后那条 chore 也留着：文件里写什么就是什么，过滤只会把写好的文案吃掉。
		expect(notesFromLines(lines)).toEqual([
			"顶栏那颗任务板按钮真能点开了",
			"悬浮球不再占着麦克风",
			"chore(版本): 2.9.22",
		]);
	});

	it("2.9.22 的文案文件几行，生成就是几行、一字不差", () => {
		const text = readFileSync(join(REPO, "release-notes", "2.9.22.txt"), "utf8");
		const want = text
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line !== "");
		const got = notesFromLines(text.split("\n"));
		expect(got).toEqual(want);
		expect(got.length).toBe(3);
	});
});
