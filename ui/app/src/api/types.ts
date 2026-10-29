/**
 * 后端视图的 TypeScript 镜像。
 *
 * 权威定义在 `src/core/shell/view.ts` —— 这里只抄界面真会读的字段，**不加**后端没有的东西
 * （界面不画后端没有的数据，见 ADR-016）。抄漏了会编译错，抄多了会让人以为后端有这个字段，
 * 所以宁可少抄、需要时再去后端确认。
 */

export type ChannelKind = "company" | "leadership" | "project" | "dm";

export type Attachment = { id: string; name: string; kind: "image" | "file"; bytes: number };

export type Channel = {
	id: string;
	kind: ChannelKind;
	owner?: string;
	ownerLabel?: string;
	doing?: string;
	title: string;
	project?: string;
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
	status?: "pending" | "done" | "error";
	pendingFor?: string;
	processing?: boolean;
	startedAt?: number;
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
	project?: string;
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

export type MemoryEntry = { heading: string; body: string };

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
	project?: string;
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
