/**
 * 多 agent 场景真模型测试（**平时不跑**，故意不叫 `.test.ts`）。
 *
 * `core-live.ts` 验的是「出厂行为」：回话、技能/记忆落盘、招人、上报链。
 * 这里验的是它够不着的多 agent 协作：私聊与群聊不串、多人同时被叫醒、
 * agent 之间互相 @、成员干活时插话、从零建团队、重启续跑。
 *
 * 每个场景每一轮都是**全新临时工作区**：搭建由代码完成（造人、造团队、开私聊），
 * 真实模型只负责被观察的沟通行为。断言分三类：
 * - `mechanism`：投递/频道/落盘是否发生 —— 失败按代码 bug 查；
 * - `behavior`：模型有没有按提示词做 —— 失败按提示词/模型查；
 * - `observation`：只记录，不判定。
 *
 * 用法：
 *
 * ```bash
 * npm run live:scenarios -- --list
 * npm run live:scenarios -- --scenario=dm-routing --rounds=1 --smoke
 * nohup npm run live:scenarios -- --rounds=3 > /tmp/scenarios.log 2>&1 &
 * ```
 *
 * 退出码：有 `ERROR` 或机制门失败 → 1；默认行为门要求 2/3 通过，`--strict` 要求全过。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OWNER, dmId, teamId } from "../src/core/channel/types.ts";
import { listTeams } from "../src/core/team/doc.ts";
import {
	WAIT_MS,
	aggregateRounds,
	captureEvidence,
	createLiveAgent,
	createTeamFixture,
	drainInFlight,
	openDm,
	openLiveWorkspace,
	parseLiveArgs,
	seqBaseline,
	waitForBusy,
	waitForCondition,
	waitForMention,
	waitForReply,
	waitForReplies,
	type Check,
	type CheckKind,
	type LiveWorld,
	type RoundResult,
	type RoundStatus,
	type ScenarioGate,
} from "./live-support.ts";

/** 场景共用：给 check 一个短名。 */
const check = (id: string, title: string, kind: CheckKind, ok: boolean, detail: string): Check => ({
	id,
	title,
	kind,
	ok,
	detail,
});

type Outcome = { readonly checks: readonly Check[]; readonly skipReason?: string };

type Scenario = {
	readonly id: string;
	readonly title: string;
	readonly gate: ScenarioGate;
	readonly cost: "cheap" | "medium" | "expensive";
	run(world: LiveWorld): Promise<Outcome>;
};

/** `--timeout` 覆盖场景里的等待上限（默认与 core-live 一致）。 */
let timeoutMs = WAIT_MS;
const T = (): number => timeoutMs;

// ── S1 私聊插话后结论回任务频道 ────────────────────────────────────────────

const interrupt: Scenario = {
	id: "interrupt",
	title: "成员忙时私聊插话，结论回到任务频道",
	gate: "behavior",
	cost: "expensive",
	async run(world) {
		const lead = await createLiveAgent(world, {
			name: "林越",
			title: "团队管理员",
			manager: world.assistantSlug,
			team: "插话团队",
		});
		await createTeamFixture(world, {
			slug: "插话团队",
			name: "插话团队",
			lead: lead.slug,
			body: "目标：验证插话。\n验收标准：私聊先答，结论回到本频道。\n不做：真的部署。\n进展：刚开始。",
		});
		const member = await createLiveAgent(world, {
			name: "沈舟",
			title: "执行成员",
			manager: lead.slug,
			team: "插话团队",
		});
		const team = teamId("插话团队");
		const dm = await openDm(world, member.slug);

		const task = await world.shell.ownerSay({
			channelId: team,
			text: `@${member.name} 用 run 执行 sleep 25，跑完用一句话汇报完成时间。`,
		});
		const busy = await waitForBusy(world, member.slug, 45_000);
		if (busy === undefined) {
			return {
				skipReason: "没观测到成员忙（模型没接长任务）",
				checks: [
					check("task-delivered", "任务消息投递到成员", "mechanism", task.delivery.delivered.includes(member.slug), task.delivery.delivered.join("、") || "（没人）"),
				],
			};
		}

		const dmAsk = await world.shell.ownerSay({
			channelId: dm,
			text: `@${member.name} 插一句：你手上有几件事？一句话回答，别停下手上的活。`,
		});
		const dmReply = await waitForReply(world.shell, dm, member.slug, dmAsk.seq, T());
		const teamConclusion = await waitForReply(world.shell, team, member.slug, task.seq, T());

		return {
			checks: [
				check("task-delivered", "任务消息投递到成员", "mechanism", task.delivery.delivered.includes(member.slug), task.delivery.delivered.join("、") || "（没人）"),
				check("dm-delivered", "插话投递到成员", "mechanism", dmAsk.delivery.delivered.includes(member.slug), dmAsk.delivery.delivered.join("、") || "（没人）"),
				check("dm-replied", "私聊里有回答", "behavior", dmReply !== undefined, dmReply?.text.slice(0, 120) ?? "超时无回话"),
				check("task-conclusion", "任务频道随后有结论", "behavior", teamConclusion !== undefined, teamConclusion?.text.slice(0, 120) ?? "超时无结论"),
				check("not-only-dm", "结论没有只落在私聊", "behavior", teamConclusion !== undefined, teamConclusion === undefined ? "团队频道没有成员的任何消息" : "团队频道有结论"),
			],
		};
	},
};

