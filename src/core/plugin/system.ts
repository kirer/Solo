/**
 * 系统动作的执行侧：**路径由内核拼、由内核校验、由内核执行**。
 *
 * 插件永远只说三样东西：动作名、当前频道 id、一个**工作区相对路径**。绝对路径一个
 * 字符都不从插件手里过 —— 它连工作区的根都拿不到（`api.scope` 给的那份是给插件自己
 * 做路径守卫的旧接口，与这里无关），所以「拿根目录去开任意盘」这件事它**表达不出来**。
 *
 * 校验顺序（每一步失败就整条拒，不降级）：
 * 1. 正在跑的动作必须在插件「声明了 且 批过了」的那一份里 —— 否则抛错；
 * 2. 相对路径：不许绝对路径、不许 `..`、不许 `~`、不许 NUL、不许空；
 * 3. `join(root, rel)` 之后 `relative(root, X)` 判前缀（挡住了 `..` 拼出来的);
 * 4. `realpath` 之后再判一次前缀（破软链接逃逸）；
 * 5. `lstat` 判是不是软链接 —— 是就拒（与文件树插件同一个口径）；
 * 6. `open` / `reveal` 只收**文件**，不收目录；
 * 7. 执行；成功失败都落一条审计（哪个插件、什么动作、什么时候、开没开成）。
 *
 * 真正的「打开 / 显示 / 复制」由宿主注入（桌面壳是 Electron 的 `shell` 与 `clipboard`，
 * 网页版没有，给的那两个函数直接说「这个宿主做不到」）。
 */
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { lstat, realpath } from "node:fs/promises";
import { appendJsonLine } from "../runtime/io.ts";
import {
	isSystemAction,
	type SystemAction,
} from "./permissions.ts";
import type { PluginScope } from "./api.ts";

/**
 * 宿主真正动手的那两个函数。
 *
 * 只开这两个口：一个「把这段文字放进剪贴板」，一个「对这个**已经校验过的绝对路径**
 * 做点什么」。**没有 exec**，一次也没给 —— 给了就等于让每个插件都变成不受审批的 `run`。
 */
export type SystemActor = {
	/** 把一个已经过校验的绝对路径交出去。`reveal` = 在访达里显示，`open` = 默认程序打开。 */
	act(action: "reveal" | "open", absolutePath: string): Promise<void>;
	/** 把文字放进剪贴板。 */
	copyText(text: string): Promise<void>;
};

/** 一条审计。字段就是老板要看的那四样，外加「为什么没成」。 */
export type SystemAudit = {
	readonly at: string;
	readonly kind: "plugin-system";
	readonly plugin: string;
	readonly action: SystemAction;
	/** 报上来的那个相对路径（失败时也要留，不然查不出是谁乱调）。 */
	readonly path?: string;
	readonly ok: boolean;
	readonly reason?: string;
	readonly ms?: number;
};

/** 一次动作的输入。插件侧构造它，参数只有三个字段。 */
export type SystemActInput = {
	readonly action: SystemAction;
	/** 哪一个频道的工作区。作用域就是它 —— 插件拿不到别人频道。 */
	readonly channelId: string;
	/** 工作区**相对**路径。`copyText` 不读它。 */
	readonly path?: string;
	/** `copyText` 的正文。上限在下面。 */
	readonly text?: string;
};

/** 剪贴板正文上限。剪贴板不是文件传输通道。 */
export const MAX_COPY_TEXT = 200_000;

/** 相对路径的硬线：这几样出现就拒，不再往下解析。 */
function checkRelative(path: string): string | undefined {
	if (path === "") return "路径是空的";
	if (path.includes("\0")) return "路径里有 NUL";
	if (path.includes("\\")) return "路径里要用 / 分隔";
	if (isAbsolute(path)) return "只收工作区里的相对路径";
	if (path.startsWith("~")) return "不认 ~：只收工作区里的相对路径";
	const parts = path.split("/");
	if (parts.some((part) => part === "..")) return "路径里不许有 ..";
	if (parts.some((part) => part === ".")) return "路径里不许有 .";
	return undefined;
}

