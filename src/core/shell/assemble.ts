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
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Conversation, Extension, Harness, Registry } from "../runtime/index.ts";
import {
	BACKGROUND_CONTEXT,
	createRegistry,
	defineExtension,
	type Context,
	type JsonObject,
} from "../runtime/index.ts";
import { OWNER_SLUG, readAllIdentities } from "../agent/identity.ts";
import { agentSection } from "../agent/runtime.ts";
import { createCoreTools, type CoreToolDeps } from "../channel/tools.ts";
import { ChannelDoc, OWNER, channelsOf, ensureChannel, type ChannelState } from "../channel/state.ts";
import { DirectoryDoc, emptyDirectory, type DirectoryState } from "../company/directory.ts";

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
	 * 旧核心是在 `hireStaff` 里 `conversation.configure({ model })` 补的，新核心统一在这里补。
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
		options: { readonly channelId: string; readonly text: string; readonly replyTo?: number },
		context?: Context,
	) => Promise<{ readonly seq: number; readonly delivery: import("../channel/deliver.ts").DeliverResult }>;
	/**
	 * **任何**一方在频道里说话（老板走 `OWNER`，agent 走自己的 slug）。
	 *
	 * 与 `ownerSay` 是同一个动作，只差发件人是谁 —— 所以它排在 `ownerSay` 里面
	 * （`ownerSay = postAs(OWNER, ...)`），不写第二份语义。
	 */
	readonly postAs: (
		options: { readonly channelId: string; readonly from: string; readonly text: string; readonly replyTo?: number },
		context?: Context,
	) => Promise<{ readonly seq: number; readonly delivery: import("../channel/deliver.ts").DeliverResult }>;
	/** 名册：slug ↔ 会话 id 的当前快照（界面拿它把 slug 翻成数字 id）。 */
	readonly bindings: () => DirectoryState;
	/** 显示名：slug → `identity.md` 里的 name。 */
	readonly labelOf: (slug: string) => string;
	/** 当前所有身份（每次都重读盘：改 `identity.md` 立刻反映到档案页）。 */
	readonly identities: () => Promise<readonly import("../agent/identity.ts").Identity[]>;
	readonly agentsRoot: string;
	readonly projectsRoot: string;
	readonly companyChannel: string;
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

	// ── 1. 装能力包 ────────────────────────────────────────────────
	const toolDeps: CoreToolDeps = {
		harness,
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
	const tools = createCoreTools(toolDeps);
	const toolsExtension = defineExtension({ name: "core-tools", tools });

	// 身份段落：每个 agent 装的扩展不一样（key 里带 slug），所以这里是一个工厂。
	const identityExtension = (slug: string): Extension =>
		defineExtension({
			name: `core-identity:${slug}`,
			sections: [agentSection(registry, { agents: options.agentsRoot, projects: options.projectsRoot }, slug)],
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
		// 一建出来就进公司频道。
		//
		// 踩过的坑：`hire` 会立刻开会话，但公司频道的成员是**启动时**按当时的
		// `agents/` 目录写死的。结果新人存在、会话也存在，却不在频道里 —— 别人
		// @ 他，`recipientsOf` 第一规则「@ 的必须是成员」把他过滤掉，消息静默不投递，
		// 界面上看起来就是「招了个人但叫不动」。
		await addToCompanyChannel(slug, ctx);
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

	const shell: CoreShell = {
		harness,
		registry,
		conversations,
		directory,
		async rescan(ctx: Context = BACKGROUND_CONTEXT): Promise<readonly string[]> {
			const all = await readAllIdentities(options.agentsRoot);
			const added: string[] = [];
			for (const identity of all) {
				if (conversations.has(identity.slug)) continue;
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
		labelOf: (slug: string) => (slug === OWNER ? "老板" : (directory.labels[slug] ?? slug)),
		identities: () => readAllIdentities(options.agentsRoot),
		agentsRoot: options.agentsRoot,
		projectsRoot: options.projectsRoot,
		companyChannel,
		close: (ctx?: Context) => harness.close(ctx ?? context),
	};
	return shell;
}

/** 建空的注册表（外壳自己的构造器，省得调用方记顺序）。 */
export function createCoreRegistry(): Registry {
	return createRegistry();
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
	},
	context: Context = BACKGROUND_CONTEXT,
): Promise<{ readonly seq: number; readonly delivery: import("../channel/deliver.ts").DeliverResult }> {
	const state = await shell.channels(context);
	const channel = state.channels[options.channelId];
	if (channel === undefined) throw new Error(`频道不存在：${options.channelId}`);
	const { postMessage } = await import("../channel/post.ts");
	const { conversationFor } = await import("../company/directory.ts");
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
		},
		{
			channelId: options.channelId,
			from: options.from ?? OWNER,
			text: options.text,
			at: Date.now(),
			...(options.replyTo === undefined ? {} : { replyTo: options.replyTo }),
		},
		context,
	);
	return { seq: result.message.seq, delivery: result.delivery };
}

/**
 * 给一个工作区播种「老板身边的人」。
 *
 * 这是**唯一**一处预置身份的地方，而且只写文件、不写代码：一个 `manager: owner` 的
 * agent，正文说清「你是老板唯一直接对话的人，其余的人由你按需要创建」。
 * 之后它自己就会 `hire` 别人 —— 那些人的身份是它写的，不是代码写的。
 */
export async function seedOwnerAssistant(
	agentsRoot: string,
	options: { readonly name: string; readonly body?: string },
): Promise<string> {
	const { createAgent } = await import("../company/org.ts");
	const identity = await createAgent({
		root: agentsRoot,
		name: options.name,
		title: "负责人",
		manager: OWNER_SLUG,
		body:
			options.body ??
			[
				"你是老板唯一直接对话的人。老板不直接管别人，只跟你说话。",
				"",
				"## 你做什么",
				"老板说一件事，你判断它需要谁，就用 `hire` 建人，把职责、边界、汇报关系写进它的身份。",
				"你不必请示：招人、分工、定边界都是你的活。做完在频道里向老板说清楚。",
				"",
				"## 你的边界",
				"你不写代码、不做设计。你只决定「谁来做、做什么、做到什么程度」，然后验收。",
				"一个任务需要三个人时，就建三个人；需要一个人时，就一个人做到底。",
				"",
				"## 怎么说话",
				"对老板：结论先行，一句话说清做完了什么、卡在哪、要他定什么。不铺垫、不罗列过程。",
				"对下属：说清目标与验收标准，不说做法。",
				"",
				"## 你自己也在变",
				"你可以用 `update_identity` 改自己的身份。发现「我该更关注成本」这类结论，就写进自己的 identity.md。",
				"经验用 `remember` 记下来，下次先 `recall` 再动手。",
			].join("\n"),
	});

	// 技能：和身份一样，是文件，不是代码。这里只播种两份最常用的「怎么做」，
	// 之后它自己用 `write_skill` 加新的、改旧的 —— 改完下一条消息生效。
	const { writeSkill } = await import("../agent/skills.ts");
	const agentDir = join(agentsRoot, identity.slug);
	await writeSkill(agentDir, {
		name: "立项",
		description: "老板给了一个新需求，要判断该不该单独立一个项目、怎么立。用在「这事要开个新摊子吗」的时候。",
		body: [
			"# 立项",
			"",
			"## 什么时候立",
			"满足任意两条就立：①会持续多天 ②需要两个人以上同时推进 ③有独立的验收标准 ④会有自己的代码/文档目录。",
			"只满足一条、或者今天就能收口的，别立项 —— 直接找一个人做完，写进频道就够了。",
			"",
			"## 怎么立",
			"1. `write_project` 写 `projects/<slug>/README.md`，正文四段：目标（做成什么样）、验收标准（怎么算做完）、不做的是什么、现在进展到哪。",
			"2. `owner` 填负责人的 slug。负责人是这个项目里唯一能被你追问「进度如何」的人，别填自己。",
			"3. 用 `hire` 建人时带上 `project: <slug>` —— 他们才会在提示词里看到项目说明。",
			"4. 在公司频道 `say` 一句：立了什么项目、谁负责、验收标准是什么。",
			"",
			"## 判断质量的标准",
			"验收标准写成「能跑通 X，输入 Y 得到 Z」这种可验证的句子。写成「做好了」「优化了」就等于没写 —— 到时候没人能说清做没做完。",
			"",
			"## 踩过的坑",
			"项目立了没人负责，就会一直挂着。立完立刻确认 owner 存在。",
		].join("\n"),
	});
	await writeSkill(agentDir, {
		name: "招人",
		description: "需要一个人来做某件事时，怎么决定招谁、写什么身份、给什么边界。用在「这事得有人干」的时候。",
		body: [
			"# 招人",
			"",
			"## 先问三个问题",
			"1. 这件事需要的是**判断**还是**执行**？需要判断的人，身份里要写「什么情况该停下来问我」；需要执行的人，身份里要写清验收标准。",
			"2. 他归谁管？归你，还是归某个项目负责人。归项目负责人的，`manager` 填那个负责人的 slug，并在身份里写「只向 X 汇报」。",
			"3. 他能不能再造人？一般情况下不能 —— 身份里明确写「你不招人」。",
			"",
			"## 身份怎么写（`hire` 的 body）",
			"四段，缺一不可：",
			"- **你负责什么**：一件事，说清产出物是什么。别写「负责技术」这种没有边界的话。",
			"- **你不做什么**：明确排除。没有这一条的人会把活越揽越多，最后什么都做不深。",
			"- **你怎么汇报**：只向谁汇报、什么情况下必须停下来问、什么问题可以自己拍板。",
			"- **做得好是什么样**：验收标准。",
			"",
			"## 招完立刻做两件事",
			"1. 在频道里 @ 他，把第一件事和验收标准说清楚（`ask`）。",
			"2. 如果他属于某个项目，确认它的 `identity.md` 里 `project` 字段填对了。",
			"",
			"## 踩过的坑",
			"身份写得太抽象（「你是技术专家」），他会自己发明工作内容。宁可写窄，不够再加。",
		].join("\n"),
	});
	return identity.slug;
}
