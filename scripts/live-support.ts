/**
 * 真实模型测试的公共件：造工作区、等消息、等提交结算、留证据。
 *
 * `core-live.ts` 与 `scenario-live.ts` 共用这一份 —— 等待语义只该有一处。
 * 这里**没有任何顶层副作用**，也不接管 `console`（收尾计数留在 core-live）。
 */
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { dmId, OWNER, type Message } from "../src/core/channel/types.ts";
import { BACKGROUND_CONTEXT, createRegistry, setupModels, type Context, type Harness } from "../src/core/runtime/index.ts";
import type { ModelRef, ModelSetup } from "../src/core/runtime/models.ts";
import { openCore, type CoreRuntime } from "../src/core/runtime/open.ts";
import { assembleCore, type CoreShell } from "../src/shell/assemble.ts";
import { seedOwnerAssistant, seedPromptTemplates, seedRules, seedTextFiles } from "../src/shell/seed.ts";
import { createAgent, readAllIdentities, type Identity } from "../src/core/documents/member/identity.ts";
import { renderTeamFile, readTeam, listTeams } from "../src/core/documents/team/doc.ts";
import { createChat } from "../src/app/chat.ts";
import { resolveLayout, type Layout } from "../src/core/layout.ts";
import { liveConversations } from "../src/core/channel/queue.ts";

export const WAIT_MS = 240_000;

/**
 * 真模型脚本的模型来源。
 *
 * 产品默认是「没有模型」（ADR-023）：没配就不响。这套脚本没有模型就跑不了，所以什么都
 * 没配时它自己往临时工作区写一份**本地网关**的 settings.json —— 这是脚本的配置，
 * 不是产品默认。想跑别的模型：设 `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`，
 * 或给 `--settings <file>`；给了 `--settings` 还解析不出模型，就直接报错（不悄悄替换）。
 */
export async function setupLiveModels(settingsFile: string, options: { readonly fallbackGateway?: boolean } = {}): Promise<ModelSetup> {
	const resolved = setupModels(process.env, { settingsFile });
	if (resolved.defaultModel !== undefined) return resolved;
	if (options.fallbackGateway === false) throw new Error(`没有可用模型：${settingsFile} 里解析不出模型`);

	const gateway = {
		providers: [
			{
				id: "magpie",
				name: "本地网关",
				baseUrl: process.env.COMMANDCODE_BASE_URL ?? "http://127.0.0.1:3425/v1",
				api: "openai-responses",
				apiKey: process.env.COMMANDCODE_API_KEY ?? "magpie",
				models: [{ id: process.env.COMMANDCODE_MODEL_ID ?? "auto/deepseek-v4.1-flash" }],
			},
		],
	};
	await mkdir(dirname(settingsFile), { recursive: true });
	await writeFile(settingsFile, `${JSON.stringify(gateway, null, 2)}\n`, "utf8");
	return setupModels(process.env, { settingsFile });
}

export type Phase = { readonly name: string; readonly ok: boolean; readonly detail: string };

export function log(phase: Phase): void {
	const mark = phase.ok ? "✓" : "✗";
	console.log(`${mark} ${phase.name}${phase.detail === "" ? "" : ` — ${phase.detail}`}`);
}

export type LiveShell = CoreShell;

/** 一个临时工作区 + 已装配的核心。`restart()` 之后换成新的 runtime/shell，目录不变。 */
export type LiveWorld = {
	readonly root: string;
	readonly layout: Layout;
	readonly agentsRoot: string;
	readonly teamsRoot: string;
	readonly databasePath: string;
	readonly model: ModelRef;
	/** 播种出来的助理 slug（每次都一样是「助理」的目录名）。 */
	readonly assistantSlug: string;
	runtime: CoreRuntime;
	shell: CoreShell;
	/** 关掉再对同一份磁盘/库重新装配（模拟重启）。 */
	restart(): Promise<void>;
	/** 关掉 shell 与库，不删目录。 */
	close(): Promise<void>;
	/** 删掉整个临时工作区（已关的情况下）。 */
	remove(): Promise<void>;
};

