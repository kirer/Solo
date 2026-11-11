/**
 * 附件（原 `uploads.ts`）：上传落盘与取回。
 *
 * 只读文件树已经删掉（ADR-091）——界面上没有「文件」页了，这个文件只剩附件。
 * 分界线照旧：**app 决定「这个 id 是什么、该不该内联、叫什么名字」**，
 * 传输层只负责把字节推出去。
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import sharp from "sharp";
import { createFiles } from "./files.ts";
import type { CoreServices } from "./types.ts";
import { AppError } from "./errors.ts";
import {
	contentDisposition,
	kindOfMime,
	putUpload,
	readUploadMeta,
	sweepOrphanUploads,
	UPLOAD_MAX_BYTES,
	uploadPathOf,
} from "../core/channel/attachments.ts";

/**
 * 「把正文里这个路径转成附件」用的前缀。
 *
 * 生成的是**真的一个附件**（同一个目录、同一份元数据），只是名字带前缀。前缀的作用是让
 * `read` 知道「这个能在还没发的时候预览」，同时告诉 `sweep` 这一份**有人正在用**。
 *
 * 待发的不许被 `sweep` 收走（季衡 R3）：输入框里那个附件没有任何消息引用它，按「没人引用
 * 就删」的规矩 10 分钟就被清掉，界面上只剩一个点不开的空壳，草稿恢复也跟着废。
 * 所以待发的只有在「被显式丢掉」之后才进入孤儿：`drop` 记下的 id 进墓碑，`draftFiles`
 * 写下的清单（防刷新丢东西）在墓碑到期前也算引用；墓碑过期以后就是普通孤儿，照常回收。
 */
export const STAGED_PREFIX = "staged-";

/** 当前事实的真相文件：`drop` 记墓碑、`draftFiles` 记正在用的 id。两者都在附件目录里。 */
const STAGED_STATE_FILE = "staged-state.json";

/** 墓碑留多久：够跨过一个浏览器刷新（刷新时 `draftFiles` 会把引用重新写回来）。 */
const TOMBSTONE_MS = 30 * 60_000;

/**
 * 缩图长边的上限（老板 2026-11-11：带图频道 21 张 80MB 全量下）。
 *
 * 1568 是 Claude 那条视觉模型管道认的边长，再大只是多传字节不多给信息。只缩不放：
 * 一张 400px 的小图缩完还是 400px，硬拉到 1568 只会糊。
 */
const PREVIEW_MAX_EDGE = 1568;

/** WebP 质量：图里 21 张截图这种，82 目视无差，体积是一半以下。 */
const PREVIEW_QUALITY = 82;

/** 待发附件的回收年龄：待发不会被上面那条 minAge 规则收走，它有自己的钟。 */
const STAGED_STALE_MS = 24 * 60 * 60_000;

type StagedState = {
	/** id → 丢掉的时刻。过了墓碑期这条就自动失效，不用另外清。 */
	readonly dropped: Readonly<Record<string, number>>;
	/** 界面上还挂在草稿里的 id（某个输入框还显示着它）。 */
	readonly drafts: readonly string[];
};

/**
 * 这张图正在生缩图的做法：同一个 id 同时来两次请求，只编一次，第二个等第一个的结果。
 *
 * 带图频道一打开，21 张图会同时请求 —— 每张编两遍等于开 42 个编码任务，
 * 而 libvips 自己是有线程上限的，多起来的只是排队和内存峰值。
 */
const previewInflight = new Map<string, Promise<{ path: string; bytes: number } | undefined>>();

/** 生缩图失败过的 id：一张坏图每次请求都重试一遍，等于每次打开频道都白烧一次 CPU。 */
const previewFailed = new Set<string>();

/**
 * 要缩图：盘上有就直接用，没有就现编一张（`<uploadsRoot>/previews/<id>.webp`）。
 *
 * 编的时候先写 `.tmp-<id>.webp` 再 rename —— 半张图落在正式名字上，下一次请求会把它
 * 当成「已经生成好」发出去，用户看到的是半张。rename 在同一目录里是原子的。
 *
 * 失败一律回 `undefined`（调用方退回原图）：
 * 图坏了、格式 libvips 不认、磁盘满了，都不该让「看图」这件事整个失败。
 * 失败记进 `previewFailed`，同一个 id 不再重试；本体被删/被替换（`removeUpload`）时清掉。
 */
