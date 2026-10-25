/**
 * 设置持久化：`workspace/settings.json`。
 *
 * 这是「老板在设置页里改的东西」的唯一落盘位置，包含三段：
 * - `network`：监听地址与端口（下次启动生效）
 * - `models`：默认模型与自定义模型（下次启动生效）
 * - `im`：IM 接入配置（立即生效，入站/出站钩子每次请求都读最新值）
 *
 * 设计取舍：
 * - 单文件、明文、无数据库：单人本机产品，改坏了删掉文件即可回到默认。
 * - 读取永远重新读盘：手工编辑文件后不用重启也能被 IM 钩子看到；
 *   `restartRequired` 用「当前磁盘 vs 进程启动时的配置」比较得出。
 * - 写入串行化 + 临时文件 rename：避免并发 PATCH 把 JSON 写坏。
 *
 * 安全边界（docs/DEPLOY.md 有完整说明）：apiKey 以明文存储，文件权限
 * 依赖操作系统用户目录；只应在本机 / 可信内网使用，不对外网暴露。
 */
import { readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseModelSettings, type CustomModelSettings, type ModelSettings } from "../runtime/models.ts";

/** 网络设置（持久化的期望值；实际监听值由启动参数 / 环境变量决定）。 */
export type NetworkSettings = {
	readonly host: string;
	readonly port: number;
};

/** 一个 IM 账号配置（不实现各平台协议，仅供外部桥识别）。 */
export type ImAccountSettings = {
	readonly id: string;
	/** 平台名：wechat / wecom / feishu / webhook…（自由文本，前端展示用）。 */
	readonly channel: string;
	readonly name: string;
	readonly enabled: boolean;
	readonly note?: string;
};

/** IM 接入设置。 */
export type ImSettings = {
	readonly enabled: boolean;
	/** 老板通道每条助手回复 POST 到这里；空串 = 不推送。 */
	readonly outboundWebhook: string;
	/** 入站校验 token；空串 = 入站关闭（一律 403）。 */
	readonly inboundToken: string;
	readonly accounts: readonly ImAccountSettings[];
};

/** settings.json 的完整规范化结构。 */
export type Settings = {
	readonly network: NetworkSettings;
	readonly models: ModelSettings;
	readonly im: ImSettings;
};

/** 当前进程实际监听值与设置页展示所需的派生信息。 */
export type SettingsView = {
	readonly network: {
		readonly port: number;
		readonly host: string;
		readonly lanUrls: readonly string[];
		readonly url: string;
	};
	readonly models: {
		readonly default: string;
		readonly catalog: readonly ModelCatalogEntry[];
		readonly restartRequired: boolean;
	};
	readonly im: ImSettings;
};

/** 设置页里的一条模型。 */
export type ModelCatalogEntry = {
	readonly id: string;
	readonly name: string;
	readonly provider: string;
	readonly baseUrl?: string;
	readonly inputPerMTok?: number;
	readonly outputPerMTok?: number;
	readonly contextWindow?: number;
	readonly maxOutput?: number;
	readonly source: "builtin" | "custom";
};

/** 默认值：端口/地址与启动参数保持一致（环境变量优先级见 main.ts）。 */
const DEFAULT_PORT = 7788;
const DEFAULT_HOST = "127.0.0.1";
/** 自定义模型 id 允许的字符：字母数字与 . _ - : / 之外的都拒绝（避免路径/URL 注入）。 */
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,119}$/;

/** 设置存储句柄。 */
export type SettingsStore = {
	/** 设置文件绝对路径。 */
	readonly path: string;
	/** 读磁盘并规范化；文件不存在或损坏时返回默认值（不抛错）。 */
	read(): Promise<Settings>;
	/** 同步版本，启动阶段用。 */
	readSync(): Settings;
	/** 合并一段结构子集并落盘，返回合并后的完整设置。 */
	patch(patch: unknown): Promise<Settings>;
	/** 新增一条自定义模型（持久化），返回规范化后的条目。 */
	addModel(input: unknown): Promise<CustomModelSettings>;
	/** 删除一条自定义模型；返回是否真的删掉了。 */
	removeModel(id: string): Promise<boolean>;
	/** 该条自定义模型是否已存在（自定义清单内）。 */
	hasCustomModel(id: string): Promise<boolean>;
	/**
	 * 进程启动时的配置（network + models）与当前磁盘是否不同。
	 * 不同 = 需要重启才生效（模型集合在启动时装配；监听地址同理）。
	 */
	restartRequired(): Promise<boolean>;
};

