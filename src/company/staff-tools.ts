/**
 * 员工的**原子执行工具表**（能力目录里的 exec 层），以及**授予粒度**。
 *
 * 原则：能力最小化。测试不该改产品代码，产品不该跑 shell。
 * 这不是靠提示词约束，是靠工具不存在（ADR-004）。
 *
 * ── 为什么不按角色查表 ──
 *
 * 这里以前是 `STAFF_TOOLSETS`（5 个角色 → read/write/bash 三个布尔）
 * 加一个 `?? DEFAULT_TOOLSET` 的静默兜底。那套东西有两个毛病，同一天暴露：
 *
 * 1. 角色名是自由字符串（`staff_hire` 的 `role` 从来没有 enum），
 *    于是「前端」「backend」「Rust工程师」全部静默落进默认值 → 只读员工、
 *    不报错、不打日志。老板以为招到了一个能干活的开发。
 * 2. 能力被锁死在 5 个预设上，而老板要的是「为每个 agent 动态创建能力」。
 *
 * 现在只剩「原子工具名 → 工厂」这一张表：**给哪些工具是招聘时显式写下来的**，
 * 不再由角色名推断。
 *
 * ── 为什么还要往后加一段「写在哪个目录」 ──
 *
 * 「有 write」和「能写哪个目录」是两件事。真实验收里 `dino-lead` 与 `dino-dev`
 * 都被授予了 `write`，都被派了「写 index.html」，dev 覆盖了 lead 已经自测过的
 * 版本，最后靠频道喊话 + `/tmp/dino-backup/` 手工备份收场
 * （`docs/roundtable/ACCEPTANCE-dino.md`「二、发现的问题 → 1（严重）」）。
 * 声明粒度停在「有没有 write」，隔离就还是靠人自觉。
 *
 * 于是名字里多了一段可选的目录范围：
 *
 *   "write"        → 整个工作空间（老语义，向后兼容）
 *   "write:src/"   → 只允许写工作空间里的 src/ 目录
 *   "read:docs/"   → 只允许读 docs/
 *
 * 范围是**相对工作空间根**（`env.cwd`，即项目文件夹）的目录，不是绝对路径。
 * 底层的内建工具（`createWriteTool()` 等）都不接受 root / scope 参数，
 * 所以约束必须由这里自己包装（见 `scopedTools` 与 ADR-035）。
 *
 * ── 已知取舍：bash 不能带范围 ──
 *
 * `bash` 是唯一不参与 scope 的原子工具，`bash:src/` 会被直接拒绝。
 * 原因是命令里能做的事没法用路径前缀表达：`cd ..`、`cat /etc/passwd`、
 * `python3 -c "open('/x','w')"`、`sed -i`、`git checkout -- .`……路径只是命令串
 * 里的一段文本，包一层前缀检查等于自欺。
 *
 * **后果要说清楚**：一个员工只要有 `bash`，就等于有全工作空间（乃至整台机器）的
 * 读写权限，`write:src/` 那层约束会被它绕过去。所以真正的文件级隔离只有一种写法：
 * **不给 bash，只给 `write:<目录>/` / `edit:<目录>/`**。给 bash 就接受它必然越界。
 * 这条取舍写在 ADR-035 的「代价」里，别指望提示词能补回来。
 */
import { createBashTool, createEditTool, createReadTool, createWriteTool, defineTool } from "../runtime/index.ts";
import type { ExecutionEnv } from "../runtime/capabilities.ts";
import type { Context } from "../runtime/index.ts";
import { capabilityOf } from "./capabilities.ts";

/** 员工可能被授予的原子工具：工具名 → 工厂。 */
const STAFF_ATOMIC_TOOLS: Record<string, () => ReturnType<typeof defineTool>> = {
	read: createReadTool,
	write: createWriteTool,
	edit: createEditTool,
	bash: createBashTool,
};

/** 可授予的原子工具名（用于错误文案与档案展示）。 */
export const STAFF_ATOMIC_TOOL_NAMES: readonly string[] = Object.keys(STAFF_ATOMIC_TOOLS);

/** 支持目录范围的原子工具：路径是它们的入参，前缀约束才有意义。 */
const SCOPED_ATOMIC_TOOLS: ReadonlySet<string> = new Set(["read", "write", "edit"]);

