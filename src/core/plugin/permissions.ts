/**
 * 插件的**系统动作权限**：清单里声明、人批准、内核执行。
 *
 * 为什么要有这一层：插件后端是主进程里 `import()` 进来的，本来就能 `import("node:fs")`
 * 做任何事（ADR-036 的「自担越界」）。**这套权限不防恶意插件**，它做的是三件更小、但
 * 现在真缺的事：让正经插件不用自己 `spawn` 写一遍；把「插件能对系统做什么」写进一份
 * 人看得懂的清单并且默认全不给；每次动手留一条审计。
 *
 * 三条由此定的规矩：
 * 1. **权限名是动作，不是目标**（`system.reveal`，不是 `open-png`）。目标的作用域内建：
 *    永远是「当前频道的工作区里、已经过校验的一个文件」。
 * 2. **默认全不给**。清单里没写 `permissions` = 一个动作都不能调，调了就抛错，不静默。
 * 3. **批准是一次性的、写回文档的**。批准记在 `plugin.md` 的 `granted:` 里，和 `enabled`
 *    一样是文档里的状态（ADR-018）。插件改了 `permissions` 之后，**新增的那几条要重问**。
 */

/** 宿主实现的动作，一个不多。加一个动词 = 改内核，得单独过。 */
export const SYSTEM_ACTIONS = ["system.reveal", "system.copyText", "system.open"] as const;

export type SystemAction = (typeof SYSTEM_ACTIONS)[number];

/**
 * 给人看的一句话。安装确认弹窗、插件页、「这个插件能干什么」都读这一份 ——
 * 同一个动作在三处各写一句人话，早晚会漂。
 */
/**
 * 确认卡上那句话。**给人看的**，所以写的是这台机器上会发生什么，不是动作名。
 *
 * 「打开你机器上的文件」「调用默认程序」这几个字是必须出现的：老板批的时候要知道
 * 自己批出去的是什么，而不是「system.reveal」这种他没法判断的字符串。
 */
export const SYSTEM_ACTION_LABELS: Readonly<Record<SystemAction, string>> = {
	"system.reveal": "打开访达，显示你机器上的一个文件",
	"system.copyText": "往你的剪贴板里写一段文字",
	"system.open": "用你机器上的默认程序打开一个文件",
};

/** 一句长一点的说明，用在确认弹窗的次要行：说清「它做不到什么」。 */
export const SYSTEM_ACTION_DETAILS: Readonly<Record<SystemAction, string>> = {
	"system.reveal": "只找得到当前频道工作区里的文件，碰不到别处；不打开文件内容。",
	"system.copyText": "只往里写，读不了你剪贴板里原来的东西。",
	"system.open": "只打开当前频道工作区里的文件：不能开文件夹、不能开网址、不能执行命令。",
};

/** 是不是宿主认得的动作。清单里写了别的（比如 `system.openUrl`）= 不认识，装的时候就报。 */
export function isSystemAction(value: string): value is SystemAction {
	return (SYSTEM_ACTIONS as readonly string[]).includes(value);
}

/**
 * 把清单里那行 `permissions: a, b, c` 拆开。
 *
 * 允许的写法：逗号分隔（`system.reveal, system.open`）、方括号列表（`[system.reveal]`）、
 * 以及 YAML 那种一行一项的子列表（`- system.reveal`）—— 后者 `parseDoc` 拆不出来，
 * 但插件作者八成会这么写，所以这里连体地认一下。
 *
 * 去重、保序；空串丢掉。
 */
export function parsePermissions(raw: string | undefined): readonly string[] {
	if (raw === undefined) return [];
	const cleaned = raw
		.replace(/^\[|\]$/g, "")
		.split(/[,\n]/)
		.map((part) => part.trim().replace(/^-\s*/, "").replace(/^["']|["']$/g, "").trim())
		.filter((part) => part !== "");
	return [...new Set(cleaned)];
}

/** 声明了但不认识的权限名。装的时候要报出来（写错了不能静默变成「没有」）。 */
export function unknownPermissions(declared: readonly string[]): readonly string[] {
	return declared.filter((name) => !isSystemAction(name));
}

/**
 * 还差哪几条批准。
 *
 * `granted` 是**过去批过的**（写在文档里），`declared` 是**现在要的**（清单里）。
 * 差的 = 现在要的 - 过去批过的。**插件删掉某条再要回来**会重新问一次 —— 这是有意的：
 * 删掉那一刻起，人就没再批过它。
 */
export function pendingPermissions(
	declared: readonly string[],
	granted: readonly string[],
): readonly string[] {
	const had = new Set(granted);
	return declared.filter((name) => !had.has(name));
}

/** 已经批过、但插件这次不再声明的（留着没用，回写时顺手清掉）。 */
export function stalePermissions(
	granted: readonly string[],
	declared: readonly string[],
): readonly string[] {
	const want = new Set(declared);
	return granted.filter((name) => !want.has(name));
}

/** 生效的那几条：声明了 **且** 批过的。插件能调的只有这一份。 */
export function activePermissions(
	declared: readonly string[],
	granted: readonly string[],
): readonly SystemAction[] {
	const had = new Set(granted);
	return declared.filter((name): name is SystemAction => isSystemAction(name) && had.has(name));
}
