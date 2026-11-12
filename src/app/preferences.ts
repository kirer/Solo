/**
 * 界面能改的少数几项偏好，存进 `settings.json`。
 *
 * 两项：**更新代理**（只给桌面版下载新版安装包用，模型调用不走它）与
 * **额外工作目录**（`file` / `search` 在两个根之外还能访问的目录，ADR-126）。
 *
 * 额外目录是安全边界的开口，所以校验只在「用户亲手加」这一刻发生：必须是绝对路径、
 * 必须真的存在、必须是目录。写进去的是展开 `~` 之后的绝对路径，工具侧只做字符串比对。
 * 未配置时 `workDirs` 键不存在，`file` / `search` 的行为与以前逐字一样。
 */
import { isAbsolute, resolve } from "node:path";
import { expandHomePath, readSettingsFile, updateSettingsFile, workDirsOf } from "../core/runtime/settings.ts";
import { fileStatAt } from "../core/runtime/io.ts";
import { AppError } from "./errors.ts";
import type { CoreServices } from "./types.ts";

export type Preferences = {
	readonly updateProxy: string;
	/** 额外工作目录（绝对路径，按加入顺序）。空数组 = 没配。 */
	readonly workDirs: readonly string[];
};

/** 空串 = 直连。写死三种协议即可，Electron 的 proxyRules 也认这些。 */
const PROXY = /^(https?|socks5?):\/\/[^\s]+$/i;

/** 上限只是防手滑（一次加几百个目录，`file` 每次调用都要比一遍）：不是功能边界。 */
const MAX_WORK_DIRS = 20;

/**
 * 校验一组目录，返回规整后的绝对路径。任何一条不合格就整份拒绝 —— 只存一半的话，
 * 用户会以为全加上了。
 */
async function checkWorkDirs(raw: unknown): Promise<readonly string[]> {
	if (!Array.isArray(raw)) throw new AppError("bad-request", "workDirs 必须是数组");
	if (raw.length > MAX_WORK_DIRS) throw new AppError("bad-request", `最多加 ${String(MAX_WORK_DIRS)} 个目录`);
	const out: string[] = [];
	for (const entry of raw) {
		if (typeof entry !== "string") throw new AppError("bad-request", "workDirs 里的每一项都必须是字符串");
		const trimmed = entry.trim();
		if (trimmed === "") continue;
		const expanded = expandHomePath(trimmed);
		if (!isAbsolute(expanded)) {
			throw new AppError("bad-request", `要用绝对路径（例如 /Users/你/code）：${trimmed}`);
		}
		const path = resolve(expanded);
		if (path === resolve("/")) throw new AppError("bad-request", "不能把整个磁盘根目录加进来");
		const info = await fileStatAt(path);
		if (info === undefined) throw new AppError("bad-request", `这个目录不存在或打不开：${path}`);
		if (info.isFile) throw new AppError("bad-request", `这是一个文件，不是目录：${path}`);
		if (!out.includes(path)) out.push(path);
	}
	return out;
}

function field(body: unknown, key: string): unknown {
	return typeof body === "object" && body !== null ? (body as Record<string, unknown>)[key] : undefined;
}

function has(body: unknown, key: string): boolean {
	return typeof body === "object" && body !== null && Object.prototype.hasOwnProperty.call(body, key);
}

export function createPreferences(services: CoreServices) {
	const read = async (): Promise<Preferences> => {
		const settings = readSettingsFile(services.layout.settingsFile);
		return { updateProxy: settings?.updateProxy ?? "", workDirs: workDirsOf(settings) };
	};

	return {
		read,
		/**
		 * 只动请求里给了的键：老版本界面（只发 `updateProxy`）照旧能用，`providers` /
		 * `agentModels` 等别的键原样保留。
		 */
		async save(body: unknown): Promise<Preferences> {
			const proxyGiven = has(body, "updateProxy");
			const dirsGiven = has(body, "workDirs");
			if (!proxyGiven && !dirsGiven) {
				throw new AppError("bad-request", "没有要保存的项（updateProxy 或 workDirs）");
			}
			let proxy: string | undefined;
			if (proxyGiven) {
				const value = field(body, "updateProxy");
				if (typeof value !== "string") throw new AppError("bad-request", "updateProxy 必须是字符串");
				proxy = value.trim();
				if (proxy !== "" && !PROXY.test(proxy)) {
					throw new AppError("bad-request", "代理地址要以 http:// 或 socks5:// 开头，例如 http://127.0.0.1:7890");
				}
			}
			const dirs = dirsGiven ? await checkWorkDirs(field(body, "workDirs")) : undefined;
			// 只动给了的键：providers / agentModels / 其它不认识的键原样保留。
			updateSettingsFile(services.layout.settingsFile, (settings) => {
				if (proxy !== undefined) {
					if (proxy === "") delete settings["updateProxy"];
					else settings["updateProxy"] = proxy;
				}
				if (dirs !== undefined) {
					if (dirs.length === 0) delete settings["workDirs"];
					else settings["workDirs"] = [...dirs];
				}
			});
			return read();
		},
	};
}
