/**
 * 真实调模型的端到端实测（**平时不跑**，故意不叫 `.test.ts`）。
 *
 * 为什么单独一份：
 * - `npm test` 不该依赖外部网关。模型不可用时，一场「本机能不能跑通」的测试会
 *   红一片，把真正的逻辑错埋掉；而模型错的表现恰好是「什么都没发生」，最容易
 *   被误当成逻辑错去改代码。
 * - 它要验的东西逻辑单测验不了：技能/团队文件改完之后，**下一条消息**是否真的
 *   出现在提示词里；招来的人被 @ 之后是否真的回话。
 *
 * 用法（需要真实网关）：
 *
 * ```bash
 * node --experimental-strip-types scripts/core-live.ts
 * ```
 *
 * 直接跑 `main()` 会：建临时工作区 → 播种助理 → 我 @ 助理 → 等回话 → 检查
 * 技能与团队是否有落盘生效。全程打印到 stdout，失败不抛（输出就是判据）。
 */
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WAIT_MS = 240_000;

type Phase = { readonly name: string; readonly ok: boolean; readonly detail: string };

function log(phase: Phase): void {
	const mark = phase.ok ? "✓" : "✗";
	console.log(`${mark} ${phase.name}${phase.detail === "" ? "" : ` — ${phase.detail}`}`);
}

/** 轮询频道，直到出现某个人发的消息（不是我发的）。 */
async function waitForReply(
	shell: Awaited<ReturnType<typeof import("../src/core/shell/assemble.ts").assembleCore>>,
	channelId: string,
	fromSlug: string,
	afterSeq: number,
	timeoutMs: number,
): Promise<{ readonly seq: number; readonly text: string } | undefined> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const state = await shell.channels();
		const list = state.messages[channelId] ?? [];
		const hit = list.find((message) => message.seq > afterSeq && message.from === fromSlug);
		if (hit !== undefined) return { seq: hit.seq, text: hit.text };
		await new Promise((resolve) => setTimeout(resolve, 1_000));
	}
	return undefined;
}

