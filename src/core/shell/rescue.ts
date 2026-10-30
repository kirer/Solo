/**
 * 「他答了，但没说出来」的安全网。
 *
 * 病根：`say` 是 agent 唯一能把话送进频道的手段，而模型经常在**最后一个回合**里
 * 直接把结论写成正文、然后结束 —— 一次 `say` 都不调。实测（2026-10-29）会话 2 的
 * transcript 里躺着 `sleep 45 跑完、耗时 45 秒…` 这段最终回答，可 `company` 频道里
 * 一个字都没有。我那边看到的就是「问了没人理」。
 *
 * 这里订阅会话提交，看到一条 `pi.assistant` 文本就等一会儿；如果这轮结束时
 * （没有正在跑的提交）他**在这条唤醒消息之后一个字都没说过**，就把那段正文
 * 替他说进他被叫醒的那个频道。落库走的仍是 `postMessage` —— 唯一写入口，不绕过任何规则。
 *
 * 为什么必须是「事后补」，不能改提示词了事：模型漏调工具是无法禁止的行为，
 * 只能在外面兜。为什么不放在 `deliver()` 里：那一层是「把消息交给会话」，
 * 会话还没跑完，它不知道答案是什么。
 */
import type { EntryRecord, Harness } from "../runtime/index.ts";
import { BACKGROUND_CONTEXT } from "../runtime/index.ts";
import { ChannelDoc, OWNER, type ChannelState, type Message } from "../channel/state.ts";
import { DirectoryDoc, wakeOf, type DirectoryState } from "../agent/roster.ts";
import { postMessage } from "../channel/post.ts";

/** 等一会儿再补：同一轮里还会接着产出条目（工具、下一段正文），早补等于抢话。 */
const RESCUE_DELAY_MS = 6_000;
/** 他还在跑（有 `placed` 的提交）就往后排，最多排这么多次。 */
const RESCUE_MAX_RETRY = 10;
/** 太短的不补：`好的`、`收到` 之类的残句补进频道只会更吵。 */
const RESCUE_MIN_CHARS = 6;

/** 从一条 `pi.assistant` 里取出「最终正文」——最后一个 text 块。 */
function finalTextOf(entry: EntryRecord): string | undefined {
	let said: string | undefined;
	for (const message of entry.model ?? []) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type !== "text" || block.text.trim().length === 0) continue;
			said = block.text;
		}
	}
	return said;
}

/** 会话号 → slug（我不在其中）。 */
function slugOfConversation(directory: DirectoryState, conversationId: number): string | undefined {
	for (const [slug, id] of Object.entries(directory.slugToConversation)) {
		if (slug === OWNER) continue;
		if (Number(id) === conversationId) return slug;
	}
	return undefined;
}

/** 从库里读一次名册，把会话号换成 slug。 */
async function sidOf(harness: Harness, conversationId: number): Promise<string | undefined> {
	const directory = (await harness.snapshot(DirectoryDoc, BACKGROUND_CONTEXT)) as DirectoryState | undefined;
	return directory === undefined ? undefined : slugOfConversation(directory, conversationId);
}

/** 这条唤醒之后，他在这个频道里说过话吗？ */
export function spokeAfterWake(list: readonly Message[], slug: string, sinceSeq: number): boolean {
	// note 是系统替他记的告警，不是他的发言，不能算答案。
	return list.some(
		(item) => item.seq > sinceSeq && item.from === slug && item.kind !== "note",
	);
}

/**
 * 启动安全网。返回取消函数（取消时把待补的箭头一起撤掉）。
 *
 * 全部在 `BACKGROUND_CONTEXT` 里跑：提交回调拿到的 context 属于刚结束的那次任务，
 * 任务一结束它就 abort（见 `spokeAfterWake` 上面那段注释）。
 */
type RescueOutcome = "posted" | "skipped" | "busy";

/**
 * 补发一次。导出是为了能被直接验：整条链路（等一会、判忙、查有没有说过话、
 * 落库）都走这里，定时器只是它的外壳。
 */
