/**
 * 外壳：把「文件夹」和「库」缝在一起。
 *
 * 这一份文件是**装配点**，不是实现。它只决定顺序，具体几段各在 `wire/` 下：
 *
 * ```
 * wire/plugins.ts        装谁：工具 / 提示词 / 路由 / 听消息 / 分发策略
 * wire/conversations.ts  谁在：扫文件夹、开会话、进频道、写名册
 * wire/identities.ts     我是谁：每个 agent 的提示词段（现读文件渲染）
 * wire/models.ts         用哪只模型：settings.json 一改就换
 * wire/directory.ts      名册落盘：slug ↔ 会话 id
 * wire/teams.ts          团队频道的两句留痕：报到 / 重启打断
 * wire/speak.ts          我开口：宿主入口，与 agent 的 say 同一套语义
 * ```
 *
 * 顺序不能变，原因是每一步都为后一步提供事实：
 *
 * 1. **装插件**必须在开会话之前：工具进同一个注册表，否则会话建出来时它还不存在；
 * 2. **开会话**必须在播种频道之前：频道成员按「谁有会话」算；
 * 3. **重启留痕**必须放在最后：频道、成员、私聊都得已经建好。
 *
 * 这里没有「CEO」「CTO」这些字，也没有上下级：组织是平的（ADR-058）。谁在哪个团队
 * 只看 `identity.md` 的 `team:`；谁是助理只看他的身份目录在不在应用根下。
 */
import type {
	Conversation,
	Extension,
	Harness,
	Registry,
	ToolRegistration,
} from "../core/runtime/index.ts";
import { BACKGROUND_CONTEXT, defineExtension, type Context } from "../core/runtime/index.ts";
import { readAllIdentities } from "../core/documents/member/identity.ts";
import { DirectoryDoc, emptyDirectory, labelIn, type DirectoryState } from "../core/channel/roster.ts";
import { createCoreTools, type CoreToolDeps } from "../core/channel/tools/index.ts";
import { ChannelDoc, emptyChannelState, type ChannelState } from "../core/channel/types.ts";
import { wireChannel } from "../core/channel/wiring.ts";
import { createTurnReport } from "../core/channel/turn/report.ts";
import type { MembershipDeps } from "../core/channel/membership.ts";
import type { FlowReport } from "../core/flow/ports.ts";
import { auditHooks } from "../app/audit.ts";
import { createDiag } from "../app/diag.ts";
import type { CoreServices } from "../app/types.ts";
import type { Layout } from "../core/layout.ts";
import { loadTextCatalog } from "../core/documents/base/catalog.ts";
import { createFsx } from "../core/fsx.ts";
import { createConversationWire } from "./wire/conversations.ts";
import { createDirectoryWire } from "./wire/directory.ts";
import { createIdentityWire } from "./wire/identities.ts";
import { createModelSwitcher } from "./wire/models.ts";
import { createPluginWire } from "./wire/plugins.ts";
import { createSpeak } from "./wire/speak.ts";
import { createTeamWire } from "./wire/teams.ts";

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
	 * 诊断出口。给了就用它（`openCore` 的 `onReport` 已经往里报）；不给就在装配这里建
	 * 一个，整个进程只有这一份。装配要传入**同一个实例**，否则 `lastReport` 不在那条线上。
	 */
	readonly diag?: CoreServices["diag"];
	/**
	 * 重启时正跑到一半的会话（`openCore` 的 `interrupted`）。装配完在频道里留一句痕，
	 * 再由底座重放这一轮（ADR-044 / ADR-074）；不给 = 不处理（测试与老调用方）。
	 */
	readonly interrupted?: readonly number[];
	/**
	 * 有排队输入、却没有活着的一轮来取它的会话（`openCore` 的 `backlog`）。
	 * 装配完各发一条 `continue`，把 inbox 里的排队项带进新的一轮。
	 */
	readonly backlog?: readonly number[];
};

/**
 * 装配结果的形状。
 *
 * 类型本体住在 `src/app/types.ts`：用例层（app）要拿它当入参，而依赖方向是
 * `shell → app`，所以这份形状不能反过来定义在外壳里。这里只留一个别名，
 * 免得老调用方（测试、`main.ts`）全都要改。
 */