// ── S2 私聊问私聊答 / 群里问群里答 ──────────────────────────────────────────

const dmRouting: Scenario = {
	id: "dm-routing",
	title: "私聊问私聊答、群里问群里答，不串频道",
	gate: "hard",
	cost: "cheap",
	async run(world) {
		const assistant = world.assistantSlug;
		const dm = await openDm(world, assistant);
		const dmChannel = (await world.shell.channels()).channels[dm];

		// seq 是**每个频道各数各的**，跨频道比大小没有意义；用「问之前这个频道有几条」切分。
		const allBeforeDm = ((await world.shell.channels()).messages["all"] ?? []).length;
		const dmAsk = await world.shell.ownerSay({ channelId: dm, text: `@${assistant} 只用一句话说你的名字。` });
		const dmReply = await waitForReply(world.shell, dm, assistant, dmAsk.seq, T());
		const dmAt = (await world.shell.channels()).messages[dm] ?? [];
		const leakedToAll = ((await world.shell.channels()).messages["all"] ?? []).slice(allBeforeDm);

		const dmBeforeAll = ((await world.shell.channels()).messages[dm] ?? []).length;
		const allAsk = await world.shell.ownerSay({ channelId: "all", text: `@${assistant} 只用一句话说你现在在哪个频道回答。` });
		const allReply = await waitForReply(world.shell, "all", assistant, allAsk.seq, T());
		const dmAfter = ((await world.shell.channels()).messages[dm] ?? []).slice(dmBeforeAll);

		return {
			checks: [
				check(
					"dm-shape",
					"私聊成员恰为我 + 助理",
					"mechanism",
					dmChannel !== undefined && dmChannel.members.length === 2 && dmChannel.members.includes(OWNER) && dmChannel.members.includes(assistant),
					dmChannel?.members.join("、") ?? "私聊频道不存在",
				),
				check("dm-delivered", "私聊消息投递到助理", "mechanism", dmAsk.delivery.delivered.includes(assistant), dmAsk.delivery.delivered.join("、") || "（没人）"),
				check("all-delivered", "群聊消息投递到助理", "mechanism", allAsk.delivery.delivered.includes(assistant), allAsk.delivery.delivered.join("、") || "（没人）"),
				check("dm-replied", "私聊问题在私聊里回答", "behavior", dmReply !== undefined, dmReply?.text.slice(0, 120) ?? "超时无回话"),
				check("all-replied", "群聊问题在群里回答", "behavior", allReply !== undefined, allReply?.text.slice(0, 120) ?? "超时无回话"),
				check(
					"no-dm-to-all",
					"私聊问题没有答到全员频道",
					"behavior",
					leakedToAll.every((message) => message.from !== assistant),
					leakedToAll.filter((message) => message.from === assistant).map((message) => message.text).join("\n").slice(0, 120) || "没有串频道",
				),
				check(
					"no-all-to-dm",
					"群聊问题没有答进私聊",
					"behavior",
					dmAfter.every((message) => message.from !== assistant),
					dmAfter.filter((message) => message.from === assistant).map((message) => message.text).join("\n").slice(0, 120) || "没有串频道",
				),
				check("dm-seq", "私聊里就是那条回答", "observation", dmAt.some((message) => message.from === assistant && message.seq > dmAsk.seq), dmId(OWNER, assistant)),
			],
		};
	},
};