/** 打开（或初始化）设置存储。 */
export function openSettings(options: {
	readonly workspace: string;
	readonly environment?: NodeJS.ProcessEnv;
}): SettingsStore {
	const path = join(options.workspace, "settings.json");
	const environment = options.environment ?? process.env;
	const defaults = defaultSettings(environment);

	/** 同步读磁盘（启动阶段 / 基线用）。 */
	const readSyncSettings = (): Settings => {
		try {
			return normalize(JSON.parse(readFileSync(path, "utf8")), defaults);
		} catch {
			return defaults;
		}
	};

	/** 进程启动时的配置签名：restartRequired 的比较基准。 */
	const appliedSignature = signature(readSyncSettings());

	/** 串行化写入：并发 PATCH 不互相覆盖 / 写坏文件。 */
	let writeChain: Promise<unknown> = Promise.resolve();
	const serialize = <T>(task: () => Promise<T>): Promise<T> => {
		const next = writeChain.then(task, task);
		writeChain = next.catch(() => undefined);
		return next;
	};

	const read = async (): Promise<Settings> => {
		let raw: unknown;
		try {
			raw = JSON.parse(await readFile(path, "utf8"));
		} catch {
			return defaults;
		}
		return normalize(raw, defaults);
	};

	const store: SettingsStore = {
		path,
		read,
		readSync(): Settings {
			// 同步读只用于启动阶段；异步版本用于请求路径
			return readSyncSettings();
		},
		async patch(patch: unknown): Promise<Settings> {
			if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
				throw new SettingsInputError("设置必须是 JSON 对象");
			}
			return serialize(async () => {
				const current = await read();
				const next = mergePatch(current, patch as Record<string, unknown>);
				await persist(path, next);
				return next;
			});
		},
		async addModel(input: unknown): Promise<CustomModelSettings> {
			if (typeof input !== "object" || input === null || Array.isArray(input)) {
				throw new SettingsInputError("模型必须是 JSON 对象");
			}
			return serialize(async () => {
				const current = await read();
				const model = normalizeCustomModel(input as Record<string, unknown>);
				if (model === undefined) {
					throw new SettingsInputError("模型缺少合法的 id（字母数字开头，可含 . _ - : @ /）");
				}
				if (current.models.custom.some((item) => item.id === model.id)) {
					throw new SettingsConflictError(`模型 ${model.id} 已存在`);
				}
				const next: Settings = {
					...current,
					models: { ...current.models, custom: [...current.models.custom, model] },
				};
				await persist(path, next);
				return model;
			});
		},
		async removeModel(id: string): Promise<boolean> {
			const target = id.trim();
			if (target === "") return false;
			return serialize(async () => {
				const current = await read();
				const custom = current.models.custom.filter((item) => item.id !== target);
				if (custom.length === current.models.custom.length) return false;
				const next: Settings = { ...current, models: { ...current.models, custom } };
				await persist(path, next);
				return true;
			});
		},
		async hasCustomModel(id: string): Promise<boolean> {
			const current = await read();
			return current.models.custom.some((item) => item.id === id.trim());
		},
		async restartRequired(): Promise<boolean> {
			const current = await read();
			return signature(current) !== appliedSignature;
		},
	};

	return store;
}

/** 输入不合法（HTTP 层映射成 400）。 */
export class SettingsInputError extends Error {}

/** 冲突（HTTP 层映射成 409）。 */
export class SettingsConflictError extends Error {}

