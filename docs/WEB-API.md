# 网页 API 契约

前端只按这份写；后端改字段必须同步这里。**代码是唯一事实**，本文档与
`src/core/shell/serve.ts` 冲突时以代码为准，并回来改这份文档。

## 0. 总览

只有 8 条路由（按方法+路径算；按路径去重是 7 条 —— `check-boundaries.mjs` 数的是去重后的
路径），全部在 `src/core/shell/serve.ts` 的 `routes` 表里声明。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/stream/org` | 组织快照流（SSE） |
| `GET` | `/api/org` | 组织快照（一次） |
| `GET` | `/api/channels` | 频道列表 |
| `POST` | `/api/channels` | 新建频道 |
| `GET` | `/api/channels/:id/mentionable` | 这个频道能 @ 谁 |
| `GET` | `/api/channels/:id` | 频道详情（含消息） |
| `POST` | `/api/channels/:id/messages` | 发一条消息 |
| `POST` | `/api/channels/:id/read` | 标已读到某条 |
| `*` | 其余 | 静态文件（`ui/web/`） |

所有响应都是 JSON（SSE 除外）。失败统一 `{ "error": "人话" }` + 4xx/5xx。
**前端必须检查 `response.ok`** —— `ui/web/js/api.js` 就是这么做的，直接 `res.json()`
会把失败当成成功（第一代最常吞掉的正是这类失败）。

`check-boundaries.mjs` 会检查这张表里的每条 `pattern` 都在 `ui/web/js` 里被请求过。
白名单只有 `/api/org`（Docker 健康检查用）。

## 1. `GET /api/stream/org`

SSE。事件名 `org`，`data` 是 [§2](#2-get-api.org) 的完整快照。

```
retry: 1500

event: org
data: {"company":{...},"people":[...]}

: ping
```

- 任何文档提交都会触发推送，**去抖 120ms**。
- 空闲时每 15s 一个 `: ping` 注释行保活。
- 每帧是**完整快照**，不是增量。前端收到就重拉需要的列表。
- 断线由 `EventSource` 自己重连。

## 2. `GET /api/org`

```ts
{
  company: { name: string },              // 固定 "一人公司"
  people: ViewActor[]                     // 按「离老板最近」排序，第一项是直接向老板汇报的人
}

type ViewActor = {
  slug: string;         // 稳定标识，核心只用这个
  label: string;        // 显示名（identity.md 的 name）
  title: string;
  project?: string;     // identity.md 的 project
  manager?: string;     // slug；undefined = 直接向老板汇报
  managerLabel?: string;
  body: string;         // identity.md 正文（档案页要显示「他是谁」）
}
```

## 3. `GET /api/channels`

```ts
{
  channels: ViewChannel[],          // 按 lastAt 降序
  unread: { total: number, mentions: number }
}

type ViewChannel = {
  id: string;
  kind: "company" | "leadership" | "project" | "dm";
  dmKind?: "personal" | "direct";   // 仅 kind === "dm"
  owner?: string;                   // 仅 kind === "project"：README.md 的 owner
  ownerLabel?: string;
  title: string;
  project?: string;                 // 仅 kind === "project"
  unread: number;
  mentions: number;                 // 未读里点名提到我的条数
  preview: string;                  // 最后一条的第一行，最多 60 字
  lastAt: number;                   // 毫秒时间戳
  lastSeq: number;
  memberCount: number;
}
```

**`kind` 是从 id 前缀反推的**（`kindOf()`），核心没有「频道类型」这个概念：

| id 前缀 | kind |
| --- | --- |
| `dm:` | `dm` |
| `proj:` | `project` |
| `lead:` | `leadership` |
| 其余（默认 `company`） | `company` |

**`dmKind` 的两种含义**（都是两个成员的一对一房间，收件人规则、未读、渲染完全一样）：

- `personal` = 某人自己的频道（`dm:owner-<slug>`）。他的过程落在这里，它同时是拍板链的
  顶端 —— 「他拍不了板就问我」问的就是这里。
- `direct` = 老板去找某人说话。

判据：成员里除老板外**恰好一个人** → `personal`；否则 `direct`（目前非老板的两人私聊
不存在，因为只有老板能发起对话）。

## 4. `POST /api/channels`

```ts
// 请求
{ id: string, title?: string, members?: string[] }
// 响应
{ ok: true, id: string }
```

老板自动入列。同名频道已存在则原样返回（幂等）。`id` 为空 → 400。

## 5. `GET /api/channels/:id/mentionable`

```ts
{ candidates: { id: number, label: string, slug: string }[] }
```

成员里除老板外的人。`id` 是会话号（名册里没有的人给 `-1`）。频道不存在时给
`{ candidates: [] }` 而不是 404 —— 输入框的 @ 补全不该因为频道刚被删就报错。

## 6. `GET /api/channels/:id`

Query：`limit`（默认 60，夹在 1..200）、`before`（seq，往前翻页）。

```ts
type ViewChannelDetail = {
  channel: Omit<ViewChannel, "unread" | "mentions" | "preview">;
  members: ViewMember[];
  messages: ViewMessage[];
  hasMore: boolean;      // 前面还有更早的
  serverNow: number;     // 毫秒。前端据此算相对时间，避免用本机时钟比服务端时间
}

