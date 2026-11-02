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
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OWNER, dmId } from "../src/core/channel/types.ts";
import {
	WAIT_MS,
	setupLiveModels,
	hopDetail,
	log,
	seqBaseline,
	settleDetail,
	waitForMention,
	waitForReply,
	waitForSettle,
	waitForSubmission,
	wakeDetail,
	type Phase,
} from "./live-support.ts";

async function main(): Promise<void> {
	// ── 收尾计数（ADR-099，取代 ADR-089 c 的 rescue 趋势）────────────────────
	// `[turn]` = 模型把结论写在正文里、一次 `say` 都没调，结算后由收尾补发。
	// 它不是验收门（测的是「模型这一轮选不选工具」，不是系统对不对），但「多少回话
	// 走了收尾」是有用的趋势信号：超过一半就说明提示词在退化。
	let turnPosted = 0;
	let turnFailed = 0;
	const passLog = console.log.bind(console);
	const passWarn = console.warn.bind(console);
	console.log = (...args: unknown[]) => {
		if (args.some((arg) => String(arg).includes("[turn]"))) turnPosted += 1;
		passLog(...args);
	};
	console.warn = (...args: unknown[]) => {
		if (args.some((arg) => String(arg).includes("[turn]"))) turnFailed += 1;
		passWarn(...args);
	};
	const { BACKGROUND_CONTEXT, createRegistry } = await import("../src/core/runtime/index.ts");
	const { openCore } = await import("../src/core/runtime/open.ts");
	const { resolveLayout } = await import("../src/core/layout.ts");
	const { assembleCore } = await import("../src/shell/assemble.ts");
	const { seedOwnerAssistant, seedPromptTemplates, seedRules, seedTextFiles } = await import("../src/shell/seed.ts");

	const root = await mkdtemp(join(tmpdir(), "core-live-"));
	// 应用私有的东西（助理、提示词、库、设置）落在 `.app/`，组织落在临时根里。
	const layout = resolveLayout({ appRoot: join(root, ".app"), userRoot: root });
	const agentsRoot = layout.membersRoot;
	const teamsRoot = layout.teamsRoot;
	await mkdir(layout.assistantRoot, { recursive: true });
	await mkdir(agentsRoot, { recursive: true });
	await mkdir(teamsRoot, { recursive: true });
	console.log(`工作区：${root}`);

	// 和 `main.ts` 启动时同一套播种：规矩、模板、全员层技能、助理身份。
	// 少了 `prompt/`，V3 的提示词渲染出来是空的 —— 那正是「单测全绿、模型收到半句话」。
	await seedRules(layout);
	await seedPromptTemplates(layout);
	await seedTextFiles(layout);
	const slug = await seedOwnerAssistant(layout, { name: "助理" });
	const assistantDir = join(layout.assistantRoot, slug);
	console.log(`播种：assistant/${slug}`);

	const configured = await setupLiveModels(layout.settingsFile);
	const runtime = await openCore({
		databasePath: layout.databasePath,
		models: configured.models,
		registry: createRegistry(),
	});
	const picked = configured.defaultModel;
	if (picked === undefined) throw new Error("没有可用模型：先在工作区写 settings.json");
	console.log(`模型：${picked.provider}/${picked.modelId}`);

	const shell = await assembleCore(runtime.harness, runtime.registry, {
		layout,
		defaultModel: picked,
	});

	// 把**真模型收到的** system prompt 打出来：单测全绿、模型收到半句话，是提示词外置
	// 最典型的翻车方式，光看段数和字符数看不出来。
	{
		const { renderAgentSection } = await import("../src/core/agent/sections.ts");
		const prompt = await renderAgentSection(
			runtime.registry,
			{ layout, chats: async () => [] },
			slug,
		);
		console.log(`\n──── system prompt（前 40 行 / 共 ${prompt.split("\n").length} 行）────`);
		console.log(prompt.split("\n").slice(0, 40).join("\n"));
		console.log("──── 以上是模型真收到的 ────\n");

		// delivery 段同样贴出来：它在同步/异步交接处，单测测的是函数、不是链路。
		const { renderReplyRules } = await import("../src/core/channel/delivery.ts");
		const { loadTemplates } = await import("../src/core/md/prompt.ts");
		const { createFsx } = await import("../src/core/fsx.ts");
		const delivery = (await loadTemplates(createFsx(layout.promptRoot), ".")).filter(
			(item) => item.use === "delivery",
		);
		const bodyOf = (segment: string): string => delivery.find((item) => item.segment === segment)?.body ?? "";
		console.log("──── delivery：只有我跟他两个人时 ────");
		console.log(
			renderReplyRules({
				template: bodyOf("reply"),
				fragments: {
					alone: { body: bodyOf("alone"), fallback: "" },
					shared: { body: bodyOf("shared"), fallback: "" },
					colleagues: { body: bodyOf("colleagues"), fallback: "" },
				},
				woken: [slug],
				viewer: slug,
				colleagues: [],
			}),
		);
		console.log("──── delivery：插话那一段 ────");
		console.log(bodyOf("interrupted"));
		console.log("──── 以上是每轮贴在投递正文末尾的 ────\n");
	}


	const phases: Phase[] = [];

	// 1. 我 @ 助理，等它开口。
	const asked = await shell.ownerSay({ channelId: "all", text: `@${slug} 你在吗？用一句话回答。` });
	console.log(`已投递 #${asked.seq}，唤醒 ${asked.delivery.delivered.join(",") || "（没人）"}`);
	// 先等这次唤醒的**提交**结算，再等频道里出现它的话：两者是两件事。
	// 上一刀「超时无回话」说不清是「没叫」「叫了没跑」「跑了没 say」，这里让它自己说。
	const firstWake = await waitForSubmission(
		runtime.harness,
		`ch:owner:all:${asked.seq}:`,
		WAIT_MS,
		BACKGROUND_CONTEXT,
	);
	const reply = await waitForReply(shell, "all", slug, asked.seq, 10_000);
	phases.push({
		name: "被 @ 会回话",
		ok: reply !== undefined,
		detail: reply?.text.slice(0, 80) ?? wakeDetail(firstWake),
	});

	// 2. 技能是否出现在提示词里（读的是同一份 render 结果）。
	await mkdir(join(assistantDir, "skills", "自测技能"), { recursive: true });
	await (await import("node:fs/promises")).writeFile(
		join(assistantDir, "skills", "自测技能", "SKILL.md"),
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
	const identityPath = join(assistantDir, "identity.md");
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
	const memoryPath = join(assistantDir, "memory.md");
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

	// 5. 全员层技能：让它写一份 scope=all 的技能，检查是否落到工作区根的 skills/。
	const shareAsked = await shell.ownerSay({
		channelId: "all",
		text: `@${slug} 用 skills 写一份全员层技能（action=write, scope=all），名字「自测共享技能」，描述「全员通用」，正文一句话。写完告诉我。`,
	});
	const shareReply = await waitForReply(shell, "all", slug, shareAsked.seq, WAIT_MS);
	const sharedPath = join(root, "skills", "自测共享技能", "SKILL.md");
	const sharedText = await readFile(sharedPath, "utf8").catch(() => "");
	phases.push({
		name: "技能共享（全员层真的写到了工作区根）",
		ok: shareReply !== undefined && sharedText.includes("全员通用"),
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
	//
	//    判据是「等 settle 那条提交**结算**」，不是「等 memory.md 变化」。上一刀吃过亏：
	//    同一份代码连跑 6 次，5 红 1 绿，因为两种完全不同的原因共用一个红灯 ——
	//    「唤醒被吞」（提交一直排着）和「模型判断这批不值得记」（提交 done、文件没变）。
	//    现在先等提交走到终态，再按状态分因；文件内容只回答「该写的写了没有」。
	const settleAsked = await shell.ownerSay({
		channelId: `team:自测团队`,
		text: "定了：这个团队的验收标准是「能跑通 core:live 全部 16 项」。",
		kind: "decision",
	});
	console.log(`团队频道已投递 #${settleAsked.seq}（kind=decision）`);
	const memoryBefore = await readFile(join(teamsRoot, "自测团队", "memory.md"), "utf8").catch(() => "");
	const settleOutcome = await waitForSettle(runtime.harness, "自测团队", WAIT_MS, BACKGROUND_CONTEXT);
	const settledText = await readFile(join(teamsRoot, "自测团队", "memory.md"), "utf8").catch(() => "");
	const wroteIt = settledText !== memoryBefore;
	// 只在「没跑」时打证据：那条提交到底还在队里，还是根本没提交。
	if (settleOutcome.kind === "pending" || settleOutcome.kind === "missing") {
		const inspection = await runtime.harness.inspect(BACKGROUND_CONTEXT);
		const pending = inspection.submissions.filter((item) => item.status === "queued" || item.status === "placed");
		console.log(`[debug] 未结提交 ${pending.length} 条：`);
		for (const item of pending.slice(0, 8)) {
			const record = item as unknown as { requestId?: string; conversationId?: number; status?: string };
			console.log(`  ${record.status} conv=${record.conversationId} req=${record.requestId ?? "-"}`);
		}
		for (const task of inspection.tasks.slice(0, 6)) {
			console.log(`  task ${task.record.kind} conv=${task.record.conversationId} state=${task.state.kind}`);
		}
	}
	phases.push({
		name: "团队记忆自动沉淀（拍板后被叫去沉淀并落盘）",
		ok: wroteIt && settledText.includes("验收标准"),
		detail: settleDetail(settleOutcome, wroteIt, settledText),
	});

	// 8. 招人：名字要像真人，且新人自动进全员群、进得了团队频道。
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
	let all = await readAllIdentities(layout.agentRoots);
	let hired = all.find((identity) => identity.slug !== slug);
	while (Date.now() < hireDeadline && hired === undefined) {
		await new Promise((resolve) => setTimeout(resolve, 1_000));
		all = await readAllIdentities(layout.agentRoots);
		hired = all.find((identity) => identity.slug !== slug);
	}
	const allAfterHire = (await shell.channels()).messages["all"] ?? [];
	const hireReply = allAfterHire.filter((message) => message.seq > hireAsked.seq && message.from === slug).at(-1);
	// 「像真人的名字」：长度 2–4、不含身份词、不含英文字母。判断放宽一点，只拦明显的违规。
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
		// 新人自动进全员群（否则没人 @ 得到他），并且立刻有「我 ↔ 他」的私聊
		// —— 他的工作过程在那里看。id 用 dmId 算，slug 排序后 `owner` 不一定在前面。
		const allChannel = state.channels["all"];
		const personal = state.channels[dmId(OWNER, hired.slug)];
		phases.push({
			name: "新人自动进全员群，且有自己的私聊",
			ok:
				allChannel !== undefined &&
				allChannel.members.includes(hired.slug) &&
				personal !== undefined &&
				personal.members.includes(OWNER) &&
				personal.members.includes(hired.slug),
			detail:
				allChannel === undefined
					? "没有全员群"
					: `全员群成员 ${allChannel.members.join("、")}${personal === undefined ? "；没有私聊" : `；私聊成员 ${personal.members.join("、")}`}`,
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
		// 拍板链写在全员技能「工作规矩」里（规则外移到技能，不进提示词正文），
		// 所以验的是「新人拿得到这条规则」：技能被列进提示词 + 正文写了不许越级。
		// 断言的是技能的**实际措辞**（「越过上级」），不是某句历史原话 —— 措辞会重写，判据不会。
		const prompt = await shell.promptOf(hired.slug);
		const rules = await readFile(join(root, "skills", "工作规矩", "SKILL.md"), "utf8").catch(() => "");
		const listed = prompt.includes("工作规矩");
		phases.push({
			name: "新人拿得到拍板链（全员技能「工作规矩」）",
			ok: listed && rules.includes("越过上级"),
			detail: listed
				? rules.includes("越过上级")
					? "工作规矩已列进提示词，正文写了不许越级"
					: "技能正文里没有「越过上级」"
				: "提示词里没列出「工作规矩」技能",
		});
	}

	// 9. 上报链：四个身份 —— 我 / 助理 / 团队管理员 / 成员。
	//
	//    前 12 项验的全是机制（回话、记忆、技能、招人），没有一项验「组织对不对」：
	//    成员该找管理员、管理员该找助理、助理才直接找我。这一段补上这条产品主线。
	//    身份直接用 `createAgent` 建（招人本身已经在上面的阶段验过），这样三层的
	//    上级关系是确定事实，不会因为模型这一次招人招得不对而让整条链失真。
	const chainTeam = "上报链团队";
	{
		const { createAgent } = await import("../src/core/agent/identity.ts");
		await mkdir(join(teamsRoot, chainTeam), { recursive: true });
		const lead = await createAgent({
			root: agentsRoot,
			name: "团队管理员甲",
			title: "团队管理员",
			manager: slug,
			team: chainTeam,
			body:
				"你是「上报链团队」的团队管理员。团队成员向你汇报，你向助理汇报。\n" +
				"团队内的事你能定；招人、改别人身份、花钱、跨团队的事超出你的职权，先问助理，不要直接找我。",
		});
		const member = await createAgent({
			root: agentsRoot,
			name: "成员乙",
			title: "成员",
			manager: lead.slug,
			team: chainTeam,
			body:
				"你是「上报链团队」的成员，向团队管理员汇报。\n" +
				"你自己职责内的事自己定；超出职责、要花钱、要改别人的事，先问团队管理员，绝不跳级找我。",
		});
		await writeFile(
			join(teamsRoot, chainTeam, "README.md"),
			`---\nname: ${chainTeam}\nlead: ${lead.slug}\nstatus: active\n---\n\n` +
				"目标：跑通上报链自测。成员 → 团队管理员 → 助理 → 我，逐级上报。\n" +
				"验收：拍不了板的时候话逐级往上，任何一层都不跳级。\n不做：真的买服务器。\n",
			"utf8",
		);
		// 新团队 / 新成员都要重扫：团队频道是在「开会话」时按 `team:` 建的。
		await shell.rescan();

		// 9.1 先验静态事实：三个人的提示词里，上级与下属写对了没有。
		const memberPrompt = await shell.promptOf(member.slug);
		const leadPrompt = await shell.promptOf(lead.slug);
		const assistantPrompt = await shell.promptOf(slug);
		const leadName = lead.name ?? lead.slug;
		const memberName = member.name ?? member.slug;
		const managerLine = (text: string): string => text.split("\n").find((line) => line.includes("你的上级：")) ?? "";
		const links = [managerLine(memberPrompt), managerLine(leadPrompt), managerLine(assistantPrompt)];
		phases.push({
			name: "四个身份的汇报线各自正确",
			ok:
				links[0]?.includes(leadName) === true &&
				links[1]?.includes("助理") === true &&
				links[2]?.includes("我（用户本人）") === true &&
				leadPrompt.includes(memberName) &&
				assistantPrompt.includes(leadName),
			detail: links.join(" ｜ "),
		});

		// 9.2 跑一次真实的上报：只有最低层收到指令，剩下两跳靠自己往上走。
		//     花我的钱是三层都拍不了的典型事 —— 成员不能订、管理员不能批、助理得问我。
		const chainBaseline = await seqBaseline(shell);
		const chainAsked = await shell.ownerSay({
			channelId: "all",
			text: `@${member.slug} 团队需要一台新服务器，每月 3000 块，你去办，今天就订。`,
		});
		console.log(`上报链起点已投递 #${chainAsked.seq}，唤醒 ${chainAsked.delivery.delivered.join(",") || "（没人）"}`);

		const hop1 = await waitForMention(shell, chainBaseline, member.slug, lead.slug, WAIT_MS);
		phases.push({
			name: "成员拍不了板，先找团队管理员（不跳级）",
			ok: hop1.hit !== undefined,
			detail: hopDetail(hop1, "团队管理员"),
		});

		const hop2 =
			hop1.hit === undefined ? {} : await waitForMention(shell, chainBaseline, lead.slug, slug, WAIT_MS);
		phases.push({
			name: "管理员拍不了板，转给助理（不跳级）",
			ok: hop2.hit !== undefined,
			detail: hopDetail(hop2, "助理"),
		});

		const hop3 =
			hop2.hit === undefined ? {} : await waitForMention(shell, chainBaseline, slug, "owner", WAIT_MS);
		phases.push({
			name: "助理把要我定的事报到我这里",
			ok: hop3.hit !== undefined,
			detail: hopDetail(hop3, "我"),
		});
	}

	for (const phase of phases) log(phase);
	// 排查用：把频道全文落一份再退出（`SOLO_LIVE_DUMP=/tmp/x.json`）。
	// 端到端失败时唯一能回答「他到底说了什么」的就是这份数据；不设就不写、照常删工作区。
	const dumpPath = process.env.SOLO_LIVE_DUMP;
	if (dumpPath !== undefined) {
		await writeFile(dumpPath, JSON.stringify(await shell.channels(), null, 2), "utf8");
		console.log(`频道全文已写到 ${dumpPath}`);
	}
	await runtime.close().catch(() => undefined);
	await shell.close().catch(() => undefined);
	const failed = phases.filter((phase) => !phase.ok);
	console.log(`\n${phases.length - failed.length}/${phases.length} 通过`);

	// ADR-099：回话阶段里有多少次是收尾（结算后自动补发）兜的。1–7 这 7 个阶段都要靠一句回话。
	const REPLY_PHASES = 7;
	const trend =
		turnPosted <= 4
			? "正常"
			: "提示词在退化（7 个回话阶段里超过 4 次走收尾 —— 改 80-reply / reply.alone 的措辞）";
	const failedNote = turnFailed > 0 ? `；补发失败 ${turnFailed} 次（内容丢了，单测没覆盖到就查 channel/turn/finish.ts）` : "";
	console.log(`收尾趋势：${turnPosted} 次 / ${REPLY_PHASES} 个回话阶段 —— ${trend}${failedNote}`);

	if (dumpPath === undefined) await rm(root, { recursive: true, force: true }).catch(() => undefined);
	else console.log(`工作区保留在 ${root}`);
	if (failed.length > 0) process.exitCode = 1;
}

await main();