/** 组装设置页视图：实际监听地址 + 内置/自定义模型清单 + 是否需重启。 */
export function buildSettingsView(options: {
	readonly settings: Settings;
	readonly bindHost: string;
	readonly port: number;
	readonly lanUrls: readonly string[];
	readonly url: string;
	readonly builtinCatalog: readonly {
		readonly id: string;
		readonly provider: string;
		readonly modelId: string;
		readonly label: string;
		readonly inputPerMTok: number;
		readonly outputPerMTok: number;
	}[];
	readonly defaultModel: { readonly provider: string; readonly modelId: string };
	readonly restartRequired: boolean;
}): SettingsView {
	const catalog: ModelCatalogEntry[] = options.builtinCatalog.map((item) => ({
		id: item.id,
		name: item.label,
		provider: item.provider,
		inputPerMTok: item.inputPerMTok,
		outputPerMTok: item.outputPerMTok,
		source: "builtin" as const,
	}));
	for (const item of options.settings.models.custom) {
		catalog.push({
			id: item.id,
			name: item.name ?? item.id,
			provider: item.provider ?? "openai-responses",
			...(item.baseUrl === undefined ? {} : { baseUrl: item.baseUrl }),
			...(item.inputPerMTok === undefined ? {} : { inputPerMTok: item.inputPerMTok }),
			...(item.outputPerMTok === undefined ? {} : { outputPerMTok: item.outputPerMTok }),
			...(item.contextWindow === undefined ? {} : { contextWindow: item.contextWindow }),
			...(item.maxOutput === undefined ? {} : { maxOutput: item.maxOutput }),
			source: "custom" as const,
		});
	}

	const configured = (options.settings.models.default ?? "").trim();
	const fallback = `${options.defaultModel.provider}/${options.defaultModel.modelId}`;
	const matched = catalog.find((item) => item.id === configured);

	return {
		network: {
			port: options.port,
			host: options.bindHost,
			lanUrls: [...options.lanUrls],
			url: options.url,
		},
		models: {
			default: configured === "" ? fallback : (matched?.id ?? configured),
			catalog,
			restartRequired: options.restartRequired,
		},
		im: normalizeIm(options.settings.im, defaultIm()),
	};
}

// ── 规范化 ──────────────────────────────────────────────────────────────────

function defaultSettings(environment: NodeJS.ProcessEnv): Settings {
	const port = Number(environment.PORT ?? DEFAULT_PORT);
	const host = (environment.AI_COMPANY_HOST ?? "").trim() || DEFAULT_HOST;
	return {
		network: { host, port: Number.isFinite(port) && port > 0 ? port : DEFAULT_PORT },
		models: { custom: [] },
		im: defaultIm(),
	};
}

function defaultIm(): ImSettings {
	return { enabled: false, outboundWebhook: "", inboundToken: "", accounts: [] };
}

function normalize(raw: unknown, defaults: Settings): Settings {
	const root = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
	return {
		network: normalizeNetwork(root.network, defaults.network),
		models: normalizeModels(root.models),
		im: normalizeIm(root.im, defaults.im),
	};
}

function normalizeNetwork(raw: unknown, fallback: NetworkSettings): NetworkSettings {
	const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
	const host = typeof record.host === "string" ? record.host.trim() : "";
	const port = Number(record.port);
	return {
		host: host === "" ? fallback.host : host,
		port: Number.isFinite(port) && port >= 1 && port <= 65_535 ? Math.floor(port) : fallback.port,
	};
}

function normalizeModels(raw: unknown): ModelSettings {
	// 复用运行时层的解析：自定义模型字段与 setupModels 完全同一套口径
	return parseModelSettings({ models: raw });
}

function normalizeIm(raw: unknown, fallback: ImSettings): ImSettings {
	const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
	const accounts = Array.isArray(record.accounts)
		? record.accounts.flatMap((item) => {
				const account = normalizeAccount(item);
				return account === undefined ? [] : [account];
			})
		: fallback.accounts;

	return {
		enabled: typeof record.enabled === "boolean" ? record.enabled : fallback.enabled,
		outboundWebhook:
			typeof record.outboundWebhook === "string" ? record.outboundWebhook.trim() : fallback.outboundWebhook,
		inboundToken: typeof record.inboundToken === "string" ? record.inboundToken.trim() : fallback.inboundToken,
		accounts,
	};
}

function normalizeAccount(raw: unknown): ImAccountSettings | undefined {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
	const record = raw as Record<string, unknown>;
	const channel = typeof record.channel === "string" ? record.channel.trim() : "";
	const name = typeof record.name === "string" ? record.name.trim() : "";
	if (channel === "" && name === "") return undefined;
	const id = typeof record.id === "string" && record.id.trim() !== "" ? record.id.trim() : `im-${Date.now().toString(36)}`;
	const note = typeof record.note === "string" ? record.note.trim() : "";
	return {
		id,
		channel: channel === "" ? "webhook" : channel,
		name: name === "" ? channel : name,
		enabled: typeof record.enabled === "boolean" ? record.enabled : true,
		...(note === "" ? {} : { note }),
	};
}

