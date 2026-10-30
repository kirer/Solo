/**
 * 后端视图的 TypeScript 镜像。
 *
 * 权威定义在 `src/core/shell/view.ts` —— 这里只抄界面真会读的字段，**不加**后端没有的东西
 * （界面不画后端没有的数据，见 ADR-016）。抄漏了会编译错，抄多了会让人以为后端有这个字段，
 * 所以宁可少抄、需要时再去后端确认。
 */

/**
 * 会话只有两种形态，按成员推（后端 `chatKind`）：
 *
 * - `dm`：恰好我和一个人 —— 标题是对方的名字；
 * - `group`：其余全部 —— 全员群、团队群、三个人以上的群都算。
 *
 * 没有「项目频道」「个人频道」这些分类：标题、头像、副标题全部从这两类里推。
 */
export type ChannelKind = "dm" | "group";

export type Attachment = { id: string; name: string; kind: "image" | "file"; bytes: number };

export type Channel = {
	id: string;
	kind: ChannelKind;
	owner?: string;
	leadLabel?: string;
	doing?: string;
	title: string;
	team?: string;
	unread: number;
	mentions: number;
	preview: string;
	lastAt: number;
	lastSeq: number;
	memberCount: number;
};

export type Mention = { id: number; label: string; read: boolean; offset: number };

export type Message = {
	seq: number;
	at: number;
	from: number;
	fromSlug: string;
	fromLabel: string;
	kind: string;
	text: string;
	mentions: Mention[];
	replyTo?: { seq: number; from: number; fromSlug: string; fromLabel: string; excerpt: string };
	read: boolean;
	needsYou?: true;
	attachments?: Attachment[];
};

export type Member = { id: number; slug: string; label: string; role: string; unread: number };

export type ChannelDetail = {
	channel: Omit<Channel, "unread" | "mentions" | "preview">;
	members: Member[];
	messages: Message[];
	hasMore: boolean;
	serverNow: number;
};

export type Actor = {
	slug: string;
	label: string;
	title: string;
	team?: string;
	manager?: string;
	managerLabel?: string;
	body: string;
	presence?: "idle" | "working" | "thinking";
	lastAt?: number;
};

export type Org = { company: { name: string }; people: Actor[] };

export type AttentionItem = {
	channelId: string;
	channelKind: ChannelKind;
	channelTitle: string;
	seq: number;
	at: number;
	from: number;
	fromSlug: string;
	fromLabel: string;
	excerpt: string;
	read: boolean;
};

/**
 * 一条记忆。
 *
 * `at`/`by`/`op` 是它的来历，来自 `agents/<slug>/.memory-journal.jsonl`。
 * 手写进 `memory.md` 的条目没有日志，后端给 `null` —— 前端照实留空，不编时间。
 */
export type MemoryEntry = {
	heading: string;
	body: string;
	at: string | null;
	by: string | null;
	op: "add" | "edit" | null;
};

export type PersonMemory = {
	slug: string;
	label: string;
	exists: boolean;
	digest: string;
	entries: MemoryEntry[];
	raw: string;
};

export type SkillInfo = { name: string; description: string; scope: "own" | "company"; overrides: boolean };

export type PersonProfile = {
	slug: string;
	label: string;
	title: string;
	team?: string;
	manager: string;
	managerLabel: string;
	body: string;
	skills: SkillInfo[];
	/** `digest` 在「还没有记忆」时后端给 `null` —— 类型必须照实写（ADR-016：不画后端没有的）。 */
	memory: { exists: boolean; entries: MemoryEntry[]; digest: string | null };
	channels: { id: string; kind: ChannelKind; title: string }[];
};

export type FileEntry = { name: string; kind: "dir" | "file"; bytes: number; at: number };

export type FilesView =
	| { path: string; parent: string; entries: FileEntry[] }
	| { path: string; parent: string; file: { name: string; bytes: number; binary: boolean; text: string } };

export type Uploaded = { id: string; name: string; kind: "image" | "file"; bytes: number };
