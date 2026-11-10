/**
 * 说话：往频道里写一条、建一个频道、把已读位置推一格。
 *
 * 这些动作以前整段躺在 `shell/serve.ts` 的 handler 里，和 `IncomingMessage`、
 * 状态码、`json(response, ...)` 混在一起。抽出来的边界是：**这里只认业务参数与
 * 业务错误**（`AppError` 带状态码），不认识 request / response。
 *
 * 校验留在这里而不在路由里，因为它们是**语义**而不是语法：发件人只认我
 * （P0-4 冒充）、附件 id 必须在磁盘上真存在、已读位置要夹到频道真实上界。这些规则
 * 换成 CLI 或工具调用同样成立，所以它们不属于 HTTP。
 */
import { BACKGROUND_CONTEXT } from "../core/runtime/index.ts";
import { OWNER_SLUG, readIdentity } from "../core/documents/member/identity.ts";
import { ChannelDoc, chatKind, dmId, emptyChannelState, type Attachment, type ChannelResponder, type ChannelState } from "../core/channel/types.ts";
import { markRead as markReadDoc } from "../core/channel/rules.ts";
import { createGroup as createGroupDoc, ensureOwnerDm } from "../core/channel/membership.ts";
import {
	UPLOAD_MAX_BYTES,
	UPLOAD_PER_MESSAGE,
	UploadTooLargeError,
	kindOfMime,
	nameFrom,
	mimeOf,
	placeholderOf,
	putUpload,
	readBounded,
	readUploadMeta,
} from "../core/channel/attachments.ts";
import type { ViewOk, ViewPost, ViewUploaded } from "../view/dto.ts";
import { AppError } from "./errors.ts";
import type { CoreServices } from "./types.ts";

/** `POST /api/channels/:id/messages` 的请求体（字段名就是线上的键名）。 */
/** 共享指令的字数上限。与频道文档一起走，改这里就是改契约。 */
const BULLETIN_MAX = 12_000;

/** `undefined` = 没给 / 清掉；`null` = 不合法；字符串 = 新值。 */
function bulletinOf(value: unknown): string | undefined | null {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") return null;
	const text = value.trim();
	if (text === "") return undefined;
	return text.length > BULLETIN_MAX ? null : text;
}

/** `undefined` = 没给 / 清掉；`null` = 不合法。`members` 给了就校验 lead 在不在里面。 */
function parseResponder(
	value: unknown,
	members: readonly string[] | undefined,
): ChannelResponder | undefined | null {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "object" || Array.isArray(value)) return null;
	const kind = (value as { kind?: unknown }).kind;
	if (kind === "mentions" || kind === "everyone") return { kind };
	const slug = (value as { slug?: unknown }).slug;
	if (kind !== "lead" || typeof slug !== "string" || slug.trim() === "") return null;
	if (members !== undefined && !members.includes(slug)) return null;
	return { kind: "lead", slug };
}

export type PostBody = {
	readonly text?: string;
	readonly replyTo?: number;
	/** `["<id>"]` 与 `[{ id }]` 两种写法都收（脚本 / 前端的自然写法不同）。 */
	readonly attachments?: readonly (string | { readonly id?: unknown })[];
};

