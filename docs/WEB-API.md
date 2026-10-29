# 网页 API 契约

前端只按这份写；后端改字段必须同步这里。**代码是唯一事实**，本文档与
`src/core/shell/serve.ts` 冲突时以代码为准，并回来改这份文档。

## 0. 总览

只有 13 条路由（按方法+路径算；按路径去重是 12 条 —— `check-boundaries.mjs` 数的是去重后
的路径），全部在 `src/core/shell/serve.ts` 的 `routes` 表里声明。

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
| `GET` | `/api/attention` | 「找你」：跨频道、需要老板拍板的消息 |
| `GET` | `/api/people/:slug` | 一个人的档案：身份 / 技能 / 记忆概况 / 所在频道 |
| `GET` | `/api/people/:slug/memory` | 一个人的记忆全文 + 按小节拆开的条目 |
| `POST` | `/api/people/:slug/memory` | 删掉一条记忆 / 加一条 |
| `POST` | `/api/uploads` | 上传一个文件，拿回 id |
| `GET` | `/api/uploads/:id` | 取回这个文件（图片内联，其余下载） |
| `*` | 其余 | 静态文件（`ui/web/`） |

所有响应都是 JSON（SSE 除外）。失败统一 `{ "error": "人话" }` + 4xx/5xx。
**前端必须检查 `response.ok`** —— `ui/web/js/api.js` 就是这么做的，直接 `res.json()`
会把失败当成成功（第一代最常吞掉的正是这类失败）。

`check-boundaries.mjs` 会检查这张表里的每条 `pattern` 都在 `ui/web/js` 里被请求过。
白名单只有 `/api/org`（Docker 健康检查直接打它；前端团队视图也用它，但白名单保留）。

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
  company: { name: string },              // 固定 "Solo"
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

