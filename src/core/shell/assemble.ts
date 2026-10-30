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
 * 4. **播种频道**：只有一条公司群（所有人自动加入、仅此一次），其余会话谁需要谁建。
 *    会话只有两种形态（私聊 / 群聊），由 `chatKind` 按成员推 —— 没有「个人频道」。
 *
 * 这里没有「CEO」「CTO」这些字。谁是谁的上级，全在 `identity.md` 的 `manager` 字段里；
 * 谁是「离我最近的人」，就是 `manager: owner` 的那一个 —— 由文档决定，不由代码决定。
 */
import { dirname } from "node:path";
import type { Conversation, Extension, Harness, Registry } from "../runtime/index.ts";
import {
	BACKGROUND_CONTEXT,
	defineExtension,
	type Context,
} from "../runtime/index.ts";
import { chainUp, readAllIdentities, readIdentity } from "../agent/identity.ts";
import { agentSections, renderAgentSection, type ChatRef } from "../agent/runtime.ts";
import { createCoreTools, type CoreToolDeps } from "../channel/tools.ts";
import { mentionRosterOf } from "../channel/alias.ts";
import {
	ChannelDoc,
	OWNER,
	chatKind,
	channelsOf,
	teamId,
	upsertChannel,
	type Attachment,
	type ChannelState,
	type Message,
} from "../channel/state.ts";
import { uploadsRootOf } from "../channel/uploads.ts";
import { promptDirOf } from "../prompt.ts";
import { postMessage } from "../channel/post.ts";
import { coalesceQueue } from "../channel/deliver.ts";
import { membersOfTeam, readTeam } from "../team/doc.ts";
import { DirectoryDoc, conversationFor, emptyDirectory, type DirectoryState } from "../agent/roster.ts";
import { settleTeam } from "../team/settle.ts";
import { startAnswerRescue } from "./rescue.ts";
import { labelIn } from "../view/index.ts";
import type { CoreServices } from "../app/types.ts";

/** 外壳配置。全部是路径和名字，没有行为开关。 */
type CoreShellOptions = {
	/** `workspace/agents`。每个 agent 一个文件夹。 */
	readonly agentsRoot: string;
	/** `workspace/teams`。 */
	readonly teamsRoot: string;
	/** 公司频道 id。 */
	readonly companyChannel?: string;
	/**
	 * 会话默认模型。
	 *
	 * **必须给**：底层建会话时不带 model 就是「没有模型」，第一次生成会直接失败并报
	 * `no_model`（实测：我 @ 助理，助理一句话都说不出来，界面上看不出任何异常）。
	 * 统一在这里补：装配时给每个会话对齐一次模型，而不是在每个新建入口里各写一遍。
	 */
	readonly defaultModel?: { readonly provider: string; readonly modelId: string };
	/**
	 * 诊断出口。给了就用它（`openCore` 的 `onReport` 已经往里报）；不给就由 `app/`
	 * 自己建一个。装配要传入**同一个实例**，否则 `lastReport` 不在那条线上。
	 */
	readonly diag?: CoreServices["diag"];
};