export type OpenWorldOptions = {
	/** 临时目录前缀（排查时一眼看出是哪个套件）。 */
	readonly prefix?: string;
	/** 把这个 settings.json 拷进临时工作区根再解析模型。 */
	readonly settings?: string;
};

async function assemble(world: Omit<LiveWorld, "restart" | "close" | "remove">): Promise<LiveShell> {
	return assembleCore(world.runtime.harness, world.runtime.registry, {
		layout: world.layout,
		defaultModel: world.model,
	});
}

export async function openLiveWorkspace(options: OpenWorldOptions = {}): Promise<LiveWorld> {
	const root = await mkdtemp(join(tmpdir(), options.prefix ?? "solo-live-"));
	// 应用私有的东西（助理、提示词、库、设置）落在 `.app/`，组织落在临时根里。
	const layout = resolveLayout({ appRoot: join(root, ".app"), userRoot: root });
	const agentsRoot = layout.membersRoot;
	const teamsRoot = layout.teamsRoot;
	const databasePath = layout.databasePath;
	await mkdir(layout.assistantRoot, { recursive: true });
	await mkdir(agentsRoot, { recursive: true });
	await mkdir(teamsRoot, { recursive: true });
	await seedRules(layout);
	await seedPromptTemplates(layout);
	await seedTextFiles(layout);
	const assistantSlug = await seedOwnerAssistant(layout, { name: "助理" });
	if (options.settings !== undefined) await copyFile(options.settings, layout.settingsFile);

	const configured = await setupLiveModels(layout.settingsFile, { fallbackGateway: options.settings === undefined });
	const model = configured.defaultModel;
	if (model === undefined) throw new Error("没有可用模型");
	const runtime = await openCore({
		databasePath,
		models: configured.models,
		registry: createRegistry(),
	});
	const world: LiveWorld = {
		root,
		layout,
		agentsRoot,
		teamsRoot,
		databasePath,
		model,
		assistantSlug,
		runtime,
		shell: undefined as unknown as CoreShell,
		async restart() {
			await drainInFlight(world.runtime.harness, 15_000);
			await world.shell.close();
			await world.runtime.close();
			const reopened = await openCore({
				databasePath,
				models: configured.models,
				registry: createRegistry(),
			});
			world.runtime = reopened;
			world.shell = await assembleCore(reopened.harness, reopened.registry, {
				layout,
				defaultModel: model,
			});
		},
		async close() {
			await world.shell.close().catch(() => undefined);
			await world.runtime.close().catch(() => undefined);
		},
		async remove() {
			await rm(root, { recursive: true, force: true }).catch(() => undefined);
		},
	};
	world.shell = await assemble(world);
	return world;
}

/** 代码造一个人（与 `hire` 工具同一条落盘 + 开会话路径，不经过模型）。 */
export async function createLiveAgent(
	world: LiveWorld,
	input: {
		readonly name: string;
		readonly title?: string;
		readonly team?: string;
		readonly body?: string;
	},
): Promise<Identity> {
	const identity = await createAgent({
		root: world.layout.membersRoot,
		name: input.name,
		...(input.title === undefined ? {} : { title: input.title }),
		...(input.team === undefined ? {} : { team: input.team }),
		...(input.body === undefined ? {} : { body: input.body }),
	});
	await world.shell.openAgent(identity.slug);
	return identity;
}

/** 代码写一份团队说明并重投影频道（与 `file` 工具写 README 同一条路径）。 */
export async function createTeamFixture(
	world: LiveWorld,
	input: { readonly slug: string; readonly name: string; readonly body: string },
): Promise<void> {
	const dir = join(world.teamsRoot, input.slug);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "README.md"), renderTeamFile({ name: input.name, status: "active", body: input.body }), "utf8");
	await world.shell.syncTeam(input.slug);
}

/** 开一个与我的私聊（唯一入口与 HTTP/界面相同）。 */
export async function openDm(world: LiveWorld, slug: string): Promise<string> {
	const chat = createChat(world.shell);
	const opened = await chat.openDirectMessage(slug);
	return opened.id;
}

