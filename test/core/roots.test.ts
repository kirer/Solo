/**
 * 两个根：应用私有的东西只落 app 根，我的组织只落用户根。
 *
 * 这条契约以前没有名字，靠 `dirname(agentsRoot)` 这类隐式约定维持 —— 漏一处就是
 * 静默降级（提示词没播种、插件没装），没有任何一处会报错。所以这里按「文件落在哪」
 * 逐项钉死，而不是只测 `resolveLayout` 拼出来的字符串。
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgent } from "../../src/core/agent/identity.ts";
import { seedOwnerAssistant, seedPlugins, seedPromptTemplates, seedRules, syncAllSkills } from "../../src/shell/seed.ts";
import { existsAt } from "../../src/core/runtime/io.ts";
import { sandboxPool } from "./support.ts";

const pool = sandboxPool();

afterEach(() => pool.cleanup());

async function names(dir: string): Promise<readonly string[]> {
	return (await readdir(dir).catch(() => [])).sort();
}

describe("两个根", () => {
	it("出厂播种：助理、提示词、插件在 app 根；规矩、全员技能在用户根", async () => {
		const box = await pool.make("core-roots-");
		const layout = box.layout;

		const slug = await seedOwnerAssistant(layout, { name: "知言" });
		await seedPromptTemplates(layout);
		await seedPlugins(layout);
		await seedRules(layout);
		await syncAllSkills(layout);

		// 助理：应用私有根下面。
		expect(await existsAt(join(layout.assistantRoot, slug, "identity.md"))).toBe(true);
		// 提示词与插件：应用私有根。
		expect((await names(layout.promptRoot)).length).toBeGreaterThan(0);
		expect((await names(layout.pluginsRoot)).length).toBeGreaterThan(0);
		// 规矩与全员技能：用户根。
		expect(await existsAt(layout.rulesFile)).toBe(true);
		expect((await names(layout.skillsRoot)).length).toBeGreaterThan(0);

		// 用户根里没有应用私有的东西。
		expect(await existsAt(join(layout.userRoot, "prompt"))).toBe(false);
		expect(await existsAt(join(layout.userRoot, "plugins"))).toBe(false);
		expect(await existsAt(join(layout.userRoot, "assistant"))).toBe(false);
		// 应用根里没有组织。
		expect(await existsAt(join(layout.appRoot, "members"))).toBe(false);
		expect(await existsAt(join(layout.appRoot, "teams"))).toBe(false);
	});

	it("招的人落在用户根的 members/，旧名字 agents/ 不再出现", async () => {
		const box = await pool.make("core-roots-");
		const layout = box.layout;

		const identity = await createAgent({ root: layout.membersRoot, name: "林越", manager: "owner" });
		expect(identity.dir.startsWith(join(layout.userRoot, "members"))).toBe(true);
		expect(await existsAt(join(layout.userRoot, "members", identity.slug, "identity.md"))).toBe(true);
		expect(await existsAt(join(layout.userRoot, "agents"))).toBe(false);
	});

	it("库、上传、密钥在 app 根；日志跟着用户根走", async () => {
		const box = await pool.make("core-roots-");
		const { layout } = box;
		for (const path of [layout.databasePath, layout.uploadsRoot, layout.secretsFile, layout.settingsFile]) {
			expect(path.startsWith(layout.appRoot)).toBe(true);
		}
		for (const path of [layout.membersRoot, layout.teamsRoot, layout.skillsRoot, layout.rulesFile, layout.logsRoot]) {
			expect(path.startsWith(layout.userRoot)).toBe(true);
			expect(path.startsWith(layout.appRoot)).toBe(false);
		}
	});
});