/** `identity.md` → 名册里的显示名投影。 */
function labelsOf(identities: readonly { readonly slug: string; readonly name?: string }[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (const identity of identities) out[identity.slug] = identity.name ?? identity.slug;
	return out;
}

/**
 * 装配结果的形状。
 *
 * 类型本体住在 `src/core/app/types.ts`：用例层（app）要拿它当入参，而依赖方向是
 * `shell → app`，所以这份形状不能反过来定义在外壳里。这里只留一个别名，
 * 免得老调用方（测试、`main.ts`）全都要改。
 */
export type CoreShell = CoreServices;

/** 名册的顶层字段（写回去时要逐字段比，不能整份替换）。 */
const DIRECTORY_KEYS = ["slugToConversation", "conversationToSlug", "wake", "labels"] as const;

/**
 * 把名册文档抄成纯数据。
 *
 * 为什么必须抄：`tx.doc()` 给的是**覆盖层代理**，它的嵌套值也是代理。把代理的值原样
 * 写回同一个覆盖层会静默丢数据（见 `saveDirectory` 的注释）。这份文档很小（几个人 +
 * 唤醒记录），JSON 来回一次比任何「小心地读代理」都便宜且确定。
 */
function plainDirectory(source: DirectoryState): DirectoryState {
	const json = JSON.stringify({
		slugToConversation: source.slugToConversation ?? {},
		conversationToSlug: source.conversationToSlug ?? {},
		wake: source.wake ?? {},
		labels: source.labels ?? {},
	});
	return JSON.parse(json) as DirectoryState;
}

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
	const companyChannel = options.companyChannel ?? "all";
	// `agents/`、`teams/`、`skills/` 是同级目录，工作区根 = agentsRoot 的父目录。
	const workspaceRoot = dirname(options.agentsRoot);

	// ── 1. 装能力包 ────────────────────────────────────────────────
	const baseDeps: CoreToolDeps = {
		harness,
		workspaceRoot,
		agentsRoot: options.agentsRoot,
		teamsRoot: options.teamsRoot,
		directory: async (ctx) => (await harness.snapshot(DirectoryDoc, ctx)) ?? emptyDirectory(),
		saveDirectory: async (change, ctx) => {
			await harness.commit(async (tx) => {
				const doc = (await tx.doc(DirectoryDoc)) as DirectoryState;
				// **只写变化过的字段**，并且先抄成纯数据。
				//
				// 旧写法是 `Object.assign(doc, change({ ...emptyDirectory(), ...doc }))`：
				// 把「文档代理展开出来的整份状态」原样写回去。展开出来的是**覆盖层的节点**，
				// 再写回同一个覆盖层，等于拿旧节点覆盖新值 —— 表现就是「名册里少一个人」，
				// 而且没有任何报错（顾南雁的映射就是这么丢的）。
				const before = plainDirectory(doc);
				const after = change(before);
				for (const key of DIRECTORY_KEYS) {
					if (JSON.stringify(after[key]) === JSON.stringify(before[key])) continue;
					// 一个字段一次写：路径式更新，不会连带重写整份名册。
					doc[key] = after[key] as never;
				}
			}, ctx);
		},
		openAgent: async (slug, ctx) => (await openOne(slug, ctx)).id as unknown as number,
	};
	// 团队记忆的自动沉淀：一条消息落地后，若它带着 `decision` / `report` 标签且落在
	// 团队频道里，就叫这个团队里该负责的人把它沉淀进 `teams/<slug>/memory.md`。
	// 条件是「形状」（kind），判断是「语义」（模型写什么），分工见 team/settle.ts。
	const afterPost = makeAfterPost(harness, options.agentsRoot, options.teamsRoot, () => conversations);
	const toolDeps: CoreToolDeps = {
		...baseDeps,
		afterPost,
		// 团队文件是事实，频道成员是投影。改了 `lead` 就得重投影一次。
		syncTeam: async (team, ctx) => {
			await syncTeamChannel(team, ctx);
		},
	};
	const tools = createCoreTools(toolDeps);
	const toolsExtension = defineExtension({ name: "core-tools", tools });

	/**
	 * 某人此刻在哪些会话里（提示词「你在组织里的位置」一节要用）。
	 *
	 * 私聊还是群聊由成员推（`chatKind`），不靠 id 前缀 —— `all` 和 `team:x` 在这里
	 * 都是“群”，没有谁特殊。
	 */
	async function chatRefsOf(slug: string): Promise<readonly ChatRef[]> {
		const state = await harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT);
		if (state === undefined) return [];
		return channelsOf(state, slug).map((channel) => ({ id: channel.id, title: channel.title, kind: chatKind(channel) }));
	}

	// 身份段：每个 agent 装的扩展不一样（key 里带 slug），所以这里是一个工厂。
	// 一个人有 8 段（身份/规矩/位置/团队/能力/记忆/技能/目录），底座按段做最小 patch。
	const identityExtension = async (slug: string): Promise<Extension> =>
		defineExtension({
			name: `core-identity:${slug}`,
			sections: await agentSections(
				registry,
				{ workspace: workspaceRoot, agents: options.agentsRoot, teams: options.teamsRoot, chats: chatRefsOf },
				slug,
			),
		});

	registry.install(toolsExtension);

	/**
	 * 装一个人的身份段落。
	 *
	 * 关键：`agent.extensions` 是**按名字**从注册表里解析的，名字找不到就被静默丢弃
	 * （实测踩过：会话里一个 section 都没有，模型完全不知道自己的身份）。
	 * 所以每加一个人都必须先 install 它自己的身份扩展。
	 */
	async function installIdentity(slug: string): Promise<Extension> {
		const extension = await identityExtension(slug);
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
				await installIdentity(slug);
				conversations.set(slug, found);
				// 已有会话也要补一次团队频道：老工作区里的人在团队频道出现之前建的，
				// 或者 `identity.md` 里刚补上 `team:`。两个都是幂等的。
				await joinTeamChannel(slug, ctx);
				return found;
			}
		}
		const created = await harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: {
					// 扩展是**按名字选的**：漏了 `core-tools` 这个人就一个工具都没有（实测踩过）。
					extensions: [toolsExtension, await installIdentity(slug)],
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
		// **建完会话立刻把映射落盘**：旧代码只改内存，靠启动/`rescan` 的批量提交顺带写下去。
		// `hire` 走的是 `openAgent`（会创建会话）而不是 `rescan`，中间一旦有别的提交把名册
		// 写回旧值，这个人的映射就永久丢了 —— 重启后他会拿到一个新会话，旧会话变孤儿
		// （顾南雁的 1861 就是这样，22 条历史留在里面没人接）。
		await harness.commit(async (tx) => {
			const doc = (await tx.doc(DirectoryDoc)) as DirectoryState;
			const before = plainDirectory(doc);
			doc.slugToConversation = { ...before.slugToConversation, [slug]: id };
			doc.conversationToSlug = { ...before.conversationToSlug, [String(id)]: slug };
		}, ctx);
		// 一建出来就进公司频道、团队频道。
		//
		// 踩过的坑：`hire` 会立刻开会话，但公司频道的成员是**启动时**按当时的
		// `agents/` 目录写死的。结果新人存在、会话也存在，却不在频道里 —— 别人
		// @ 他，`recipientsOf` 第一规则「@ 的必须是成员」把他过滤掉，消息静默不投递，
		// 界面上看起来就是「招了个人但叫不动」。
		await addToCompanyChannel(slug, ctx);
		await joinTeamChannel(slug, ctx);
		return created;
	}

	/**
	 * 把人加进公司频道（幂等）。
	 *
	 * 「有则并成员、无则建」的规矩只在 `channel/state.ts` 的 `upsertChannel` 里写一次；
	 * 公司频道不存在时这里什么都不做（它由播种建，招人只是往里加人）。
	 */
	async function addToCompanyChannel(slug: string, ctx: Context): Promise<void> {
		await harness.commit(async (tx) => {
			const doc = (await tx.doc(ChannelDoc)) as ChannelState;
			const channel = doc.channels[companyChannel];
			if (channel === undefined) return;
			// 整体替换，不就地 push：读出来的是副本，就地改不产生 op。
			Object.assign(doc, upsertChannel(doc, { id: companyChannel, title: channel.title, members: [slug], at: Date.now() }));
		}, ctx);
	}

	/**
	 * 把这个人拉进它所属团队的频道（幂等）。团队频道不存在就建。
	 *
	 * 频道 id 用 `team:<slug>`（与 `src/core/channel/state.ts` 的 `teamId()` 一致），
	 * 因为沉淀逻辑靠这个前缀认出「这是团队频道」。
	 *
	 * 成员不只是「进来的人」：团队 `README.md` 里写了谁负责（`lead`），那个人就必须在
	 * 频道里 —— 否则团队里出了问题，员工连派活的人都 @ 不到。我也始终在里面，
	 * 因为拍板链的最后一环是他。
	 */
	async function joinTeamChannel(slug: string, ctx: Context): Promise<void> {
		const identity = await readIdentity(options.agentsRoot, slug);
		const team = identity?.team;
		if (team === undefined || team === "") return;
		await syncTeamChannel(team, ctx);
	}

	/**
	 * 按「团队文件写的事实」重建一个团队频道的成员表（幂等）。
	 *
	 * 成员 = 我 + 团队管理员 + 团队管理员的整条汇报线（向上到我，含知言这类统筹者）
	 * + 所有 `identity.md` 里 `team:` 指向它的人。
	 * 团队管理员在 `teams/<slug>/README.md` 的 `lead` 里 —— 那是文档的事实，代码照抄，
	 * 不猜「谁该负责」。团队管理员还没定就只少那一个人，频道照样建。
	 *
	 * 为什么要把团队管理员的上级（通常是知言）也拉进团队频道：知言要在团队频道里给
	 * 团队管理员派活、团队管理员要向知言汇报（见 ADR-024）。缺了知言，团队频道里 @ 不到她，
	 * 「知言 ↔ 团队管理员在团队频道协作」就落不下。
	 *
	 * 成员表是事实的投影，所以用「精确重算后整体替换」而不是「只加不删」：
	 * 一旦某人不再在团队管理员汇报线里、或不再 `team:` 指向它，他就该从团队频道消失；
	 * 只加不删会留下 `gunanyan` 这类幽灵成员（实测：改名/重建后旧 slug 残留在成员表里，
	 * 界面上显示成一个连不上会话的人）。
	 */
	async function syncTeamChannel(team: string, ctx: Context): Promise<void> {
		const [doc, all] = await Promise.all([
			readTeam(options.teamsRoot, team),
			readAllIdentities(options.agentsRoot),
		]);
		const lead = doc?.lead;
		// 团队管理员的整条汇报线（向上到我，不含自己）：让知言这类统筹者也进团队频道。
		const chain = lead === undefined || lead === "" ? [] : chainUp(all, lead);
		const members = Array.from(
			new Set([
				OWNER,
				...(lead === undefined || lead === "" ? [] : [lead]),
				...chain,
				...membersOfTeam(all, team),
			]),
		);
		// 团队频道里**任何人说话都叫醒团队管理员**。团队频道只为这一个团队而存在，
		// 团队管理员本来就要看见全部进展；不这样设，员工说「做完了」而没 @ 人，团队管理员
		// 就永远收不到 —— 实测里 agent 因此用 `run sleep 120` 轮询等进度，白烧一轮。
		const wakeOnAll = lead === undefined || lead === "" ? [] : [lead];
		await harness.commit(async (tx) => {
			const state = (await tx.doc(ChannelDoc)) as ChannelState;
			const id = teamId(team);
			const existing = state.channels[id];
			const title = doc?.name ?? team;
			if (existing === undefined) {
				// 频道还不存在：建（同一个 `upsertChannel`，这里只是它的建群那一半）。
				Object.assign(state, upsertChannel(state, { id, title, members, wakeOnAll, at: Date.now() }));
			} else {
				// 已存在：成员表整体替换为事实投影（去幽灵、补统筹），唤醒表同理。
				// 这一步**不能**交给 `upsertChannel`：它只加不删，而这里要的是精确重算。
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
	//
	// 它就是个**普通群**：id 是 `all`、所有人自动进来，仅此而已。代码里没有任何
	// 「如果频道是 all 就……」的分支 —— 特权的地方一旦存在，第二个群就永远长不出来。
	await harness.commit(async (tx) => {
		const doc = (await tx.doc(ChannelDoc)) as ChannelState;
		const members = [OWNER, ...identities.map((item) => item.slug)];
		// 「有则并成员、无则建」：`upsertChannel` 就是这一件事的唯一实现。`wakeOnAll`
		// 只在建群那一刻写一次，之后它只是个普通字段（投递时收件人一定排除发件人、
		// 也一定排除我，所以它不会让任何人多醒一次）。
		// 整体替换文档对象，不用 push / 不用就地改：读出来的是副本，就地改不产生 op
		// （实测消息会静默消失）。
		Object.assign(
			doc,
			upsertChannel(doc, { id: companyChannel, title: "全员", members, wakeOnAll: [OWNER], at: Date.now() }),
		);
	}, context);


	// 「他答了但没说出来」的安全网：模型漏调 `say` 时替它把最终正文发出去。
	const stopAnswerRescue = startAnswerRescue(harness);

	const shell: CoreShell = {
		harness,
		registry,
		conversations,
		directory,
		// 沉淀钩子只造一个：它是无状态的（读的都是当下的事实），每次发言再造一个纯属浪费。
		afterPost,
		async syncTeam(team: string, ctx: Context = BACKGROUND_CONTEXT): Promise<void> {
			await syncTeamChannel(team, ctx);
		},
		async promptOf(slug: string): Promise<string> {
			return renderAgentSection(
				registry,
				{ workspace: workspaceRoot, agents: options.agentsRoot, teams: options.teamsRoot, chats: chatRefsOf },
				slug,
			);
		},
		async rescan(ctx: Context = BACKGROUND_CONTEXT): Promise<readonly string[]> {
			const all = await readAllIdentities(options.agentsRoot);
			const added: string[] = [];
			for (const identity of all) {
				if (conversations.has(identity.slug)) {
					// 已经开着会话的人也要补一次团队频道：`identity.md` 里刚加上
					// `team:` 的人，不重扫就永远进不了那个团队的频道（幂等）。
					await joinTeamChannel(identity.slug, ctx);
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
		async channels(ctx: Context = BACKGROUND_CONTEXT): Promise<ChannelState> {
			return (await harness.snapshot(ChannelDoc, ctx)) ?? { channels: {}, messages: {}, nextSeq: {}, readMarks: {} };
		},
		openAgent: async (slug: string, ctx: Context = BACKGROUND_CONTEXT) => (await openOne(slug, ctx)).id as unknown as number,
		ownerSay: (input, ctx) => ownerSpeak(shell, input, ctx),
		postAs: (input, ctx) => ownerSpeak(shell, input, ctx),
		bindings: () => directory,
		labelOf: (slug) => labelIn(directory, slug),
		identities: () => readAllIdentities(options.agentsRoot),
		agentsRoot: options.agentsRoot,
		teamsRoot: options.teamsRoot,
		companyChannel,
		...(options.diag === undefined ? {} : { diag: options.diag }),
		close: async (ctx?: Context) => {
			// 这个订阅是「读会话、写频道」，关库之前先停掉，免得它对着已关闭的库再提交一次。
			stopAnswerRescue();
			await harness.close(ctx ?? context);
		},
	};

	return shell;
}


/**
 * 造「一条消息落地之后」的钩子：团队记忆自动沉淀。
 *
 * 只看一件事：这条消息落在**团队频道**里（形状判据）。哪些消息值得进记忆、什么该记
 * 什么不该记，都由模型按公司技能「记忆整理」判断 —— 代码不按 `kind` 也不按语义拦。
 */
function makeAfterPost(
	harness: Harness,
	agentsRoot: string,
	teamsRoot: string,
	live: () => ReadonlyMap<string, Conversation>,
): (message: Message, channelId: string, context: Context) => Promise<void> {
	return async (_message, channelId, context) => {
		if (!channelId.startsWith("team:")) return;
		await settleTeam(
			{
				harness,
				agentsRoot,
				teamsRoot,
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
				// 沉淀和投递走同一条 `wake()`：回话规矩同一个来源、同样合并唤醒、
				// 没产出同样在频道里留一句（以前这条路上什么都没有）。
				promptDir: promptDirOf(agentsRoot),
				coalesceQueue: (conversationId, keepRequestId) =>
					coalesceQueue(harness, conversationId, keepRequestId, context),
				// 留痕里用 slug：这一层拿不到显示名表，而留痕是给人看位置，不是给人看称呼。
				labelOf: (slug) => slug,
			},
			channelId.slice("team:".length),
			context,
		);
	};
}

/**
 * 我开口：把我的一句话投进频道。
 *
 * 我不是 agent（没有会话、没有提示词），所以它不能走 `say` 工具，需要一个宿主入口。
 * 语义与 agent 完全一致：同一套 @ 解析、同一套收件人规则、同一套投递。
 */
export async function ownerSpeak(
	shell: CoreShell,
	options: {
		readonly channelId: string;
		readonly text: string;
		/** 谁说这句话。缺省是我。 */
		readonly from?: string;
		readonly replyTo?: number;
		/**
		 * 消息语义标签。`decision` / `report` 会被团队记忆自动沉淀（见 `team/settle.ts`）。
		 * 我在团队频道里拍板时要带上 —— 那是最该进记忆的东西。
		 */
		readonly kind?: string;
		/** 附件引用（图片会被读成内容块交给模型）。 */
		readonly attachments?: readonly Attachment[];
	},
	context: Context = BACKGROUND_CONTEXT,
): Promise<{ readonly seq: number; readonly delivery: import("../channel/deliver.ts").DeliverResult }> {
	const state = await shell.channels(context);
	const channel = state.channels[options.channelId];
	if (channel === undefined) throw new Error(`频道不存在：${options.channelId}`);
	// 名册读**当下**那一份，不读装配期那份：`hire` 之后 `labels` 要等下一次 `rescan`
	// 才刷新，中间这个人会以 slug 出现在投递摘要与提示词里（`@shen-zhou`），
	// 看上去就像「我视角里没有这个人」。
	const directory = (await shell.harness.snapshot(DirectoryDoc, context)) ?? shell.directory;
	// 我的话也要过一遍名册：他自己写 `@我`（或者老消息里的 `@我`）时，
	// 不给名册就只能存成字面 token，界面画得出来、`recipientsOf` 却认不出人。
	const everyone = await readAllIdentities(shell.agentsRoot);
	const roster = mentionRosterOf(
		everyone.map((identity) => ({
			slug: identity.slug,
			name: identity.name,
			title: identity.title,
			manager: identity.manager,
		})),
	);
	// 显示名以**当下的** `identity.md` 为准，名册里的 `labels` 只做兜底。
	const labels = { ...directory.labels, ...labelsOf(everyone) };
	const result = await postMessage(
		{
			harness: shell.harness,
			state,
			conversationOf: async (slug: string) => {
				const id = conversationFor(directory, slug);
				if (id !== undefined) {
					const found = await shell.harness.conversation(id as never, context);
					if (found !== undefined) return found;
				}
				return shell.conversations.get(slug);
			},
			labelOf: (slug) => labelIn({ ...directory, labels }, slug),
			// 附件根跟着工作区走：`<workspace>/uploads`。给了它，我发的图片才会被读成
			// 内容块交给模型 —— 不给的话模型只看到一行「[图片] x.png」。
			uploadsRoot: uploadsRootOf(shell.agentsRoot),
			// 回话规矩（`prompt/80-reply.md`、`90-interrupted.md`）每轮现读一次：
			// 改模板下一条消息生效，不需要重启（V3 第一条纪律）。
			promptDir: promptDirOf(shell.agentsRoot),
			// 我说话也要记「谁在哪个频道被叫醒」。不传这一项，被叫的人回话时
			// 查不到 wake，只能退到「我最早的那个频道」—— 那往往是私聊，
			// 于是我在公司频道问话、对方在私聊里答，问到的人什么都看不到。
			rememberWake: async (slug: string, wake) => {
				await shell.harness.commit(async (tx) => {
					const doc = (await tx.doc(DirectoryDoc)) as DirectoryState;
					// 用**文档里**的映射：刚 `hire` 的人只在文档里有，装配期那份里没有。
					const id = conversationFor(doc, slug);
					if (id === undefined) return;
					// 只写 `wake` 这一个字段：以前是 `Object.assign(doc, { ...doc, wake })`，
					// 把整份名册展开再写回去，任何一处覆盖层节点被顺手写回来就是一次静默丢人。
					doc.wake = { ...plainDirectory(doc).wake, [String(id)]: { ...wake } };
				}, context);
			},
		},
		{
			channelId: options.channelId,
			from: options.from ?? OWNER,
			text: options.text,
			roster,
			at: Date.now(),
			...(options.replyTo === undefined ? {} : { replyTo: options.replyTo }),
			...(options.kind === undefined ? {} : { kind: options.kind }),
			...(options.attachments === undefined ? {} : { attachments: options.attachments }),
		},
		context,
	);

	// 我在团队频道里拍板也要沉淀：它不是 agent，不会走工具层，这条路径得自己调。
	await shell.afterPost(result.message, options.channelId, context);
	return { seq: result.message.seq, delivery: result.delivery };
}