/**
 * 轮询频道，等他这一轮**收工**，然后取他最后一句回话。
 *
 * 只看「第一条回话」会提前放行：模型常先发一条过程话（「我先记一下」），真正做完的
 * 回话在它后面；下一阶段于是拿到上一阶段的答案，一错错一串。收工的判据是「他的会话
 * 没有活任务、也没有未结算的提交」—— 答完的收尾任务也在这里面，所以补发的那一句
 * 一定已经落进频道（ADR-077）。
 */
export async function waitForReply(
	shell: LiveShell,
	channelId: string,
	fromSlug: string,
	afterSeq: number,
	timeoutMs: number,
): Promise<{ readonly seq: number; readonly text: string } | undefined> {
	const deadline = Date.now() + timeoutMs;
	const conversationId = shell.conversations.get(fromSlug)?.id;
	let last: { readonly seq: number; readonly text: string } | undefined;
	while (Date.now() < deadline) {
		const state = await shell.channels();
		const hits = (state.messages[channelId] ?? []).filter(
			(message) => message.seq > afterSeq && message.from === fromSlug,
		);
		const hit = hits.at(-1);
		if (hit !== undefined) {
			last = { seq: hit.seq, text: hit.text };
			if (conversationId === undefined) return last;
			const inspection = await shell.harness.inspect(BACKGROUND_CONTEXT).catch(() => undefined);
			const busy =
				inspection !== undefined &&
				(inspection.tasks.some((task) => Number(task.record.conversationId) === Number(conversationId)) ||
					inspection.submissions.some(
						(item) =>
							Number(item.conversationId) === Number(conversationId) &&
							(item.status === "queued" || item.status === "placed"),
					));
			if (!busy) return last;
		}
		await sleep(500);
	}
	return last;
}

/** 等一组人都在同一个频道里说话（多人被叫醒的场景）。 */
export async function waitForReplies(
	shell: LiveShell,
	channelId: string,
	slugs: readonly string[],
	afterSeq: number,
	timeoutMs: number,
): Promise<{ readonly found: ReadonlyMap<string, Message>; readonly missing: readonly string[] }> {
	const deadline = Date.now() + timeoutMs;
	let last: { found: Map<string, Message>; missing: string[] } = { found: new Map(), missing: [...slugs] };
	while (Date.now() < deadline) {
		const state = await shell.channels();
		const list = state.messages[channelId] ?? [];
		const found = new Map<string, Message>();
		for (const slug of slugs) {
			const hit = list.find((message) => message.seq > afterSeq && message.from === slug && message.kind !== "note");
			if (hit !== undefined) found.set(slug, hit);
		}
		last = { found, missing: slugs.filter((slug) => !found.has(slug)) };
		if (last.missing.length === 0) return last;
		await sleep(1_000);
	}
	return last;
}

/** 反复问同一个问题，直到它为真或超时。 */
export async function waitForCondition<T>(
	probe: () => Promise<T | undefined>,
	timeoutMs: number,
	intervalMs = 1_000,
): Promise<T | undefined> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await probe().catch(() => undefined);
		if (value !== undefined) return value;
		await sleep(intervalMs);
	}
	return undefined;
}

/** 等到这个人真的手上有活（非后台任务在跑）。 */
export async function waitForBusy(
	world: LiveWorld,
	slug: string,
	timeoutMs: number,
): Promise<number | undefined> {
	const conversationId = await waitForCondition(async () => {
		const id = world.shell.conversations.get(slug)?.id;
		if (id === undefined) return undefined;
		const busy = await liveConversations(world.runtime.harness);
		return busy.has(Number(id)) ? Number(id) : undefined;
	}, timeoutMs, 500);
	return conversationId;
}

/** 等到没有排队/正在跑的输入，也没有活着的任务。重启前必须过这一关。 */
export async function drainInFlight(harness: Harness, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const inspection = await harness.inspect(BACKGROUND_CONTEXT).catch(() => undefined);
		if (inspection !== undefined) {
			const pending = inspection.submissions.filter((item) => item.status === "queued" || item.status === "placed");
			if (pending.length === 0 && inspection.tasks.length === 0) return;
		}
		await sleep(500);
	}
	console.warn("[live] 等待在途提交结算超时：重启证据里可能出现假失败");
}

