/**
 * `settings.json` 的唯一读写入口。
 *
 * 这份文件是**用户配置**，不是缓存：`providers`、`defaultModel`、`agentModels`、以后加的
 * 字段都在里面。坏文件的处理方式只有一种 —— 报错、不写盘。以前两处写入口都把它当成
 * 「空文件」然后整份重写，结果一个手滑的逗号就能把全部提供商抹掉。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export type ProviderConfig = {
	readonly id: string;
	readonly name?: string;
	readonly baseUrl?: string;
	readonly apiKey?: string;
	/** `openai-responses` | `anthropic` | `openai`。缺省是 `openai-responses`。 */
	readonly api?: string;
	readonly models: readonly {
		readonly id: string;
		readonly name?: string;
		readonly reasoning?: boolean;
		readonly contextWindow?: number;
		readonly maxTokens?: number;
	}[];
};

export type Settings = {
	readonly defaultModel?: string;
	/** 更新代理（如 `http://127.0.0.1:7890`）：只给桌面版下载新版安装包用，模型不走它。 */
	readonly updateProxy?: string;
	readonly providers?: readonly ProviderConfig[];
	/** slug → `provider/modelId`：这个人单独用哪只模型。 */
	readonly agentModels?: Readonly<Record<string, string>>;
	/**
	 * 额外工作目录（绝对路径）：`file` / `search` 在这两个根之外还能访问的目录。
	 *
	 * 只有用户亲手在设置里加的才在里面（ADR-126）。空数组 / 缺省 = 跟以前完全一样：
	 * `file` 与 `search` 只认两个根。目录不存在或不是绝对路径的条目读取时被丢掉 ——
	 * 一份坏条目不该让整个服务起不来。
	 */
	readonly workDirs?: readonly string[];
};

/** `~/x` → `<home>/x`；`~` → 家目录；其它原样。 */
export function expandHomePath(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
	return path;
}

/**
 * 配置里的额外工作目录，规整成可以直接比对的绝对路径。
 *
 * 只留下绝对路径的条目：相对路径的含义取决于进程从哪儿启动，同一份配置在两台机器上
 * 会指向不同地方 —— 这种「静默不同」比直接不生效更难查。去重时保留第一次出现的顺序。
 */
export function workDirsOf(settings: Settings | undefined): readonly string[] {
	const raw = settings?.workDirs;
	if (raw === undefined) return [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const entry of raw) {
		if (typeof entry !== "string") continue;
		const trimmed = entry.trim();
		if (trimmed === "") continue;
		const expanded = expandHomePath(trimmed);
		if (!isAbsolute(expanded)) continue;
		const normalized = resolve(expanded);
		if (seen.has(normalized)) continue;
		seen.add(normalized);
		out.push(normalized);
	}
	return out;
}

/** 读一份 settings 里的额外工作目录。文件坏了 / 没有 = 空数组（工具照旧只认两个根）。 */
export function readWorkDirs(file: string): readonly string[] {
	try {
		return workDirsOf(readSettingsFile(file));
	} catch {
		return [];
	}
}

