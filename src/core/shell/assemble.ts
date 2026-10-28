/**
 * 外壳：把「文件夹」和「库」缝在一起。
 *
 * 这一份文件是新核心的**唯一装配点**。它做四件事，顺序不能变：
 *
 * 1. **装能力包**：注册表是内存态、不持久化，必须先装再开会话（否则重启后所有
 *    agent 都失去工具，而它们自己看不出来）。
 * 2. **扫文件夹**：`agents/<slug>/identity.md` 就是 agent 的全部事实。扫出谁存在。
 * 3. **给每个 agent 开会话**：会话 id 是底层分配的，所以要写进名册（`core.directory`）。
 *    已有的会话复用，没有的新建 —— 这样重启不会重复造人。
 * 4. **播种频道**：只有一条「公司」频道，成员是所有 agent + 老板。别的频道谁需要谁建。
 *
 * 这里没有「CEO」「CTO」这些字。谁是谁的上级，全在 `identity.md` 的 `manager` 字段里；
 * 谁是「离老板最近的人」，就是 `manager: owner` 的那一个 —— 由文档决定，不由代码决定。
 */
import { dirname } from "node:path";
import type { Conversation, Extension, Harness, Registry } from "../runtime/index.ts";
import {
	BACKGROUND_CONTEXT,
	defineExtension,
	type Context,
} from "../runtime/index.ts";
import { chainUp, readAllIdentities, readIdentity } from "../agent/identity.ts";
import { agentSection, renderAgentSection } from "../agent/runtime.ts";
import { createCoreTools, type CoreToolDeps } from "../channel/tools.ts";
import { ChannelDoc, OWNER, ensureChannel, personalId, projectId, upsertChannel, type ChannelState, type Message } from "../channel/state.ts";
import { membersOfProject, readProject } from "../project/doc.ts";
import { DirectoryDoc, conversationFor, emptyDirectory, type DirectoryState } from "../agent/roster.ts";
import { settleProject } from "../project/settle.ts";
import { backfillTranscripts, startTranscriptSink } from "./projector.ts";

/** 外壳配置。全部是路径和名字，没有行为开关。 */
export type CoreShellOptions = {
	/** `workspace/agents`。每个 agent 一个文件夹。 */
	readonly agentsRoot: string;
	/** `workspace/projects`。 */
	readonly projectsRoot: string;
	/** 公司频道 id。 */
	readonly companyChannel?: string;
	/** 老板显示名。只用于渲染。 */
	readonly ownerName?: string;
	/**
	 * 会话默认模型。
	 *
	 * **必须给**：底层建会话时不带 model 就是「没有模型」，第一次生成会直接失败并报
	 * `no_model`（实测：老板 @ 助理，助理一句话都说不出来，界面上看不出任何异常）。
	 * 统一在这里补：装配时给每个会话对齐一次模型，而不是在每个新建入口里各写一遍。
	 */
	readonly defaultModel?: { readonly provider: string; readonly modelId: string };
};