async function main(): Promise<void> {
	const { createRegistry, setupModels } = await import("../src/core/runtime/index.ts");
	const { openCore } = await import("../src/core/runtime/open.ts");
	const { assembleCore } = await import("../src/core/shell/assemble.ts");
	const { seedOwnerAssistant, seedPromptTemplates, seedRules } = await import("../src/core/shell/seed.ts");

	const root = await mkdtemp(join(tmpdir(), "core-live-"));
	const agentsRoot = join(root, "agents");
	const teamsRoot = join(root, "teams");
	await mkdir(agentsRoot, { recursive: true });
	await mkdir(teamsRoot, { recursive: true });
	console.log(`工作区：${root}`);

	// 和 `main.ts` 启动时同一套播种：规矩、模板、公司层技能、助理身份。
	// 少了 `prompt/`，V3 的提示词渲染出来是空的 —— 那正是「单测全绿、模型收到半句话」。
	await seedRules(root);
	await seedPromptTemplates(root);
	const slug = await seedOwnerAssistant(agentsRoot, { name: "助理" });
	console.log(`播种：agents/${slug}`);

	const configured = setupModels(process.env, { workspace: root });
	const runtime = await openCore({
		databasePath: join(root, "core.sqlite"),
		models: configured.models,
		registry: createRegistry(),
	});
	const picked = configured.defaultModel;
	if (picked === undefined) throw new Error("没有可用模型：先在工作区写 settings.json");
	console.log(`模型：${picked.provider}/${picked.modelId}`);

	const shell = await assembleCore(runtime.harness, runtime.registry, {
		agentsRoot,
		teamsRoot,
		defaultModel: picked,
	});

	// 把**真模型收到的** system prompt 打出来：单测全绿、模型收到半句话，是提示词外置
	// 最典型的翻车方式，光看段数和字符数看不出来。
	{
		const { renderAgentSection } = await import("../src/core/agent/runtime.ts");
		const prompt = await renderAgentSection(
			runtime.registry,
			{ workspace: root, agents: agentsRoot, teams: teamsRoot, chats: async () => [] },
			slug,
		);
		console.log(`\n──── system prompt（前 40 行 / 共 ${prompt.split("\n").length} 行）────`);
		console.log(prompt.split("\n").slice(0, 40).join("\n"));
		console.log("──── 以上是模型真收到的 ────\n");

		// delivery 段同样贴出来：它在同步/异步交接处，单测测的是函数、不是链路。
		const { renderReplyRules } = await import("../src/core/channel/deliver.ts");
		const { loadTemplates, promptDirOf } = await import("../src/core/prompt.ts");
		const { createFsx } = await import("../src/core/fsx.ts");
		const delivery = (await loadTemplates(createFsx(promptDirOf(agentsRoot)), ".")).filter(
			(item) => item.use === "delivery",
		);
		const bodyOf = (segment: string): string => delivery.find((item) => item.segment === segment)?.body ?? "";
		console.log("──── delivery：只有我跟他两个人时 ────");
		console.log(renderReplyRules({ template: bodyOf("reply"), woken: [slug], viewer: slug, colleagues: [] }));
		console.log("──── delivery：插话那一段 ────");
		console.log(bodyOf("interrupted"));
		console.log("──── 以上是每轮贴在投递正文末尾的 ────\n");
	}


	const phases: Phase[] = [];

	// 1. 我 @ 助理，等它开口。
	const asked = await shell.ownerSay({ channelId: "all", text: `@${slug} 你在吗？用一句话回答。` });
	console.log(`已投递 #${asked.seq}，唤醒 ${asked.delivery.delivered.join(",") || "（没人）"}`);
	const reply = await waitForReply(shell, "all", slug, asked.seq, WAIT_MS);
	phases.push({ name: "被 @ 会回话", ok: reply !== undefined, detail: reply?.text.slice(0, 80) ?? "超时无回话" });

	// 2. 技能是否出现在提示词里（读的是同一份 render 结果）。
	await mkdir(join(agentsRoot, slug, "skills", "自测技能"), { recursive: true });
	await (await import("node:fs/promises")).writeFile(
		join(agentsRoot, slug, "skills", "自测技能", "SKILL.md"),
		"---\nname: 自测技能\ndescription: 这是实测写入的技能\n---\n\n正文。\n",
		"utf8",
	);
	const skillAsked = await shell.ownerSay({ channelId: "all", text: `@${slug} 你有哪些技能？只列名字。` });
	const skillReply = await waitForReply(shell, "all", slug, skillAsked.seq, WAIT_MS);
	phases.push({
		name: "技能热更新生效（不需要重启）",
		ok: skillReply !== undefined && skillReply.text.includes("自测技能"),
		detail: skillReply?.text.slice(0, 120) ?? "超时无回话",
	});

	// 3. 团队说明是否进入团队成员的提示词。
	await mkdir(join(teamsRoot, "自测团队"), { recursive: true });
	await (await import("node:fs/promises")).writeFile(
		join(teamsRoot, "自测团队", "README.md"),
		"---\nname: 自测团队\nlead: " + slug + "\nstatus: active\n---\n\n目标：验证团队说明会进提示词。\n",
		"utf8",
	);
	const identityPath = join(agentsRoot, slug, "identity.md");
	const identity = await readFile(identityPath, "utf8");
	await (await import("node:fs/promises")).writeFile(
		identityPath,
		identity.replace(/^---\n([\s\S]*?)\n---/, `---\n$1\nteam: 自测团队\n---`),
		"utf8",
	);
	// 改了 identity.md 之后必须重扫一次：团队频道是在「开会话」时按 `team:` 建的，
	// 不重扫的话这个人永远不在团队频道里（实测踩过：`频道不存在：team:自测团队`）。
	await shell.rescan();
	const teamAsked = await shell.ownerSay({
		channelId: "all",
		text: `@${slug} 你现在在哪个团队里？团队目标是什么？一句话。`,
	});
	const teamReply = await waitForReply(shell, "all", slug, teamAsked.seq, WAIT_MS);
	phases.push({
		name: "团队说明进提示词",
		ok: teamReply !== undefined && teamReply.text.includes("自测团队"),
		detail: teamReply?.text.slice(0, 120) ?? "超时无回话",
	});

	// 4. 记忆：让它记一条，再问它记了什么（提示词里只有目录，正文靠 read_history(scope=memory)）。
	const rememberAsked = await shell.ownerSay({
		channelId: "all",
		text: `@${slug} 用 remember 记一条：「我喜欢结论先行」。记完告诉我。`,
	});
	const rememberReply = await waitForReply(shell, "all", slug, rememberAsked.seq, WAIT_MS);
	const memoryPath = join(agentsRoot, slug, "memory.md");
	const memoryText = await readFile(memoryPath, "utf8").catch(() => "");
	phases.push({
		name: "记忆落盘（remember 真写了文件）",
		ok: rememberReply !== undefined && memoryText.includes("结论先行"),
		detail: memoryText.split("\n").filter(Boolean).slice(-1)[0] ?? "文件里没有",
	});

	const recallAsked = await shell.ownerSay({ channelId: "all", text: `@${slug} 用 read_history(scope=memory) 查一下你关于「结论」的记忆。` });
	const recallReply = await waitForReply(shell, "all", slug, recallAsked.seq, WAIT_MS);
	phases.push({
		name: "记忆能读回（read_history 真读到了）",
		ok: recallReply !== undefined && recallReply.text.includes("结论"),
		detail: recallReply?.text.slice(0, 100) ?? "超时无回话",
	});

	// 5. 公司层技能：让它写一份 scope=company 的技能，检查是否落到工作区根的 skills/。
	const shareAsked = await shell.ownerSay({
		channelId: "all",
		text: `@${slug} 用 skills 写一份公司层技能（action=write, scope=company），名字「自测共享技能」，描述「全公司通用」，正文一句话。写完告诉我。`,
	});
	const shareReply = await waitForReply(shell, "all", slug, shareAsked.seq, WAIT_MS);
	const sharedPath = join(root, "skills", "自测共享技能", "SKILL.md");
	const sharedText = await readFile(sharedPath, "utf8").catch(() => "");
	phases.push({
		name: "技能共享（公司层真的写到了工作区根）",
		ok: shareReply !== undefined && sharedText.includes("全公司通用"),
		detail: sharedText === "" ? "工作区根没有 skills/自测共享技能/SKILL.md" : sharedText.split("\n")[2] ?? "",
	});

	// 6. 团队记忆：让它记一条团队级的事，检查是否落到 teams/<slug>/memory.md。
	const teamMemoryAsked = await shell.ownerSay({
		channelId: "all",
		text: `@${slug} 用 remember(scope=team) 记一条团队级的事：「这个团队第一次跑通了」。记完告诉我。`,
	});
	const teamMemoryReply = await waitForReply(shell, "all", slug, teamMemoryAsked.seq, WAIT_MS);
	const teamMemoryText = await readFile(join(teamsRoot, "自测团队", "memory.md"), "utf8").catch(() => "");
	phases.push({
		name: "团队记忆落盘（teams/<slug>/memory.md）",
		ok: teamMemoryReply !== undefined && teamMemoryText.includes("第一次跑通"),
		detail: teamMemoryText.split("\n").filter(Boolean).slice(-1)[0] ?? "文件里没有",
	});

	// 7. 团队记忆的自动沉淀：让助理在团队频道里拍一次板（kind=decision），
	//    检查 `teams/自测团队/memory.md` 是否被自动写入了内容 —— 这条路上
	//    agent 没有被明确要求「去记一条」，它只收到「请判断这件事值不值得沉淀」。
	const settleAsked = await shell.ownerSay({
		channelId: `team:自测团队`,
		text: "定了：这个团队的验收标准是「能跑通 core:live 全部 12 项」。",
		kind: "decision",
	});
	console.log(`团队频道已投递 #${settleAsked.seq}（kind=decision）`);
	const memoryBefore = await readFile(join(teamsRoot, "自测团队", "memory.md"), "utf8").catch(() => "");
	let settled = "";
	const deadline = Date.now() + WAIT_MS;
	while (Date.now() < deadline && settled === "") {
		const now = await readFile(join(teamsRoot, "自测团队", "memory.md"), "utf8").catch(() => "");
		if (now !== memoryBefore) settled = now;
		await new Promise((resolve) => setTimeout(resolve, 1_000));
	}
	// 失败时要看得见助理到底说了什么：它说「没有需要沉淀的」是判断问题，它什么都没说
	// 就是唤醒被吞了 —— 两者修法完全不同。
	if (settled === "") {
		const state = await shell.channels();
		const tail = (state.messages["team:自测团队"] ?? []).slice(-4);
		console.log("[debug] 团队频道最后几条：");
		for (const message of tail) console.log(`  #${message.seq} ${message.from}（${message.kind ?? "-"}）：${message.text.slice(0, 120)}`);
	}
	phases.push({
		name: "团队记忆自动沉淀（拍板后被叫去沉淀并落盘）",
		ok: settled.includes("验收标准"),
		detail: settled === "" ? "memory.md 没变化（没人去沉淀，或沉淀了但没写这一条）" : settled.split("\n").filter(Boolean).slice(-1)[0] ?? "",
	});

	// 8. 招人：名字要像真人，且新人自动进公司群、进得了团队频道。
	//
	// 这是「模型有没有遵守我们写下的规矩」的唯一验证口径 —— 名字、频道、汇报线三件
	// 事都只写在技能与提示词里，代码只负责记录结果。如果不验这一段，规矩写错了不会
	// 有任何反馈，只会在用起来的那天变成「@前端工程师」这种叫座位的话。
	const hireAsked = await shell.ownerSay({
		channelId: "all",
		text: `@${slug} 招一个人进「自测团队」做前端，负责团队频道的界面。用 hire 建，名字用真人的名字（姓+名）。建完告诉我他叫什么。`,
	});
	// 等「人真的建出来了」，不等某一条回话。回话可能串到别的频道去（它答的是上一个
	// 问题），按消息判断会把「没招人」误判成「招了人」，再让后面的断言全部失真。
	const { readAllIdentities } = await import("../src/core/agent/identity.ts");
	const hireDeadline = Date.now() + WAIT_MS;
	let all = await readAllIdentities(agentsRoot);
	let hired = all.find((identity) => identity.slug !== slug);
	while (Date.now() < hireDeadline && hired === undefined) {
		await new Promise((resolve) => setTimeout(resolve, 1_000));
		all = await readAllIdentities(agentsRoot);
		hired = all.find((identity) => identity.slug !== slug);
	}
	const companyAfterHire = (await shell.channels()).messages["all"] ?? [];
	const hireReply = companyAfterHire.filter((message) => message.seq > hireAsked.seq && message.from === slug).at(-1);
	// 「像真人的名字」：长度 2–4、不含岗位词、不含英文字母。判断放宽一点，只拦明显的违规。
	const JOB_WORDS = ["工程师", "负责人", "经理", "总监", "专员", "助理", "主管", "前端", "后端", "设计", "测试"];
	const looksLikeName =
		hired !== undefined &&
		hired.name !== undefined &&
		hired.name.length >= 2 &&
		hired.name.length <= 4 &&
		!/[A-Za-z0-9]/.test(hired.name) &&
		!JOB_WORDS.some((word) => hired.name?.includes(word) === true);
	// 「名字」只看建出来的那个人，不看它有没有回话：回话可能串到别的频道，
	// 而这一条要验的是命名纪律，不是汇报纪律。
	phases.push({
		name: "招来的人有像真人的名字",
		ok: looksLikeName,
		detail:
			hired === undefined
				? `没有招到人；对方回的是：${hireReply?.text.slice(0, 120) ?? "（超时没回话）"}`
				: `${hired.name}（title: ${hired.title ?? "无"}）`,
	});

	if (hired !== undefined) {
		const state = await shell.channels();
		// 新人自动进公司群（否则没人 @ 得到他）；但**没有**私聊 —— 私聊只能我开。
		const allChannel = state.channels["all"];
		const personal = state.channels[`dm:owner-${hired.slug}`];
		phases.push({
			name: "新人自动进公司群，且没有凭空建出的私聊",
			ok: allChannel !== undefined && allChannel.members.includes(hired.slug) && personal === undefined,
			detail:
				allChannel === undefined
					? "没有公司群"
					: `公司群成员 ${allChannel.members.join("、")}${personal === undefined ? "；没有私聊" : "；居然有私聊"}`,
		});
		// 团队频道里有团队管理员（README.md 的 owner）+ 新人。
		const team = state.channels["team:自测团队"];
		const owner = all.find((identity) => identity.slug === slug)?.slug;
		phases.push({
			name: "团队频道里有团队管理员和新人",
			ok:
				team !== undefined &&
				team.members.includes(hired.slug) &&
				(owner === undefined || team.members.includes(owner)),
			detail: team === undefined ? "没有团队频道" : `成员 ${team.members.join("、")}`,
		});
		// 拍板链写在公司技能「工作规矩」里（规则外移到技能，不进提示词正文），
		// 所以验的是「新人拿得到这条规则」：技能被列进提示词 + 正文里有不跳级。
		const prompt = await shell.promptOf(hired.slug);
		const rules = await readFile(join(root, "skills", "工作规矩", "SKILL.md"), "utf8").catch(() => "");
		const listed = prompt.includes("工作规矩");
		phases.push({
			name: "新人拿得到拍板链（公司技能「工作规矩」）",
			ok: listed && rules.includes("绝不跳级"),
			detail: listed
				? rules.includes("绝不跳级")
					? "工作规矩已列进提示词，正文含「绝不跳级」"
					: "技能正文里没有「绝不跳级」"
				: "提示词里没列出「工作规矩」技能",
		});
	}

	for (const phase of phases) log(phase);
	await runtime.close().catch(() => undefined);
	await shell.close().catch(() => undefined);
	const failed = phases.filter((phase) => !phase.ok);
	console.log(`\n${phases.length - failed.length}/${phases.length} 通过`);
	await rm(root, { recursive: true, force: true }).catch(() => undefined);
	if (failed.length > 0) process.exitCode = 1;
}

await main();