/** PATCH 合并：network/models/im 三段浅合并，im.accounts 整段替换。 */
function mergePatch(current: Settings, patch: Record<string, unknown>): Settings {
	const networkRaw = isRecord(patch.network) ? patch.network : {};
	const modelsRaw = isRecord(patch.models) ? patch.models : {};
	const imRaw = isRecord(patch.im) ? patch.im : {};

	const network: NetworkSettings = {
		host:
			typeof networkRaw.host === "string" && networkRaw.host.trim() !== ""
				? networkRaw.host.trim()
				: current.network.host,
		port: parsePort(networkRaw.port) ?? current.network.port,
	};

	// 模型清单只能通过 /api/models 增删；PATCH 只改默认模型
	const defaultModel =
		typeof modelsRaw.default === "string" && modelsRaw.default.trim() !== ""
			? modelsRaw.default.trim()
			: current.models.default;
	const models: ModelSettings = {
		...(defaultModel === undefined || defaultModel === "" ? {} : { default: defaultModel }),
		custom: current.models.custom,
	};

	const im: ImSettings = {
		enabled: typeof imRaw.enabled === "boolean" ? imRaw.enabled : current.im.enabled,
		outboundWebhook:
			typeof imRaw.outboundWebhook === "string"
				? imRaw.outboundWebhook.trim()
				: current.im.outboundWebhook,
		inboundToken:
			typeof imRaw.inboundToken === "string" ? imRaw.inboundToken.trim() : current.im.inboundToken,
		accounts: Array.isArray(imRaw.accounts)
			? imRaw.accounts.flatMap((item) => {
					const account = normalizeAccount(item);
					return account === undefined ? [] : [account];
				})
			: current.im.accounts,
	};

	// 保留未知顶层字段（例如将来新增的段），避免 PATCH 一次就丢配置
	return { ...current, network, models, im };
}

/** 校验并补齐一条自定义模型。 */
function normalizeCustomModel(record: Record<string, unknown>): CustomModelSettings | undefined {
	const id = typeof record.id === "string" ? record.id.trim() : "";
	if (!MODEL_ID_PATTERN.test(id)) return undefined;

	const provider = typeof record.provider === "string" ? record.provider.trim() : "openai-responses";
	const name = typeof record.name === "string" ? record.name.trim() : "";
	const baseUrl = typeof record.baseUrl === "string" ? record.baseUrl.trim() : "";
	const apiKey = typeof record.apiKey === "string" ? record.apiKey.trim() : "";
	const inputPerMTok = nonNegative(record.inputPerMTok);
	const outputPerMTok = nonNegative(record.outputPerMTok);
	const contextWindow = positive(record.contextWindow);
	const maxOutput = positive(record.maxOutput);
	if (baseUrl !== "" && !/^https?:\/\//i.test(baseUrl)) {
		throw new SettingsInputError("baseUrl 必须是 http(s) 地址");
	}

	return {
		id,
		...(name === "" ? {} : { name }),
		provider: provider === "" ? "openai-responses" : provider,
		...(baseUrl === "" ? {} : { baseUrl }),
		...(apiKey === "" ? {} : { apiKey }),
		...(inputPerMTok === undefined ? {} : { inputPerMTok }),
		...(outputPerMTok === undefined ? {} : { outputPerMTok }),
		...(contextWindow === undefined ? {} : { contextWindow }),
		...(maxOutput === undefined ? {} : { maxOutput }),
	};
}

/**
 * 写盘：同目录临时文件 + rename，保证任何时刻磁盘上都是一份完整 JSON。
 *
 * 文件权限固定 0600：这里可能存着模型的 apiKey，同机其他用户不该读得到。
 * 先写临时文件再 chmod 再 rename，避免「刚创建时是 0644」那一瞬的窗口。
 */
async function persist(path: string, settings: Settings): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`;
	await writeFile(temporary, `${JSON.stringify(settings, null, "\t")}\n`, { encoding: "utf8", mode: 0o600 });
	try {
		await chmod(temporary, 0o600);
	} catch {
		// 某些文件系统（网络盘 / Windows 挂载）不支持 chmod：不影响使用
	}
	await rename(temporary, path);
}

/** network + models 的指纹；im 改了立即生效，不影响 restartRequired。 */
function signature(settings: Settings): string {
	return JSON.stringify({
		network: settings.network,
		models: settings.models,
	});
}

// ── 小工具 ──────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePort(value: unknown): number | undefined {
	const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
	return Number.isFinite(parsed) && parsed >= 1 && parsed <= 65_535 ? Math.floor(parsed) : undefined;
}

function nonNegative(value: unknown): number | undefined {
	const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function positive(value: unknown): number | undefined {
	const parsed = nonNegative(value);
	return parsed !== undefined && parsed > 0 ? Math.floor(parsed) : undefined;
}