/** `identity.md` → 名册里的显示名投影。 */
function labelsOf(identities: readonly { readonly slug: string; readonly name?: string }[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (const identity of identities) out[identity.slug] = identity.name ?? identity.slug;
	return out;
}

export type CoreShell = {
	readonly harness: Harness;
	readonly registry: Registry;
	/** slug → 会话。已经建好的都在里面。 */
	readonly conversations: ReadonlyMap<string, Conversation>;
	/** 名册快照（只读用途；写请走工具）。 */
	readonly directory: DirectoryState;
	/** 重新扫描文件夹，给新出现的人开会话。返回新建的 slug。 */
	readonly rescan: (context?: Context) => Promise<readonly string[]>;
	/**
	 * 给某个人开会话（已存在就直接返回）。`hire` 内部就用它，外壳/测试也用同一个入口。
	 *
	 * 返回会话的数字 id（界面拿它当 `conversationId`）。
	 */
	readonly openAgent: (slug: string, context?: Context) => Promise<number>;
	/** 读一次频道状态（工具内部已自带，这个是给外壳/API 用的）。 */
	readonly channels: (context?: Context) => Promise<ChannelState>;
	/** 老板说话。宿主入口，语义与 agent 的 `say` 完全一致。 */
	readonly ownerSay: (
		options: {
			readonly channelId: string;
			readonly text: string;
			readonly replyTo?: number;
			readonly kind?: string;
		},
		context?: Context,
	) => Promise<{ readonly seq: number; readonly delivery: import("../channel/deliver.ts").DeliverResult }>;
	/**
	 * **任何**一方在频道里说话（老板走 `OWNER`，agent 走自己的 slug）。
	 *
	 * 与 `ownerSay` 是同一个动作，只差发件人是谁 —— 所以它排在 `ownerSay` 里面
	 * （`ownerSay = postAs(OWNER, ...)`），不写第二份语义。
	 */
	readonly postAs: (
		options: {
			readonly channelId: string;
			readonly from: string;
			readonly text: string;
			readonly replyTo?: number;
			readonly kind?: string;
		},
		context?: Context,
	) => Promise<{ readonly seq: number; readonly delivery: import("../channel/deliver.ts").DeliverResult }>;
	/** 名册：slug ↔ 会话 id 的当前快照（界面拿它把 slug 翻成数字 id）。 */
	readonly bindings: () => DirectoryState;
	/** 显示名：slug → `identity.md` 里的 name。 */
	readonly labelOf: (slug: string) => string;
	/** 当前所有身份（每次都重读盘：改 `identity.md` 立刻反映到档案页）。 */
	readonly identities: () => Promise<readonly import("../agent/identity.ts").Identity[]>;
	/**
	 * 补漏扫一遍所有项目频道，把「该沉淀但还没等到答复」的结论再问一次。
	 *
	/** 按项目文件重建它的频道成员（幂等）。`write_project` 里用过，界面也用它。 */
	readonly syncProject: (project: string, context?: Context) => Promise<void>;
	/**
	 * 某人**此刻**会看到的提示词原文。
	 *
	 * 给自测与调试用：断言「规矩真的进了提示词」时不该靠猜。它调的是会话里同一个
	 * section 的 `render`，所以拿到的就是模型下次开口时会读到的东西。
	 */
	readonly promptOf: (slug: string, context?: Context) => Promise<string>;
	readonly agentsRoot: string;
	readonly projectsRoot: string;
	readonly companyChannel: string;
	/** 停止「会话记录 → 个人频道」的投影订阅。 */
	readonly stopTranscript: () => void;
	readonly close: (context?: Context) => Promise<void>;
};

/**
 * 装配。
 *
 * `harness` 与 `registry` 由调用方先建好（`openCore` 的产物），因为打开库与装配是
 * 两件不同的事：前者是运行时，后者是本应用的组织语义。
 */
export async function assembleCore(
	harness: Harness,
	registry: Registry,
	options: CoreShellOptions,
	context: Context = BACKGROUND_CONTEXT,
): Promise<CoreShell> {
	const companyChannel = options.companyChannel ?? "company";
	// `agents/`、`projects/`、`skills/` 是同级目录，工作区根 = agentsRoot 的父目录。
	const workspaceRoot = dirname(options.agentsRoot);

	// ── 1. 装能力包 ────────────────────────────────────────────────
	const baseDeps: CoreToolDeps = {
		harness,
		workspaceRoot,
		agentsRoot: options.agentsRoot,
		projectsRoot: options.projectsRoot,
		directory: async (ctx) => (await harness.snapshot(DirectoryDoc, ctx)) ?? emptyDirectory(),
		saveDirectory: async (change, ctx) => {
			await harness.commit(async (tx) => {
				const doc = (await tx.doc(DirectoryDoc)) as DirectoryState;
				Object.assign(doc, change({ ...emptyDirectory(), ...doc }));
			}, ctx);
		},
		openAgent: async (slug, ctx) => (await openOne(slug, ctx)).id as unknown as number,
	};
	// 项目记忆的自动沉淀：一条消息落地后，若它带着 `decision` / `report` 标签且落在
	// 项目频道里，就叫这个项目里该负责的人把它沉淀进 `projects/<slug>/memory.md`。
	// 条件是「形状」（kind），判断是「语义」（模型写什么），分工见 project/settle.ts。
	const afterPost = makeAfterPost(harness, options.agentsRoot, options.projectsRoot, () => conversations);
	const toolDeps: CoreToolDeps = {
		...baseDeps,
		afterPost,
		// 项目文件是事实，频道成员是投影。改了 `owner` 就得重投影一次。
		syncProject: async (project, ctx) => {
			await syncProjectChannel(project, ctx);
		},
	};
	const tools = createCoreTools(toolDeps);
	const toolsExtension = defineExtension({ name: "core-tools", tools });

	// 身份段落：每个 agent 装的扩展不一样（key 里带 slug），所以这里是一个工厂。
	const identityExtension = (slug: string): Extension =>
		defineExtension({
			name: `core-identity:${slug}`,
			sections: [
				agentSection(
					registry,
					{ workspace: workspaceRoot, agents: options.agentsRoot, projects: options.projectsRoot },
					slug,
				),
			],
		});

	registry.install(toolsExtension);

	/**
	 * 装一个人的身份段落。
	 *
	 * 关键：`agent.extensions` 是**按名字**从注册表里解析的，名字找不到就被静默丢弃
	 * （实测踩过：会话里一个 section 都没有，模型完全不知道自己的身份）。
	 * 所以每加一个人都必须先 install 它自己的身份扩展。
	 */
	function installIdentity(slug: string): Extension {
		const extension = identityExtension(slug);
		registry.install(extension);
		return extension;
	}

	// ── 2 & 3. 扫文件夹 + 开会话 ──────────────────────────────────
	const identities = await readAllIdentities(options.agentsRoot);
	const directory: DirectoryState = (await harness.snapshot(DirectoryDoc, context)) ?? emptyDirectory();
	const conversations = new Map<string, Conversation>();

	/** 给一个 slug 开会话（内部用：先查名册，再建）。 */
	async function openOne(slug: string, ctx: Context): Promise<Conversation> {
		const existing = conversations.get(slug);
		if (existing !== undefined) return existing;
		const known = directory.slugToConversation[slug];
		if (known !== undefined) {
			const found = await harness.conversation(known as never, ctx);
			if (found !== undefined) {
				// 已有会话也要补一次模型：老库里可能存着 `no_model`，或者建它的时候
				// 还没配模型。`configure` 不改已有对话历史，只改这次选用的模型。
				await applyModel(found, ctx);
				// 也补一次身份扩展（幂等）：`hire` 时会立刻开会话，那时还没重启，
				// 注册表里没有它的身份段落。不补的话它醒过来不知道自己是谁。
				installIdentity(slug);
				conversations.set(slug, found);
				// 已有会话也要补一次个人频道与项目频道：老工作区里的人在个人频道/项目频道
				// 出现之前建的，或者 `identity.md` 里刚补上 `project:`。两个都是幂等的。
				await ensurePersonalChannel(slug, ctx);
				await joinProjectChannel(slug, ctx);
				return found;
			}
		}
		const created = await harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: {
					// 扩展是**按名字选的**：漏了 `core-tools` 这个人就一个工具都没有（实测踩过）。
					extensions: [toolsExtension, installIdentity(slug)],
					// 模型在建会话时一次给全，不要等第一次生成才发现没有模型。
					...(options.defaultModel === undefined
						? {}
						: { model: { provider: options.defaultModel.provider, modelId: options.defaultModel.modelId } }),
				},
			},
			ctx,
		);
		conversations.set(slug, created);
		const id = created.id as unknown as number;
		directory.slugToConversation[slug] = id;
		directory.conversationToSlug[String(id)] = slug;
		// 一建出来就进公司频道、个人频道、项目频道。
		//
		// 踩过的坑：`hire` 会立刻开会话，但公司频道的成员是**启动时**按当时的
		// `agents/` 目录写死的。结果新人存在、会话也存在，却不在频道里 —— 别人
		// @ 他，`recipientsOf` 第一规则「@ 的必须是成员」把他过滤掉，消息静默不投递，
		// 界面上看起来就是「招了个人但叫不动」。
		await addToCompanyChannel(slug, ctx);
		// 个人频道 = 他与老板的私聊。每个人从出生就该有一个：他的日常记录落在这里，
		// 需要别人看见的才去公司/项目频道。没有它，「向上汇报」连个落点都没有。
		await ensurePersonalChannel(slug, ctx);
		await joinProjectChannel(slug, ctx);
		return created;
	}

	/** 把人加进公司频道（幂等）。 */
	async function addToCompanyChannel(slug: string, ctx: Context): Promise<void> {
		await harness.commit(async (tx) => {
			const doc = (await tx.doc(ChannelDoc)) as ChannelState;
			const channel = doc.channels[companyChannel];
			if (channel === undefined) return;
			if (channel.members.includes(slug)) return;
			// 整体替换，不就地 push：读出来的是副本，就地改不产生 op。
			doc.channels[companyChannel] = { ...channel, members: [...channel.members, slug] };
		}, ctx);
	}

	/**
	 * 给这个人建个人频道（幂等）。
	 *
	 * 个人频道就是他与老板的私聊（`personalId` = `dm:owner-<slug>`）。它同时承担两件事：
	 * 他的日常记录落在这里；以及拍板链的顶端 —— 他（或他的上级）拍不了板时，就在这个
	 * 频道里问老板。所以它必须从出生就存在，而不是等到第一次私聊才被顺手建出来。
	 */
	async function ensurePersonalChannel(slug: string, ctx: Context): Promise<void> {
		if (slug === OWNER) return;
		await harness.commit(async (tx) => {
			const doc = (await tx.doc(ChannelDoc)) as ChannelState;
			const identity = await readIdentity(options.agentsRoot, slug);
			Object.assign(
				doc,
				upsertChannel(doc, {
					id: personalId(slug),
					title: identity?.name ?? slug,
					members: [OWNER, slug],
					wakeOnAll: [],
					at: Date.now(),
				}),
			);
		}, ctx);
	}

	/**
	 * 把这个人拉进它所属项目的频道（幂等）。项目频道不存在就建。
	 *
	 * 频道 id 用 `proj:<slug>`（与 `src/core/channel/state.ts` 的 `projectId()` 一致），
	 * 因为沉淀逻辑靠这个前缀认出「这是项目频道」。
	 *
	 * 成员不只是「进来的人」：项目 `README.md` 里写了谁负责（`owner`），那个人就必须在
	 * 频道里 —— 否则项目里出了问题，员工连派活的人都 @ 不到。老板也始终在里面，
	 * 因为拍板链的最后一环是他。
	 */
	async function joinProjectChannel(slug: string, ctx: Context): Promise<void> {
		const identity = await readIdentity(options.agentsRoot, slug);
		const project = identity?.project;
		if (project === undefined || project === "") return;
		await syncProjectChannel(project, ctx);
	}

	/**
	 * 按「项目文件写的事实」重建一个项目频道的成员表（幂等）。
	 *
	 * 成员 = 老板 + 项目负责人 + 负责人的整条汇报线（向上到老板，含知言这类统筹者）
	 * + 所有 `identity.md` 里 `project:` 指向它的人。
	 * 负责人在 `projects/<slug>/README.md` 的 `owner` 里 —— 那是文档的事实，代码照抄，
	 * 不猜「谁该负责」。负责人还没定就只少那一个人，频道照样建。
	 *
	 * 为什么要把负责人的上级（通常是知言）也拉进项目频道：知言要在项目频道里给
	 * 负责人派活、负责人要向知言汇报（见 ADR-024）。缺了知言，项目频道里 @ 不到她，
	 * 「知言 ↔ 负责人在项目频道协作」就落不下。
	 *
	 * 成员表是事实的投影，所以用「精确重算后整体替换」而不是「只加不删」：
	 * 一旦某人不再在负责人汇报线里、或不再 `project:` 指向它，他就该从项目频道消失；
	 * 只加不删会留下 `gunanyan` 这类幽灵成员（实测：改名/重建后旧 slug 残留在成员表里，
	 * 界面上显示成一个连不上会话的人）。
	 */
	async function syncProjectChannel(project: string, ctx: Context): Promise<void> {
		const [doc, all] = await Promise.all([
			readProject(options.projectsRoot, project),
			readAllIdentities(options.agentsRoot),
		]);
		const owner = doc?.owner;
		// 负责人的整条汇报线（向上到老板，不含自己）：让知言这类统筹者也进项目频道。
		const chain = owner === undefined || owner === "" ? [] : chainUp(all, owner);
		const members = Array.from(
			new Set([
				OWNER,
				...(owner === undefined || owner === "" ? [] : [owner]),
				...chain,
				...membersOfProject(all, project),
			]),
		);
		// 项目频道里**任何人说话都叫醒负责人**。项目频道只为这一个项目而存在，
		// 负责人本来就要看见全部进展；不这样设，员工说「做完了」而没 @ 人，负责人
		// 就永远收不到 —— 实测里 agent 因此用 `run sleep 120` 轮询等进度，白烧一轮。
		const wakeOnAll = owner === undefined || owner === "" ? [] : [owner];
		await harness.commit(async (tx) => {
			const state = (await tx.doc(ChannelDoc)) as ChannelState;
			const id = projectId(project);
			const existing = state.channels[id];
			const title = doc?.name ?? project;
			if (existing === undefined) {
				// 频道还不存在：建。
				Object.assign(
					state,
					ensureChannel(state, { id, title, members, wakeOnAll, at: Date.now() }),
				);
			} else {
				// 已存在：成员表整体替换为事实投影（去幽灵、补统筹），唤醒表同理。
				state.channels[id] = { ...existing, members, title, wakeOnAll };
			}
		}, ctx);
	}

	/** 补模型（幂等：已经是这个模型就不写，避免每次重启都产生一次提交）。 */
	async function applyModel(conversation: Conversation, ctx: Context): Promise<void> {
		if (options.defaultModel === undefined) return;
		const agent = await conversation.agent(ctx);
		const current = agent.model;
		if (
			current !== undefined &&
			current.provider === options.defaultModel.provider &&
			current.modelId === options.defaultModel.modelId
		) {
			return;
		}
		await conversation.configure(
			{ model: { provider: options.defaultModel.provider, modelId: options.defaultModel.modelId } },
			ctx,
		);
	}

	for (const identity of identities) {
		await openOne(identity.slug, context);
	}

	// 名册落盘（一次提交，不是每人一次）。
	await harness.commit(async (tx) => {
		const doc = (await tx.doc(DirectoryDoc)) as DirectoryState;
		Object.assign(doc, {
			slugToConversation: { ...doc.slugToConversation, ...directory.slugToConversation },
			conversationToSlug: { ...doc.conversationToSlug, ...directory.conversationToSlug },
			labels: { ...doc.labels, ...labelsOf(identities) },
		});
		directory.labels = { ...doc.labels };
	}, context);

	// ── 4. 播种公司频道 ──────────────────────────────────────────
	await harness.commit(async (tx) => {
		const doc = (await tx.doc(ChannelDoc)) as ChannelState;
		const members = [OWNER, ...identities.map((item) => item.slug)];
		if (doc.channels[companyChannel] === undefined) {
			Object.assign(doc, ensureChannel(doc, { id: companyChannel, title: "公司", members, wakeOnAll: [], at: Date.now() }));
		} else {
			// 频道已存在：把新出现的人加进去（老板永远在）。
			const channel = doc.channels[companyChannel];
			if (channel !== undefined) {
				// 整体替换频道记录，不用 push / 不用就地改：文档读出来的是副本，
				// 就地改不产生 op（实测消息会静默消失）。
				const missing = members.filter((member) => !channel.members.includes(member));
				if (missing.length > 0) {
					doc.channels[companyChannel] = { ...channel, members: [...channel.members, ...missing] };
				}
			}
		}
	}, context);


	// ── 5. 投影订阅：会话里的思考/文案/工具调用 → 个人频道 ──────────
	// 必须在名册与频道都就绪之后才开。
	// 先回填历史：把每个 agent 会话里还没投影过的 `pi.assistant` 条目补进个人频道。
	// 只读已经落库的会话记录，不阻止主流程；失败也只在日志里丢一条，不影响启动。
	try {
		await backfillTranscripts(harness, directory, context);
	} catch (error) {
		console.error("[core] 历史投影回填失败（已忽略，不影响启动）：", error);
	}
	const unsubscribeTranscript = startTranscriptSink(harness, directory);

	const shell: CoreShell = {
		harness,
		registry,
		conversations,
		directory,
		async syncProject(project: string, ctx: Context = BACKGROUND_CONTEXT): Promise<void> {
			await syncProjectChannel(project, ctx);
		},
		async promptOf(slug: string): Promise<string> {
			return renderAgentSection(
				registry,
				{ workspace: workspaceRoot, agents: options.agentsRoot, projects: options.projectsRoot },
				slug,
			);
		},
		async rescan(ctx: Context = BACKGROUND_CONTEXT): Promise<readonly string[]> {
			const all = await readAllIdentities(options.agentsRoot);
			const added: string[] = [];
			for (const identity of all) {
				if (conversations.has(identity.slug)) {
					// 已经开着会话的人也要补一次项目频道：`identity.md` 里刚加上
					// `project:` 的人，不重扫就永远进不了那个项目的频道（幂等）。
					await joinProjectChannel(identity.slug, ctx);
					continue;
				}
				await openOne(identity.slug, ctx);
				added.push(identity.slug);
			}
			if (added.length > 0) {
				await harness.commit(async (tx) => {
					const doc = (await tx.doc(DirectoryDoc)) as DirectoryState;
					Object.assign(doc, {
						slugToConversation: { ...doc.slugToConversation, ...directory.slugToConversation },
						conversationToSlug: { ...doc.conversationToSlug, ...directory.conversationToSlug },
						// 每次 rescan 都把显示名刷新一遍：`identity.md` 改名后不用清库。
						labels: { ...doc.labels, ...labelsOf(all) },
					});
					directory.labels = { ...doc.labels };
					const channelDoc = (await tx.doc(ChannelDoc)) as ChannelState;
					const channel = channelDoc.channels[companyChannel];
					if (channel !== undefined) {
						const missing = added.filter((slug) => !channel.members.includes(slug));
						if (missing.length > 0) {
							channelDoc.channels[companyChannel] = { ...channel, members: [...channel.members, ...missing] };
						}
					}
				}, ctx);
			}
			return added;
		},
		/** 停止「会话记录 → 个人频道」的投影订阅。 */
		stopTranscript: () => unsubscribeTranscript(),
		async channels(ctx: Context = BACKGROUND_CONTEXT): Promise<ChannelState> {
			return (await harness.snapshot(ChannelDoc, ctx)) ?? { channels: {}, messages: {}, nextSeq: {}, readMarks: {} };
		},
		openAgent: async (slug: string, ctx: Context = BACKGROUND_CONTEXT) => (await openOne(slug, ctx)).id as unknown as number,
		ownerSay: (input, ctx) => ownerSpeak(shell, input, ctx),
		postAs: (input, ctx) => ownerSpeak(shell, input, ctx),
		bindings: () => directory,
		labelOf: (slug: string) => (slug === OWNER ? "老板" : (directory.labels[slug] ?? slug)),
		identities: () => readAllIdentities(options.agentsRoot),
		agentsRoot: options.agentsRoot,
		projectsRoot: options.projectsRoot,
		companyChannel,
		close: (ctx?: Context) => harness.close(ctx ?? context),
	};

	return shell;
}


