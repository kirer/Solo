/**
 * 工具侧的安全闸与上限：太长、越界路径、内心独白。
 *
 * 这些是「事后反馈」：模型做错了，工具回一句话让它改，而不是抛错。
 */
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { resolveInOrUndefined } from "../../fsx.ts";
import { ASSISTANT_DIR, type Layout } from "../../layout.ts";
import { expandHomePath } from "../../runtime/settings.ts";
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
 * - `assistant/`、`prompt/`、`plugins/`、`settings.json`、`uploads/` → 应用私有目录；
 * - 其他（`members/`、`teams/`、`skills/`、`rules.md`）→ 用户目录。
 *
 * `uploads/` 必须在应用侧：附件本体落在 `<appRoot>/uploads`，投递行让模型按
 * `uploads/<id>` 去读 —— 归到用户根会读成「文件不存在」，群里每个人都会说没收到附件。
 *
 * 不能「哪个根先装得下就用哪个」：`members/x` 在 app 根里同样是一条合法路径，
 * 那样会静默写到错误的地方。
 */
const APP_SIDE = new Set([ASSISTANT_DIR, "prompt", "plugins", "settings.json", "uploads"]);

export function resolveInRoots(layout: Layout, path: string, workDirs: readonly string[] = []): string | undefined {
	const resolved = resolveToolPath(layout, path, workDirs);
	return resolved.kind === "ok" ? resolved.path : undefined;
}

/**
 * `file` / `search` 的路径解析结果。
 *
 * 分成三种而不是只回 `undefined`，是因为模型要看到**为什么**没成：
 * - `outside`：`..` 越界，或者一个绝对路径不在任何已配置的目录里（后者要说「去设置里加」，
 *   否则它只会以为工具坏了，回头改用 `run` 里的 `sed`）；
 * - `protected`：密钥与库不开放（用户把整个家目录加进来时，应用私有目录也在里面）。
 */
export type ToolPath =
	| { readonly kind: "ok"; readonly path: string }
	| { readonly kind: "outside"; readonly absolute: boolean }
	| { readonly kind: "protected" };

/** 路径里有没有 `..` 段：有就是「往上走」，拒绝理由要说「越界」而不是「没配置」。 */
export function hasDotDot(path: string): boolean {
	return /(^|[\\/])\.\.([\\/]|$)/.test(path);
}

/**
 * 无论从哪个根进来都不开放的文件名：密钥、库、配置。
 *
 * `settings.json` 也在这里，而且理由比「里面有 apiKey」更重：`file` 能写它就能改
 * `workDirs` 给自己加任意目录 —— 同一轮里先写配置、下一次调用边界就变了，这是提权。
 * 改配置只有一条路：用户在界面上亲手改。
 */
export function isProtectedName(path: string): boolean {
	const name = basename(path);
	return name === ".secrets.json" || name === "settings.json" || name.startsWith("core.sqlite");
}

/**
 * 尽最大努力把一条路径解成**真实**路径：从它自己往上找第一个存在的祖先，realpath 那一段，
 * 再把还不存在的尾段拼回去。
 *
 * 为什么不直接 `realpathSync`：新建文件的路径本来就不存在，它会抛 —— 于是「写一个新文件」
 * 这条最常用的路就成了唯一绕过软链检查的路。也正因为要看**中间段**，不能只对末一段判：
 * `a/link/x.txt` 里的 `link` 指向哪儿，只有整条解出来才知道。
 */
function realpathLoose(path: string): string {
	const abs = resolve(path);
	let head = abs;
	const rest: string[] = [];
	for (;;) {
		try {
			const real = realpathSync(head);
			return rest.length === 0 ? real : resolve(real, ...rest);
		} catch {
			const parent = dirname(head);
			if (parent === head) return abs;
			rest.unshift(basename(head));
			head = parent;
		}
	}
}