/** 某一刻每个频道的「下一条 seq」。 */
export async function seqBaseline(shell: LiveShell): Promise<Record<string, number>> {
	const state = await shell.channels();
	// 新频道还没有任何消息时，`nextSeq` 里没有这个 key；写 0 而不是留空。
	// 留空会让 `waitForMention` 回落到 `Infinity`，把之后这个频道里的一切消息都当成
	// 「基线之前」——场景 S4 就是这么空等满 240 秒的。
	const baseline: Record<string, number> = {};
	for (const channelId of Object.keys(state.channels)) baseline[channelId] = state.nextSeq[channelId] ?? 0;
	return baseline;
}

/** `from` 在基线之后说的最后一句（截短）。没说话返回 `undefined` —— 和「说了但没 @ 人」分开。 */
export async function lastSaidBy(
	shell: LiveShell,
	from: string,
	baseline: Readonly<Record<string, number>>,
): Promise<string | undefined> {
	const state = await shell.channels();
	const found: { readonly message: Message; readonly channelId: string }[] = [];
	for (const [channelId, list] of Object.entries(state.messages)) {
		const base = baseline[channelId] ?? Number.POSITIVE_INFINITY;
		for (const message of list) {
			if (message.seq >= base && message.from === from) found.push({ message, channelId });
		}
	}
	found.sort((left, right) => left.message.at - right.message.at || left.message.seq - right.message.seq);
	const last = found[found.length - 1];
	if (last === undefined) return undefined;
	const text = last.message.text.replace(/\s+/g, " ").trim();
	return `[${last.message.kind} @${last.channelId}] ${text.length > 120 ? `${text.slice(0, 120)}…` : text}`;
}

/** 等 `from` 在新消息里 @ 到 `target`；`target !== "owner"` 时把「跳级 @ 我」判成失败。 */
export async function waitForMention(
	shell: LiveShell,
	baseline: Readonly<Record<string, number>>,
	from: string,
	target: string,
	timeoutMs: number,
): Promise<{ readonly hit?: Message; readonly wrong?: Message }> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const state = await shell.channels();
		const messages: Message[] = [];
		for (const [channelId, list] of Object.entries(state.messages)) {
			const base = baseline[channelId] ?? Number.POSITIVE_INFINITY;
			for (const message of list) {
				if (message.seq >= base && message.from === from) messages.push(message);
			}
		}
		messages.sort((left, right) => left.at - right.at || left.seq - right.seq);
		if (target !== "owner") {
			const wrong = messages.find((message) => message.mentions.includes("owner"));
			if (wrong !== undefined) return { wrong };
		}
		const hit = messages.find((message) => message.mentions.includes(target));
		if (hit !== undefined) return { hit };
		await sleep(1_000);
	}
	return {};
}

/**
 * 等 `from` 把话交到我手里：在任何频道 @我，或者直接发进我和他的私聊（ADR-094 之后
 * 助理的结论走后者，私聊里不需要 `@`，所以不能只看 `mentions`）。
 */
export async function waitForOwnerReached(
	shell: LiveShell,
	baseline: Readonly<Record<string, number>>,
	from: string,
	timeoutMs: number,
): Promise<{ readonly hit?: Message; readonly channelId?: string }> {
	const dm = dmId(from, OWNER);
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const state = await shell.channels();
		for (const [channelId, list] of Object.entries(state.messages)) {
			const base = baseline[channelId] ?? Number.POSITIVE_INFINITY;
			for (const message of list) {
				if (message.seq < base || message.from !== from) continue;
				if (channelId === dm || message.mentions.includes(OWNER)) return { hit: message, channelId };
			}
		}
		await sleep(1_000);
	}
	return {};
}

/** 把一跳的结果翻成一句能直接决定去查哪儿的话。 */
export function hopDetail(
	outcome: { readonly hit?: Message; readonly wrong?: Message },
	targetLabel: string,
): string {
	if (outcome.hit !== undefined) return outcome.hit.text.slice(0, 120);
	if (outcome.wrong !== undefined) return `跳级了：${outcome.wrong.text.slice(0, 110)}`;
	return `等待超时：没有把话交给${targetLabel}`;
}