async function ensurePreview(
	root: string,
	id: string,
	source: string,
): Promise<{ path: string; bytes: number } | undefined> {
	const target = previewPathOf(root, id);
	if (target === undefined) return undefined;

	const onDisk = await stat(target).catch(() => undefined);
	if (onDisk !== undefined && onDisk.isFile() && onDisk.size > 0) return { path: target, bytes: onDisk.size };
	if (previewFailed.has(id)) return undefined;

	const running = previewInflight.get(id);
	if (running !== undefined) return running;

	const task = (async () => {
		const dir = join(root, PREVIEW_DIR);
		const staging = join(dir, `.tmp-${id}.webp`);
		try {
			const source2 = await stat(source).catch(() => undefined);
			if (source2 === undefined) return undefined;
			await mkdir(dir, { recursive: true });
			// `fit: inside` + `withoutEnlargement`：只缩不放，长边封顶 1568。
			// 透明不铺底 —— 铺白底是 JPEG 那条线的妥协，WebP 原生带 alpha，不该丢。
			// Windows 上 libvips 按**路径**打开源图后，那份文件在它手里是锁着的 ——
			// 用户这时删附件（`removeUpload`）会撞 `EBUSY`，删不掉。
			// 所以先自己把字节读出来，交给 `sharp(buffer)`：libvips 从头到尾不碰这台机器上的路径，
			// 也就没有「攥着源图不放」这回事。附件最大也就几十 MB，读一遍完全划算。
			const sourceBytes = await readFile(source);
			// 另外 `destroy()` 自己收 pipeline —— 不靠 GC，GC 什么时候来不由我们定。
			const pipeline = sharp(sourceBytes);
			let bytes: Buffer;
			try {
				bytes = await pipeline
					.rotate() // 手机照片带 EXIF 方向，不转过来缩图是歪的
					.resize({ width: PREVIEW_MAX_EDGE, height: PREVIEW_MAX_EDGE, fit: "inside", withoutEnlargement: true })
					.webp({ quality: PREVIEW_QUALITY })
					.toBuffer();
			} finally {
				pipeline.destroy();
			}
			await writeFile(staging, bytes);
			await rename(staging, target);
			return { path: target, bytes: bytes.length };
		} catch (error: unknown) {
			previewFailed.add(id);
			await unlink(staging).catch(() => undefined);
			console.log(`[core] 缩图没生出来 ${id}：${(error as Error)?.message ?? "未知"}`);
			return undefined;
		} finally {
			previewInflight.delete(id);
		}
	})();
	previewInflight.set(id, task);
	return task;
}

/** 只有 `staged-` 开头的才记：别的 id 进状态文件等于给人一份能写到别处的清单。 */
function isStagedId(value: unknown): value is string {
	return typeof value === "string" && value.startsWith(STAGED_PREFIX) && !value.includes("/") && !value.includes("..");
}

