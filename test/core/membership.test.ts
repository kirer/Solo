/**
 * 团队频道的成员投影：谁进来了。
 *
 * 招人 / 写 README 之后频道会重投影一次，`syncTeamChannel` 把**这次新进来的人**交出去 ——
 * 装配层拿它叫这些人自己报到（ADR-042）。算错的两个方向都很贵：漏了人，他进了团队频道
 * 却从不说话；多算了，每次重启都让全体成员白烧一轮。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { syncTeamChannel } from "../../src/core/channel/membership.ts";
import { ChannelDoc, OWNER, type ChannelState } from "../../src/core/channel/types.ts";
import { writeTeam } from "../../src/core/team/doc.ts";
import { BACKGROUND_CONTEXT } from "../../src/core/runtime/index.ts";
import { sandboxPool } from "./support.ts";

const pool = sandboxPool();

afterEach(() => pool.cleanup());

async function person(root: string, slug: string, header: string): Promise<void> {
	await mkdir(join(root, slug), { recursive: true });
	await writeFile(join(root, slug, "identity.md"), `---\nname: ${slug}\n${header}---\n\n做事的。\n`, "utf8");
}

async function setup() {
	const box = await pool.make("membership-");
	// 助理住在应用根的 `assistant/` 下（文件夹事实，ADR-058），成员在用户根。
	await person(box.layout.assistantRoot, "知言", "title: 助理\n");
	await person(box.agentsRoot, "程一", "title: 开发\nteam: alpha\n");
	await person(box.agentsRoot, "林越", "title: 测试\nteam: alpha\n");
	await writeTeam(box.teamsRoot, { slug: "alpha", name: "alpha", body: "目标：把网页做到能看。" });
	const runtime = await box.open();
	return { box, runtime, deps: { harness: runtime.harness, layout: box.layout, allChannel: "all" } };
}

describe("团队频道重投影：谁是新来的", () => {
	it("第一次投影：团队成员都是新人，我和助理不算", async () => {
		const { deps } = await setup();
		expect((await syncTeamChannel(deps, "alpha")).sort()).toEqual(["程一", "林越"].sort());
	});

	it("幂等：成员没变就没有新人（重启不会让全体再报一次到）", async () => {
		const { deps } = await setup();
		await syncTeamChannel(deps, "alpha");
		expect(await syncTeamChannel(deps, "alpha")).toEqual([]);
	});

	it("后来招进来的人单独算新人", async () => {
		const { box, deps } = await setup();
		await syncTeamChannel(deps, "alpha");
		await person(box.agentsRoot, "沈砚", "title: 开发\nteam: alpha\n");
		expect(await syncTeamChannel(deps, "alpha")).toEqual(["沈砚"]);
	});

	it("解散的团队不叫人报到", async () => {
		const { box, deps } = await setup();
		await writeTeam(box.teamsRoot, { slug: "alpha", status: "archived", body: "目标：先不做了。" });
		expect(await syncTeamChannel(deps, "alpha")).toEqual([]);
	});
});

describe("装配层：新进来的人被叫去报到", () => {
	it("重投影一次，团队频道里留下一条报到留痕（助理自己不发言）", async () => {
		const { box, runtime } = await setup();
		const shell = await box.assemble(runtime);
		// 装配时还没有 README，频道不存在；写 README 之后的重投影才是真实路径。
		await person(box.agentsRoot, "沈砚", "title: 开发\nteam: beta\n");
		await writeTeam(box.teamsRoot, { slug: "beta", name: "Beta", body: "目标：先做出来。" });
		await shell.syncTeam("beta");
		const state = await shell.channels(BACKGROUND_CONTEXT);
		// 一条留痕叫醒新人：正文里带频道标题，醒来说什么由他们自己决定。
		const joins = (state.messages["team:beta"] ?? []).filter(
			(item) => item.kind === "note" && item.text.includes("团队频道"),
		);
		expect(joins).toHaveLength(1);
		expect(joins[0]?.text).toContain("Beta");
		expect(joins[0]?.from).toBe(OWNER);
		// 再同步一次没人新进来：不再留痕（重启不会让全体再报一次到）。
		await shell.syncTeam("beta");
		const again = (await shell.channels(BACKGROUND_CONTEXT)).messages["team:beta"] ?? [];
		expect(again.filter((item) => item.kind === "note" && item.text.includes("团队频道"))).toHaveLength(1);
	});
});

describe("成员表：团队成员和助理都在", () => {
	it("频道成员包含我、团队成员和助理", async () => {
		const { deps } = await setup();
		await syncTeamChannel(deps, "alpha");
		const state = (await deps.harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT)) as ChannelState;
		const members = state.channels["team:alpha"]?.members ?? [];
		expect(members).toContain(OWNER);
		expect(members).toContain("程一");
		expect(members).toContain("林越");
		expect(members).toContain("知言");
	});
});