/**
 * 造「一条消息落地之后」的钩子：项目记忆自动沉淀。
 *
 * 只在**项目频道** + **decision/report** 时才动 —— 这两个条件是形状判据，代码判得准。
 * 写什么由模型（`remember(scope=project)`）决定，代码不猜语义。
 */
function makeAfterPost(
	harness: Harness,
	agentsRoot: string,
	projectsRoot: string,
	live: () => ReadonlyMap<string, Conversation>,
): (message: Message, channelId: string, context: Context) => Promise<void> {
	return async (message, channelId, context) => {
		if (!channelId.startsWith("proj:")) return;
		if (message.kind !== "decision" && message.kind !== "report") return;
		await settleProject(
			{
				harness,
				agentsRoot,
				projectsRoot,
				channelState: async () =>
					(await harness.snapshot(ChannelDoc, context)) ?? { channels: {}, messages: {}, nextSeq: {}, readMarks: {} },
				// 先查内存里的会话表：名册是异步落盘的，刚 `hire` 出来的人可能还没写进去
				// （实测：新招的人被静默算成「没有人能写」）。名册只作为兜底。
				conversationOf: async (slug) => {
					const known = live().get(slug);
					if (known !== undefined) return known;
					const dir = (await harness.snapshot(DirectoryDoc, context)) ?? emptyDirectory();
					const id = conversationFor(dir, slug);
					if (id === undefined) return undefined;
					return harness.conversation(id as never, context);
				},
			},
			channelId.slice("proj:".length),
			context,
		);
	};
}