/** 读状态文件：没有、坏了、类型不对一律当空 —— 这只是清理用的线索，不是业务状态。 */
async function readStagedState(root: string): Promise<StagedState> {
	try {
		const raw = await readFile(join(root, STAGED_STATE_FILE), "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return { dropped: {}, drafts: [] };
		const record = parsed as { dropped?: unknown; drafts?: unknown };
		const dropped: Record<string, number> = {};
		if (typeof record.dropped === "object" && record.dropped !== null) {
			for (const [id, at] of Object.entries(record.dropped)) {
				if (isStagedId(id) && typeof at === "number" && Number.isFinite(at)) dropped[id] = at;
			}
		}
		const drafts = Array.isArray(record.drafts) ? record.drafts.filter(isStagedId) : [];
		return { dropped, drafts };
	} catch {
		return { dropped: {}, drafts: [] };
	}
}

/** 写状态文件：先写临时文件再 `rename`，写一半断电也不会留下半截 JSON。 */
async function writeStagedState(root: string, state: StagedState): Promise<void> {
	const body = `${JSON.stringify(state, null, "\t")}\n`;
	const temp = join(root, `${STAGED_STATE_FILE}.tmp`);
	await writeFile(temp, body, "utf8");
	await rename(temp, join(root, STAGED_STATE_FILE));
}

/**
 * 删一个文件，删不掉要说出来。
 *
 * 早先这里是 `unlink(...).catch(() => undefined)` —— 整个吞掉。Windows 上很常见：
 * 刚生成完缩图、下游还握着句柄，`unlink` 撞 `EBUSY`，删不掉，可调用方以为删干净了，
 * 盘上留一份指向已删附件的孤儿（还会被当成「已生成」直接发出去）。
 * 所以：`ENOENT`（本来就没有）算成功；`EBUSY`/`EPERM` 退避重试几次；
 * 还不行就记一条日志（带上路径和最后一次的错误），**不静默**。
 */
async function unlinkOrReport(path: string): Promise<void> {
	const retries = 5;
	for (let attempt = 0; attempt <= retries; attempt += 1) {
		try {
			await unlink(path);
			return;
		} catch (error: unknown) {
			const code = (error as NodeJS.ErrnoException)?.code;
			// 本来就没有：目标达成。
			if (code === "ENOENT") return;
			// 只有「被别人攥着」值得重试；别的错（权限、路径非法）重试也没用。
			const held = code === "EBUSY" || code === "EPERM" || code === "EACCES";
			if (!held || attempt === retries) {
				console.log(`[core] 删不掉 ${path}：${(error as Error)?.message ?? "未知"}`);
				return;
			}
			await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
		}
	}
}

/** 顺手删掉一个附件的本体与元数据；本来就不在也算成功（`drop` 是幂等的）。 */
async function removeUpload(root: string, id: string): Promise<void> {
	const path = uploadPathOf(root, id);
	if (path === undefined) return;
	await unlinkOrReport(path);
	await unlinkOrReport(`${path}.json`);
	const thumb = previewPathOf(root, id);
	if (thumb !== undefined) await unlinkOrReport(thumb);
	// 这个 id 已经没了，生缩图失败的黑名单跟着清 —— 不然它也一直涨，而且万一以后
	// 同一个 id 又出现（理论上不会），会带着一个莫名其妙的「失败过」标记。
	previewFailed.delete(id);
}

/**
 * 缩图在盘上的位置：`<uploadsRoot>/previews/<id>.webp`。
 *
 * 和附件本体**同根**，是为了让清理只需要一套规矩：本体没了、或者本体被 `sweep` 当孤儿收走，
 * 缩图跟着消失。单独开一个目录再自己维护引用，迟早会漏。
 */
export const PREVIEW_DIR = "previews";

export function previewPathOf(root: string, id: string): string | undefined {
	return uploadPathOf(root, id) === undefined ? undefined : join(root, PREVIEW_DIR, `${id}.webp`);
}

/** 取一个附件时要给传输层的东西。 */
export type UploadForRead = {
	readonly path: string;
	readonly mime: string;
	readonly bytes: number;
	readonly name: string;
	/** 浏览器直接显示（图片 / PDF / 文本），而不是下载。 */
	readonly inline: boolean;
	readonly disposition: string;
};

export function createUploads(shell: CoreServices) {
	const root = shell.layout.uploadsRoot;
	/** 转附件时走的是同一条预览/校验：路径规矩只有一份。 */
	const files = createFiles(shell.layout);

	/**
	 * `preview` = 在聊天里点开看一眼：图片 / PDF / 文本内联，其余照旧下载。
	 *
	 * HTML **永远按 `text/plain`** 发：附件是同源的，一个自称 HTML 的上传一旦当页面执行，
	 * 就是自己给自己开了一个 XSS。预览文本也声明编码 —— 中文文件不声明会变乱码。
	 */
	async function read(
		id: string,
		options: { readonly download?: boolean; readonly preview?: boolean } = {},
	): Promise<UploadForRead> {
		// 白名单 id 同时挡住了路径穿越：`../core.sqlite` 在 `:id` 里捕获不到 `/`，
		// 但 `..%2f` 能被解码回来，所以还是靠 `isUploadId` 再收一道。
		const path = uploadPathOf(root, id);
		const meta = await readUploadMeta(root, id);
		if (path === undefined || meta === undefined) throw new AppError("not-found", "没有这个文件");
		const text = meta.mime.startsWith("text/") || meta.mime === "application/pdf";
		const inline = options.download !== true && (kindOfMime(meta.mime) === "image" || (options.preview === true && text));
		// 列表要的是缩图，点开要的是原图 —— 分界就在这里：
		// `preview=1` 且**没要下载**、而且是图片，才走缩图；`preview=1&download=1` 与不带
		// `preview` 一律原图。缩图还没生成好（或生成失败）就退回原图，不能因为缩图把图看不了。
		//
		// 只看「缩图在不在盘上」，**不在这里生成**：这个函数在请求路径上，还在 `app` 层，
		// 不该在这里起编码任务；生成与回收在 `sweep` 那一轮统一做。
		if (options.download !== true && options.preview === true && kindOfMime(meta.mime) === "image") {
			const thumb = await ensurePreview(root, id, path);
			if (thumb !== undefined) {
				return {
					path: thumb.path,
					mime: "image/webp",
					bytes: thumb.bytes,
					name: meta.name,
					inline: true,
					disposition: contentDisposition(true, meta.name),
				};
			}
		}
		const mime = inline && options.preview === true && meta.mime.startsWith("text/") ? `${meta.mime}; charset=utf-8` : meta.mime;
		return {
			path,
			mime: inline && options.preview === true && meta.mime === "text/html" ? "text/plain; charset=utf-8" : mime,
			bytes: meta.bytes,
			name: meta.name,
			inline,
			disposition: contentDisposition(inline, meta.name),
		};
	}

	/**
	 * 清一次上传孤儿（审计 P2-3）。
	 *
	 * 引用真相是频道文档里的 `attachments`：一条消息引用过的 id 一个都不动，其余超过
	 * 10 分钟的（避免误删正在上传的那半套）删掉。失败只记一行，不影响启动 ——
	 * 清不掉只是占点磁盘。
	 *
	 * 待发附件（`staged-`）另算（季衡 R3）：界面正在用的（`draftFiles` 报上来的）一个不动；
	 * 被 `drop` 掉、或早就不在界面上、又放了 24 小时的，才回收。判据在两次扫之间会变
	 * （界面随时丢弃、刷新随时重报），所以真删之前再读一次状态文件，翻回去了就不删。
	 */
	async function sweep(): Promise<void> {
		try {
			const state = await shell.channels();
			const messageIds = new Set<string>();
			for (const list of Object.values(state.messages ?? {})) {
				for (const message of list) {
					for (const attachment of message.attachments ?? []) messageIds.add(attachment.id);
				}
			}
			const candidates = await stagedCandidates();
			// 删之前再读一次：候选里已经重新被界面认领的（刷新重报 / 又拖回来了）放过。
			const fresh = await readStagedState(root);
			const revive = new Set<string>(fresh.drafts);
			// 缩图跟着附件本体走同一趟：本体是孤儿要删的，缩图别再等下一轮 ——
			// 两轮之间本体已经没了，缩图就成了永远没人认领也不够条件删的垃圾。
			const result = await sweepOrphanUploads(root, new Set([...messageIds, ...revive]), Date.now(), {
				staged: { staleMs: STAGED_STALE_MS, only: candidates },
				previews: PREVIEW_DIR,
			});
			// 过了墓碑期、又不在草稿里的墓碑不再有用，顺手清掉。
			const now = Date.now();
			const kept = Object.entries(fresh.dropped).filter(([, at]) => now - at < TOMBSTONE_MS);
			if (kept.length !== Object.keys(fresh.dropped).length) {
				await writeStagedState(root, { dropped: Object.fromEntries(kept), drafts: fresh.drafts }).catch(() => undefined);
			}
			if (result.removed > 0) {
				console.log(`[core] 清掉 ${result.removed} 个没人引用的上传文件（扫描 ${result.scanned} 个）`);
			}
		} catch {
			/* 清理失败不影响启动 */
		}
	}

	/** 哪些待发附件可以回收：被丢掉（墓碑里）或者不在任何草稿里、并且放了够久。 */
	async function stagedCandidates(): Promise<Set<string>> {
		const state = await readStagedState(root);
		let names: string[];
		try {
			names = await readdir(root);
		} catch {
			return new Set();
		}
		const drafts = new Set(state.drafts);
		const now = Date.now();
		const candidates = new Set<string>();
		for (const name of names) {
			if (name.endsWith(".json")) continue;
			if (!isStagedId(name)) continue;
			const droppedAt = state.dropped[name];
			if (drafts.has(name)) continue;
			if (droppedAt === undefined) {
				// 没被显式丢掉、也不在草稿里：可能是界面还没报上来。只用时间兜底，别急着删。
				const info = await stat(join(root, name)).catch(() => undefined);
				if (info !== undefined && now - info.mtimeMs >= STAGED_STALE_MS) candidates.add(name);
				continue;
			}
			candidates.add(name);
		}
		return candidates;
	}

	/**
	 * 界面上把这个待发附件丢掉了（删草稿、点叉）：立刻删盘，别等下一轮扫。
	 *
	 * 先记墓碑再删：两次请求撞在一起（这边刚放下、那边 `draftFiles` 又把它报成在用），
	 * 墓碑让 `sweep` 知道「这一份已经有人明确不要了」。删不掉就留着当墓碑，下一轮扫再删。
	 */
	async function drop(ids: readonly string[]): Promise<void> {
		const live = ids.filter(isStagedId);
		if (live.length === 0) return;
		const state = await readStagedState(root);
		const now = Date.now();
		const dropped: Record<string, number> = { ...state.dropped };
		for (const id of live) dropped[id] = now;
		const drafts = state.drafts.filter((id) => !live.includes(id));
		await writeStagedState(root, { dropped, drafts });
		for (const id of live) await removeUpload(root, id);
	}

	/**
	 * 界面报一次「我现在挂在草稿上的待发附件是这些」。
	 *
	 * 为什么要有：重启、断网、浏览器崩掉之后，界面手上的清单和盘上的文件对不上。全量上报
	 * 一次，后端就知道哪些还活着、哪些早没人要了 —— 不用猜。不在清单里的**不立即删**，
	 * 交给 `sweep` 按年纪回收，免得两个窗口各报一份时互相踩。
	 */
	async function draftFiles(ids: readonly string[]): Promise<void> {
		const live = [...new Set(ids.filter(isStagedId))];
		const state = await readStagedState(root);
		const dropped: Record<string, number> = { ...state.dropped };
		// 又被认领回来的不算丢过了。
		for (const id of live) delete dropped[id];
		await writeStagedState(root, { dropped, drafts: live });
	}

	/**
	 * 把正文里的一个路径转成一个**待发附件**。
	 *
	 * 两个必须：①**先过 `files.preview`**，路径校验一条都不新写 —— 那三条硬线（相对路径、
	 * 不许 `..`、隐藏文件与自家密钥不给看）本来就在那儿，绕开它等于开了第二个后门；
	 * ②只搬 `preview` 认的字节（文本 / 图片 / PDF，各有大小上限），认不出的不搬 ——
	 * 转成附件以后，界面就要负责把它画出来，画不了的东西别往队列里放。
	 *
	 * id 带 `STAGED_PREFIX`：发出去之前没有消息引用它，所以它靠 `draftFiles` / `drop` 自报
	 * 「还在用」；界面明确丢掉之后立刻删盘，没人报又放了很久的由 `sweep` 兜底回收。
	 */
	async function stage(path: string): Promise<{ readonly id: string; readonly name: string; readonly kind: "image" | "file"; readonly bytes: number }> {
		const file = await files.preview(path);
		// 认不出的格式与找不到分开说：前者是「换不了」，后者是「没这个文件」。
		if (file.kind === "none") throw new AppError(file.status === 415 ? "bad-request" : "not-found", file.reason);
		// 放开了绝对路径之后，`/etc/passwd`、`/var/log/…` 这类都能点到「转成附件」——
		// 先按 `preview` 给的大小挡一道，别为了一个 4GB 的日志把内存吃光。
		if (file.size > UPLOAD_MAX_BYTES) {
			throw new AppError("too-large", `单个附件最大 ${Math.round(UPLOAD_MAX_BYTES / 1024 / 1024)}MB，这个太大了`);
		}
		let bytes: Uint8Array;
		try {
			bytes = await readFile(file.path);
		} catch {
			throw new AppError("not-found", "这个文件读不出来");
		}
		// 读完再看一眼大小：`preview` 判的是它 `stat` 那一刻的大小，中间被改大就不搬。
		const now = await stat(file.path).catch(() => undefined);
		if (now === undefined || now.size !== bytes.byteLength) throw new AppError("bad-request", "文件正在变，稍后再试");
		const name = basename(file.name) === "" ? "附件" : file.name;
		return await putUpload(root, { id: STAGED_PREFIX + randomUUID(), name, mime: file.mime, bytes, at: Date.now() });
	}

	return { root, read, stage, drop, draftFiles, sweep };
}
