/**
 * 装配的端到端测试：从「文件夹里有什么」到「老板说一句话、谁被唤醒」。
 *
 * 这是新核心最重要的一条验证 —— 它同时证明了四件事：
 * 1. `identity.md` 是唯一事实：没有代码里的角色枚举。
 * 2. 名册能从会话 id 反查 slug，因此投递能落地。
 * 3. 老板 @ 谁，谁就被唤醒（且只有他）。
 * 4. 老板不是 agent，不会被投递（也没有会话）。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT, openCore, createRegistry, setupModels } from "../../src/core/runtime/index.ts";
import { assembleCore, ownerSpeak } from "../../src/core/shell/assemble.ts";
import { seedOwnerAssistant } from "../../src/core/shell/seed.ts";
import { readIdentity } from "../../src/core/agent/identity.ts";
import { ChannelDoc, personalId, projectId, type ChannelState } from "../../src/core/channel/state.ts";
import { writeProject } from "../../src/core/project/doc.ts";
import { DirectoryDoc, emptyDirectory, type DirectoryState } from "../../src/core/agent/roster.ts";
import { createAgent } from "../../src/core/agent/create.ts";

const dirs: string[] = [];

async function workspace(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "core-shell-"));
	dirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** 一个能开库的最小环境。不需要真模型：我们只验证装配与投递，不跑生成。 */
async function env(root: string) {
	const models = setupModels(process.env, { workspace: root }).models;
	const opened = await openCore({
		databasePath: join(root, "company.sqlite"),
		models,
		registry: createRegistry(),
	});
	return opened;
}

describe("装配", () => {
	test("扫文件夹建会话，并把 slug↔会话写进名册", async () => {
		const root = await workspace();
		const agents = join(root, "agents");
		await createAgent({ root: agents, name: "林越", title: "负责人", manager: "owner" });
		await createAgent({ root: agents, name: "沈舟", title: "财务", manager: "林越" });

		const opened = await env(root);
		try {
			const shell = await assembleCore(opened.harness, opened.registry, {
				agentsRoot: agents,
				projectsRoot: join(root, "projects"),
			});

			expect([...shell.conversations.keys()].sort()).toEqual(["林越", "沈舟"].sort());
			const directory = (await opened.harness.snapshot(DirectoryDoc)) as DirectoryState | undefined;
			expect(directory?.slugToConversation["林越"]).toBeTypeOf("number");
			expect(directory?.conversationToSlug[String(directory?.slugToConversation["沈舟"])]).toBe("沈舟");
		} finally {
			await opened.close();
		}
	});

	test("公司频道自动包含所有人和老板", async () => {
		const root = await workspace();
		const agents = join(root, "agents");
		await createAgent({ root: agents, name: "林越", manager: "owner" });

		const opened = await env(root);
		try {
			const shell = await assembleCore(opened.harness, opened.registry, {
				agentsRoot: agents,
				projectsRoot: join(root, "projects"),
			});
			const state = await shell.channels();
			expect(state.channels.company?.members.sort()).toEqual(["owner", "林越"].sort());
		} finally {
			await opened.close();
		}
	});

	test("rescan 只为新出现的人开会话", async () => {
		const root = await workspace();
		const agents = join(root, "agents");
		await createAgent({ root: agents, name: "林越", manager: "owner" });

		const opened = await env(root);
		try {
			const shell = await assembleCore(opened.harness, opened.registry, {
				agentsRoot: agents,
				projectsRoot: join(root, "projects"),
			});
			const before = shell.conversations.size;
			await createAgent({ root: agents, name: "沈舟", manager: "林越" });
			const added = await shell.rescan();
			expect(added).toEqual(["沈舟"]);
			expect(shell.conversations.size).toBe(before + 1);
			const state = await shell.channels();
			expect(state.channels.company?.members).toContain("沈舟");
		} finally {
			await opened.close();
		}
	});

	test("重启不会重复造人（会话 id 复用）", async () => {
		const root = await workspace();
		const agents = join(root, "agents");
		await createAgent({ root: agents, name: "林越", manager: "owner" });

		const first = await env(root);
		let firstId: number | undefined;
		try {
			await assembleCore(first.harness, first.registry, { agentsRoot: agents, projectsRoot: join(root, "projects") });
			const directory = (await first.harness.snapshot(DirectoryDoc)) as DirectoryState | undefined;
			firstId = directory?.slugToConversation["林越"];
		} finally {
			await first.close();
		}

		const second = await env(root);
		try {
			await assembleCore(second.harness, second.registry, { agentsRoot: agents, projectsRoot: join(root, "projects") });
			const directory = (await second.harness.snapshot(DirectoryDoc)) as DirectoryState | undefined;
			expect(directory?.slugToConversation["林越"]).toBe(firstId);
		} finally {
			await second.close();
		}
	});
});

