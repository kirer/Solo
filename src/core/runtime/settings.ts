/**
 * `settings.json` 的唯一读写入口。
 *
 * 这份文件是**用户配置**，不是缓存：`providers`、`defaultModel`、`agentModels`、以后加的
 * 字段都在里面。坏文件的处理方式只有一种 —— 报错、不写盘。以前两处写入口都把它当成
 * 「空文件」然后整份重写，结果一个手滑的逗号就能把全部提供商抹掉。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

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
	readonly providers?: readonly ProviderConfig[];
	/** slug → `provider/modelId`：这个人单独用哪只模型。 */
	readonly agentModels?: Readonly<Record<string, string>>;
};

/** 文件存在但读不懂。调用方必须把这句话交给用户，不能当成「没有配置」。 */
export class SettingsFileError extends Error {
	constructor(file: string, reason: string) {
		super(`${file} 读不出来：${reason}`);
		this.name = "SettingsFileError";
	}
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
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new SettingsFileError(file, "顶层必须是一个对象");
	}
	return parsed as Settings;
}

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
	const temp = `${file}.tmp`;
	writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
	renameSync(temp, file);
	return next as Settings;
}