/**
 * 老板开口：把老板的一句话投进频道。
 *
 * 老板不是 agent（没有会话、没有提示词），所以它不能走 `say` 工具，需要一个宿主入口。
 * 语义与 agent 完全一致：同一套 @ 解析、同一套收件人规则、同一套投递。
 */
export async function ownerSpeak(
	shell: CoreShell,
	options: {
		readonly channelId: string;
		readonly text: string;
		/** 谁说这句话。缺省是老板。 */
		readonly from?: string;
		readonly replyTo?: number;
		/**
		 * 消息语义标签。`decision` / `report` 会被项目记忆自动沉淀（见 `project/settle.ts`）。
		 * 老板在项目频道里拍板时要带上 —— 那是最该进记忆的东西。
		 */
		readonly kind?: string;
	},
	context: Context = BACKGROUND_CONTEXT,
): Promise<{ readonly seq: number; readonly delivery: import("../channel/deliver.ts").DeliverResult }> {
	const state = await shell.channels(context);
	const channel = state.channels[options.channelId];
	if (channel === undefined) throw new Error(`频道不存在：${options.channelId}`);
	const { postMessage } = await import("../channel/post.ts");
	const { conversationFor } = await import("../agent/roster.ts");
	const result = await postMessage(
		{
			harness: shell.harness,
			state,
			conversationOf: async (slug: string) => {
				const id = conversationFor(shell.directory, slug);
				if (id !== undefined) {
					const found = await shell.harness.conversation(id as never, context);
					if (found !== undefined) return found;
				}
				return shell.conversations.get(slug);
			},
			labelOf: (slug: string) => (slug === OWNER ? "老板" : (shell.directory.labels[slug] ?? slug)),
			// 老板说话也要记「谁在哪个频道被叫醒」。不传这一项，被叫的人回话时
			// 查不到 wake，只能退到「我最早的那个频道」—— 那往往是个人频道，
			// 于是老板在公司频道问话、对方在私聊里答，问到的人什么都看不到。
			rememberWake: async (slug: string, wake) => {
				const id = conversationFor(shell.directory, slug);
				if (id === undefined) return;
				await shell.harness.commit(async (tx) => {
					const doc = (await tx.doc(DirectoryDoc)) as DirectoryState;
					Object.assign(doc, {
						...doc,
						wake: { ...doc.wake, [String(id)]: { ...wake } },
					});
				}, context);
			},
		},
		{
			channelId: options.channelId,
			from: options.from ?? OWNER,
			text: options.text,
			at: Date.now(),
			...(options.replyTo === undefined ? {} : { replyTo: options.replyTo }),
			...(options.kind === undefined ? {} : { kind: options.kind }),
		},
		context,
	);
	// 老板在项目频道里拍板也要沉淀：它不是 agent，不会走工具层，这条路径得自己调。
	await makeAfterPost(shell.harness, shell.agentsRoot, shell.projectsRoot, () => shell.conversations)(
		result.message,
		options.channelId,
		context,
	);
	return { seq: result.message.seq, delivery: result.delivery };
}