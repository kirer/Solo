/**
 * 真实调模型的端到端实测（**平时不跑**，故意不叫 `.test.ts`）。
 *
 * 为什么单独一份：
 * - `npm test` 不该依赖外部网关。模型不可用时，一场「本机能不能跑通」的测试会
 *   红一片，把真正的逻辑错埋掉；而模型错的表现恰好是「什么都没发生」，最容易
 *   被误当成逻辑错去改代码。
 * - 它要验的东西逻辑单测验不了：技能/项目文件改完之后，**下一条消息**是否真的
 *   出现在提示词里；招来的人被 @ 之后是否真的回话。
 *
 * 用法（需要真实网关）：
 *
 * ```bash
 * node --experimental-strip-types scripts/core-live.ts
 * ```
 *
 * 直接跑 `main()` 会：建临时工作区 → 播种助理 → 老板 @ 助理 → 等回话 → 检查
 * 技能与项目是否有落盘生效。全程打印到 stdout，失败不抛（输出就是判据）。
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

/** 轮询频道，直到出现某个人发的消息（不是老板发的）。 */
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
	const { assembleCore, seedOwnerAssistant } = await import("../src/core/shell/assemble.ts");

	const root = await mkdtemp(join(tmpdir(), "core-live-"));
	const agentsRoot = join(root, "agents");
	const projectsRoot = join(root, "projects");
	await mkdir(agentsRoot, { recursive: true });
	await mkdir(projectsRoot, { recursive: true });
	console.log(`工作区：${root}`);

	const slug = await seedOwnerAssistant(agentsRoot, { name: "助理" });
	console.log(`播种：agents/${slug}`);

	const configured = setupModels(process.env, { workspace: root });
	const runtime = await openCore({
		databasePath: join(root, "core.sqlite"),
		models: configured.models,
		registry: createRegistry(),
	});
	// `setupModels` 返回的是 {models, defaultModel, catalog}：`defaultModel` 是 `{provider, modelId}`，
	// 已经没有模型时回落成 catalog 的第一条，两条都没有才是真的没配。
	const picked =
		configured.defaultModel ?? (configured.catalog[0] === undefined ? undefined : {
			provider: configured.catalog[0].provider,
			modelId: configured.catalog[0].modelId,
		});
	if (picked === undefined) throw new Error("没有可用模型：先在工作区写 settings.json");
	console.log(`模型：${picked.provider}/${picked.modelId}`);

	const shell = await assembleCore(runtime.harness, runtime.registry, {
		agentsRoot,
		projectsRoot,
		defaultModel: picked,
		ownerName: "老板",
	});

	const phases: Phase[] = [];

	// 1. 老板 @ 助理，等它开口。
	const asked = await shell.ownerSay({ channelId: "company", text: `@${slug} 你在吗？用一句话回答。` });
	console.log(`已投递 #${asked.seq}，唤醒 ${asked.delivery.delivered.join(",") || "（没人）"}`);
	const reply = await waitForReply(shell, "company", slug, asked.seq, WAIT_MS);
	phases.push({ name: "被 @ 会回话", ok: reply !== undefined, detail: reply?.text.slice(0, 80) ?? "超时无回话" });

	// 2. 技能是否出现在提示词里（读的是同一份 render 结果）。
	await mkdir(join(agentsRoot, slug, "skills", "自测技能"), { recursive: true });
	await (await import("node:fs/promises")).writeFile(
		join(agentsRoot, slug, "skills", "自测技能", "SKILL.md"),
		"---\nname: 自测技能\ndescription: 这是实测写入的技能\n---\n\n正文。\n",
		"utf8",
	);
	const skillAsked = await shell.ownerSay({ channelId: "company", text: `@${slug} 你有哪些技能？只列名字。` });
	const skillReply = await waitForReply(shell, "company", slug, skillAsked.seq, WAIT_MS);
	phases.push({
		name: "技能热更新生效（不需要重启）",
		ok: skillReply !== undefined && skillReply.text.includes("自测技能"),
		detail: skillReply?.text.slice(0, 120) ?? "超时无回话",
	});

	// 3. 项目说明是否进入项目成员的提示词。
	await mkdir(join(projectsRoot, "自测项目"), { recursive: true });
	await (await import("node:fs/promises")).writeFile(
		join(projectsRoot, "自测项目", "README.md"),
		"---\nname: 自测项目\nowner: " + slug + "\nstatus: active\n---\n\n目标：验证项目说明会进提示词。\n",
		"utf8",
	);
	const identityPath = join(agentsRoot, slug, "identity.md");
	const identity = await readFile(identityPath, "utf8");
	await (await import("node:fs/promises")).writeFile(
		identityPath,
		identity.replace(/^---\n([\s\S]*?)\n---/, `---\n$1\nproject: 自测项目\n---`),
		"utf8",
	);
	// 改了 identity.md 之后必须重扫一次：项目频道是在「开会话」时按 `project:` 建的，
	// 不重扫的话这个人永远不在项目频道里（实测踩过：`频道不存在：proj:自测项目`）。
	await shell.rescan();
	const projectAsked = await shell.ownerSay({
		channelId: "company",
		text: `@${slug} 你现在在哪个项目里？项目目标是什么？一句话。`,
	});
	const projectReply = await waitForReply(shell, "company", slug, projectAsked.seq, WAIT_MS);
	phases.push({
		name: "项目说明进提示词",
		ok: projectReply !== undefined && projectReply.text.includes("自测项目"),
		detail: projectReply?.text.slice(0, 120) ?? "超时无回话",
	});

	// 4. 记忆：让它记一条，再问它记了什么（提示词里只有目录，正文靠 recall）。
	const rememberAsked = await shell.ownerSay({
		channelId: "company",
		text: `@${slug} 用 remember 记一条：「老板喜欢结论先行」。记完告诉我。`,
	});
	const rememberReply = await waitForReply(shell, "company", slug, rememberAsked.seq, WAIT_MS);
	const memoryPath = join(agentsRoot, slug, "memory.md");
	const memoryText = await readFile(memoryPath, "utf8").catch(() => "");
	phases.push({
		name: "记忆落盘（remember 真写了文件）",
		ok: rememberReply !== undefined && memoryText.includes("结论先行"),
		detail: memoryText.split("\n").filter(Boolean).slice(-1)[0] ?? "文件里没有",
	});

	const recallAsked = await shell.ownerSay({ channelId: "company", text: `@${slug} recall 一下你关于「结论」的记忆。` });
	const recallReply = await waitForReply(shell, "company", slug, recallAsked.seq, WAIT_MS);
	phases.push({
		name: "记忆能读回（recall 真读到了）",
		ok: recallReply !== undefined && recallReply.text.includes("结论"),
		detail: recallReply?.text.slice(0, 100) ?? "超时无回话",
	});

	// 5. 公司层技能：让它写一份 scope=company 的技能，检查是否落到工作区根的 skills/。
	const shareAsked = await shell.ownerSay({
		channelId: "company",
		text: `@${slug} 用 write_skill 写一份公司层技能（scope=company），名字「自测共享技能」，描述「全公司通用」，正文一句话。写完告诉我。`,
	});
	const shareReply = await waitForReply(shell, "company", slug, shareAsked.seq, WAIT_MS);
	const sharedPath = join(root, "skills", "自测共享技能", "SKILL.md");
	const sharedText = await readFile(sharedPath, "utf8").catch(() => "");
	phases.push({
		name: "技能共享（公司层真的写到了工作区根）",
		ok: shareReply !== undefined && sharedText.includes("全公司通用"),
		detail: sharedText === "" ? "工作区根没有 skills/自测共享技能/SKILL.md" : sharedText.split("\n")[2] ?? "",
	});

	// 6. 项目记忆：让它记一条项目级的事，检查是否落到 projects/<slug>/memory.md。
	const projectMemoryAsked = await shell.ownerSay({
		channelId: "company",
		text: `@${slug} 用 remember_project 记一条项目级的事：「这个项目第一次跑通了」。记完告诉我。`,
	});
	const projectMemoryReply = await waitForReply(shell, "company", slug, projectMemoryAsked.seq, WAIT_MS);
	const projectMemoryText = await readFile(join(projectsRoot, "自测项目", "memory.md"), "utf8").catch(() => "");
	phases.push({
		name: "项目记忆落盘（projects/<slug>/memory.md）",
		ok: projectMemoryReply !== undefined && projectMemoryText.includes("第一次跑通"),
		detail: projectMemoryText.split("\n").filter(Boolean).slice(-1)[0] ?? "文件里没有",
	});

	// 7. 项目记忆的自动沉淀：让助理在项目频道里拍一次板（kind=decision），
	//    检查 `projects/自测项目/memory.md` 是否被自动写入了内容 —— 这条路上
	//    agent 没有被明确要求「去记一条」，它只收到「请判断这件事值不值得沉淀」。
	const settleAsked = await shell.ownerSay({
		channelId: `proj:自测项目`,
		text: "定了：这个项目的验收标准是「能跑通 core:live 全部 8 项」。",
		kind: "decision",
	});
	console.log(`项目频道已投递 #${settleAsked.seq}（kind=decision）`);
	const memoryBefore = await readFile(join(projectsRoot, "自测项目", "memory.md"), "utf8").catch(() => "");
	let settled = "";
	const deadline = Date.now() + WAIT_MS;
	while (Date.now() < deadline && settled === "") {
		const now = await readFile(join(projectsRoot, "自测项目", "memory.md"), "utf8").catch(() => "");
		if (now !== memoryBefore) settled = now;
		await new Promise((resolve) => setTimeout(resolve, 1_000));
	}
	phases.push({
		name: "项目记忆自动沉淀（拍板后被叫去沉淀并落盘）",
		ok: settled.includes("验收标准"),
		detail: settled === "" ? "memory.md 没变化（没人去沉淀，或沉淀了但没写这一条）" : settled.split("\n").filter(Boolean).slice(-1)[0] ?? "",
	});

	// 8. 招人：名字要像真人，且新人自动有个人频道、进得了项目频道。
	//
	// 这是「模型有没有遵守我们写下的规矩」的唯一验证口径 —— 名字、频道、汇报线三件
	// 事都只写在技能与提示词里，代码只负责记录结果。如果不验这一段，规矩写错了不会
	// 有任何反馈，只会在用起来的那天变成「@前端工程师」这种叫座位的话。
	const hireAsked = await shell.ownerSay({
		channelId: "company",
		text: `@${slug} 招一个人进「自测项目」做前端，负责项目频道的界面。用 hire 建，名字用真人的名字（姓+名）。建完告诉我他叫什么。`,
	});
	const hireReply = await waitForReply(shell, "company", slug, hireAsked.seq, WAIT_MS);
	const { readAllIdentities } = await import("../src/core/agent/identity.ts");
	const all = await readAllIdentities(agentsRoot);
	const hired = all.find((identity) => identity.slug !== slug);
	// 「像真人的名字」：长度 2–4、不含岗位词、不含英文字母。判断放宽一点，只拦明显的违规。
	const JOB_WORDS = ["工程师", "负责人", "经理", "总监", "专员", "助理", "主管", "前端", "后端", "设计", "测试"];
	const looksLikeName =
		hired !== undefined &&
		hired.name !== undefined &&
		hired.name.length >= 2 &&
		hired.name.length <= 4 &&
		!/[A-Za-z0-9]/.test(hired.name) &&
		!JOB_WORDS.some((word) => hired.name?.includes(word) === true);
	phases.push({
		name: "招来的人有像真人的名字",
		ok: hireReply !== undefined && looksLikeName,
		detail: hired === undefined ? "没有招到人" : `${hired.name}（title: ${hired.title ?? "无"}）`,
	});

	if (hired !== undefined) {
		const state = await shell.channels();
		// 个人频道 = 他与老板的私聊。没有它，「向上汇报」连个落点都没有。
		const personal = state.channels[`dm:owner-${hired.slug}`];
		phases.push({
			name: "新人自动有个人频道",
			ok: personal !== undefined && personal.members.includes(hired.slug) && personal.members.includes("owner"),
			detail: personal === undefined ? "没有 dm 频道" : `成员 ${personal.members.join("、")}`,
		});
		// 项目频道里有负责人（README.md 的 owner）+ 新人。
		const project = state.channels["proj:自测项目"];
		const owner = all.find((identity) => identity.slug === slug)?.slug;
		phases.push({
			name: "项目频道里有负责人和新人",
			ok:
				project !== undefined &&
				project.members.includes(hired.slug) &&
				(owner === undefined || project.members.includes(owner)),
			detail: project === undefined ? "没有项目频道" : `成员 ${project.members.join("、")}`,
		});
		// 拍板链写进了新人的提示词（「不要跳级」是这条规则的关键词）。
		const prompt = await shell.promptOf(hired.slug);
		phases.push({
			name: "拍板链进了新人的提示词",
			ok: prompt.includes("不要跳级"),
			detail: prompt.includes("不要跳级") ? "有拍板链" : "提示词里没有拍板链",
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