// ── S3 团队频道多人同时被叫醒 ──────────────────────────────────────────────

const multiWake: Scenario = {
	id: "multi-wake",
	title: "一条消息同时叫醒多人，没被 @ 的人不发言",
	gate: "hard",
	cost: "medium",
	async run(world) {
		const lead = await createLiveAgent(world, {
			name: "林越",
			title: "团队管理员",
			manager: world.assistantSlug,
			team: "多人团队",
		});
		await createTeamFixture(world, {
			slug: "多人团队",
			name: "多人团队",
			lead: lead.slug,
			body: "目标：验证多人同时被叫醒。\n验收标准：各自回答，不重复。\n不做：真的上线。\n进展：刚开始。",
		});
		const first = await createLiveAgent(world, { name: "周砚", title: "前端", manager: lead.slug, team: "多人团队" });
		const second = await createLiveAgent(world, { name: "顾南雁", title: "后端", manager: lead.slug, team: "多人团队" });
		const third = await createLiveAgent(world, { name: "陆知远", title: "测试", manager: lead.slug, team: "多人团队" });
		const team = teamId("多人团队");

		const ask = await world.shell.ownerSay({
			channelId: team,
			text: `@${first.name} @${second.name} 每人用一句话说清你负责什么，不要重复对方的话。`,
		});
		const replies = await waitForReplies(world.shell, team, [first.slug, second.slug], ask.seq, T());
		const channel = (await world.shell.channels()).channels[team];
		const after = (await world.shell.channels()).messages[team] ?? [];
		const thirdSpoke = after.some((message) => message.from === third.slug && message.seq > ask.seq);
		const same = replies.found.size === 2 && new Set([...replies.found.values()].map((message) => message.text.trim())).size === 1;

		return {
			checks: [
				check(
					"team-members",
					"团队频道成员完整",
					"mechanism",
					channel !== undefined && [OWNER, lead.slug, first.slug, second.slug, third.slug].every((slug) => channel.members.includes(slug)),
					channel?.members.join("、") ?? "团队频道不存在",
				),
				check(
					"delivered-two",
					"两人都被投递",
					"mechanism",
					ask.delivery.delivered.includes(first.slug) && ask.delivery.delivered.includes(second.slug),
					ask.delivery.delivered.join("、") || "（没人）",
				),
				check(
					"delivered-lead",
					"团队管理员由 wakeOnAll 叫醒",
					"mechanism",
					ask.delivery.delivered.includes(lead.slug),
					ask.delivery.delivered.join("、") || "（没人）",
				),
				check("first-replied", "成员一在团队频道回答", "behavior", replies.found.has(first.slug), replies.found.get(first.slug)?.text.slice(0, 100) ?? "超时无回话"),
				check("second-replied", "成员二在团队频道回答", "behavior", replies.found.has(second.slug), replies.found.get(second.slug)?.text.slice(0, 100) ?? "超时无回话"),
				check("third-silent", "没被 @ 的人没有发言", "behavior", !thirdSpoke, thirdSpoke ? "第三人发言了" : "没有发言"),
				check("no-duplicate", "两人没有说同一句", "observation", !same, same ? "两人回答完全一样" : "回答不同"),
			],
		};
	},
};

// ── S4 agent 之间互相 @ ────────────────────────────────────────────────────

