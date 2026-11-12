/**
 * 两个根：应用私有的东西只落 app 根，我的组织只落用户根。
 *
 * 这条契约以前没有名字，靠 `dirname(agentsRoot)` 这类隐式约定维持 —— 漏一处就是
 * 静默降级（提示词没播种、插件没装），没有任何一处会报错。所以这里按「文件落在哪」
 * 逐项钉死，而不是只测 `resolveLayout` 拼出来的字符串。
 */
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgent } from "../../src/core/documents/member/identity.ts";
import { seedOwnerAssistant, seedPlugins, seedPromptTemplates, seedRules, syncAllSkills } from "../../src/shell/seed.ts";
import { existsAt } from "../../src/core/runtime/io.ts";
import { resolveInRoots, resolveToolPath } from "../../src/core/channel/tools/guards.ts";
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

	it("库、上传、密钥在 app 根；日志跟着用户根走", async () => {		const box = await pool.make("core-roots-");
		const { layout } = box;
		for (const path of [layout.databasePath, layout.uploadsRoot, layout.secretsFile, layout.settingsFile]) {
			expect(path.startsWith(layout.appRoot)).toBe(true);
		}
		for (const path of [layout.membersRoot, layout.teamsRoot, layout.skillsRoot, layout.rulesFile, layout.logsRoot]) {
			expect(path.startsWith(layout.userRoot)).toBe(true);
			expect(path.startsWith(layout.appRoot)).toBe(false);
		}
	});

	it("投递行里的 uploads/<id> 落到 app 根的附件目录，谁读都一样", async () => {
		const box = await pool.make("core-roots-");
		const { layout } = box;
		// 附件本体在 <appRoot>/uploads；投递行让模型按 `uploads/<id>` 读。
		// 归到用户根的话每个收到附件的人都会读成「文件不存在」（实测群里发生过）。
		expect(resolveInRoots(layout, "uploads/abc-123")).toBe(join(layout.uploadsRoot, "abc-123"));
		expect(resolveInRoots(layout, "uploads/../../outside")).toBeUndefined();
	});

	it("额外工作目录：只有显式绝对路径才进，未配置时绝对路径一律不认（ADR-126）", async () => {
		const box = await pool.make("core-roots-");
		const { layout } = box;
		const repo = join(box.root, "code", "solo");
		await mkdir(repo, { recursive: true });

		// 未配置：绝对路径不进（行为与以前一样）。
		expect(resolveToolPath(layout, join(repo, "a.ts"))).toEqual({ kind: "outside", absolute: true });
		// 默认路径也不因为配置了就被顺带扫进去。
		expect(resolveToolPath(layout, ".", [repo])).toEqual({ kind: "ok", path: layout.userRoot });

		expect(resolveToolPath(layout, join(repo, "a.ts"), [repo])).toEqual({ kind: "ok", path: join(repo, "a.ts") });
		// 往上走仍然拒：额外目录只是多了一个根，不是取消边界。
		expect(resolveToolPath(layout, join(repo, "..", "..", "etc", "passwd"), [repo])).toEqual({
			kind: "outside",
			absolute: true,
		});
		// 应用私有目录即使在额外目录里面也不开放（settings.json 里的 key、密钥、库）。
		expect(resolveToolPath(layout, layout.settingsFile, [box.root])).toEqual({ kind: "protected" });
		expect(resolveToolPath(layout, join(repo, ".secrets.json"), [repo])).toEqual({ kind: "protected" });
		expect(resolveToolPath(layout, join(repo, "core.sqlite"), [repo])).toEqual({ kind: "protected" });
	});

	it("额外工作目录里的相对路径不生效：相对路径仍然只按第一段落两个根", async () => {
		const box = await pool.make("core-roots-");
		const { layout } = box;
		const repo = join(box.root, "code", "solo");
		await mkdir(repo, { recursive: true });
		// `code/solo/a.ts` 相对的是用户根（成员的组织目录），不是额外目录 —— 绝不静默换根。
		expect(resolveToolPath(layout, "code/solo/a.ts", [repo])).toEqual({
			kind: "ok",
			path: join(layout.userRoot, "code", "solo", "a.ts"),
		});
	});
	it("额外工作目录里的软链一律拒：指向应用根/密钥/库、中间段、新建文件都拦，指向范围内的照旧放行（ADR-126）", async () => {
		const box = await pool.make("core-roots-");
		const { layout } = box;
		const repo = join(box.root, "code", "solo");
		const sub = join(repo, "pkg");
		await mkdir(sub, { recursive: true });
		await writeFile(join(sub, "a.ts"), "export const a = 1;\n");
		// 真实的密钥与库位置（内容无所谓，要的是「目标真的存在」）：软链指向不存在的目标时
		// 解不出来，也就谈不上泄漏；能泄漏的只有真存在的那种。
		await writeFile(layout.secretsFile, '{"openai":"sk-test"}\n');
		await writeFile(layout.databasePath, "SQLite format 3");

		// 文件软链 → 密钥、库：词法上都在目录里面，真实位置在应用私有根。
		await symlink(layout.secretsFile, join(repo, "leak.json"));
		expect(resolveToolPath(layout, join(repo, "leak.json"), [repo])).toEqual({ kind: "outside", absolute: true });
		await symlink(layout.databasePath, join(repo, "leakdb"));
		expect(resolveToolPath(layout, join(repo, "leakdb"), [repo])).toEqual({ kind: "outside", absolute: true });

		// 目录软链 → 应用根：里面任何一个文件都不该打开，包括新建的（目标还不存在也要拦）。
		await symlink(layout.appRoot, join(repo, "appdir"));
		expect(resolveToolPath(layout, join(repo, "appdir", "settings.json"), [repo])).toEqual({
			kind: "outside",
			absolute: true,
		});
		expect(resolveToolPath(layout, join(repo, "appdir", "brand-new.ts"), [repo])).toEqual({
			kind: "outside",
			absolute: true,
		});

		// 中间段是软链、指向范围外：一样拦（只有整条解出来才知道）。
		const outside = await mkdtemp(join(tmpdir(), "core-outside-"));
		await writeFile(join(outside, "x.txt"), "secret\n");
		await symlink(outside, join(repo, "outlink"));
		expect(resolveToolPath(layout, join(repo, "outlink", "x.txt"), [repo])).toEqual({ kind: "outside", absolute: true });
		await rm(outside, { recursive: true, force: true });

		// 指向**范围内**的软链可以留：不越界就不该被禁。
		await symlink(sub, join(repo, "alias"));
		expect(resolveToolPath(layout, join(repo, "alias", "a.ts"), [repo])).toEqual({
			kind: "ok",
			path: join(repo, "alias", "a.ts"),
		});

		// 组织目录里一条指向范围外的软链：词法上在 `members/` 下面，真实位置在外面 → 拒。
		// 这条是落点判据本身，删掉它「软链指向 home 下的 token」就能读。
		await mkdir(join(layout.userRoot, "members", "x"), { recursive: true });
		const vault = await mkdtemp(join(tmpdir(), "core-vault-"));
		await writeFile(join(vault, "github-token"), "ghp_secret\n");
		await symlink(join(vault, "github-token"), join(layout.userRoot, "members", "x", "token.txt"));
		expect(resolveToolPath(layout, "members/x/token.txt")).toEqual({ kind: "outside", absolute: false });
		await symlink(vault, join(layout.userRoot, "members", "x", "vault"));
		expect(resolveToolPath(layout, "members/x/vault/github-token")).toEqual({ kind: "outside", absolute: false });
		await rm(vault, { recursive: true, force: true });

		const extra = await mkdtemp(join(tmpdir(), "core-extra-"));
		// 配了目录之后同一个文件相对与绝对才一致（Solo #2151）；没配时绝对路径一律拒。
		// 判据收窄后不再要求「组织目录里的绝对路径能读」，也不再要求额外目录里的软链能读 ——
		// 绝对路径只认显式授权过的目录，软链按真实位置判，真实位置不在那个目录里就拒。
		await writeFile(join(layout.userRoot, "members", "x", "real.txt"), "同一份内容\n");
		expect(resolveToolPath(layout, join(layout.userRoot, "members", "x", "real.txt"))).toEqual({
			kind: "outside",
			absolute: true,
		});
		expect(resolveToolPath(layout, "members/x/real.txt", [layout.userRoot])).toEqual(
			resolveToolPath(layout, join(layout.userRoot, "members", "x", "real.txt"), [layout.userRoot]),
		);
		// 范围外的绝对路径照旧拒（放宽的是「哪些根算允许」，不是取消边界）。
		expect(resolveToolPath(layout, join(tmpdir(), "核心之外", "x.txt"))).toEqual({ kind: "outside", absolute: true });
		await rm(extra, { recursive: true, force: true });

		// 相对路径这边同样：词法上在用户根、真实位置落到应用私有根（中间有软链）→ 落在允许的根里。
		await mkdir(join(layout.userRoot, "members", "x"), { recursive: true });
		await symlink(layout.appRoot, join(layout.userRoot, "members", "x", "appdir"));
		expect(resolveToolPath(layout, "members/x/appdir/settings.json")).toEqual({ kind: "protected" });
		// 直接写的 `assistant/…` 词法上本来就在应用根，不受这条影响。
		expect(resolveToolPath(layout, "assistant/anything")).toEqual({
			kind: "ok",
			path: join(layout.assistantRoot, "anything"),
		});
	});

});