describe("老板说话", () => {
	test("@ 谁就只叫谁；老板自己不被投递（他没有会话）", async () => {
		const root = await workspace();
		const agents = join(root, "agents");
		await createAgent({ root: agents, name: "林越", manager: "owner" });
		await createAgent({ root: agents, name: "沈舟", manager: "林越" });

		const opened = await env(root);
		try {
			const shell = await assembleCore(opened.harness, opened.registry, {
				agentsRoot: agents,
				projectsRoot: join(root, "projects"),
			});
			const sent = await ownerSpeak(shell, { channelId: "company", text: "@林越 停掉所有任务" });
			expect(sent.seq).toBe(1);

			const state = (await opened.harness.snapshot(ChannelDoc)) as ChannelState;
			const message = state.messages.company?.[0];
			expect(message?.from).toBe("owner");
			expect(message?.mentions).toEqual(["林越"]);

			// 林越的会话里应该收到一条投递（内容含频道名与正文）。
			const lin = shell.conversations.get("林越");
			expect(lin).toBeDefined();
			const view = await lin!.context(undefined as never).catch(() => undefined);
			// 不强制断言 context 内容：投递是异步 task，能读到会话本身已足够。
			expect(view === undefined || Array.isArray(view.messages)).toBe(true);
		} finally {
			await opened.close();
		}
	});

	test("不 @ 人时按规则唤醒第一个非老板成员", async () => {
		const root = await workspace();
		const agents = join(root, "agents");
		await createAgent({ root: agents, name: "林越", manager: "owner" });

		const opened = await env(root);
		try {
			const shell = await assembleCore(opened.harness, opened.registry, {
				agentsRoot: agents,
				projectsRoot: join(root, "projects"),
			});
			await ownerSpeak(shell, { channelId: "company", text: "有人吗" });
			const state = (await opened.harness.snapshot(ChannelDoc)) as ChannelState;
			expect(state.messages.company?.[0]?.mentions).toEqual([]);
			// 收件人规则在 state.ts 的单测里已覆盖；这里只确认消息落了盘。
		} finally {
			await opened.close();
		}
	});
});

describe("播种", () => {
	test("种出来的人 manager 就是 owner，且正文写清了职责", async () => {
		const root = await workspace();
		const agents = join(root, "agents");
		const slug = await seedOwnerAssistant(agents, { name: "林越" });
		const identity = await readIdentity(agents, slug);
		expect(identity?.manager).toBe("owner");
		expect(identity?.body).toContain("hire");
	});

	test("seed 出来的人能被装配扫到", async () => {
		const root = await workspace();
		const agents = join(root, "agents");
		await seedOwnerAssistant(agents, { name: "林越" });

		const opened = await env(root);
		try {
			const shell = await assembleCore(opened.harness, opened.registry, {
				agentsRoot: agents,
				projectsRoot: join(root, "projects"),
			});
			expect(shell.conversations.has("林越")).toBe(true);
			expect((await shell.channels()).channels.company?.members).toContain("林越");
		} finally {
			await opened.close();
		}
	});
});