const agentToAgent: Scenario = {
	id: "agent-to-agent",
	title: "管理员派活给成员、成员回答、管理员汇总",
	gate: "hard",
	cost: "medium",
	async run(world) {
		const lead = await createLiveAgent(world, {
			name: "林越",
			title: "团队管理员",
			manager: world.assistantSlug,
			team: "协作团队",
		});
		await createTeamFixture(world, {
			slug: "协作团队",
			name: "协作团队",
			lead: lead.slug,
			body: "目标：验证 agent 之间互相 @。\n验收标准：派活、回答、汇总闭环。\n不做：越级找我。\n进展：刚开始。",
		});
		const member = await createLiveAgent(world, { name: "沈舟", title: "前端", manager: lead.slug, team: "协作团队" });
		const team = teamId("协作团队");
		const baseline = await seqBaseline(world.shell);

		const ask = await world.shell.ownerSay({
			channelId: team,
			text: `@${lead.name} 派给${member.name}一件事：用一句话汇报他负责的事。你确认后汇总给助理，不要替他答。`,
		});
		const hop = await waitForMention(world.shell, baseline, lead.slug, member.slug, T());
		const memberReply = hop.hit === undefined ? undefined : await waitForReply(world.shell, team, member.slug, hop.hit.seq, T());
		const summary = await waitForCondition(async () => {
			const list = (await world.shell.channels()).messages[team] ?? [];
			return list.find((message) => message.from === lead.slug && message.seq > (memberReply?.seq ?? hop.hit?.seq ?? ask.seq));
		}, T());
		const leadMessages = ((await world.shell.channels()).messages[team] ?? []).filter(
			(message) => message.from === lead.slug && message.seq > ask.seq,
		);

		return {
			checks: [
				check("lead-delivered", "管理员被投递", "mechanism", ask.delivery.delivered.includes(lead.slug), ask.delivery.delivered.join("、") || "（没人）"),
				check("lead-mentions-member", "管理员 @ 了成员", "behavior", hop.hit !== undefined, hop.hit?.text.slice(0, 120) ?? "管理员没有 @ 成员"),
				check("member-replied", "成员在团队频道回答", "behavior", memberReply !== undefined, memberReply?.text.slice(0, 120) ?? "超时无回话"),
				check("lead-summary", "管理员在成员回答后汇总", "behavior", summary !== undefined, summary?.text.slice(0, 120) ?? "没有汇总"),
				check(
					"no-jump",
					"过程没有越级 @ 我",
					"behavior",
					leadMessages.every((message) => !message.mentions.includes(OWNER)),
					leadMessages.find((message) => message.mentions.includes(OWNER))?.text.slice(0, 100) ?? "没有越级",
				),
			],
		};
	},
};

// ── S5 从零建团队（建立团队技能）───────────────────────────────────────────

const buildTeam: Scenario = {
	id: "build-team",
	title: "从零建团队：README、lead、成员的 team、频道投影",
	gate: "behavior",
	cost: "expensive",
	async run(world) {
		const assistant = world.assistantSlug;
		const dm = await openDm(world, assistant);
		const before = new Set((await listTeams(world.teamsRoot)).map((team) => team.slug));

		const ask = await world.shell.ownerSay({
			channelId: dm,
			text: "帮我建一个新团队，做发布检查：会持续两周、需要两个人、有独立的验收标准。找好团队管理员和执行成员，建完在私聊里一句话告诉我。",
		});
		// 判据是「他说建完了」，不是「README 出现了」：README 可能先写一版、再补 frontmatter，
		// 中间态没有 lead、频道也还没投影。在他回话之前下结论，测到的是半成品。
		const announcement = await waitForReply(world.shell, dm, assistant, ask.seq, T());
		const created = await waitForCondition(async () => {
			const teams = await listTeams(world.teamsRoot);
			return teams.find((team) => !before.has(team.slug));
		}, 15_000, 1_000);

		if (created === undefined) {
			return {
				checks: [
					check("team-created", "出现了新的团队文件", "behavior", false, "回话后仍没有 teams/<slug>/README.md"),
					check("dm-announced", "在私聊里宣告", "behavior", announcement !== undefined, announcement?.text.slice(0, 120) ?? "私聊里没有新消息"),
				],
			};
		}

		// 只读：不调用 rescan/syncTeam，验证「写 README + hire」本身就把频道投影出来了。
		const channel = (await world.shell.channels()).channels[teamId(created.slug)];
		const identities = await world.shell.identities();
		const members = identities.filter((identity) => identity.team === created.slug);
		const allMembersProjected = members.every((identity) => channel?.members.includes(identity.slug));

		return {
			checks: [
				check("team-created", "出现了新的团队文件", "behavior", true, `teams/${created.slug}/README.md`),
				check(
					"team-channel",
					"团队频道已投影（脚本没有 rescan/syncTeam）",
					"mechanism",
					channel !== undefined && channel.members.includes(OWNER) && allMembersProjected,
					channel === undefined ? "团队频道不存在" : `成员 ${channel.members.join("、")}；team=${created.slug} 的人 ${members.map((identity) => identity.slug).join("、") || "（无）"}`,
				),
				check(
					"lead-valid",
					"lead 是名册里的人，且不是助理自己",
					"behavior",
					created.lead !== undefined && created.lead !== "" && created.lead !== assistant && identities.some((identity) => identity.slug === created.lead),
					created.lead ?? "没写 lead",
				),
				check(
					"member-in-team",
					"至少一名执行成员的 team 指向新团队",
					"behavior",
					members.length >= 1,
					members.map((identity) => identity.slug).join("、") || "没有成员",
				),
				check(
					"two-people",
					"至少建出管理员 + 一名执行成员",
					"behavior",
					identities.length >= 3,
					`名册 ${identities.map((identity) => identity.slug).join("、")}`,
				),
				check("dm-announced", "在私聊里向我宣告", "behavior", announcement !== undefined, announcement?.text.slice(0, 120) ?? "私聊里没有新消息"),
				check("readme-body", "README 正文有验收标准", "observation", created.body.includes("验收"), created.body.slice(0, 100)),
			],
		};
	},
};

