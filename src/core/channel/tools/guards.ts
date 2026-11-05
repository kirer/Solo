/**
 * 工具侧的安全闸与上限：太长、越界路径、内心独白。
 *
 * 这些是「事后反馈」：模型做错了，工具回一句话让它改，而不是抛错。
 */
import { resolveInOrUndefined } from "../../fsx.ts";
import { ASSISTANT_DIR, type Layout } from "../../layout.ts";
import { fill, type TextCatalog } from "../../documents/base/catalog.ts";

/** 一条 `say` 的上限。不是「存不下」，是「不该在频道里说这么多」。 */
export const SAY_LIMIT = 1_200;

/** 群聊里的一条上限：一群人都在看的频道，只放结论。私聊还能多说两句。 */
export const GROUP_SAY_LIMIT = 600;

/** 这个频道里一条消息最多多少字。 */
export function sayLimitOf(kind: "dm" | "group"): number {
	return kind === "dm" ? SAY_LIMIT : GROUP_SAY_LIMIT;
}

/**
 * 「这一轮我不说」。
 *
 * 抄自 ds-bot 的 `[PASS]`（`groups.js:81` 的 `isPass`）：那里「不说话」是合法结果，
 * 轮次照常往下走。**每轮必须产出一条消息，模型就会拿思维草稿去填空** —— 线上 46%
 * 的英文独白、大量「收到」都是这么来的。给一个合法的静音出口，那些消息才会消失。
 *
 * 空正文也算 PASS：模型直接不调 `say` 本来就已经是「这一轮不说话」了，两件事应当等价。
 */
export function isPass(text: string): boolean {
	if (text.trim() === "") return true;
	return /^\s*(?:[\[【(（]\s*pass\s*[\]】)）]|pass)\s*[.。!！]?\s*$/iu.test(text);
}

/** 「这是内心独白，不是发言」的开头。模型用英文自言自语时有固定套路，抓得住。 */
const MONOLOGUE_OPENERS = [
	"let me",
	"let's",
	"now i",
	"now let",
	"i'll",
	"i will",
	"i need to",
	"i should",
	"i can",
	"i have to",
	"i think",
	"okay,",
	"ok,",
	"then i",
	"first,",
	"next,",
	"hmm",
	"looking at",
	"so the",
];

/**
 * 判断一段 `say` 是不是模型在把「思考」当「发言」倒出来。
 *
 * 证据来自线上：agent 1136 条发言里 46% 是英文（苏澄 96%、温言 92%），长度中位数 195 字
 * 而我是 15 字。我的原话是「根本不像正常人之间沟通」。
 *
 * 判据必须两道一起过，单看哪一道都会误伤：
 * - **以第一人称计划开头**（`Let me…` / `Now I'll…` / `I need to…`）—— 中文正文里夹英文
 *   文件名、报错、代码不会这么开头，所以不会被打中；
 * - **而且英文占绝对多数**（按「英文字母 vs 汉字」算比例，不看字符总数：代码块里全是 ASCII）。
 *
 * 返回命中的开头（给模型看，让它知道被哪句话出卖了），不认识就返回 `undefined`。
 */
export function monologueOpener(text: string): string | undefined {
	const head = text.trimStart().slice(0, 40).toLowerCase();
	const opener = MONOLOGUE_OPENERS.find((candidate) => head.startsWith(candidate));
	if (opener === undefined) return undefined;
	let latin = 0;
	let han = 0;
	for (const char of text) {
		if (/[A-Za-z]/.test(char)) latin += 1;
		else if (/\p{Script=Han}/u.test(char)) han += 1;
	}
	// 英文占「英文字母 + 汉字」的 70% 以上才算独白；中文汇报里夹几个英文词不算。
	if (latin + han < 40) return undefined;
	return latin / (latin + han) >= 0.7 ? opener : undefined;
}

/** 回给模型的输出上限。比频道宽（它要继续干活），但远小于一次大测试的完整输出。 */
export const MODEL_LIMIT = 8_000;

/**
 * 把长文本剪成「头 + 省略标记 + 尾」。
 *
 * 为什么留尾巴而不是只留头：被剪的几乎都是命令输出，而命令输出的重点在**结尾**
 * （测试摘要、报错栈、退出状态）。只留头会得到一段滚过去的日志和一个看不见的结论。
 */
export function clip(source: string, limit: number, catalog?: TextCatalog): string {
	if (source.length <= limit) return source;
	// 省略标记本身也占长度，所以先把它定下来再分头尾 —— 输出因此**不超过** `limit`，
	// 于是「已经剪过的文本再剪一次」原样返回（幂等）。否则每过一层就再塌一截。
	const marker = `\n${fill(catalog, "tool.clip.marker", { length: source.length })}\n`;
	const room = Math.max(limit - marker.length, 2);
	const head = Math.floor(room / 4);
	const tail = room - head;
	return `${source.slice(0, head)}${marker}${source.slice(source.length - tail)}`;
}

/**
 * 把一个「相对工作区根」的路径解成绝对路径，越界返回 `undefined`。
 *
 * 为什么拦：agent 有 `run`（shell），真想做坏事拦不住 —— 这里拦的不是恶意，是
 * **写错**。`../../members/别人/identity.md` 这种路径通常是它对自己所在层级搞错了，
 * 默默写到别人文件夹里比报错更难查。另外静态文件服务本来就有同样的越界判断，
 * 两处规则一致，读代码的人不用猜「这里到底拦不拦」。
 */
export function resolveInWorkspace(root: string, path: string): string | undefined {
	return resolveInOrUndefined(root, path);
}

/**
 * 两个根上线之后，`file` 的路径按**第一段**决定落到哪个根：
 *
 * - `assistant/`、`prompt/`、`plugins/`、`settings.json` → 应用私有目录；
 * - 其他（`members/`、`teams/`、`skills/`、`rules.md`）→ 用户目录。
 *
 * 不能「哪个根先装得下就用哪个」：`members/x` 在 app 根里同样是一条合法路径，
 * 那样会静默写到错误的地方。
 */
const APP_SIDE = new Set([ASSISTANT_DIR, "prompt", "plugins", "settings.json"]);

export function resolveInRoots(layout: Layout, path: string): string | undefined {
	const first = path.split(/[\\/]/)[0] ?? "";
	const root = APP_SIDE.has(first) ? layout.appRoot : layout.userRoot;
	return resolveInOrUndefined(root, path);
}