/**
 * 员工层级能吃下的能力层。
 *
 * 高于 staff 的层（leader / management / ceo）不能授予员工——那不是「配置」，
 * 是越权。校验放在这里而不是提示词里，是因为**工具不给就是不存在**（ADR-004）。
 */
const STAFF_LAYERS: ReadonlySet<string> = new Set(["universal", "exec", "staff"]);

/** 一条授予声明拆开后的样子：`write:src/` → 基名 `write`、范围 `src`。 */
type Grant = {
	/** 原始声明（原样存进名册，档案页与错误文案都用它）。 */
	readonly name: string;
	/** 原子工具名，也就是模型看到的工具名：`write`。 */
	readonly base: string;
	/** 归一化后的范围（相对工作空间、无首尾分隔符）；`undefined` = 整个工作空间。 */
	readonly scope: string | undefined;
};

/**
 * 拆一条授予声明，并校验范围本身是否合法。
 *
 * 这里只管「语法」；「这个原子工具能不能给员工」由 `assertGrantable` 管，
 * 两件事分开报，上级才知道该改哪一处。
 */
function parseGrant(name: string): Grant {
	const separator = name.indexOf(":");
	if (separator < 0) return { name, base: name, scope: undefined };

	const base = name.slice(0, separator);
	const rawScope = name.slice(separator + 1);

	if (STAFF_ATOMIC_TOOLS[base] === undefined) {
		// 基名不认识：交给 assertGrantable 报「未知工具」，文案里给出完整声明
		return { name, base, scope: undefined };
	}
	if (!SCOPED_ATOMIC_TOOLS.has(base)) {
		throw new Error(
			`${base} 不支持目录范围（写成了 ${name}）。bash 里能做的事没法用路径前缀表达，给了 bash 就等于有全盘写权限（ADR-035）。`,
		);
	}
	if (rawScope === "") {
		throw new Error(
			`非法能力声明：${name} 的目录范围是空的。写成 ${base}:src/ 表示只允许 ${base} 工作空间里的 src/ 目录。`,
		);
	}
	if (rawScope.startsWith("/") || rawScope.startsWith("\\") || /^[A-Za-z]:/.test(rawScope)) {
		throw new Error(
			`非法能力声明：${name} 的范围必须是相对工作空间的目录，不能是绝对路径。写成 ${base}:src/ 这样。`,
		);
	}

	// Windows 分隔符与 `./` 前缀都按同一件事处理：先切开再拼回 `/`。
	const segments = rawScope.split(/[\\/]+/).filter((segment) => segment !== "" && segment !== ".");
	if (segments.some((segment) => segment === "..")) {
		throw new Error(
			`非法能力声明：${name} 的范围不能包含 ".."（那会跑到工作空间外面去）。`,
		);
	}
	if (segments.length === 0) {
		throw new Error(
			`非法能力声明：${name} 的目录范围是空的。要整个工作空间就别写冒号，直接写 "${base}"。`,
		);
	}
	return { name, base, scope: segments.join("/") };
}

/** 比较路径用的归一化：统一分隔符（Windows 的 `\` 与 POSIX 的 `/` 视作同一个）。 */
function comparablePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * 目标路径的「真实落点」：尽量用 realpath，拿不到就把最深的已存在祖先 realpath 后再拼回来。
 *
 * 为什么要这么做：
 * 1. 前缀比较必须比**真实路径**，否则 `src/link -> /etc` 就绕过去了。
 * 2. 要写的文件通常还不存在（`write` 会创建它），`realpath()` 会 ENOENT，
 *    于是退一步：父目录是真实的，拼上文件名就是它将来真实的位置——与底层
 *    `withFileMutationQueue()` 的做法一致。
 * 3. 万一目标是个**解析不到的符号链接**（悬空链接），真实落点无法确认，
 *    宁可直接拒绝，也不要按「看起来在 src 里」放行。
 */
