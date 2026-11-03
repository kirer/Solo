/**
 * 团队频道的成员投影：谁进来了。
 *
 * 招人 / 写 README 之后频道会重投影一次，`syncTeamChannel` 把**这次新进来的人**交出去 ——
 * 装配层拿它叫这些人自己报到（ADR-042）。算错的两个方向都很贵：漏了人，他进了团队频道
 * 却从不说话；多算了，每次重启都让全体成员白烧一轮。
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { archiveGoneTeams, createGroup, ensureOwnerDm, syncTeamChannel } from "../../src/core/channel/membership.ts";
import { ChannelDoc, OWNER, dmId, type ChannelState } from "../../src/core/channel/types.ts";
import { writeTeam } from "../../src/core/team/doc.ts";
import { BACKGROUND_CONTEXT } from "../../src/core/runtime/index.ts";
import { serveCore } from "../../src/shell/serve.ts";
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

describe("私聊：同一个人重新招回来", () => {
	it("旧私聊被开除时归档、成员摘掉；再招回来要恢复成我和他", async () => {
		const { deps } = await setup();
		const id = dmId(OWNER, "程一");
		await ensureOwnerDm(deps, "程一");
		// 和 `hire action=fire` 一样：摘掉成员并归档这条私聊。
		await deps.harness.commit(async (tx) => {
			const state = (await tx.doc(ChannelDoc)) as ChannelState;
			const channel = state.channels[id]!;
			state.channels[id] = { ...channel, members: [OWNER], archived: true };
		}, BACKGROUND_CONTEXT);
		await ensureOwnerDm(deps, "程一");
		const channel = ((await deps.harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT)) as ChannelState).channels[id];
		expect(channel?.archived).toBeUndefined();
		expect(channel?.members).toEqual([OWNER, "程一"]);
	});
});

describe("运行时删掉团队目录：目录监听立刻归档", () => {
	it("服务跑着的时候删掉 teams/<slug>，频道在几百毫秒内归档（不用重启）", async () => {
		const { box, runtime } = await setup();
		const shell = await box.assemble(runtime);
		await shell.syncTeam("alpha");
		const server = await serveCore({ shell, port: 0 });
		try {
			await rm(join(box.teamsRoot, "alpha"), { recursive: true, force: true });
			await new Promise((resolve) => setTimeout(resolve, 600));
			const state = await shell.channels(BACKGROUND_CONTEXT);
			expect(state.channels["team:alpha"]?.archived).toBe(true);
		} finally {
			await server.close();
		}
	});
});

describe("团队目录没了：频道归档", () => {
	it("删掉团队目录后扫一遍把它归档（历史消息还留着）", async () => {
		const { box, deps } = await setup();
		await syncTeamChannel(deps, "alpha");
		await rm(join(box.teamsRoot, "alpha"), { recursive: true, force: true });
		await archiveGoneTeams(deps);
		const state = (await deps.harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT)) as ChannelState;
		expect(state.channels["team:alpha"]?.archived).toBe(true);
	});

	it("团队还在就什么都不改（重启不会误伤）", async () => {
		const { deps } = await setup();
		await syncTeamChannel(deps, "alpha");
		await archiveGoneTeams(deps);
		const state = (await deps.harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT)) as ChannelState;
		expect(state.channels["team:alpha"]?.archived).toBeUndefined();
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

describe("任意组群（ADR-063）", () => {
	it("建出来是 group: 开头的普通频道，进来的每个人都会被新消息叫醒", async () => {
		const { deps } = await setup();
		const group = await createGroup(deps, { title: "首页改版", members: ["程一", "林越"], creator: OWNER });
		expect(group.id).toBe("group:首页改版");
		const state = (await deps.harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT)) as ChannelState;
		const channel = state.channels[group.id];
		expect(channel?.members.sort()).toEqual([OWNER, "程一", "林越"].sort());
		// 群组不设「助理负责分发」：每个人自己判断要不要接。
		expect(channel?.wakeOnAll.sort()).toEqual([OWNER, "程一", "林越"].sort());
	});

	it("建群的人自己在里面（哪怕没写进名单）", async () => {
		const { deps } = await setup();
		const group = await createGroup(deps, { title: "两个人", members: ["程一"], creator: OWNER });
		expect(group.members).toContain(OWNER);
	});

	it("至少要两个人：只有自己不成群", async () => {
		const { deps } = await setup();
		await expect(createGroup(deps, { title: "我自己", members: [], creator: OWNER })).rejects.toThrow();
	});

	it("不认识的人进不来", async () => {
		const { deps } = await setup();
		await expect(
			createGroup(deps, { title: "幽灵", members: ["程一", "查无此人"], creator: OWNER }),
		).rejects.toThrow();
	});

	it("同名群不会建出第二份房间", async () => {
		const { deps } = await setup();
		await createGroup(deps, { title: "首页改版", members: ["程一"], creator: OWNER });
		await expect(
			createGroup(deps, { title: "首页改版", members: ["林越"], creator: OWNER }),
		).rejects.toThrow();
	});
});