/** 一条唤醒提交的终态。 */
export type SubmissionOutcome =
	| { readonly kind: "missing" }
	| { readonly kind: "pending"; readonly status: string }
	| { readonly kind: "unanswered"; readonly reason: string }
	| { readonly kind: "gone" }
	| { readonly kind: "done" };

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 等一条唤醒提交走到终态（done / unanswered）。`prefix` 如 `ch:<频道>:<seq>:<slug>`。 */
export async function waitForSubmission(
	harness: Harness,
	prefix: string,
	timeoutMs: number,
	context: Context = BACKGROUND_CONTEXT,
): Promise<SubmissionOutcome> {
	const deadline = Date.now() + timeoutMs;
	let id: Parameters<Harness["submission"]>[0] | undefined;
	let lastStatus = "queued";

	while (Date.now() < deadline) {
		if (id === undefined) {
			const inspection = await harness.inspect(context);
			const hit = inspection.submissions.find((item) => String(item.requestId ?? "").startsWith(prefix));
			if (hit !== undefined) id = hit.id;
		}
		if (id !== undefined) {
			const handle = await harness.submission(id, context);
			if (handle === undefined) return { kind: "gone" };
			const record = await handle.status(context);
			if (record.status === "done") return { kind: "done" };
			if (record.status === "unanswered") return { kind: "unanswered", reason: String(record.reason ?? "") };
			lastStatus = record.status;
		}
		await sleep(1_000);
	}
	return id === undefined ? { kind: "missing" } : { kind: "pending", status: lastStatus };
}

/** 把「提交没结算」翻成一句能直接决定去查哪儿的话。 */
export function wakeDetail(outcome: SubmissionOutcome): string {
	if (outcome.kind === "missing") return "提交没有落地：wake 没提交，或被合并撤掉了";
	if (outcome.kind === "pending") return `提交一直是 ${outcome.status}，等到超时：没跑`;
	if (outcome.kind === "unanswered") {
		return `提交结算成 unanswered（${outcome.reason === "" ? "没有原因" : outcome.reason}）：底座/网关没产出`;
	}
	if (outcome.kind === "gone") return "提交结算后底座查不到记录：底座侧丢了";
	return "提交 done，但频道里没有它说的话，收尾（turn）也没补上";
}

/** `JSON.stringify` 的 replacer：`harness.inspect()` 里有 bigint。 */
export function jsonReplacer(_key: string, value: unknown): unknown {
	return typeof value === "bigint" ? value.toString() : value;
}

export type EvidenceInput = {
	readonly scenario: string;
	readonly round: number;
	readonly outDir: string;
	readonly world: LiveWorld;
	readonly checks: readonly { readonly id: string; readonly title: string; readonly kind: string; readonly ok: boolean; readonly detail: string }[];
	readonly deliveries?: readonly unknown[];
	readonly logs?: readonly string[];
	readonly error?: string;
};

/**
 * 把这一轮的证据落盘：频道全文、提示词、身份/团队/记忆文件、提交与任务、最近条目。
 * 目录不随临时工作区删除 —— 失败后第一件要看的就是「他到底说了什么」。
 */