async function canonicalTarget(env: ExecutionEnv, absolutePath: string, context: Context): Promise<string> {
	const direct = await env.canonicalPath(absolutePath, context);
	if (direct.ok) return direct.value;
	if (direct.error.code === "not_supported") return absolutePath;

	const info = await env.fileInfo(absolutePath, context);
	if (info.ok && info.value.kind === "symlink") {
		throw new Error(
			`拒绝访问 ${absolutePath}：它是指向不存在目标的符号链接，无法确认真实落点是否在授权目录之内。`,
		);
	}

	const parent = await env.joinPath([absolutePath, ".."], context);
	if (!parent.ok) return absolutePath;
	if (parent.value === absolutePath || !absolutePath.startsWith(parent.value)) return absolutePath;

	const name = absolutePath.slice(parent.value.length + (/[/\\]$/.test(parent.value) ? 0 : 1));
	const canonicalParent = await canonicalTarget(env, parent.value, context);
	const joined = await env.joinPath([canonicalParent, name], context);
	return joined.ok ? joined.value : absolutePath;
}

/**
 * 判断 `target` 是否落在 `root` 之内。
 *
 * 边界必须是分隔符：`/proj/src` 不能匹配 `/proj/src-evil`——这正是验收里
 * 「`src-evil/x.js` 算不算 src 下」那一类错误。
 */
function isWithin(root: string, target: string): boolean {
	const base = comparablePath(root);
	const full = comparablePath(target);
	return full === base || full.startsWith(`${base}/`);
}

/** 越界文案里的动词，按工具名换：读 / 写 / 编辑。 */
function verbOf(base: string): string {
	if (base === "read") return "读";
	if (base === "edit") return "编辑";
	return "写";
}

/**
 * 给一个文件类工具加上「只能动这个目录」的约束。
 *
 * 实现选择：**先自己校验，再把调用原样转发给原工具的 execute**，而不是自己调
 * `env.writeFile()`。理由：
 * 1. 原工具的语义（write 建父目录、edit 的文本替换 + diff、read 的偏移/图片、
 *    以及各自的 `withFileMutationQueue()` 并发队列）全靠重写一遍才能保住，
 *    转发一次就都不丢。
 * 2. 校验只需要 `path` 一个字段，`read` / `write` / `edit` 的 schema 里它都叫
 *    `path`，所以一层包装能同时盖住三个工具。
 * 3. `api.executeTool()` 是嵌套调用（会再跑一遍 validate / hooks / replay 策略），
 *    对一个纯校验的前缀检查来说太重；直接调 `execute` 才只是转发。
 *
 * 对模型暴露的 `name` 仍是基名（`write`），范围只体现在 description 与拦截面：
 * 模型不该看到两个同名不同义的工具（ADR-014 的名字唯一）。范围写成别的名字
 * （`write:src`）会让 `write` 与 `write:src` 在能力包里并存，模型只能靠猜。
 */
export function scopedTools(
	tool: ReturnType<typeof defineTool>,
	options: { readonly grant: string; readonly scope: string | undefined },
): ReturnType<typeof defineTool> {
	const { grant, scope } = options;
	// 没有范围：老语义，原工具直接返回，一个字节的额外开销都不要
	if (scope === undefined) return tool;

	const base = tool.name;
	const verb = verbOf(base);

	return defineTool({
		...tool,
		// prepareArguments（edit 用来修正模型发歪的 edits）由 spread 保留
		description:
			`${tool.description}\n\n权限范围：你只能${verb}工作空间里 \`${scope}/\` 之内的文件（授予的能力是 \`${grant}\`）。` +
			`其它路径会被拒绝并报错；确实需要时向上级申请更大范围。`,
		async execute(args, api, context) {
			const env = api.env;
			if (env === undefined) throw new Error("没有执行环境，无法校验路径范围");
			const rawPath = (args as { path?: unknown }).path;
			if (typeof rawPath !== "string") {
				throw new Error(`${base} 的 path 参数必须是字符串。`);
			}

			const resolved = await env.absolutePath(rawPath, context);
			if (!resolved.ok) throw resolved.error;
			const root = await env.absolutePath(scope, context);
			if (!root.ok) throw root.error;

			const target = await canonicalTarget(env, resolved.value, context);
			const canonicalRoot = await canonicalTarget(env, root.value, context);
			if (!isWithin(canonicalRoot, target)) {
				throw new Error(
					`不能${verb} ${rawPath}（解析为 ${resolved.value}）：你的${verb}权限被限制在 \`${scope}/\` 之内（授予的能力是 \`${grant}\`）。如果你确实需要${verb}这个文件，请向上级申请。`,
				);
			}

			return tool.execute(args, api, context);
		},
	});
}