// ── S6 重启续跑 ────────────────────────────────────────────────────────────

const restart: Scenario = {
	id: "restart",
	title: "重启后续跑：会话复用、历史不丢、代号记得住",
	gate: "hard",
	cost: "cheap",
	async run(world) {
		const assistant = world.assistantSlug;
		const ask = await world.shell.ownerSay({
			channelId: "all",
			text: `@${assistant} 记住这个代号：蓝鲸-42，只用一句话确认。`,
		});
		const firstReply = await waitForReply(world.shell, "all", assistant, ask.seq, T());
		const beforeChannels = await world.shell.channels();
		const beforeIds = await world.shell.identities();
		const beforeConversation = world.shell.conversations.get(assistant)?.id;

		await drainInFlight(world.runtime.harness, 20_000);
		await world.restart();

		const afterChannels = await world.shell.channels();
		const afterIds = await world.shell.identities();
		const afterConversation = world.shell.conversations.get(assistant)?.id;
		const oldList = beforeChannels.messages["all"] ?? [];
		const newList = afterChannels.messages["all"] ?? [];
		const kept = oldList.every((message) => newList.some((item) => item.seq === message.seq && item.text === message.text));

		const askAgain = await world.shell.ownerSay({ channelId: "all", text: `@${assistant} 刚才的代号是什么？只回答代号。` });
		const secondReply = await waitForReply(world.shell, "all", assistant, askAgain.seq, T());

		return {
			checks: [
				check("first-reply", "重启前有回话并确认", "behavior", firstReply !== undefined, firstReply?.text.slice(0, 100) ?? "超时无回话"),
				check(
					"conversation-reused",
					"重启后复用同一个会话",
					"mechanism",
					beforeConversation !== undefined && String(afterConversation) === String(beforeConversation),
					`${String(beforeConversation)} → ${String(afterConversation)}`,
				),
				check("history-kept", "重启前频道消息一条不少", "mechanism", kept && newList.length >= oldList.length, `${oldList.length} → ${newList.length}`),
				check(
					"no-duplicate-agent",
					"重启没有重复建人",
					"mechanism",
					afterIds.length === beforeIds.length,
					`${beforeIds.length} → ${afterIds.length}`,
				),
				check(
					"memory-survives",
					"重启后仍记得代号",
					"behavior",
					secondReply !== undefined && secondReply.text.includes("蓝鲸-42"),
					secondReply?.text.slice(0, 120) ?? "超时无回话",
				),
				check("second-delivered", "重启后消息能正常投递", "mechanism", askAgain.delivery.delivered.includes(assistant), askAgain.delivery.delivered.join("、") || "（没人）"),
			],
		};
	},
};

