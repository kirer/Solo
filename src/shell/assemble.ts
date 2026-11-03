/**
 * 外壳：把「文件夹」和「库」缝在一起。
 *
 * 这一份文件是新核心的**唯一装配点**。它做四件事，顺序不能变：
 *
 * 1. **装能力包**：注册表是内存态、不持久化，必须先装再开会话（否则重启后所有
 *    agent 都失去工具，而它们自己看不出来）。
 * 2. **扫文件夹**：`members/<slug>/identity.md` 就是 agent 的全部事实。扫出谁存在。
 * 3. **给每个 agent 开会话**：会话 id 是底层分配的，所以要写进名册（`core.directory`）。
 *    已有的会话复用，没有的新建 —— 这样重启不会重复造人。
 * 4. **播种频道**：只有一条全员群（所有人自动加入、仅此一次），其余会话谁需要谁建。
 *    会话只有两种形态（私聊 / 群聊），由 `chatKind` 按成员推 —— 没有「个人频道」。
 *
 * 这里没有「CEO」「CTO」这些字，也没有上下级：组织是平的（ADR-058）。谁在哪个团队
 * 只看 `identity.md` 的 `team:`；谁是助理只看他的身份目录在不在应用根下。
 */
import type { Conversation, Extension, Harness, Registry } from "../core/runtime/index.ts";
import { parseModelRef, setAgentModel } from "../core/runtime/models.ts";
import {
	BACKGROUND_CONTEXT,
	defineExtension,
	syncModels,
	type Context,
} from "../core/runtime/index.ts";
import { labelsOf, readAllIdentities, readIdentity } from "../core/agent/identity.ts";
import { mtimeOrUndefined } from "../core/runtime/io.ts";
import { agentSections, renderAgentSection, type ChatRef } from "../core/agent/sections.ts";
import { createCoreTools, type CoreToolDeps } from "../core/channel/tools/index.ts";
import { mentionRosterOf } from "../core/channel/mentions.ts";
import { ChannelDoc, OWNER, chatKind, emptyChannelState, teamId, type Attachment, type ChannelState, type Message } from "../core/channel/types.ts";
import { channelsOf } from "../core/channel/rules.ts";
import { postMessage } from "../core/channel/post.ts";
import {
	DirectoryDoc,
	conversationFor,
	emptyDirectory,
	labelIn,
	mergeDirectory,
	plainDirectory,
	type DirectoryState,
} from "../core/agent/roster.ts";
import { wireChannel } from "../core/channel/wiring.ts";
import {
	addToAllChannel,
	ensureAllChannel,
	ensureOwnerDm,
	joinTeamChannel,
	syncTeamChannel,
	type MembershipDeps,
} from "../core/channel/membership.ts";
import { auditHooks } from "../app/audit.ts";
import { readTeam } from "../core/team/doc.ts";
import { loadPlugins, type PluginListener } from "../core/plugin/index.ts";
import type { CoreServices } from "../app/types.ts";
import { teamWorkspace, workspaceOf, type Layout } from "../core/layout.ts";
import { fill, loadTextCatalog } from "../core/md/catalog.ts";
import { createFsx } from "../core/fsx.ts";

/** 外壳配置。全部是路径和名字，没有行为开关。 */
type CoreShellOptions = {
	/** 两个根的布局：应用私有目录 + 用户目录。 */
	readonly layout: Layout;
	/** 全员频道 id。 */
	readonly allChannel?: string;
	/**
	 * 会话默认模型。
	 *
	 * **必须给**：底层建会话时不带 model 就是「没有模型」，第一次生成会直接失败并报
	 * `no_model`（实测：我 @ 助理，助理一句话都说不出来，界面上看不出任何异常）。
	 * 统一在这里补：装配时给每个会话对齐一次模型，而不是在每个新建入口里各写一遍。
	 */
	readonly defaultModel?: { readonly provider: string; readonly modelId: string };
	/** 单独给某个人指定的模型（slug → 引用），压过 `defaultModel`。 */
	readonly agentModels?: Readonly<Record<string, { readonly provider: string; readonly modelId: string }>>;
	/** 模型注册表：界面改某个人的模型时要先确认那只模型真的存在。 */
	readonly models?: CoreServices["models"];
	/**
	 * 诊断出口。给了就用它（`openCore` 的 `onReport` 已经往里报）；不给就由 `app/`
	 * 自己建一个。装配要传入**同一个实例**，否则 `lastReport` 不在那条线上。
	 */
	readonly diag?: CoreServices["diag"];
	/**
	 * 重启时正跑到一半的会话（`openCore` 的 `interrupted`）。装配完把人叫回来接着做
	 * （ADR-044）；不给 = 不叫（测试与老调用方）。
	 */
	readonly interrupted?: readonly number[];
};