/**
 * 校验一个工具名能不能授予员工。
 *
 * 三类失败分开报：目录里存在但层级太高（`staff_hire` 之类）、压根不存在、
 * 范围类型不合法（`bash:src/`、绝对路径、含 `..`）。分开报是因为上级要据此
 * 做不同的事——前者是「你不该给」，中间是「你写错了」，后者是「你写的范围没意义」。
 */
export function assertGrantable(name: string): void {
	const { base } = parseGrant(name);

	const capability = capabilityOf(name) ?? capabilityOf(base);
	if (capability !== undefined && !STAFF_LAYERS.has(capability.layer)) {
		throw new Error(
			`不能授予 ${name}：它属于「${capability.layer}」层，员工只吃 universal / exec / staff 层（ADR-004：权限靠工具不存在，不靠提示词）。`,
		);
	}
	if (STAFF_ATOMIC_TOOLS[base] === undefined) {
		throw new Error(
			`未知工具：${name}。可授予的原子工具：${STAFF_ATOMIC_TOOL_NAMES.join(" / ")}（可带目录范围，例如 write:src/）。`,
		);
	}
}

/** 校验一批工具名（空数组合法：那是「不给执行工具」，不是错误）。 */
export function assertGrantableTools(names: readonly string[]): void {
	for (const name of names) assertGrantable(name);
}

/**
 * 招聘入口的显式性检查：`tools` 必须真的写了。
 *
 * 为什么必须报错而不是兜底：静默兜底就是原来的 bug 本身。少给一个工具的
 * 代价，老板要等到员工干不了活、任务卡住才发现；报错当场就能改。
 */
export function assertToolsRequested(names: readonly string[] | undefined): void {
	if (names === undefined || names.length === 0) {
		throw new Error(
			'未指定 tools。请显式列出要授予的原子工具，例如 ["read","write","edit"]，或带目录范围 ["read","write:src/"]。可用工具见 my_capabilities。',
		);
	}
}

/**
 * 按工具名构造执行工具列表（名字可带目录范围）。
 *
 * 同一个原子工具有多条声明时只留一个（模型不该看到两个同名工具）：
 * - 有 `write` 又有 `write:src/` → 留 `write`（无范围的更能干，且这是显式声明过的），
 *   并打一条 warning：范围限制不生效，这多半是上级写重了。
 * - 两条都带范围 → 留先声明的那个，同样 warning：范围是「取交集还是取并集」没有
 *   直觉答案，静默挑一个会更糟。
 *
 * 顺序即入参顺序，重复名只保留一次——重复授予不该让同一个工具装两遍。
 */
export function toolsForNames(names: readonly string[]): ReturnType<typeof defineTool>[] {
	const order: string[] = [];
	const chosen = new Map<string, Grant>();

	for (const name of names) {
		assertGrantable(name);
		const grant = parseGrant(name);
		const existing = chosen.get(grant.base);

		if (existing === undefined) {
			order.push(grant.base);
			chosen.set(grant.base, grant);
			continue;
		}
		// 一模一样写两遍：静默去重（老行为，不制造噪音）
		if (existing.name === grant.name) continue;
		if (existing.scope === undefined) {
			console.warn(
				`能力授予重复：已授予 ${existing.name}，又给了 ${grant.name}。${existing.name} 已覆盖整个工作空间，${grant.name} 的范围限制不会生效。`,
			);
			continue;
		}
		if (grant.scope === undefined) {
			console.warn(
				`能力授予重复：${existing.name} 与 ${grant.name} 指向同一个工具。保留 ${grant.name}（无范围），${existing.name} 的范围限制不会生效。`,
			);
			chosen.set(grant.base, grant);
			continue;
		}
		console.warn(
			`能力授予重复：${existing.name} 与 ${grant.name} 指向同一个工具，只保留先声明的 ${existing.name}。`,
		);
	}

	const tools: ReturnType<typeof defineTool>[] = [];
	for (const base of order) {
		const grant = chosen.get(base);
		if (grant === undefined) continue;
		const factory = STAFF_ATOMIC_TOOLS[base];
		if (factory === undefined) continue;
		tools.push(scopedTools(factory(), { grant: grant.name, scope: grant.scope }));
	}
	return tools;
}