type ViewMember = {
  id: number;
  slug: string;
  label: string;
  role: "owner" | "lead" | "member";   // 老板 / 项目负责人 / 成员
  unread: number;
}

type ViewMessage = {
  seq: number;
  at: number;
  from: number;          // 会话号；老板是 0
  fromSlug: string;
  fromLabel: string;
  kind: string;          // chat | question | decision | report | ...
  text: string;
  mentions: { id: number, label: string, read: boolean, offset: number }[];
  replyTo?: { seq: number, from: number, fromSlug: string, fromLabel: string, excerpt: string };
  read: boolean;         // 从老板视角
}
```

- `role` 只用三种**能从文件里读出来**的事实，不引岗位枚举：老板 / 项目负责人 / 成员。
- `mentions[].offset` 是 `@label` 在正文里的位置，`-1` 表示算不出来（前端就不高亮）。
- `replyTo.excerpt` 最多 60 字。
- 频道不存在 → 404 `{ error: "频道不存在或无权查看" }`。

## 7. `POST /api/channels/:id/messages`

```ts
// 请求
{
  text: string,          // 必填，trim 后不能为空
  replyTo?: number,      // 引用回复的 seq
  from?: string,         // 发件人 slug；省略 = 老板。只有调试/脚本用，界面永不传
  kind?: string          // 语义标签，省略 = chat
}
// 响应
{ ok: true, seq: number, delivered: number, failed: number }
```

- `text` 为空 → 400；频道不存在 → 404。
- `kind` 由**说话的人自己声明**。项目频道里带 `decision` / `report` 的话才会触发项目
  记忆沉淀（`src/core/project/settle.ts`）。
- 投递是异步的：`delivered` / `failed` 是本条消息唤醒了几个人，**不是**他们的回答。
- 前端拿到响应后不要自己插一条消息，等 SSE 推新快照。

## 8. `POST /api/channels/:id/read`

```ts
// 请求
{ seq: number }
// 响应
{ ok: true }
```

把老板在这个频道里的已读位置推到 `seq`。只前进，不回退。

## 9. 静态文件

其余所有路径都当静态文件处理，根目录是 `ui/web/`（`serve.ts` 的 `uiDir` 默认值）：

- 越界保护：解析后的路径必须仍在根目录下。
- 无扩展名的路径回退到 `index.html`（SPA）。
- 入口 `index.html` 不缓存（`no-cache`），其余 `max-age=300, must-revalidate`。
- 带 ETag，支持 `br` / `gzip` 协商。

界面**没有构建步骤** —— 改 `ui/web/` 里的文件，刷新浏览器就生效。

## 10. 已知限制

- **没有鉴权**。服务监听 `127.0.0.1`，只在可信内网用。不要做公网端口映射。
- **没有工具调用 trace**。`ViewMessage` 只有消息正文，看不到 agent 中间调了哪些工具。
- **没有待办 / 任务 / 成本**。第一代有，当前核心一个都没有，界面相应位置是空的
  （ADR-016：不画后端没有的东西）。
- **不能发图片 / 附件**。只有文本。
- **SSE 连接数**：浏览器的同源并发连接上限是 6，同时开很多标签页会碰上限。

## 11. 兼容性纪律

1. 加字段随便加（前端忽略未知字段）。
2. **不许改字段含义**，尤其是 `read` / `unread` / `mentions` 这种带状态的 —— 宁可加新字段。
3. 删字段前先 grep `ui/web/js` 确认没有消费者，然后同步删这段文档。
4. 新增路由必须在前端有消费者，否则 `npm run check` 会失败（`check-boundaries.mjs`）。