export async function captureEvidence(input: EvidenceInput): Promise<string> {
	const { world } = input;
	const dir = join(input.outDir, input.scenario, `round-${input.round}`);
	await mkdir(dir, { recursive: true });
	const shell = world.shell;
	const [channels, identities, teams, inspection] = await Promise.all([
		shell.channels().catch(() => undefined),
		readAllIdentities(world.agentsRoot).catch(() => []),
		listTeams(world.teamsRoot).catch(() => []),
		world.runtime.harness.inspect(BACKGROUND_CONTEXT).catch(() => undefined),
	]);
	const prompts: Record<string, string> = {};
	const entries: Record<string, unknown> = {};
	const memories: Record<string, string> = {};
	for (const identity of identities) {
		prompts[identity.slug] = await shell.promptOf(identity.slug).catch(() => "");
		memories[`agents/${identity.slug}`] = await readFile(join(world.agentsRoot, identity.slug, "memory.md"), "utf8").catch(() => "");
		const conversation = shell.conversations.get(identity.slug);
		if (conversation !== undefined) {
			const page = await conversation.entries({ order: "descending" }, 10, undefined, BACKGROUND_CONTEXT).catch(() => undefined);
			entries[identity.slug] = page?.items ?? [];
		}
	}
	for (const team of teams) {
		memories[`teams/${team.slug}`] = await readFile(join(world.teamsRoot, team.slug, "memory.md"), "utf8").catch(() => "");
		await writeFile(join(dir, `team-${team.slug}.json`), JSON.stringify(team, jsonReplacer, 2), "utf8");
	}
	await writeFile(join(dir, "channels.json"), JSON.stringify(channels, jsonReplacer, 2), "utf8");
	await writeFile(join(dir, "prompts.json"), JSON.stringify(prompts, null, 2), "utf8");
	await writeFile(join(dir, "identities.json"), JSON.stringify(identities, jsonReplacer, 2), "utf8");
	await writeFile(join(dir, "memory.json"), JSON.stringify(memories, null, 2), "utf8");
	await writeFile(join(dir, "entries.json"), JSON.stringify(entries, jsonReplacer, 2), "utf8");
	await writeFile(
		join(dir, "report.json"),
		JSON.stringify(
			{
				scenario: input.scenario,
				round: input.round,
				model: world.model,
				workspace: world.root,
				checks: input.checks,
				deliveries: input.deliveries ?? [],
				logs: input.logs ?? [],
				...(input.error === undefined ? {} : { error: input.error }),
				inspection: inspection ?? null,
			},
			jsonReplacer,
			2,
		),
		"utf8",
	);
	return dir;
}

/** 读回团队（证据/断言用）。 */
export { readTeam, listTeams, readAllIdentities };

// ── 轮次聚合与命令行（纯函数：不碰模型、不碰磁盘）─────────────────────────

export type CheckKind = "mechanism" | "behavior" | "observation";

export type Check = {
	readonly id: string;
	readonly title: string;
	readonly kind: CheckKind;
	readonly ok: boolean;
	readonly detail: string;
};

export type RoundStatus = "PASS" | "PARTIAL" | "FAIL" | "ERROR" | "SKIP";

export type RoundResult = {
	readonly scenarioId: string;
	readonly round: number;
	readonly status: RoundStatus;
	readonly checks: readonly Check[];
	readonly durationMs: number;
	readonly error?: string;
	readonly evidencePath?: string;
	readonly skipReason?: string;
};

export type ScenarioGate = "hard" | "behavior";

export type AggregateOptions = {
	/** `--strict`：要求全轮通过，而不是默认的 2/3。 */
	readonly strict?: boolean;
	/** `--smoke`：行为门失败只警告，机制门失败与脚本异常才算失败。 */
	readonly smoke?: boolean;
	/** 默认 2/3。 */
	readonly minPassRate?: number;
};

export type ScenarioRow = {
	readonly id: string;
	readonly gate: ScenarioGate;
	readonly rounds: Record<RoundStatus, number>;
	/** 去掉 SKIP 后的轮数。 */
	readonly counted: number;
	readonly passRate: number;
	readonly ok: boolean;
	/** 全部轮次都 SKIP：覆盖缺口，报告里标红，但不单独置退出码。 */
	readonly coverageGap: boolean;
	readonly reason: string;
};

export type Aggregate = {
	readonly rows: readonly ScenarioRow[];
	readonly failed: readonly ScenarioRow[];
	readonly exitCode: 0 | 1;
};

const emptyRounds = (): Record<RoundStatus, number> => ({ PASS: 0, PARTIAL: 0, FAIL: 0, ERROR: 0, SKIP: 0 });

/**
 * 3 轮结果怎么算过：
 * - 有 ERROR 或机制门失败 → 不过（先按代码/脚手架查）；
 * - `--smoke` 下行为门失败只算警告；
 * - 默认 `PASS / 非 SKIP 轮次 >= minPassRate`；`--strict` 要求全部通过；
 * - 全部 SKIP → 覆盖缺口：报告标红，但不单独置退出码。
 */