const SCENARIOS: readonly Scenario[] = [dmRouting, restart, multiWake, agentToAgent, interrupt, buildTeam];

// ── 运行器 ────────────────────────────────────────────────────────────────

function stamp(): string {
	return new Date().toISOString().replace(/[:.]/g, "-");
}

function statusOf(outcome: Outcome): RoundStatus {
	if (outcome.skipReason !== undefined) return "SKIP";
	const mechanisms = outcome.checks.filter((item) => item.kind === "mechanism");
	const behaviors = outcome.checks.filter((item) => item.kind === "behavior");
	if (mechanisms.some((item) => !item.ok)) return "FAIL";
	if (behaviors.some((item) => !item.ok)) return "PARTIAL";
	return "PASS";
}

function summaryOf(result: RoundResult): string {
	const failed = result.checks.filter((item) => !item.ok && item.kind !== "observation");
	if (result.status === "SKIP") return result.skipReason ?? "跳过";
	if (failed.length === 0) return "全部检查通过";
	return failed.map((item) => `${item.title}：${item.detail}`).join("；");
}

function renderReport(
	results: readonly RoundResult[],
	aggregate: ReturnType<typeof aggregateRounds>,
	selected: readonly Scenario[],
	model: string,
	reportDir: string,
): string {
	const lines = ["# 场景测试报告", "", `- 模型：${model}`, `- 证据目录：${reportDir}`, ""];
	lines.push("| 场景 | 轮次（按轮序） | PASS | PARTIAL | FAIL | ERROR | SKIP | 通过率 | 判定 |");
	lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
	for (const row of aggregate.rows) {
		const scenario = selected.find((item) => item.id === row.id);
		const rounds = results
			.filter((result) => result.scenarioId === row.id)
			.sort((left, right) => left.round - right.round)
			.map((result) => result.status.slice(0, 4))
			.join(" / ");
		lines.push(
			`| ${scenario?.title ?? row.id} | ${rounds} | ${row.rounds.PASS} | ${row.rounds.PARTIAL} | ${row.rounds.FAIL} | ${row.rounds.ERROR} | ${row.rounds.SKIP} | ${Math.round(row.passRate * 100)}% | ${row.ok ? "过" : row.coverageGap ? "覆盖缺口" : "不过"} |`,
		);
		if (row.reason !== "") lines.push(`| | ${row.reason} | | | | | | | |`);
	}
	lines.push("", "## 逐轮详情", "");
	for (const result of results) {
		lines.push(`### ${result.scenarioId} 第 ${result.round} 轮 — ${result.status}（${Math.round(result.durationMs / 1000)}s）`);
		if (result.error !== undefined) lines.push("", `脚本异常：${result.error}`);
		if (result.skipReason !== undefined) lines.push("", `跳过：${result.skipReason}`);
		if (result.evidencePath !== undefined) lines.push("", `证据：${result.evidencePath}`);
		lines.push("");
		for (const item of result.checks) {
			const mark = item.kind === "observation" ? "·" : item.ok ? "✓" : "✗";
			lines.push(`- ${mark} [${item.kind}] ${item.title} — ${item.detail}`);
		}
		lines.push("");
	}
	return lines.join("\n");
}

let active: LiveWorld | undefined;