/**
 * 装配结果的形状。
 *
 * 类型本体住在 `src/app/types.ts`：用例层（app）要拿它当入参，而依赖方向是
 * `shell → app`，所以这份形状不能反过来定义在外壳里。这里只留一个别名，
 * 免得老调用方（测试、`main.ts`）全都要改。
 */
export type CoreShell = CoreServices;

/** 名册的顶层字段（写回去时要逐字段比，不能整份替换）。 */
const DIRECTORY_KEYS = ["slugToConversation", "conversationToSlug", "wake", "labels"] as const;

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
	const allChannel = options.allChannel ?? "all";
	// 路径只在 `layout.ts` 里拼：以前这里靠 `dirname(agentsRoot)` 推工作区根，
	// 两个根上线之后那个约定不再成立（而且它一直是隐式的）。
	const layout = options.layout;
	// 会话表要在 `baseDeps` 之前声明：收尾器与投递都要用它（先查内存，再查名册）。
	const conversations = new Map<string, Conversation>();

	// 成员投影也是 domain 的事：外壳只决定「什么时候」调，不决定「谁该在频道里」。
	const membership: MembershipDeps = {
		harness,
		layout,
		allChannel,
	};

	/** 落一次名册变更：**只写变化过的字段**，并且先抄成纯数据。 */
	async function saveDirectoryImpl(
		change: (state: DirectoryState) => DirectoryState,
		ctx: Context,
	): Promise<void> {
		await harness.commit(async (tx) => {
			const doc = (await tx.doc(DirectoryDoc)) as DirectoryState;
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
	}

	/**
	 * 读名册：这次运行里开过的会话 + 落盘那份。
	 *
	 * 落盘的映射可能落后（旧库、上一版只写了内存、某次提交丢了）。只读不补的话，
	 * 下一次提交把缺人的那份原样写回去，重启后这个人就换个新会话、旧历史变孤儿。
	 * 所以发现落盘缺人就在这里补一次 —— 名册是缓存，这次运行的会话是真话。
	 */
	async function directoryNow(ctx: Context): Promise<DirectoryState> {
		const doc = (await harness.snapshot(DirectoryDoc, ctx)) ?? emptyDirectory();
		const merged = mergeDirectory(doc, directory);
		if (Object.keys(merged.slugToConversation).length !== Object.keys(doc.slugToConversation).length) {
			await saveDirectoryImpl(() => merged, ctx);
		}
		return merged;
	}

	// ── 1. 装能力包 ────────────────────────────────────────────────
	// 工具描述、参数说明、拒绝话术全在 `<appRoot>/text/` 里（`seed/text/` 播种过来）。
	// 装配时读一次：`defineTool` 的描述是静态的，改文案要重启（和插件一致）。
	const text = await loadTextCatalog(createFsx(layout.appRoot));
	if (text.keys().length === 0) {
		console.warn(`[core] 没读到文案目录（${layout.textRoot}）：工具描述会是空的`);
	}
	// 频道层要的那几根线只在这里接一次：会话在哪、谁叫醒了他、收尾怎么补。
	// `open`：会话键找不到时开一条 —— 额外会话（ADR-050）懒创建，第一次用到才建。
	const wiring = wireChannel({
		harness,
		layout,
		live: () => conversations,
		open: (slug, ctx) => openOne(slug, ctx),
		text,
	});
	const baseDeps: CoreToolDeps = {
		harness,
		layout,
		text,
		directory: (ctx) => directoryNow(ctx),
		saveDirectory: (change, ctx) => saveDirectoryImpl(change, ctx),
		openAgent: async (slug, ctx) => (await openOne(slug, ctx)).id as unknown as number,
		modelChoices: () => modelChoices(),
		setModel: (slug, ref, ctx) => setModel(slug, ref, ctx),
		wiring,
	};

	// ── 1.5 装插件 ──────────────────────────────────────────────────
	// 插件在开会话**之前**装：工具要进同一个注册表（否则会话建出来时它还不存在，
	// 那个人下次重启前都用不上）。一个坏插件只留一条错误，不影响启动。
	let plugins = await loadPlugins({
		pluginsRoot: layout.pluginsRoot,
		workspace: layout.appRoot,
		scope: (channelId) => channelScope(harness, layout, channelId),
		log: (line) => console.log(`[plugin] ${line}`),
	});
	for (const error of plugins.errors) console.warn(`[plugin] 没装上：${error}`);

	// 插件要听消息走这一个钩子 —— 落盘之后、唤醒之前，只有这一处。
	// 传的是取值函数不是数组：插件重装之后，这条钩子要听**新的**那一批（ADR-026）。
	const afterPost = makeAfterPost(() => plugins.messages);
	const toolDeps: CoreToolDeps = {
		...baseDeps,
		afterPost,
		// 团队文件是事实，频道成员是投影。改了 README 或身份里的 `team` 就得重投影一次。
		syncTeam: async (team, ctx) => {
			await syncTeamAndAnnounce(team, ctx);
		},
		// 招人时 `openAgent` 已经把人加进频道了，「新进的」那条差集算不出来 —— 这里直接点名。
		announceJoin: async (team, slugs, ctx) => {
			await announceJoin(team, slugs, ctx);
		},
		// 招进来的人立刻有私聊：他的工作过程在那里看。
		ensureDm: async (slug, ctx) => {
			await ensureOwnerDm(membership, slug, ctx);
		},
	};
	// 核心七个 + 插件带来的：同一个注册表，没有「谁的工具有特权」这一说。
	//
	// 现造而不是留一份：插件重装时按同名原地换掉这一个扩展（ADR-026），
	// 会话是按扩展**名字**解析的，所以换上去下一次生成就看得见。
	const buildToolsExtension = (): Extension =>
		defineExtension({
			name: "core-tools",
			tools: [...createCoreTools(toolDeps), ...plugins.tools],
			// 审计挂在工具包上：它是每个会话都选的扩展，所以「装一次 = 全都在审」。
			// 钩子拿不到名册，只能拿会话 id，所以这里给一个反查。
			hooks: auditHooks({
				logsRoot: layout.logsRoot,
				slugOf: (conversationId) => {
					for (const [slug, conversation] of conversations) {
						if (Number(conversation.id) === conversationId) return slug;
					}
					return undefined;
				},
			}),
		});


	// 身份段：每个 agent 装的扩展不一样（key 里带 slug），所以这里是一个工厂。
	// 一个人有 8 段（身份/规矩/位置/团队/能力/记忆/技能/目录），底座按段做最小 patch。
	const identityExtension = async (slug: string): Promise<Extension> =>
		defineExtension({
			name: `core-identity:${slug}`,
			sections: await agentSections(
				registry,
				{
					layout,
					chats: (slug) => chatRefsOf(harness, slug),
					extraPrompt: plugins.prompt,
					text,
				},
				slug,
			),
		});

	let toolsExtension = buildToolsExtension();
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

	/**
	 * 重新装一遍插件：开关、装 / 卸、改后端代码都走这里，**不用重启**（ADR-026）。
	 *
	 * 三件事，缺一件都叫「看起来装了其实没用」：
	 * 1. 工具：按同名原地换掉 `core-tools`，会话按名字解析，下一次生成就看得见；
	 * 2. 提示词：插件段是装的时候拍下来的快照，所以要重装每个人的身份扩展；
	 * 3. 路由与听消息：那两处每次用时取（`*rest` 兜底里现查、`afterPost` 取的是函数）。
	 */
	async function reloadPlugins(): Promise<void> {
		const next = await loadPlugins({
			pluginsRoot: layout.pluginsRoot,
			workspace: layout.appRoot,
			scope: (channelId) => channelScope(harness, layout, channelId),
			log: (line) => console.log(`[plugin] ${line}`),
		});
		plugins = next;
		for (const error of next.errors) console.warn(`[plugin] 没装上：${error}`);
		toolsExtension = buildToolsExtension();
		registry.install(toolsExtension);
		// 身份扩展按人装（幂等）。
		for (const slug of conversations.keys()) await installIdentity(slug);
	}

	// ── 2 & 3. 扫文件夹 + 开会话 ──────────────────────────────────
	const identities = await readAllIdentities(layout.agentRoots);
	const directory: DirectoryState = (await harness.snapshot(DirectoryDoc, context)) ?? emptyDirectory();

	/** 给一个人开会话（内部用：先查名册，再建）。 */
	async function openOne(slug: string, ctx: Context): Promise<Conversation> {
		const existing = conversations.get(slug);
		if (existing !== undefined) return existing;
		// 开会话前先看一眼 settings.json：刚加的提供商要能立刻用上（ADR-025）。
		await refreshModels(ctx);
		const known = conversationFor(directory, slug);
		if (known !== undefined) {
			const found = await harness.conversation(known as never, ctx);
			if (found !== undefined) {
				// 已有会话也要补一次模型：老库里可能存着 `no_model`，或者建它的时候
				// 还没配模型。`configure` 不改已有对话历史，只改这次选用的模型。
				await applyModel(found, slug, ctx);
				// 也补一次身份扩展（幂等）：`hire` 时会立刻开会话，那时还没重启，
				// 注册表里没有它的身份段落。不补的话它醒过来不知道自己是谁。
				await installIdentity(slug);
				conversations.set(slug, found);
				// 已有会话也要补一次团队频道：老工作区里的人在团队频道出现之前建的，
				// 或者 `identity.md` 里刚补上 `team:`。两个都是幂等的。
				await joinTeamChannel(membership, slug, ctx);
				// 私聊同理：老工作区里的人是「私聊要等我开」的时代建的，重启后补上。
				await ensureOwnerDm(membership, slug, ctx);
				return found;
			}
		}
		const wanted = modelFor(slug);
		const created = await harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: {
					// 扩展是**按名字选的**：漏了 `core-tools` 这个人就一个工具都没有（实测踩过）。
					extensions: [toolsExtension, await installIdentity(slug)],
					// 模型在建会话时一次给全，不要等第一次生成才发现没有模型。
					...(wanted === undefined ? {} : { model: { provider: wanted.provider, modelId: wanted.modelId } }),
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
		// 一建出来就进全员频道、团队频道。
		//
		// 踩过的坑：`hire` 会立刻开会话，但全员频道的成员是**启动时**按当时的
		// `members/` 目录写死的。结果新人存在、会话也存在，却不在频道里 —— 别人
		// @ 他，`recipientsOf` 第一规则「@ 的必须是成员」把他过滤掉，消息静默不投递，
		// 界面上看起来就是「招了个人但叫不动」。
		await addToAllChannel(membership, [slug], ctx);
		await joinTeamChannel(membership, slug, ctx);
		// 每个成员一出现就有自己的私聊：他的工作过程在那里看，群聊只留结论。
		await ensureOwnerDm(membership, slug, ctx);
		return created;
	}

	const modelSwitch = createModelSwitcher({ options, layout, conversations });
	const { refreshModels, modelFor, modelChoices, setModel, applyModel } = modelSwitch;

	for (const identity of identities) {
		await openOne(identity.slug, context);
	}

	// 名册落盘（一次提交，不是每人一次）。
	await mergeDirectoryInto(harness, directory, labelsOf(identities), context);

	await ensureAllChannel(membership, identities, context);

	/**
	 * 重投影一个团队频道，并叫**新进来的人**自己报到（ADR-042）。
	 *
	 * 报到是成员自己说的话：一条系统留痕叫醒他们，谁都不用先发言 —— 团队一建好，
	 * 新来的成员各自说一句「我是谁、负责什么」。只有这条运行时路径会叫：
	 * 启动时的 `joinTeamChannel` 不叫，否则每次重启都让全体成员白烧一轮。
	 */
	async function syncTeamAndAnnounce(team: string, ctx: Context): Promise<void> {
		await announceJoin(team, await syncTeamChannel(membership, team, ctx), ctx);
	}

	/** 叫这些人去团队频道报到：一条系统留痕 + 只叫他们，助理不发言。 */
	async function announceJoin(team: string, slugs: readonly string[], ctx: Context): Promise<void> {
		if (slugs.length === 0) return;
		const channel = (await shell.channels(ctx)).channels[teamId(team)];
		if (channel === undefined || channel.archived === true) return;
		await shell.postAs(
			{
				channelId: channel.id,
				from: OWNER,
				kind: "note",
				text: fill(shell.text, "membership.joined", { title: channel.title }),
				wakeTo: slugs,
			},
			ctx,
		);
	}

	/**
	 * 重启把某人的一轮掐断了：在**他当时干活的那个频道**留一句痕，并把他叫回来接着做
	 * （ADR-044）。没有唤醒记录（不是被叫醒的）就不猜 —— 宁可不叫，也不乱叫。
	 */
	async function resumeInterrupted(conversationId: number, ctx: Context): Promise<void> {
		const slug = Object.entries(directory.conversationToSlug).find(
			([id]) => Number(id) === conversationId,
		)?.[1];
		if (slug === undefined) return;
		const wake = await wiring.wakeOf(slug, ctx);
		if (wake === undefined) return;
		const channel = (await shell.channels(ctx)).channels[wake.task.channelId];
		if (channel === undefined || channel.archived === true || !channel.members.includes(slug)) return;
		await shell.postAs(
			{
				channelId: channel.id,
				from: OWNER,
				kind: "note",
				text: fill(shell.text, "turn.interrupted", {
					name: labelIn(directory, slug),
					seq: wake.task.seq,
				}),
				wakeTo: [slug],
			},
			ctx,
		);
	}

	const shell: CoreShell = {
		harness,
		registry,
		conversations,
		directory,
		...(options.models === undefined ? {} : { models: options.models }),
		// getter：默认模型会随 `settings.json` 变，读的人每次都拿当下那一只。
		get defaultModel() {
			return modelSwitch.defaultModel;
		},
		refreshModels,
		setModel,
		modelChoices,
		// 落盘钩子只造一个：它是无状态的（读的都是当下的事实），每次发言再造一个纯属浪费。
		afterPost,
		async syncTeam(team: string, ctx: Context = BACKGROUND_CONTEXT): Promise<void> {
			await syncTeamAndAnnounce(team, ctx);
		},
		async promptOf(slug: string): Promise<string> {
			return renderAgentSection(
				registry,
				{
					layout,
					chats: (slug) => chatRefsOf(harness, slug),
					extraPrompt: plugins.prompt,
					text: shell.text,
				},
				slug,
			);
		},
		// getter：插件重装之后，读它的人拿到的就是新的那一份。
		get plugins() {
			return plugins;
		},
		reloadPlugins,
		async rescan(ctx: Context = BACKGROUND_CONTEXT): Promise<readonly string[]> {
			const all = await readAllIdentities(layout.agentRoots);
			const added: string[] = [];
			for (const identity of all) {
				if (conversations.has(identity.slug)) {
					// 已经开着会话的人也要补一次团队频道：`identity.md` 里刚加上
					// `team:` 的人，不重扫就永远进不了那个团队的频道（幂等）。
					await joinTeamChannel(membership, identity.slug, ctx);
					// `rescan` 不走 `openOne`，私聊要在这里单独补（幂等）。
					await ensureOwnerDm(membership, identity.slug, ctx);
					continue;
				}
				await openOne(identity.slug, ctx);
				added.push(identity.slug);
			}
			if (added.length > 0) {
				// 每次 rescan 都把显示名刷新一遍：`identity.md` 改名后不用清库。
				await mergeDirectoryInto(harness, directory, labelsOf(all), ctx);
				// 新人的全员频道成员单独提交一次：`merge` 只加不删，与名册刷新互不影响。
				await addToAllChannel(membership, added, ctx);
			}
			return added;
		},
		async channels(ctx: Context = BACKGROUND_CONTEXT): Promise<ChannelState> {
			return (await harness.snapshot(ChannelDoc, ctx)) ?? emptyChannelState();
		},
		openAgent: async (slug: string, ctx: Context = BACKGROUND_CONTEXT) => (await openOne(slug, ctx)).id as unknown as number,
		ownerSay: (input, ctx) => ownerSpeak(shell, input, ctx),
		postAs: (input, ctx) => ownerSpeak(shell, input, ctx),
		bindings: () => directory,
		labelOf: (slug) => labelIn(directory, slug),
		identities: () => readAllIdentities(layout.agentRoots),
		layout,
		text,
		allChannel,
		...(options.diag === undefined ? {} : { diag: options.diag }),
		close: async (ctx?: Context) => {
			await harness.close(ctx ?? context);
		},
	};

	// 重启前被掐断的那几轮：频道里留痕、把人叫回来接着做（ADR-044）。放在最后：
	// 频道、成员、私聊都得已经建好，不然这一句会落进一个还不存在的地方。
	for (const conversationId of options.interrupted ?? []) {
		await resumeInterrupted(conversationId, context).catch((error: unknown) => {
			console.warn(`[resume] 叫回会话 ${conversationId} 失败：${error instanceof Error ? error.message : String(error)}`);
		});
	}

	return shell;
}


/** 造「一条消息落地之后」的钩子：插件听消息（落盘之后、唤醒之前，只有这一处）。 */
function makeAfterPost(
	listeners: () => readonly PluginListener[] = () => [],
): (message: Message, channelId: string, context: Context) => Promise<void> {
	return async (message, channelId) => {
		// 并发跑、全部 settled —— 一个插件抛错不该让别的插件不跑，也不该让投递变慢。
		await Promise.allSettled(listeners().map(async (listener) => listener(message, channelId)));
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
		 * 消息语义标签（`decision` / `report`）。界面用它把拍板与交付标出来。
		 */
		readonly kind?: string;
		/** 附件引用（图片会被读成内容块交给模型）。 */
		readonly attachments?: readonly Attachment[];
		/** 不按 @ 推算，直接叫醒这几个人（系统留痕叫人时用）。 */
		readonly wakeTo?: readonly string[];
	},
	context: Context = BACKGROUND_CONTEXT,
): Promise<{ readonly seq: number; readonly delivery: import("../core/channel/dispatch.ts").DeliverResult }> {
	const state = await shell.channels(context);
	const channel = state.channels[options.channelId];
	if (channel === undefined) throw new Error(`频道不存在：${options.channelId}`);
	// 名册读**当下**那一份，不读装配期那份：`hire` 之后 `labels` 要等下一次 `rescan`
	// 才刷新，中间这个人会以 slug 出现在投递摘要与提示词里（`@shen-zhou`），
	// 看上去就像「我视角里没有这个人」。
	const directory = (await shell.harness.snapshot(DirectoryDoc, context)) ?? shell.directory;
	// 我的话也要过一遍名册：他自己写 `@我`（或者老消息里的 `@我`）时，
	// 不给名册就只能存成字面 token，界面画得出来、`recipientsOf` 却认不出人。
	const everyone = await readAllIdentities(shell.layout.agentRoots);
	const roster = mentionRosterOf(
		everyone.map((identity) => ({
			slug: identity.slug,
			name: identity.name,
		})),
	);
	// 显示名以**当下的** `identity.md` 为准，名册里的 `labels` 只做兜底。
	const labels = { ...directory.labels, ...labelsOf(everyone) };
	// 频道层那几根线接一次（先查内存会话表，再查名册）；收尾也用它。
	const wiring = wireChannel({ harness: shell.harness, layout: shell.layout, live: () => shell.conversations, text: shell.text });
	const result = await postMessage(
		{
			harness: shell.harness,
			state,
			conversationOf: (slug: string) => wiring.conversationOf(slug, context),
			labelOf: (slug) => labelIn({ ...directory, labels }, slug),
			// 附件根跟着工作区走；回话规矩每轮现读一次（改模板下一条消息生效）。
			uploadsRoot: wiring.uploadsRoot,
			promptDir: wiring.promptDir,
			text: shell.text,
			// 我开口派的活也要立工单：这是「谁派的」最确定的一处。
			policyFile: shell.layout.policyFile,
			// 我说话也要记「谁在哪个频道被叫醒」，否则被叫的人回话会落到别的频道。
			rememberWake: (slug, wake) => wiring.rememberWake(slug, wake, context),
			// 插话时继承他上一次的 `task`：我在他干活时私聊一句，不覆盖团队频道。
			wakeOf: (slug: string) => wiring.wakeOf(slug, context),
			finishTurn: wiring.finishTurn,
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
			...(options.wakeTo === undefined ? {} : { wakeTo: options.wakeTo }),
		},
		context,
	);

	// 我自己说话也要走这条钩子：我不是 agent，不会走工具层，插件听消息得在这里接上。
	await shell.afterPost(result.message, options.channelId, context);
	return { seq: result.message.seq, delivery: result.delivery };
}

/**
 * 运行中换模型：`settings.json` 一改就就地重装，不用重启（ADR-025）。
 *
 * 从装配里拆出来的理由：这一段只认「配置 + 会话表」，不认频道、插件、工具。
 * 留在 500 行的装配函数里时，改模型的人要先读完整个装配顺序。
 */
function createModelSwitcher(deps: {
	readonly options: Pick<CoreShellOptions, "models" | "defaultModel" | "agentModels">;
	readonly layout: Layout;
	readonly conversations: ReadonlyMap<string, Conversation>;
}) {
	const { options, layout, conversations } = deps;
	let defaultModel = options.defaultModel;
	let agentModels = options.agentModels;
	let settingsStamp: number | undefined;

	/**
	 * `settings.json` 变了就把提供商重新装进注册表（原地 upsert，不用重启）。
	 *
	 * 每处「要读模型」的地方先调一次：一次 stat，没变就返回。默认模型换了还要把
	 * **没单独指定模型的人**重新对齐 —— 他们身上挂的是旧的那一只。
	 */
	async function refreshModels(ctx: Context = BACKGROUND_CONTEXT): Promise<void> {
		if (options.models === undefined) return;
		const file = layout.settingsFile;
		const stamp = await mtimeOrUndefined(file);
		if (stamp === undefined || stamp === settingsStamp) return;
		settingsStamp = stamp;
		const applied = syncModels(options.models, file);
		if (applied === undefined) return;
		defaultModel = applied.defaultModel;
		agentModels = applied.agentModels;
		for (const [slug, conversation] of conversations) {
			if (agentModels?.[slug] !== undefined) continue;
			await applyModel(conversation, slug, ctx).catch(() => undefined);
		}
	}

	/** 这个人该用哪只模型：单独指定的压过默认。都没有就是「没有模型」（ADR-023）。 */
	function modelFor(slug: string): { readonly provider: string; readonly modelId: string } | undefined {
		return agentModels?.[slug] ?? defaultModel;
	}

	/** 能挑的模型（招人时按角色分）。先刷一遍配置：刚在设置里加的提供商要能被看见。 */
	async function modelChoices(ctx: Context = BACKGROUND_CONTEXT): Promise<{ models: readonly string[]; default?: string }> {
		await refreshModels(ctx);
		const models = (options.models?.getModels() ?? []).map((model) => `${model.provider}/${model.id}`);
		return { models, ...(defaultModel === undefined ? {} : { default: `${defaultModel.provider}/${defaultModel.modelId}` }) };
	}

	/**
	 * 给某个人换模型：**当场生效**，并记进 `settings.json` 的 `agentModels`。
	 *
	 * 空串 = 跟默认（删掉这条记录）。只认注册表里真有的模型：写一个解析不到的引用，
	 * 这个人此后每轮都 `no_model`，而界面上只是一句「他这一轮没答上来」。
	 */
	async function setModel(slug: string, ref: string, ctx: Context = BACKGROUND_CONTEXT): Promise<{ model: string }> {
		await refreshModels(ctx);
		if (!conversations.has(slug)) throw new Error(`没有这个人的会话：${slug}`);
		const value = ref.trim();
		const wanted = value === "" ? defaultModel : parseModelRef(value);
		if (wanted === undefined) {
			throw new Error(value === "" ? "还没有配置默认模型，先配一只" : `模型要写成 提供商/模型：${value}`);
		}
		if (options.models !== undefined && options.models.getModel(wanted.provider, wanted.modelId) === undefined) {
			const available = (await modelChoices(ctx)).models;
			throw new Error(`没有这个模型：${value}（可选：${available.join("、") || "（还没有配置模型）"}）`);
		}
		await conversations.get(slug)?.configure({ model: { provider: wanted.provider, modelId: wanted.modelId } }, ctx);
		const next = { ...(agentModels ?? {}) };
		if (value === "") delete next[slug];
		else next[slug] = { provider: wanted.provider, modelId: wanted.modelId };
		agentModels = Object.keys(next).length === 0 ? undefined : next;
		setAgentModel(layout.settingsFile, slug, value === "" ? null : value);
		return { model: value };
	}

	/** 补模型（幂等：已经是这个模型就不写，避免每次重启都产生一次提交）。 */
	async function applyModel(conversation: Conversation, slug: string, ctx: Context): Promise<void> {
		const wanted = modelFor(slug);
		if (wanted === undefined) return;
		const agent = await conversation.agent(ctx);
		const current = agent.model;
		if (current !== undefined && current.provider === wanted.provider && current.modelId === wanted.modelId) {
			return;
		}
		await conversation.configure({ model: { provider: wanted.provider, modelId: wanted.modelId } }, ctx);
	}

	return {
		refreshModels,
		modelFor,
		modelChoices,
		setModel,
		applyModel,
		// getter：读的人每次都拿当下那一只。
		get defaultModel() {
			return defaultModel;
		},
	};
}

/**
 * 把这次运行的名册并进落盘那份（一次提交，路径式写字段）。
 *
 * 启动与 `rescan` 走同一段：两处各写一遍时，只要有一处忘了带 `labels`，
 * 「改了名字界面上还是旧名」就会只在一半的路径上出现。
 */
async function mergeDirectoryInto(
	harness: Harness,
	directory: DirectoryState,
	labels: Readonly<Record<string, string>>,
	context: Context,
): Promise<void> {
	await harness.commit(async (tx) => {
		const doc = (await tx.doc(DirectoryDoc)) as DirectoryState;
		Object.assign(doc, {
			slugToConversation: { ...doc.slugToConversation, ...directory.slugToConversation },
			conversationToSlug: { ...doc.conversationToSlug, ...directory.conversationToSlug },
			labels: { ...doc.labels, ...labels },
		});
		directory.labels = { ...doc.labels };
	}, context);
}

/**
 * 插件问「这个频道的工作区在哪」。
 *
 * 只有两种频道有工作区：私聊是那个人的 `workspace/`，团队频道是团队的 `workspace/`。
 * 全员频道没有 —— 它不是谁的工作区。归档的频道也没有：它已经不在列表里了。
 */
async function channelScope(harness: Harness, layout: Layout, channelId: string) {
	const state = (await harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT)) as ChannelState | undefined;
	const channel = state?.channels[channelId];
	if (channel === undefined || channel.archived === true) return undefined;
	if (chatKind(channel) === "dm") {
		const other = channel.members.find((slug) => slug !== OWNER);
		if (other === undefined) return undefined;
		const identity = await readIdentity(layout.agentRoots, other);
		if (identity === undefined) return undefined;
		return { kind: "dm" as const, title: channel.title, root: workspaceOf(identity.dir), label: identity.name ?? other };
	}
	if (!channel.id.startsWith("team:")) return undefined;
	const team = channel.id.slice("team:".length);
	const doc = await readTeam(layout.teamsRoot, team);
	return { kind: "group" as const, title: channel.title, root: teamWorkspace(layout, team), label: doc?.name ?? channel.title };
}

/**
 * 某人此刻在哪些会话里（提示词「你在组织里的位置」一节要用）。
 *
 * 私聊还是群聊由成员推（`chatKind`），不靠 id 前缀 —— `all` 和 `team:x` 在这里
 * 都是“群”，没有谁特殊。
 */
async function chatRefsOf(harness: Harness, slug: string): Promise<readonly ChatRef[]> {
	const state = await harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT);
	if (state === undefined) return [];
	return channelsOf(state, slug).map((channel) => ({ id: channel.id, title: channel.title, kind: chatKind(channel) }));
}