export async function rescueAnswer(
	harness: Harness,
	slug: string,
	conversationId: number,
	text: string,
	options: { readonly loadDirectory?: () => Promise<DirectoryState | undefined> } = {},
): Promise<RescueOutcome> {
	const context = BACKGROUND_CONTEXT;
	// 唤醒记录在**文档**里，不在内存里的那份名册对象上：`rememberWake` 是往
	// `DirectoryDoc` 提交的，进程内 `shell.directory` 并不会跟着变。读内存版会一直拿到
	// 启动那一刻的快照 —— 症状就是「明明被叫醒了，安全网却说没有唤醒位」。
	const directory = await (options.loadDirectory ?? (async () => (await harness.snapshot(DirectoryDoc, context)) as DirectoryState | undefined))();
	if (directory === undefined) return "skipped";
	const wake = wakeOf(directory, conversationId);
	if (wake === undefined) return "skipped";
	// 他还在跑：这一轮可能后面就会自己 say，别抢。
	const info = await harness.inspect(context);
	const busy = info.submissions.some((item) => item.conversationId === conversationId && item.status === "placed");
	if (busy) return "busy";
	const doc = (await harness.snapshot(ChannelDoc, context)) as ChannelState | undefined;
	if (doc === undefined) return "skipped";
	const list = doc.messages?.[wake.channelId] ?? [];
	if (spokeAfterWake(list, slug, wake.seq)) return "skipped";
	const written = await postMessage(
		{ harness, state: doc, conversationOf: async () => undefined, labelOf: (value: string) => value },
		{ channelId: wake.channelId, from: slug, text, at: Date.now(), kind: "say", wake: false },
		context,
	);
	// 留一行日志：这一条是系统替它发的，不是它自己说的。查「谁替我回了」时靠这行定位。
	console.log(
		`[rescue] ${slug} 答在会话里但没说出来，已补发到 ${wake.channelId}（唤自 #${wake.seq}；落成 #${written.message.seq}「${written.message.text.slice(0, 20)}」）`,
	);
	return "posted";
}

/**
 * 启动安全网。返回取消函数（取消时把待补的定时器一起撤掉）。
 *
 * 全部在 `BACKGROUND_CONTEXT` 里跑：提交回调拿到的 context 属于刚结束的那次任务，
 * 任务一结束它就 abort —— 所以我们只存 `conversationId`，回调里现查。
 */
export function startAnswerRescue(harness: Harness): () => void {
	const timers = new Map<string, ReturnType<typeof setTimeout>>();

	const schedule = (slug: string, conversationId: number, text: string, retry: number): void => {
		const existing = timers.get(slug);
		if (existing !== undefined) clearTimeout(existing);
		const timer = setTimeout(() => {
			timers.delete(slug);
			void rescueAnswer(harness, slug, conversationId, text)
				.then((outcome) => {
					if (outcome !== "busy") return;
					if (retry >= RESCUE_MAX_RETRY) return;
					schedule(slug, conversationId, text, retry + 1);
				})
				.catch((error) => {
					console.warn("[rescue] 补发失败：", error instanceof Error ? error.message : String(error));
				});
		}, RESCUE_DELAY_MS);
		// 定时器不该拖住进程退出（测试、优雅停机都会卡住）。
		timer.unref?.();
		timers.set(slug, timer);
	};

	const unsubscribe = harness.subscribeCommits((publication) => {
		for (const change of publication.changes) {
			if (change.type !== "entry") continue;
			const entry = change.value;
			if (entry.kind !== "pi.assistant") continue;
			const conversationId = Number(entry.conversationId);
			if (conversationId <= 0) continue;
			const text = finalTextOf(entry);
			if (text === undefined || text.trim().length < RESCUE_MIN_CHARS) continue;
			void sidOf(harness, conversationId)
				.then((slug) => {
					if (slug !== undefined) schedule(slug, conversationId, text, 0);
				})
				.catch(() => undefined);
		}
	});

	return () => {
		unsubscribe();
		for (const timer of timers.values()) clearTimeout(timer);
		timers.clear();
	};
}
