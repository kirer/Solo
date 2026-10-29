/**
 * 把 agent 的**会话记录**投影成频道里看得见的消息。
 *
 * ## 为什么需要它
 *
 * agent 的每一轮产出都躺在 pi-durable 的会话条目里（`pi.assistant` / `pi.tool-result`），
 * 而频道消息是另一份东西。两者之间没有任何自动连线，于是：
 *
 * - agent 想清楚了、写了文案、决定了做法 —— 老板在个人频道里**看不到**，
 *   只看到 `run` 工具的输出（那是唯一一条当初被人手写过的连线）。
 * - 老板插话问「你在想什么」，对方得重讲一遍，因为它写的过程没被记下来。
 *
 * ## 投影的是什么
 *
 * 一条 `pi.assistant` 条目里有三类内容块，投影成三种消息：
 *
 * | 块 | 投影成 | 界面上 |
 *---|---|---|
 * | `thinking` | `kind: "think"` | 折叠的思考区（ChatGPT 的「思考」样式） |
 * | `text` | `kind: "say"` | 正文，一段一条 |
 * | `toolCall` | `kind: "tool"` | 折叠的工具调用卡片（名字 + 参数摘要） |
 *
 * 工具**结果**不投影：`run` 的结果已经通过 `logWork` 落过一遍了，再落一次就是重复。
 * 其余工具（`read_file` / `recall` 等）的结果留在会话记录里，agent 自己看得见，
 * 老板要细节可以问它 —— 这条通道是**给老板看的过程**，不是给老板的完整日志。
 *
 * ## 落在哪儿
 *
 * 只落**个人频道**（`dm:owner-<slug>`）。理由：
 *
 * - 个人频道就是「他的工作台」，过程记录落在这里是它的本职（见 `工作规矩` 技能）。
 * - 项目频道与公司频道放的是**需要别人看见的结论**。思考过程不是结论。
 *   混进去会让项目频道被私有推理淹没，别人 @ 它找不到该看的东西。
 *
 * ## 为什么是代码而不是提示词
 *
 * 提示词能让 agent「自己说一遍」，但那靠模型自觉，且会污染模型的上下文预算：
 * 把思考重写一遍要花 token，还可能复述失真。投影是**读它已经写下的东西**，
 * 零额外推理、零失真。
 */
import type { EntryRecord } from "../runtime/index.ts";

/** 一条投影出来的内容。 */
export type Projection = {
	/** `think` | `say` | `tool`。 */
	readonly kind: "think" | "say" | "tool";
	/** 正文。`tool` 是参数摘要，不是完整参数。 */
	readonly text: string;
};

/** 底层消息里的内容块。结构上只用到几个字段，故按需收窄。 */
type Block = {
	readonly type?: string;
	readonly text?: string;
	readonly thinking?: string;
	readonly name?: string;
	readonly arguments?: unknown;
};

/** 一条 assistant 条目里的模型消息。 */
type AssistantModel = {
	readonly role?: string;
	readonly content?: readonly Block[];
};

/** 工具参数摘要的长度上限。 */
const ARG_LIMIT = 160;

/**
 * 工具调用参数压成一行摘要。
 *
 * 参数可能是任意 JSON（含嵌套对象、数组、超长字符串）。全量塞进消息流会把
 * 频道刷爆 —— 而老板真正想知道的是「他调了什么」，不是「参数每个字节」。
 * 所以：短的键值对原样列出，长的截断，嵌套结构只说规模。
 */
function summarizeArguments(args: unknown): string {
	if (args === undefined || args === null) return "";
	if (typeof args !== "object") return String(args);
	if (Array.isArray(args)) return args.length === 0 ? "[]" : `[${args.length} 项]`;
	const entries = Object.entries(args as Record<string, unknown>);
	if (entries.length === 0) return "";
	const parts: string[] = [];
	for (const [key, value] of entries) {
		let rendered: string;
		if (value === null) rendered = "null";
		else if (Array.isArray(value)) rendered = `[${value.length} 项]`;
		else if (typeof value === "object") rendered = "{…}";
		else {
			const flat = String(value).replace(/\s+/g, " ").trim();
			rendered = flat.length > ARG_LIMIT ? `${flat.slice(0, ARG_LIMIT)}…` : flat;
		}
		parts.push(`${key}=${rendered}`);
	}
	const line = parts.join(" · ");
	return line.length > ARG_LIMIT * 2 ? `${line.slice(0, ARG_LIMIT * 2)}…` : line;
}

/**
 * 收尾用的空思考词表。
 *
 * 模型经常在收尾时补一句 `End.` / `Done.` / `完成` 这样的思考块。它不是过程，
 * 是一条**噪声过程行** —— 界面上会变成「思考 End.」+ 一个「正在执行」组，看起来
 * 像他还活着、还在干活（实测老板就是这么被误导的）。
 *
 * 只认「整段话就是这些词或标点」的，任何一个有意义的词都让它留下来。
 */
const FILLER_THINKING = new Set([
	"end",
	"done",
	"ok",
	"okay",
	"finish",
	"finished",
	"complete",
	"completed",
	"结束",
	"完成",
	"已结束",
	"已完成",
]);

/**
 * 这段思考是不是纯收尾噪声。
 *
 * 判据：去掉空白与标点之后，只剩下上面那些词（全空也算）。所以
 * `End.`、`OK, done.`、`完成。` 都算噪声；`Done. 接下来我看日志` 不算。
 */
export function isFillerThinking(text: string): boolean {
	const tokens = text
		.trim()
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter((token) => token !== "");
	if (tokens.length === 0) return true;
	return tokens.every((token) => FILLER_THINKING.has(token));
}

/**
 * 从一条 assistant 条目里抽出该给老板看的三样东西。
 *
 * 返回空数组表示这条没什么可看的（比如只有工具调用）—— 调用方就不该落消息，
 * 免得个人频道里全是空卡片。
 */
export function projectAssistantEntry(entry: EntryRecord): readonly Projection[] {
	if (entry.kind !== "pi.assistant") return [];
	const model = entry.model?.[0] as AssistantModel | undefined;
	if (model === undefined || model.role !== "assistant") return [];
	const blocks = model.content ?? [];
	const out: Projection[] = [];
	for (const block of blocks) {
		if (block.type === "thinking") {
			const text = (block.thinking ?? "").trim();
			if (text === "") continue;
			// 收尾噪声（`End.` / `完成`）不落库：它会被画成一条「思考 End.」+ 过程组，
			// 让老板以为他还在干活。正文（`text` 块）不走这条判据 —— 那是他说的话。
			if (isFillerThinking(text)) continue;
			out.push({ kind: "think", text });
		} else if (block.type === "text") {
			const text = (block.text ?? "").trim();
			if (text === "") continue;
			out.push({ kind: "say", text });
		} else if (block.type === "toolCall") {
			const name = block.name ?? "tool";
			// `say` 的结果就是一条真正的频道消息（落在它说的那个频道），
			// 再在个人频道投影一次就是重复。其余工具调用都是「过程」，留在这里。
			if (name === "say") continue;
			const args = summarizeArguments(block.arguments);
			out.push({ kind: "tool", text: args === "" ? name : `${name} ${args}` });
		}
	}
	return out;
}