export type CoreShell = CoreServices;

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
	const layout = options.layout;
	const conversations = new Map<string, Conversation>();
	const membership: MembershipDeps = { harness, layout, allChannel };
	// 整个进程只有这一份诊断出口：底座报告、插件、策略错误都写进同一条线。
	const diag = options.diag ?? createDiag(layout.logsRoot);
	/**
	 * 运行中出错的一条出口：console 留一行（终端能看见），同时进诊断日志（事后能查）。
	 * 以前插件监听与策略失败只有 console，界面上的症状都是「他就是不回话」。
	 */
	const report: FlowReport = (kind, detail) => {
		console.warn(`[flow] ${detail}`);
		diag.recordFlow(kind, detail);
	};

	// ── 1. 文案与插件 ────────────────────────────────────────────────
	// 工具描述、参数说明、拒绝话术全在 `<appRoot>/text/` 里（`seed/text/` 播种过来）。
	// 装配时读一次：`defineTool` 的描述是静态的，改文案要重启（和插件一致）。
	const text = await loadTextCatalog(createFsx(layout.appRoot));
	if (text.keys().length === 0) {
		console.warn(`[core] 没读到文案目录（${layout.textRoot}）：工具描述会是空的`);
	}
	// 插件在开会话**之前**装：工具要进同一个注册表（否则会话建出来时它还不存在，
	// 那个人下次重启前都用不上）。一个坏插件只留一条错误，不影响启动。
	// 插件发言的出口：`speak` 依赖 flow，要等下面才造得出来，所以这里先留一个晚绑的钩子。
	// 插件只会在运行中调用它（IM 收消息、定时任务），那时装配已经结束。
	let pluginPost: ((input: { readonly channelId: string; readonly text: string }) => Promise<void>) | undefined;
	const pluginWire = createPluginWire({
		harness,
		layout,
		report,
		post: async (input) => {
			if (pluginPost === undefined) throw new Error("插件发言的出口还没接上");
			await pluginPost(input);
		},
	});
	await pluginWire.load();

	// ── 2. 名册、模型、身份 ────────────────────────────────────────
	const directory: DirectoryState = (await harness.snapshot(DirectoryDoc, context)) ?? emptyDirectory();
	const directoryWire = createDirectoryWire({ harness, directory });
	const models = createModelSwitcher({ options, layout, conversations });
	const identityWire = createIdentityWire({
		registry,
		layout,
		harness,
		prompt: () => pluginWire.host().prompt,
		text,
	});

	// ── 3. 频道接线 ────────────────────────────────────────────────
	// 频道层要的那几根线只在这里接一次：会话在哪、谁叫醒了他、收尾怎么补。
	// 工具、我说话、系统留痕都拿同一个 `wiring.flow`，不各自组装投递。
	const wiring = wireChannel({
		harness,
		layout,
		live: () => conversations,
		open: (slug, ctx) => conversationWire.open(slug, ctx),
		text,
		afterPublish: pluginWire.afterPublish,
		policies: pluginWire.policies,
		report,
	});

	let toolsExtension: Extension | undefined;
	const conversationWire = createConversationWire({
		harness,
		membership,
		conversations,
		directory,
		directoryWire,
		models,
		identities: () => readAllIdentities(layout.agentRoots),
		installIdentity: identityWire.install,
		toolsExtension: () => {
			if (toolsExtension === undefined) throw new Error("工具包还没装好");
			return toolsExtension;
		},
	});

	const teamWire = createTeamWire({
		harness,
		membership,
		text,
		directory,
		agentRoots: layout.agentRoots,
		flow: wiring.flow,
		wakeOf: wiring.wakeOf,
	});

	// ── 4. 工具包 ──────────────────────────────────────────────────
	const toolDeps: CoreToolDeps = {
		harness,
		layout,
		text,
		directory: (ctx) => directoryWire.now(ctx),
		saveDirectory: (change, ctx) => directoryWire.save(change, ctx),
		openAgent: async (slug, ctx) => (await conversationWire.open(slug, ctx)).id as unknown as number,
		modelChoices: () => models.modelChoices(),
		setModel: (slug, ref, ctx) => models.setModel(slug, ref, ctx),
		// 团队文件是事实，频道成员是投影。改了 README 或身份里的 `team` 就得重投影一次。
		syncTeam: (team, ctx) => teamWire.sync(team, ctx),
		// 招人时 `openAgent` 已经把人加进频道了，「新进的」那条差集算不出来 —— 这里直接点名。
		announceJoin: (team, slugs, ctx) => teamWire.announce(team, slugs, ctx),
		wiring,
	};

	// 核心八个 + 插件带来的：同一个注册表，没有「谁的工具有特权」这一说。
	// 现造而不是留一份：插件重装时按同名原地换掉这一个扩展（ADR-026），
	// 会话是按扩展**名字**解析的，所以换上去下一次生成就看得见。
	const buildToolsExtension = (): Extension => {
		// 答完写回频道：`afterRun` 钩子 + durable task（ADR-077）。和工具挂在同一个
		// 扩展上 —— 每个会话都选 `core-tools`，所以不需要给已经存在的会话补选扩展。
		const turnReport = createTurnReport(wiring.finishTurn);
		return defineToolsExtension({
			layout,
			conversations,
			tools: [...createCoreTools(toolDeps), ...pluginWire.host().tools],
			turnReport,
		});
	};
	toolsExtension = buildToolsExtension();
	registry.install(toolsExtension);

	/**
	 * 重新装一遍插件：开关、装 / 卸、改后端代码都走这里，**不用重启**（ADR-026）。
	 *
	 * 三件事，缺一件都叫「看起来装了其实没用」：
	 * 1. 工具：按同名原地换掉 `core-tools`，会话按名字解析，下一次生成就看得见；
	 * 2. 提示词：插件段是装的时候拍下来的快照，所以要重装每个人的身份扩展；
	 * 3. 路由 / 听消息 / 分发策略：都按活引用取（`*rest` 兜底里现查、`afterPublish` 与
	 *    `policies` 取的是函数），下一次请求或下一条消息自动用新的那一批。
	 */
	async function reloadPlugins(): Promise<void> {
		await pluginWire.reload();
		toolsExtension = buildToolsExtension();
		registry.install(toolsExtension);
		for (const slug of conversations.keys()) await identityWire.install(slug);
	}

	const speak = createSpeak({
		harness,
		agentRoots: layout.agentRoots,
		directory,
		flow: wiring.flow,
	});
	pluginPost = async (input) => {
		await speak({ channelId: input.channelId, text: input.text }, BACKGROUND_CONTEXT);
	};

	// ── 5. 扫描与开会话 ────────────────────────────────────────────
	await conversationWire.start(context);

	let closed = false;
	const shell: CoreShell = {
		harness,
		registry,
		conversations,
		directory,
		...(options.models === undefined ? {} : { models: options.models }),
		// getter：默认模型会随 `settings.json` 变，读的人每次都拿当下那一只。
		get defaultModel() {
			return models.defaultModel;
		},
		refreshModels: models.refreshModels,
		setModel: models.setModel,
		modelChoices: models.modelChoices,
		// 落盘钩子只造一个：它是无状态的（读的都是当下的事实），每次发言再造一个就是两份语义。
		afterPost: pluginWire.afterPublish,
		syncTeam: (team, ctx = BACKGROUND_CONTEXT) => teamWire.sync(team, ctx),
		promptOf: (slug) => identityWire.promptOf(slug),
		// getter：插件重装之后，读它的人拿到的就是新的那一份。
		get plugins() {
			return pluginWire.host();
		},
		reloadPlugins,
		rescan: (ctx = BACKGROUND_CONTEXT) => conversationWire.rescan(ctx),
		channels: async (ctx = BACKGROUND_CONTEXT): Promise<ChannelState> =>
			(await harness.snapshot(ChannelDoc, ctx)) ?? emptyChannelState(),
		openAgent: async (slug, ctx = BACKGROUND_CONTEXT) =>
			(await conversationWire.open(slug, ctx)).id as unknown as number,
		ownerSay: (input, ctx = BACKGROUND_CONTEXT) => speak(input, ctx),
		postAs: (input, ctx = BACKGROUND_CONTEXT) => speak(input, ctx),
		bindings: () => directory,
		labelOf: (slug) => labelIn(directory, slug),
		identities: () => readAllIdentities(layout.agentRoots),
		layout,
		text,
		allChannel,
		diag,
		// 关两次是正常的（`main.ts` 先关服务、再关运行时）：这里只关一次。
		close: async (ctx?: Context) => {
			if (closed) return;
			closed = true;
			await harness.close(ctx ?? context);
		},
	};

	// 重启前被掐断的那几轮：频道里留痕（ADR-044）。放在最后：频道、成员、私聊
	// 都得已经建好，不然这一句会落进一个还不存在的地方。
	for (const conversationId of options.interrupted ?? []) {
		await teamWire.noteInterrupted(conversationId, context).catch((error: unknown) => {
			console.warn(
				`[resume] 给会话 ${conversationId} 留痕失败：${error instanceof Error ? error.message : String(error)}`,
			);
		});
	}
	// 底座的重放也在装配之后：任务一开跑就要用工具、技能、插件，而这些刚装好。
	// 没有这一步，被强杀的一轮会一直停在 pending，直到下一条输入把调度叫醒。
	harness.resume();
	for (const conversationId of options.backlog ?? []) {
		const conversation = await harness.conversation(conversationId as never, context);
		if (conversation === undefined) continue;
		await conversation.submit({ type: "continue" }, context).catch((error: unknown) => {
			// `ConversationBusy`：replay 已经接上了；`nothing_to_answer` 由底座结算，不抛。
			console.warn(
				`[resume] 会话 ${conversationId} 的积压没能接上：${error instanceof Error ? error.message : String(error)}`,
			);
		});
	}

	return shell;
}

/** 工具包扩展：工具、收尾任务、审计钩子挂在同一个扩展上（每个会话都选它）。 */
function defineToolsExtension(deps: {
	readonly layout: Layout;
	readonly conversations: ReadonlyMap<string, Conversation>;
	readonly tools: readonly ToolRegistration[];
	readonly turnReport: ReturnType<typeof createTurnReport>;
}): Extension {
	return defineExtension({
		name: "core-tools",
		tools: deps.tools,
		tasks: [deps.turnReport.task],
		// 审计挂在工具包上：它是每个会话都选的扩展，所以「装一次 = 全都在审」。
		// 钩子拿不到名册，只能拿会话 id，所以这里给一个反查。
		hooks: [
			...auditHooks({
				logsRoot: deps.layout.logsRoot,
				slugOf: (conversationId) => {
					for (const [slug, conversation] of deps.conversations) {
						if (Number(conversation.id) === conversationId) return slug;
					}
					return undefined;
				},
			}),
			deps.turnReport.hook,
		],
	});
}