**`dm` 频道**：一对一房间。个人频道（`dm:owner-<slug>`）= 与老板的私聊，也是工作台。

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
  kind?: string,         // 语义标签，省略 = chat
  attachments?: (string | { id: string })[]
                         // 附件 id（先 POST /api/uploads 拿）。两种写法等价：
                         // `["<id>"]` 适合脚本，`[{ id }]` 是前端写法。
}
// 响应
{ ok: true, seq: number, delivered: number, failed: number }
```

- `text` 为空 → 400；**只有当消息带附件时才可以空**（服务端补一行占位正文，例如
  `[图片] 宽图.png`）。
- 频道不存在 → 404。附件 id 对不上（被清理过）→ 400「附件不存在（可能已经被清理），
  重新发一次」。
- `kind` 由**说话的人自己声明**。项目频道里带 `decision` / `report` 的话才会触发项目
  记忆沉淀（`src/core/project/settle.ts`）。
- 投递是异步的：`delivered` / `failed` 是本条消息唤醒了几个人，**不是**他们的回答。
- 前端拿到响应后不要自己插一条消息，等 SSE 推新快照。

**过程投影的 `kind`**（仅出现在个人频道，由运行时从会话条目自动生成，不是人写的）：
| `kind` | 含义 | 来源 |
|---|---|---|
| `think` | 该员工的思考过程 | `pi.assistant` 条目的 `thinking` 块 |
| `say` | 该员工这一轮写的文案（非工具、非思考） | `pi.assistant` 条目的 `text` 块 |
| `tool` | 该员工调了什么工具（名字 + 参数摘要） | `pi.assistant` 条目的 `toolCall` 块（不含 `say`） |

投影进度存在 `ChannelState.cursors`（会话 id → 最大条目 id），随频道文档持久化；
启动时会做一遍历史回填，把游标之后还没投影过的条目补进个人频道，所以重启不重复、
旧会话也有完整的思考/文案/调用卡。

**`work` 的操作标签**：`run` 落的 `work` 消息正文保留完整输出（不截断），界面把
正文第一行读出「做了什么操作」——`$ ` 开头标「执行命令」、`已写入` 标「写文件」、
`文件不存在` 标「读文件」、`(后台运行` 标「后台运行」，其余标「工作记录」。
这个标签由前端 `workOp()` 投影，后端不存。过程行（work / tool / think）都是一行
紧凑摘要、默认收起：图标 + 「已运行 / 已写入文件 / 已调用 / 思考」+ 单行省略摘要 +
展开箭头，连续多条时只第一条带头像 —— 过程是扫一眼的，不是逐条读的。

## 8. `POST /api/channels/:id/read`

```ts
// 请求
{ seq: number }
// 响应
{ ok: true }
```

把老板在这个频道里的已读位置推到 `seq`。只前进，不回退。

## 9. `GET /api/attention`

「找我」——全公司里**需要老板拍板**的消息，跨频道汇总，按时间倒序。

```ts
// 响应
{
  unread: number,
  items: {
    channelId: string, channelKind: string, channelTitle: string,
    seq: number, at: number,
    from: string, fromSlug: string, fromLabel: string,
    excerpt: string, read: boolean
  }[]
}
```

判定在 `src/core/shell/view.ts` 的 `needsYou(message)`：**不是老板自己发的**，且
（`mentions` 含 `owner`，或正文里有 `needsOwner()` 认的那几种求拍板说法）。窗口 7 天，
最多 60 条。已读的也返回（带 `read: true`），前端淡化显示 —— 老板要能回头看「哪些我还没理」。

为什么需要它：实测老板在 4804 条消息里回了 51 条（**1.06%**）。不是不想理，是**找不到**
—— 一条要拍板的消息埋在两小时的 think/tool 流水里，没有任何东西把它拎出来。

## 10. `GET /api/people/:slug`

详情面板的**一次取全**：点开一个私聊的右上角，要的就是这一份。

```ts
// 响应
{
  slug: string, label: string, title: string | null, project: string | null,
  manager: string | null, managerLabel: string | null,
  body: string,                      // identity.md 正文（预置提示词）
  skills: { name: string, description: string, scope: "personal" | "company", overrides: boolean }[],
  memory: { exists: boolean, entries: number, digest: string },
  channels: { id: string, kind: "company" | "leadership" | "project" | "dm" | "other", title: string }[]
}
```

`kind` 是**按 id 前缀推的**（`company` / `leadership` / `proj:` / `dm:`），频道文档里不存这个字段。
`skills` 来自 `listSkills()`，个人层覆盖公司同名时 `overrides: true`（界面显示「覆盖公司同名」）。
`slug` 必须是名册里存在的 agent 且不是 `owner`，否则 404。

## 11. `GET /api/people/:slug/memory`

```ts
// 响应
{ slug: string, label: string, exists: boolean, digest: string,
  entries: { heading: string, body: string }[], raw: string }
```

`entries` 按 Markdown 的 `##` 标题拆（标题就是记下的日期）。`raw` 是 `agents/<slug>/memory.md`
全文。`slug` 必须是名册里存在的 agent（且不是 `owner`）—— 这既挡路径穿越，也让不存在的人
老实 404。

## 12. `POST /api/people/:slug/memory`

```ts
// 删一条
{ op: "forget", heading: "2026-10-28" }
// 加一条
{ op: "add", text: "老板喜欢简短汇报" }
// 响应
{ ok: true, changed: boolean, message: string }
```

记忆是**不可信的模型写的**，所以要有人能审、能删。写入走 `src/core/agent/memory.ts` 的
同一道闸（`entryProblem` 拒空/超长/像密钥，`appendMemory` 串行 + 落 journal），和管理端
没有第二条路。

## 13. `POST /api/uploads` / `GET /api/uploads/:id`

上传是**裸二进制**，不是 multipart：请求体就是文件本身，文件名走 `x-filename` 头或
`?name=` 查询参数。

```ts
// POST /api/uploads?name=宽图.png   body: <文件字节>
// 响应
{ id: string, name: string, kind: "image" | "file", bytes: number }
```

- 上限 **25MB**（`UPLOAD_MAX_BYTES`），超过 → 413。一条消息最多 **10 个**附件。
- `kind` **由服务端按 mime 重算**，不信客户端声明 —— 一个 `.svg` 自称图片后内联执行，
  正是这样被挡住的（`INLINE_IMAGE` 里没有 `svg`）。
- 落盘在 `<workspace>/uploads/<id>` + `<id>.json`（`{name, mime, bytes, at}`）。一个
  文件一份元数据，并发写不会互相覆盖。
- `GET /api/uploads/:id` 图片内联，其余 `Content-Disposition: attachment`；带
  `Cache-Control: immutable` 与 `X-Content-Type-Options: nosniff`（id 一旦生成内容不变）。

**模型看不见图片内容**（ADR-051）：附件在投递正文里只有一行占位。agent 应该说
「我读不了图里的内容，请用文字说一下要我做什么」，而不是猜。

## 14. 静态文件

其余所有路径都当静态文件处理，根目录是 `ui/web/`（`serve.ts` 的 `uiDir` 默认值）：

- 越界保护：解析后的路径必须仍在根目录下。
- 无扩展名的路径回退到 `index.html`（SPA）。
- 入口 `index.html` 不缓存（`no-cache`），其余 `max-age=300, must-revalidate`。
- 带 ETag，支持 `br` / `gzip` 协商。

界面**没有构建步骤** —— 改 `ui/web/` 里的文件，刷新浏览器就生效。

## 15. 已知限制

- **没有鉴权**。服务监听 `127.0.0.1`，只在可信内网用。不要做公网端口映射。
- **没有工具调用 trace**。`ViewMessage` 只有消息正文，看不到 agent 中间调了哪些工具。
- **没有待办 / 任务 / 成本**。第一代有，当前核心一个都没有，界面相应位置是空的
  （ADR-016：不画后端没有的东西）。
- **SSE 连接数**：浏览器的同源并发连接上限是 6，同时开很多标签页会碰上限。

## 16. 兼容性纪律

1. 加字段随便加（前端忽略未知字段）。
2. **不许改字段含义**，尤其是 `read` / `unread` / `mentions` 这种带状态的 —— 宁可加新字段。
3. 删字段前先 grep `ui/web/js` 确认没有消费者，然后同步删这段文档。
4. 新增路由必须在前端有消费者，否则 `npm run check` 会失败（`check-boundaries.mjs`）。