/** 只看字面的从属判断（不跟软链）：用来发现「词法上在 A、真实在 B」。 */
function contains(root: string, target: string): boolean {
	const back = relative(root, target);
	return back === "" || (back !== ".." && !back.startsWith(`..${sep}`) && !isAbsolute(back));
}

/**
 * `target` 是否落在 `root` 里（含根自身）。
 *
 * 两边都先解成**真实**路径再比。只比字面时，额外目录里一条 `ln -s <应用根> appdir` 就绕过去了：
 * 词法上它在目录里面，真实位置却是 `settings.json`（apiKey 在那里）和整个库。软链在**中间段**
 * （`a/link/x.txt`）同理，所以整条都要解。
 */
function isInside(root: string, target: string): boolean {
	return contains(realpathLoose(root), realpathLoose(target));
}

/**
 * 工具看到的一条路径落在哪。
 *
 * 相对路径的规矩不变（第一段决定哪个根）。绝对路径只认用户配置的额外工作目录：
 * **只有显式给了绝对路径才进** —— 默认搜的 `.` 仍然是组织目录，额外目录不会因为
 * 配置了就被顺带扫进结果里。
 *
 * 越界仍然拒绝：`..` 是写错层级的信号（见 `resolveInWorkspace` 的说明），额外目录
 * 只是拓宽了「允许的根」，不是取消边界。
 */
export function resolveToolPath(
	layout: Layout,
	path: string,
	workDirs: readonly string[] = [],
): ToolPath {
	// 只把「全是空白」当成默认路径；其余原样解析（文件名里的空格是文件名的一部分）。
	const expanded = expandHomePath(path.trim() === "" ? "." : path);
	if (isAbsolute(expanded)) {
		const target = resolve(expanded);
		// 绝对路径是「你显式授权过这个目录」的受限能力，只认额外工作目录。**不能**把组织根也算
		// 进来：那等于不配任何目录也能读写整个 `~/.solo`，门就没了。相对路径不受限是因为它
		// 词法上就落在组织目录里，本来不需要授权。
		if (!workDirs.some((root) => isInside(root, target))) return { kind: "outside", absolute: true };
		// 应用私有目录即使在额外目录里面也不开放：settings.json 里的 apiKey、密钥文件、
		// 库都在那儿。用户把家目录加进来是常有的事（项目就在家目录下）。判的是**真实**位置：
		// 目录里一条指向应用根的软链，词法上在目录里面，实际读的是 apiKey 和整个库。
		if (isInside(layout.appRoot, target) || isProtectedName(realpathLoose(target))) return { kind: "protected" };
		return { kind: "ok", path: target };
	}
	const first = expanded.split(/[\\/]/)[0] ?? "";
	const root = APP_SIDE.has(first) ? layout.appRoot : layout.userRoot;
	const target = resolveInOrUndefined(root, expanded);
	if (target === undefined) return { kind: "outside", absolute: false };
	const real = realpathLoose(target);
	// 真实位置在应用私有根里：与绝对路径同一条判据、同一句话术。两侧要是分叉，同一个文件
	// 相对路径读得到、绝对路径读不到，用户只会当成坏了。
	// 第一段就是应用侧（`assistant/…`、`uploads/…`）时它本来就在应用根里，照旧放行。
	if (root !== layout.appRoot && isInside(layout.appRoot, target)) return { kind: "protected" };
	// 落点判据本身不能省：真实位置必须还在工作区 / 组织目录 / 额外目录里。组织目录里一条
	// `ln -s ~/.solo-secrets/token link.txt`，词法上在 `members/` 下面，实际读的是范围外的
	// 文件 —— 只留名字黑名单，这条就漏了。
	if (![layout.userRoot, ...workDirs].some((allowedRoot) => isInside(allowedRoot, target))) {
		return { kind: "outside", absolute: false };
	}
	// 落在允许的根里，还要过名字黑名单：密钥、库、配置在任何根里都不开放。软链指向它们时
	// `real` 的 basename 就是它们。
	if (target === layout.secretsFile || isProtectedName(real)) return { kind: "protected" };
	return { kind: "ok", path: target };
}