export function aggregateRounds(
	results: readonly RoundResult[],
	scenarios: readonly { readonly id: string; readonly gate: ScenarioGate }[],
	options: AggregateOptions = {},
): Aggregate {
	const minPassRate = options.strict ? 1 : (options.minPassRate ?? 2 / 3);
	const rows = scenarios.map((scenario) => {
		const rounds = emptyRounds();
		for (const result of results) {
			if (result.scenarioId === scenario.id) rounds[result.status] += 1;
		}
		const counted = rounds.PASS + rounds.PARTIAL + rounds.FAIL + rounds.ERROR;
		const coverageGap = counted === 0;
		const enough = options.strict ? rounds.PASS === counted : counted > 0 && rounds.PASS / counted >= minPassRate;
		const reasons: string[] = [];
		if (rounds.ERROR > 0) reasons.push(`脚本异常 ${rounds.ERROR} 轮`);
		if (rounds.FAIL > 0) reasons.push(`机制门失败 ${rounds.FAIL} 轮`);
		if (!options.smoke && !enough) {
			if (rounds.PARTIAL > 0) reasons.push(`行为门未过 ${rounds.PARTIAL} 轮`);
			reasons.push(`通过率 ${rounds.PASS}/${counted} < ${options.strict ? "3/3" : "2/3"}`);
		}
		const ok = !coverageGap && rounds.ERROR === 0 && rounds.FAIL === 0 && (options.smoke || enough);
		return {
			id: scenario.id,
			gate: scenario.gate,
			rounds,
			counted,
			passRate: counted === 0 ? 0 : rounds.PASS / counted,
			ok,
			coverageGap,
			reason: coverageGap ? "全部轮次 SKIP：覆盖缺口，不是通过" : reasons.join("；"),
		};
	});
	const failed = rows.filter((row) => !row.ok && !row.coverageGap);
	return { rows, failed, exitCode: failed.length === 0 ? 0 : 1 };
}

export type LiveArgs = {
	/** 只跑这些场景；`undefined` = 全部。 */
	readonly scenarios?: readonly string[] | undefined;
	readonly rounds: number;
	readonly settings?: string | undefined;
	readonly out?: string | undefined;
	readonly keep: boolean;
	readonly keepFailed: boolean;
	readonly timeoutMs?: number | undefined;
	readonly strict: boolean;
	readonly smoke: boolean;
	readonly list: boolean;
};

const NUMBER = /^\d+$/;

/** 解析 `--scenario=a,b` / `--rounds=3` 这类开关；不认识的参数直接报错，不静默忽略。 */
export function parseLiveArgs(argv: readonly string[]): LiveArgs {
	const args = {
		scenarios: undefined as string[] | undefined,
		rounds: 3,
		settings: undefined as string | undefined,
		out: undefined as string | undefined,
		keep: false,
		keepFailed: false,
		timeoutMs: undefined as number | undefined,
		strict: false,
		smoke: false,
		list: false,
	};
	for (const raw of argv) {
		const [key, value] = raw.split("=", 2);
		const flag = key ?? "";
		if (flag === "--list") args.list = true;
		else if (flag === "--keep") args.keep = true;
		else if (flag === "--keep-failed") args.keepFailed = true;
		else if (flag === "--strict") args.strict = true;
		else if (flag === "--smoke") args.smoke = true;
		else if (flag === "--scenario") {
			const ids = (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
			if (ids.length === 0) throw new Error("--scenario 需要 id，逗号分隔");
			args.scenarios = ids;
		} else if (flag === "--rounds") {
			if (value === undefined || !NUMBER.test(value) || Number(value) < 1) throw new Error("--rounds 需要正整数");
			args.rounds = Number(value);
		} else if (flag === "--timeout") {
			if (value === undefined || !NUMBER.test(value) || Number(value) < 1000) throw new Error("--timeout 需要 ≥1000 的毫秒数");
			args.timeoutMs = Number(value);
		} else if (flag === "--settings") {
			if (value === undefined || value === "") throw new Error("--settings 需要文件路径");
			args.settings = value;
		} else if (flag === "--out") {
			if (value === undefined || value === "") throw new Error("--out 需要目录");
			args.out = value;
		} else {
			throw new Error(`不认识的参数：${raw}（用 --list 看场景）`);
		}
	}
	if (args.smoke && args.rounds !== 1) {
		throw new Error("--smoke 只用于 1 轮脚手架检查：加 --rounds=1");
	}
	return args;
}