/** 解析出一个**可以交给系统**的绝对路径；不合法就返回原因。 */
export async function resolveInside(
	root: string,
	path: string,
	options: { readonly fileOnly: boolean },
): Promise<{ readonly absolute: string } | { readonly reason: string }> {
	const bad = checkRelative(path);
	if (bad !== undefined) return { reason: bad };

	const base = resolve(root);
	const target = resolve(join(base, path));
	const rel = relative(base, target);
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes("..")) {
		return { reason: "跑出工作区了" };
	}

	// `lstat`：先判是不是软链接（软链接一律不跟，哪怕它指回工作区里面）。
	const info = await lstat(target).catch(() => undefined);
	if (info === undefined) return { reason: "没有这个文件" };
	if (info.isSymbolicLink()) return { reason: "软链接不跟" };
	if (options.fileOnly && !info.isFile()) return { reason: "只收文件，不收目录" };

	// `realpath` 之后再判一次：目录本身可能是软链接（工作区根被换掉那种）。
	const real = await realpath(target).catch(() => undefined);
	if (real === undefined) return { reason: "解析不出真实路径" };
	const realBase = await realpath(base).catch(() => base);
	const realRel = relative(realBase, real);
	if (realRel === "" || realRel.startsWith("..") || isAbsolute(realRel)) {
		return { reason: "解析之后跑出工作区了" };
	}
	return { absolute: real };
}

/**
 * 造一个执行器。返回的 `act` 就是插件的 `api.system.act`。
 *
 * `active` 与 `scope` 都是**本次加载时定死的**：权限是装的时候批的那一份，
 * 作用域是按频道现查的（频道会归档，工作区会变）。
 */
export function createSystemActions(deps: {
	readonly plugin: string;
	readonly active: readonly SystemAction[];
	readonly scope: (channelId: string) => Promise<PluginScope | undefined>;
	readonly actor: SystemActor;
	/** 审计落在哪（`<logsRoot>/tools.jsonl`，和 `run` 一个口径）。不给就不写。 */
	readonly auditFile?: string;
}): (input: SystemActInput) => Promise<void> {
	async function write(entry: SystemAudit): Promise<void> {
		if (deps.auditFile === undefined) return;
		// 审计不能反过来影响动作：写失败就丢掉这一行。
		await appendJsonLine(deps.auditFile, entry, { rotateAt: 5 * 1024 * 1024 }).catch(() => undefined);
	}

	return async function act(input: SystemActInput): Promise<void> {
		const started = Date.now();
		const at = new Date().toISOString();
		const action = input.action;
		const fail = async (reason: string): Promise<never> => {
			await write({
				at,
				kind: "plugin-system",
				plugin: deps.plugin,
				action,
				...(input.path === undefined ? {} : { path: input.path }),
				ok: false,
				reason,
				ms: Date.now() - started,
			});
			throw new Error(`系统动作 ${action} 被拒：${reason}`);
		};

		if (!isSystemAction(action)) return fail("宿主不认识这个动作");
		// 未声明 / 未批准：抛错，**不静默降级**（老板点的那条）。
		if (!deps.active.includes(action)) return fail("插件没有声明或没有被批准这个权限");

		if (action === "system.copyText") {
			const text = input.text;
			if (typeof text !== "string") return fail("copyText 要给 text");
			if (text.length > MAX_COPY_TEXT) return fail("要复制的内容太长了");
			try {
				await deps.actor.copyText(text);
			} catch (error) {
				return fail(error instanceof Error ? error.message : String(error));
			}
			await write({ at, kind: "plugin-system", plugin: deps.plugin, action, ok: true, ms: Date.now() - started });
			return;
		}

		// reveal / open：作用域是**当前频道的工作区**。全员频道没有工作区 → 直接拒。
		const scope = await deps.scope(input.channelId);
		if (scope === undefined) return fail("这个频道没有工作区");
		const path = input.path;
		if (typeof path !== "string") return fail("要给 path");

		const resolved = await resolveInside(scope.root, path, { fileOnly: true });
		if ("reason" in resolved) return fail(resolved.reason);

		try {
			await deps.actor.act(action === "system.reveal" ? "reveal" : "open", resolved.absolute);
		} catch (error) {
			return fail(error instanceof Error ? error.message : String(error));
		}
		await write({
			at,
			kind: "plugin-system",
			plugin: deps.plugin,
			action,
			path,
			ok: true,
			ms: Date.now() - started,
		});
	};
}
