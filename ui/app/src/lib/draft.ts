/**
 * 输入框的草稿：正文 + 待发附件，按频道各存一份，落 `localStorage`。
 *
 * 为什么要有这个：正文原来是组件里的 `useState`，切频道就重置，关窗更是什么都不剩。
 * 人打了半屏话、手滑点了旁边一个频道，回来是空的 —— 这是会白干活的一类问题，
 * 不是「体验不好」。附件同理：传上去之后只差「发送」，重开还得重传一遍。
 *
 * 存的形式：`solo.draft.<channelId>` → `{ text, files, at }`，`at` 是写入时间。
 * 附件存的是服务端回执（`id/name/kind/bytes`），不存预览地址 —— `blob:` 地址活不过一次刷新，
 * 按 `id` 拼 `/api/uploads/<id>` 重新预览就行，不用再传一遍。
 *
 * 没 `localStorage` 的环境（node 里跑单测）读不到就当没有，不抛错：这是偏好，不是状态。
 */

/** 草稿里的一个附件：就是服务端回执那四个字段。 */
export type DraftFile = { id: string; name: string; kind: "image" | "file"; bytes: number };

/** 一个频道里还没发出去的东西。 */
export type ComposerDraft = { text: string; files: DraftFile[] };

const PREFIX = "solo.draft.";

/** 单条草稿的上限：正文截到 20000 字，附件最多 10 个（跟一条消息的附件上限一致）。 */
const MAX_TEXT = 20000;
const MAX_FILES = 10;

const EMPTY: ComposerDraft = { text: "", files: [] };

function storage(): Storage | undefined {
	try {
		return typeof localStorage === "undefined" ? undefined : localStorage;
	} catch {
		// 隐私模式下访问 localStorage 会抛，按「存不了」处理，不影响打字。
		return undefined;
	}
}

/** 一个附件回执是不是完整可用。 */
function isDraftFile(value: unknown): value is DraftFile {
	if (typeof value !== "object" || value === null) return false;
	const file = value as Record<string, unknown>;
	return (
		typeof file.id === "string" &&
		file.id !== "" &&
		typeof file.name === "string" &&
		(file.kind === "image" || file.kind === "file") &&
		typeof file.bytes === "number" &&
		Number.isFinite(file.bytes)
	);
}

/** 读一个频道的草稿：没有、坏了、类型不对，一律当空。 */
export function readDraft(channelId: string | null): ComposerDraft {
	if (channelId === null || channelId === "") return { ...EMPTY };
	const raw = storage()?.getItem(PREFIX + channelId);
	if (raw === undefined || raw === null) return { ...EMPTY };
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return { ...EMPTY };
		const record = parsed as { text?: unknown; files?: unknown };
		const text = typeof record.text === "string" ? record.text.slice(0, MAX_TEXT) : "";
		const files = Array.isArray(record.files) ? record.files.filter(isDraftFile).slice(0, MAX_FILES) : [];
		return { text, files };
	} catch {
		return { ...EMPTY };
	}
}

/** 写一个频道的草稿：正文空、附件也空就整条删掉，别在 localStorage 里攒空壳。 */
export function writeDraft(channelId: string | null, draft: ComposerDraft): void {
	if (channelId === null || channelId === "") return;
	const store = storage();
	if (store === undefined) return;
	const text = draft.text.slice(0, MAX_TEXT);
	const files = draft.files.slice(0, MAX_FILES);
	if (text === "" && files.length === 0) {
		store.removeItem(PREFIX + channelId);
		return;
	}
	store.setItem(PREFIX + channelId, JSON.stringify({ text, files, at: Date.now() }));
}

/** 发出去之后把这个频道的草稿清掉。 */
export function clearDraft(channelId: string | null): void {
	if (channelId === null || channelId === "") return;
	storage()?.removeItem(PREFIX + channelId);
}