/** 文件存在但读不懂。调用方必须把这句话交给用户，不能当成「没有配置」。 */
export class SettingsFileError extends Error {
	constructor(file: string, reason: string) {
		super(`${file} 读不出来：${reason}`);
		this.name = "SettingsFileError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 形状校验：只查装配会直接读的字段，不认识的键原样保留。
 *
 * 校验放在这里而不是装配处，是为了让「文件坏了」只有一个出口 —— `SettingsFileError`。
 * 否则一个少了 `models` 的 provider 会在启动时抛原始 `TypeError`，堆栈里看不出是配置问题。
 */
function shapeProblem(settings: Record<string, unknown>): string | undefined {
	if (settings["defaultModel"] !== undefined && typeof settings["defaultModel"] !== "string") {
		return "defaultModel 必须是字符串";
	}
	if (settings["updateProxy"] !== undefined && typeof settings["updateProxy"] !== "string") {
		return "updateProxy 必须是字符串";
	}
	const agentModels = settings["agentModels"];
	if (agentModels !== undefined) {
		if (!isRecord(agentModels)) return "agentModels 必须是对象";
		for (const [slug, value] of Object.entries(agentModels)) {
			if (typeof value !== "string") return `agentModels.${slug} 必须是字符串`;
		}
	}
	const workDirs = settings["workDirs"];
	if (workDirs !== undefined) {
		if (!Array.isArray(workDirs)) return "workDirs 必须是数组";
		for (const [index, entry] of workDirs.entries()) {
			if (typeof entry !== "string") return `workDirs[${String(index)}] 必须是字符串`;
		}
	}
	const providers = settings["providers"];
	if (providers === undefined) return undefined;
	if (!Array.isArray(providers)) return "providers 必须是数组";
	for (const [index, raw] of providers.entries()) {
		if (!isRecord(raw)) return `providers[${String(index)}] 必须是对象`;
		if (typeof raw["id"] !== "string" || raw["id"].trim() === "") {
			return `providers[${String(index)}].id 必须是非空字符串`;
		}
		for (const key of ["name", "baseUrl", "apiKey", "api"]) {
			if (raw[key] !== undefined && typeof raw[key] !== "string") {
				return `providers[${String(index)}].${key} 必须是字符串`;
			}
		}
		const models = raw["models"];
		if (!Array.isArray(models)) return `providers[${String(index)}].models 必须是数组`;
		for (const [modelIndex, model] of models.entries()) {
			const where = `providers[${String(index)}].models[${String(modelIndex)}]`;
			if (!isRecord(model) || typeof model["id"] !== "string" || model["id"].trim() === "") {
				return `${where}.id 必须是非空字符串`;
			}
			if (model["name"] !== undefined && typeof model["name"] !== "string") return `${where}.name 必须是字符串`;
			for (const key of ["contextWindow", "maxTokens"]) {
				if (model[key] !== undefined && typeof model[key] !== "number") return `${where}.${key} 必须是数字`;
			}
			if (model["reasoning"] !== undefined && typeof model["reasoning"] !== "boolean") {
				return `${where}.reasoning 必须是布尔值`;
			}
		}
	}
	return undefined;
}

/**
 * 读一份 settings。文件不存在 = `undefined`（首次启动，合法）；存在但坏了 = 抛错。
 *
 * 区分「没有」和「坏了」是这份文件唯一重要的语义：前者可以写新文件，后者不能。
 */
export function readSettingsFile(file: string): Settings | undefined {
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new SettingsFileError(file, error instanceof Error ? error.message : String(error));
	}
	if (!isRecord(parsed)) throw new SettingsFileError(file, "顶层必须是一个对象");
	const problem = shapeProblem(parsed);
	if (problem !== undefined) throw new SettingsFileError(file, problem);
	return parsed as Settings;
}

/** 同一个进程里的临时文件名序号（并发写同一份文件时互不覆盖）。 */
let tempSeq = 0;

/**
 * 读 → 改 → 写回。临时文件 + rename：写到一半崩掉不会留下半份 JSON。
 *
 * 只修改 `change` 动过的键；不认识的键原样保留（前向兼容）。
 */
export function updateSettingsFile(
	file: string,
	change: (settings: Record<string, unknown>) => void,
): Settings {
	const current = readSettingsFile(file);
	const next = current === undefined ? {} : { ...(current as Record<string, unknown>) };
	change(next);
	mkdirSync(dirname(file), { recursive: true });
	// 每次换一个临时名：插件也用这份文件，同名 `.tmp` 并发时会把对方写了一半的内容换上去。
	const temp = `${file}.${String(process.pid)}.${String(tempSeq++)}.tmp`;
	writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
	renameSync(temp, file);
	return next as Settings;
}