async function main(): Promise<void> {
	const args = parseLiveArgs(process.argv.slice(2));
	timeoutMs = args.timeoutMs ?? WAIT_MS;
	const selected = args.scenarios === undefined ? SCENARIOS : SCENARIOS.filter((scenario) => args.scenarios?.includes(scenario.id));
	if (args.scenarios !== undefined) {
		const missing = args.scenarios.filter((id) => !SCENARIOS.some((scenario) => scenario.id === id));
		if (missing.length > 0) throw new Error(`没有这些场景：${missing.join("、")}（用 --list 看全部）`);
	}
	if (args.list) {
		for (const scenario of SCENARIOS) {
			console.log(`${scenario.id.padEnd(14)} ${scenario.gate.padEnd(8)} ${scenario.cost.padEnd(10)} ${scenario.title}`);
		}
		return;
	}

	const reportDir = args.out ?? join(tmpdir(), `solo-scenarios-${stamp()}`);
	await mkdir(reportDir, { recursive: true });
	const results: RoundResult[] = [];
	let modelLabel = "（未知）";

	for (const scenario of selected) {
		for (let round = 1; round <= args.rounds; round += 1) {
			console.log(`\n── ${scenario.id} 第 ${round}/${args.rounds} 轮 ──`);
			const startedAt = Date.now();
			let world: LiveWorld | undefined;
			let outcome: Outcome = { checks: [] };
			let error: string | undefined;
			try {
				world = await openLiveWorkspace({
					prefix: `solo-scn-${scenario.id}-`,
					...(args.settings === undefined ? {} : { settings: args.settings }),
				});
				active = world;
				modelLabel = `${world.model.provider}/${world.model.modelId}`;
				outcome = await scenario.run(world);
			} catch (caught) {
				error = caught instanceof Error ? `${caught.message}\n${caught.stack ?? ""}` : String(caught);
				outcome = { checks: [check("error", "场景脚本没有跑完", "mechanism", false, error)] };
			}
			const status: RoundStatus = error === undefined ? statusOf(outcome) : "ERROR";
			const durationMs = Date.now() - startedAt;
			const provisional: RoundResult = {
				scenarioId: scenario.id,
				round,
				status,
				checks: outcome.checks,
				durationMs,
				...(error === undefined ? {} : { error }),
				...(outcome.skipReason === undefined ? {} : { skipReason: outcome.skipReason }),
			};
			console.log(`${status}  ${summaryOf(provisional)}`);
			let evidencePath: string | undefined;
			if (world !== undefined) {
				// 收尾的沉淀/补发也是这一轮的产物：先让它们落地再截图，否则证据里只有半轮。
				await drainInFlight(world.runtime.harness, 15_000).catch(() => undefined);
				try {
					evidencePath = await captureEvidence({
						scenario: scenario.id,
						round,
						outDir: reportDir,
						world,
						checks: outcome.checks,
						...(error === undefined ? {} : { error }),
					});
				} catch (caught) {
					console.warn(`证据落盘失败：${caught instanceof Error ? caught.message : String(caught)}`);
				}
				await world.close();
				const keep = args.keep || (args.keepFailed && (status === "FAIL" || status === "ERROR" || status === "PARTIAL"));
				if (keep) console.log(`工作区保留：${world.root}`);
				else await world.remove();
				active = undefined;
			}
			results.push({ ...provisional, ...(evidencePath === undefined ? {} : { evidencePath }) });
		}
	}

	const aggregate = aggregateRounds(results, selected.map((scenario) => ({ id: scenario.id, gate: scenario.gate })), {
		strict: args.strict,
		smoke: args.smoke,
	});
	console.log("\n──── 汇总 ────");
	for (const row of aggregate.rows) {
		const scenario = selected.find((item) => item.id === row.id);
		const counts = `PASS ${row.rounds.PASS} / PARTIAL ${row.rounds.PARTIAL} / FAIL ${row.rounds.FAIL} / ERROR ${row.rounds.ERROR} / SKIP ${row.rounds.SKIP}`;
		console.log(`${row.ok ? "✓" : row.coverageGap ? "–" : "✗"} ${scenario?.title ?? row.id}：${counts}（通过率 ${Math.round(row.passRate * 100)}%）${row.reason === "" ? "" : ` —— ${row.reason}`}`);
	}
	await writeFile(join(reportDir, "report.md"), renderReport(results, aggregate, selected, modelLabel, reportDir), "utf8");
	await writeFile(join(reportDir, "report.json"), JSON.stringify({ args, model: modelLabel, results, aggregate }, null, 2), "utf8");
	console.log(`\n报告：${join(reportDir, "report.md")}`);
	process.exitCode = aggregate.exitCode;
}

process.on("SIGINT", () => {
	void (async () => {
		await active?.close().catch(() => undefined);
		await active?.remove().catch(() => undefined);
		process.exit(130);
	})();
});

await main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.stack ?? error.message : String(error));
	process.exitCode = 1;
});