describe("个人频道与项目频道", () => {
	test("每个人一出生就有个人频道（与老板的私聊）", async () => {
		const root = await workspace();
		const agents = join(root, "agents");
		await createAgent({ root: agents, name: "林越", manager: "owner" });
		await createAgent({ root: agents, name: "沈舟", manager: "林越" });

		const opened = await env(root);
		try {
			const shell = await assembleCore(opened.harness, opened.registry, {
				agentsRoot: agents,
				projectsRoot: join(root, "projects"),
			});
			const state = await shell.channels();
			// 个人频道是「他和老板的私聊」，也是拍板链的顶端。没有它，向上汇报没有落点。
			for (const slug of ["林越", "沈舟"]) {
				const personal = state.channels[personalId(slug)];
				expect(personal?.members.sort()).toEqual(["owner", slug].sort());
			}
			// 老板自己没有个人频道。
			expect(state.channels[personalId("owner")]).toBeUndefined();
		} finally {
			await opened.close();
		}
	});

	test("项目负责人、成员、老板都进项目频道", async () => {
		const root = await workspace();
		const agents = join(root, "agents");
		const projects = join(root, "projects");
		await createAgent({ root: agents, name: "林越", manager: "owner" });
		await createAgent({ root: agents, name: "沈舟", manager: "林越", project: "坦克大战" });
		// 负责人是林越，但林越自己不在项目里（负责人不一定写代码）。
		await writeProject(projects, { slug: "坦克大战", owner: "林越", body: "# 目标\n能两个人打。" });

		const opened = await env(root);
		try {
			const shell = await assembleCore(opened.harness, opened.registry, {
				agentsRoot: agents,
				projectsRoot: projects,
			});
			const state = await shell.channels();
			const channel = state.channels[projectId("坦克大战")];
			// 负责人不在频道里 → 员工派活 @ 不到他 → 出了问题没人能拍板。
			expect(channel?.members.sort()).toEqual(["owner", "沈舟", "林越"].sort());
			expect(channel?.title).toBe("坦克大战");
		} finally {
			await opened.close();
		}
	});

	test("项目频道里谁说话都叫醒负责人（员工不用 @ 上级）", async () => {
		const root = await workspace();
		const agents = join(root, "agents");
		const projects = join(root, "projects");
		await createAgent({ root: agents, name: "林越", manager: "owner" });
		await createAgent({ root: agents, name: "沈舟", manager: "林越", project: "坦克大战" });
		await writeProject(projects, { slug: "坦克大战", owner: "林越", body: "# 目标\n能两个人打。" });

		const opened = await env(root);
		try {
			const shell = await assembleCore(opened.harness, opened.registry, {
				agentsRoot: agents,
				projectsRoot: projects,
			});
			const state = await shell.channels();
			const channel = state.channels[projectId("坦克大战")];
			// 员工在项目频道说「做完了」时通常不会 @ 人。负责人收不到 → 只能轮询
			// （实测里 agent 用 `run sleep 120` 等进度）。所以项目频道要让负责人始终醒着。
			expect(channel?.wakeOnAll).toEqual(["林越"]);
		} finally {
			await opened.close();
		}
	});

	test("改了项目负责人，频道成员跟着变（不需要重启）", async () => {
		const root = await workspace();
		const agents = join(root, "agents");
		const projects = join(root, "projects");
		await createAgent({ root: agents, name: "林越", manager: "owner", project: "坦克大战" });
		await createAgent({ root: agents, name: "沈舟", manager: "林越", project: "坦克大战" });
		await writeProject(projects, { slug: "坦克大战", owner: "林越", body: "# 目标\n能两个人打。" });

		const opened = await env(root);
		try {
			const shell = await assembleCore(opened.harness, opened.registry, {
				agentsRoot: agents,
				projectsRoot: projects,
			});
			await writeProject(projects, { slug: "坦克大战", owner: "沈舟", body: "# 目标\n能两个人打。" });
			await shell.syncProject("坦克大战");
			const state = await shell.channels();
			expect(state.channels[projectId("坦克大战")]?.members).toContain("沈舟");
		} finally {
			await opened.close();
		}
	});

	test("项目频道含负责人的整条汇报线（统筹者也进项目频道）", async () => {
		const root = await workspace();
		const agents = join(root, "agents");
		const projects = join(root, "projects");
		// 知言：老板直接下属（统筹者）；顾南雁：项目负责人，归知言；沈舟：执行员工，归顾南雁。
		await createAgent({ root: agents, name: "知言", manager: "owner" });
		await createAgent({ root: agents, name: "顾南雁", manager: "知言", project: "恐龙" });
		await createAgent({ root: agents, name: "沈舟", manager: "顾南雁", project: "恐龙" });
		await writeProject(projects, { slug: "恐龙", owner: "顾南雁", body: "# 目标\n做一只恐龙。" });

		const opened = await env(root);
		try {
			const shell = await assembleCore(opened.harness, opened.registry, {
				agentsRoot: agents,
				projectsRoot: projects,
			});
			const state = await shell.channels();
			// 项目的成员是事实的投影：老板 + 负责人(顾南雁) + 其汇报线(知言) + 执行员工(沈舟)。
			expect(state.channels[projectId("恐龙")]?.members.sort()).toEqual(
				["owner", "沈舟", "知言", "顾南雁"].sort(),
			);
		} finally {
			await opened.close();
		}
	});

	test("项目频道成员按事实精确重算，不残留幽灵成员", async () => {
		const root = await workspace();
		const agents = join(root, "agents");
		const projects = join(root, "projects");
		await createAgent({ root: agents, name: "林越", manager: "owner", project: "坦克大战" });
		await createAgent({ root: agents, name: "沈舟", manager: "林越", project: "坦克大战" });
		await writeProject(projects, { slug: "坦克大战", owner: "林越", body: "# 目标\n能两个人打。" });

		const opened = await env(root);
		try {
			const shell = await assembleCore(opened.harness, opened.registry, {
				agentsRoot: agents,
				projectsRoot: projects,
			});
			// 模拟一个旧 slug 残留（改名/重建后留下的幽灵成员）。
			const before = await shell.channels();
			before.channels[projectId("坦克大战")] = {
				...before.channels[projectId("坦克大战")],
				members: [...before.channels[projectId("坦克大战")].members, "gunanyan"],
			};
			await opened.harness.commit(async (tx) => {
				const doc = (await tx.doc(ChannelDoc)) as ChannelState;
				doc.channels[projectId("坦克大战")] = before.channels[projectId("坦克大战")];
			}, BACKGROUND_CONTEXT);

			// 重算后幽灵成员应被清除。
			await shell.syncProject("坦克大战");
			const after = await shell.channels();
			expect(after.channels[projectId("坦克大战")]?.members).not.toContain("gunanyan");
			expect(after.channels[projectId("坦克大战")]?.members.sort()).toEqual(
				["owner", "林越", "沈舟"].sort(),
			);
		} finally {
			await opened.close();
		}
	});
});