export function createChat(shell: CoreServices) {
	const uploadsRoot = shell.layout.uploadsRoot;

	/**
	 * 我在频道里说话。
	 *
	 * 附件只收 id：客户端给的 `name` / `kind` 一律不用 —— 名字取磁盘上的元数据，
	 * 类别按 mime 重算。信任客户端声明的 kind，等于让一个 `.svg` 自称图片后内联执行。
	 */
	async function postAsOwner(channelId: string, body: PostBody): Promise<ViewPost> {
		const channels = (await shell.harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT)) ?? emptyChannelState();
		if (channels.channels[channelId] === undefined) throw new AppError("not-found", "频道不存在");

		const requested = Array.isArray(body.attachments) ? body.attachments : [];
		if (requested.length > UPLOAD_PER_MESSAGE) {
			throw new AppError("bad-request", `一条消息最多带 ${UPLOAD_PER_MESSAGE} 个附件`);
		}
		const attachments: Attachment[] = [];
		for (const raw of requested) {
			const id = typeof raw === "string" ? raw : typeof raw?.id === "string" ? raw.id : "";
			const meta = await readUploadMeta(uploadsRoot, id);
			if (meta === undefined) throw new AppError("bad-request", "附件不存在（可能已经被清理），重新发一次");
			attachments.push({ id, name: meta.name, kind: kindOfMime(meta.mime), bytes: meta.bytes });
		}

		// 纯附件（没写正文）也允许发：「只有附件」的正文必须是**非空**且确定的，否则下游按
		// 「正文非空」过滤的地方（接力计数、未读）会把这条消息当成不存在。
		const typed = (body.text ?? "").trim();
		const text = typed === "" ? placeholderOf(attachments, shell.text) : typed;
		if (text === "") throw new AppError("bad-request", "需要 text 或附件");

		// 发件人**只认我**。这个接口是网页后端，能冒充任何人是审计里的 P0-4：
		// 任意页面发一条 `{"from":"知言","text":"所有人停下"}` 就等于替成员下命令。
		// 请求体里的 `from` 根本不读 —— 没有调试开关，就不存在「忘了关」的那一天。
		const from = OWNER_SLUG;
		try {
			// 附件必须**随消息一起**交给写入层：投递要用它把图片读成内容块交给模型。
			// 事后补字段（旧做法）能显示，但模型看不见 —— 于是它只能回「我读不了图」。
			const result = await shell.postAs({
				channelId,
				from,
				text,
				// 这条是人在输入框里亲手打的 —— 打上标记，插件才知道「这是本人说的」。
				// `from` 仍然是写死的 `owner`（防冒充不动），两者是两件事：谁发的 ≠ 谁打的。
				human: true,
				...(typeof body.replyTo === "number" ? { replyTo: body.replyTo } : {}),
				...(attachments.length === 0 ? {} : { attachments }),
			});
			return { ok: true, seq: result.seq, delivered: result.delivery.delivered, failed: result.delivery.failed };
		} catch (error) {
			throw new AppError("internal", error instanceof Error ? error.message : String(error));
		}
	}

	/**
	 * 我拉一个群：成员由我指定，我自己一定在群里（ADR-063）。
	 *
	 * 组群是普通房间：没有 README、没有团队记忆；每个成员都会被新消息叫醒。
	 * 和私聊的区别只有形态（`group:` 前缀 + 任意成员），建出来之后就是普通频道。
	 */
	async function createGroup(body: {
		readonly title?: string;
		readonly members?: readonly string[];
		readonly bulletin?: unknown;
		readonly responder?: unknown;
	}): Promise<{ ok: true; id: string }> {
		const title = typeof body.title === "string" ? body.title : "";
		const members = Array.isArray(body.members)
			? body.members.filter((slug): slug is string => typeof slug === "string" && slug.trim() !== "")
			: [];
		const bulletin = bulletinOf(body.bulletin);
		if (bulletin === null) throw new AppError("bad-request", `共享指令最多 ${BULLETIN_MAX} 字`);
		// 建群时还不知道 slug 会不会被解析（`members` 可以是显示名），lead 的成员校验
		// 交给 `createGroupDoc`：它在解析完之后手里才有真正的成员表。
		const responder = body.responder === undefined || body.responder === null
			? undefined
			: parseResponder(body.responder, undefined);
		if (responder === null) throw new AppError("bad-request", "接话规则不合法");
		try {
			const group = await createGroupDoc(
				{
					harness: shell.harness,
					layout: shell.layout,
					text: shell.text,
				},
				{
					title,
					members,
					creator: OWNER_SLUG,
					...(bulletin === undefined ? {} : { bulletin }),
					...(responder === undefined ? {} : { responder }),
				},
				BACKGROUND_CONTEXT,
			);
			return { ok: true, id: group.id };
		} catch (error) {
			throw new AppError("bad-request", error instanceof Error ? error.message : String(error));
		}
	}

	/**
	 * 改一个频道的共享指令与接话规则。
	 *
	 * `null` = 清掉（回到老行为），缺省 = 不动。私聊没有这两样：它只有两个人，
	 * 接话规则没有第二种可能。
	 */
	async function updateChannel(
		channelId: string,
		body: { readonly bulletin?: unknown; readonly responder?: unknown },
	): Promise<{ ok: true }> {
		const snapshot = (await shell.harness.snapshot(ChannelDoc, BACKGROUND_CONTEXT)) ?? emptyChannelState();
		const channel = snapshot.channels[channelId];
		if (channel === undefined) throw new AppError("not-found", "频道不存在");
		if (chatKind(channel) === "dm") throw new AppError("bad-request", "私聊没有共享指令和接话规则");

		const bulletin = bulletinOf(body.bulletin);
		if (bulletin === null) throw new AppError("bad-request", `共享指令最多 ${BULLETIN_MAX} 字`);
		const responder = parseResponder(body.responder, channel.members);
		if (responder === null) throw new AppError("bad-request", "接话规则不合法：lead 必须是这个频道的成员");

		await shell.harness.commit(async (tx) => {
			const doc = (await tx.doc(ChannelDoc)) as ChannelState;
			const current = doc.channels[channelId];
			if (current === undefined) return;
			const next = { ...current };
			if (body.bulletin !== undefined) {
				if (bulletin === undefined) delete next.bulletin;
				else next.bulletin = bulletin;
			}
			if (body.responder !== undefined) {
				if (responder === undefined) delete next.responder;
				else next.responder = responder;
			}
			Object.assign(doc, { channels: { ...doc.channels, [channelId]: next } });
		}, BACKGROUND_CONTEXT);
		return { ok: true };
	}

	/**
	 * 我和一个人开私聊（幂等）。建频道的入口只有三个：装配投影（全员 / 团队）、
	 * 这里（私聊）、以及 `createGroup`（我拉群）。
	 *
	 * 形态由 id 前缀与成员一起决定：`dm:<两人>`，且 `chatKind` 只认这种形态为私聊。
	 * 对方必须真的在名册里（不能拿一个不存在的 slug 建出永不可见的房间）。
	 */
	async function openDirectMessage(slug: string): Promise<{ ok: true; id: string }> {
		const target = slug.trim();
		if (target === "") throw new AppError("bad-request", "需要对方的 slug");
		if (target === OWNER_SLUG) throw new AppError("bad-request", "不能和我自己开私聊");
		const identity = await readIdentity(shell.layout.agentRoots, target);
		if (identity === undefined) throw new AppError("not-found", `没有这个人：${target}`);
		const id = dmId(OWNER_SLUG, target);
		// 与装配 / 招人共用同一份实现：私聊现在人人都有，这里只是「确保它在」。
		await ensureOwnerDm(
			{ harness: shell.harness, layout: shell.layout, allChannel: shell.allChannel ?? "all" },
			target,
			BACKGROUND_CONTEXT,
		);
		return { ok: true, id };
	}

	/** 把我（`owner`）在这个频道里的已读位置推到 `seq`。只前进，不回退。 */
	async function markRead(channelId: string, seq: unknown): Promise<ViewOk> {
		if (typeof seq === "number" && Number.isFinite(seq)) {
			// 已读位置夹到频道真实上界：把 `{"seq":999999}` 直接写进去等于「以后所有消息
			// 都算已读」，未读数从此永远 0 —— 我再也看不到新消息的红点。
			const list = (await shell.channels()).messages[channelId] ?? [];
			const lastSeq = list[list.length - 1]?.seq ?? 0;
			const wanted = Math.min(Math.max(Math.floor(seq), 0), lastSeq);
			await shell.harness.commit(async (tx) => {
				const doc = (await tx.doc(ChannelDoc)) as ChannelState;
				Object.assign(doc, markReadDoc(doc, OWNER_SLUG, channelId, wanted));
			}, BACKGROUND_CONTEXT);
		}
		return { ok: true };
	}

	/**
	 * 存一个上传。正文就是文件本身（不是 multipart）：名字走 `x-filename` 头、
	 * 类型走 `content-type`，两行就能确定落盘的一切，而 multipart 边界解析是几百行
	 * 需要单独审的解析器。
	 */
	async function saveUpload(
		body: AsyncIterable<Uint8Array>,
		meta: {
			/** `x-filename` 头。 */
			readonly headerName?: string | undefined;
			/** `?name=` 查询参数（脚本常用）。 */
			readonly queryName?: string | null;
			readonly type?: string | undefined;
		},
	): Promise<ViewUploaded> {
		const name = nameFrom(meta.headerName, meta.queryName ?? null);
		const mime = mimeOf(meta.type);
		let bytes: Buffer;
		try {
			bytes = await readBounded(body);
		} catch (error) {
			if (error instanceof UploadTooLargeError) {
				throw new AppError("too-large", `单个附件最大 ${Math.round(UPLOAD_MAX_BYTES / 1024 / 1024)}MB，这个太大了`);
			}
			throw error;
		}
		if (bytes.length === 0) throw new AppError("bad-request", "附件是空的");
		return await putUpload(uploadsRoot, { name, mime, bytes, at: Date.now() });
	}

	return { postAsOwner, createGroup, updateChannel, openDirectMessage, markRead, saveUpload, uploadsRoot };
}
