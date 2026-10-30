# 网页 API 契约

前端只按这份写；后端改字段必须同步这里。**代码是唯一事实**，本文档与
`src/core/shell/serve.ts` 冲突时以代码为准，并回来改这份文档。

## 0. 总览

只有 17 条路由（按方法+路径算；按路径去重是 15 条 —— `check-boundaries.mjs` 数的是去重后
的路径），全部在 `src/core/shell/serve.ts` 的 `routes` 表里声明。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/stream/org` | 组织快照流（SSE） |
| `GET` | `/api/org` | 组织快照（一次） |
| `GET` | `/api/channels` | 频道列表 |
| `POST` | `/api/channels` | 新建频道 |
| `GET` | `/api/channels/:id/mentionable` | 这个频道能 @ 谁 |
| `GET` | `/api/channels/:id` | 频道详情（含消息） |
| `GET` | `/api/channels/:id/stream` | 频道消息流（SSE：只有 `create`） |
| `POST` | `/api/channels/:id/messages` | 发一条消息 |
| `POST` | `/api/channels/:id/read` | 标已读到某条 |
| `GET` | `/api/attention` | 「找我」：跨频道、需要我本人看一眼的消息 |
| `GET` | `/api/files?path=` | 工作区的只读文件树（右栏「文件」页） |
| `GET` | `/api/people/:slug` | 一个人的档案：身份 / 技能 / 记忆概况 / 所在频道 |
| `GET` | `/api/people/:slug/memory` | 一个人的记忆全文 + 按小节拆开的条目 |
| `POST` | `/api/people/:slug/memory` | 删掉一条记忆 / 加一条 |
| `POST` | `/api/uploads` | 上传一个文件，拿回 id |
| `GET` | `/api/uploads/:id` | 取回这个文件（图片内联，其余下载） |
| `POST` | `/api/diag` | 浏览器自报卡顿，落 `workspace/logs/jank.jsonl` |
| `*` | 其余 | 静态文件（`ui/web/`） |

所有响应都是 JSON（SSE 除外）。失败统一 `{ "error": "人话" }` + 4xx/5xx。
**前端必须检查 `response.ok`** —— `ui/app/src/api/client.ts` 的 `call()` 就是这么做的，直接 `res.json()`
会把失败当成成功（第一代最常吞掉的正是这类失败）。

`check-boundaries.mjs` 会检查这张表里的每条 `pattern` 都在 `ui/app/src` 里被请求过。
白名单只有 `/api/org`（Docker 健康检查直接打它；前端也用，但白名单保留）。

## 1. `GET /api/stream/org`

SSE。事件名 `org`，`data` 是 [§2](#2-get-apiorg) 的完整快照。

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
- 组织流只有这一个事件名。以前的 `draft`（正在说）与 `done`（回复落库）随过程投影一起
  删掉了（ADR-081）。

## 2. `GET /api/org`

```ts
{
  company: { name: string },              // 固定 "Solo"
  people: ViewActor[]                     // 按「离我最近」排序，第一项是直接向我汇报的人
}

type ViewActor = {
  slug: string;         // 稳定标识，核心只用这个
  label: string;        // 显示名（identity.md 的 name）
  title: string;
  team?: string;        // identity.md 的 team（团队 slug）
  manager?: string;     // slug；undefined = 直接向我汇报
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
  kind: "dm" | "group";             // 由成员表推导，见下
  lead?: string;                    // 仅团队频道：README.md 的 lead（团队管理员）
  leadLabel?: string;               // 仅团队频道：团队管理员显示名
  doing?: string;                   // 仅团队频道且写了 doing：一句话现状
  title: string;                    // 私聊 = 对方的名字；群聊/团队 = 频道/团队名
  team?: string;                    // 仅团队频道（id 形如 team:<slug>）
  unread: number;
  mentions: number;                 // 未读里点名提到我的条数
  preview: string;                  // 最后一条**人说的话**的第一行，最多 60 字
  lastAt: number;                   // 毫秒时间戳
  lastSeq: number;
  memberCount: number;
}
```

**`kind` 只有两种，而且是从成员表推出来的**（`channel/state.ts` 的 `chatKind()`，
`view.ts` 直接转它的结果）：

| 成员表 | kind |
| --- | --- |
| 恰好两个人，且其中一个是 `owner` | `dm` |
| 其余全部（公司频道、团队频道、多人房间） | `group` |

没有任何「按 id 前缀判断」的规则了。团队频道就是 `team:<slug>` 这个**普通的群** ——
它和别的群的区别只有「有一份 `teams/<slug>/README.md`」，界面上体现在 `team` /
`lead` / `leadLabel` / `doing` 这四个字段上。

**`dm`**：一对一房间，成员就是 `{owner, 那个人}`。**私聊只能我开** —— 没有
`ensureDm`，也没有「个人频道」这种东西；agent 不能私下找另一个人。

`preview` 只取「人说的话」（`chat` / `say` / `question` / `decision` / `report`）：
`note`（系统留痕）与历史遗留的 `think` / `tool` / `work` / `step` 都不进预览。

## 4. `POST /api/channels`

```ts
// 请求
{ id: string, title?: string, members?: string[] }
// 响应
{ ok: true, id: string }
```

我自动入列（`members` 里给不给 `owner` 都一样）。同名频道已存在则原样返回（幂等）。
`id` 为空 → 400。新建的频道 `wakeOnAll` 为空。

挑 id 的约定：团队频道是 `team:<slug>`，公司频道是 `company`。除此之外没有前缀语义 ——
核心不解析 id，形态只看成员表。

## 5. `GET /api/channels/:id/mentionable`

```ts
{ candidates: { id: number, label: string, slug: string, title: string }[] }
```

成员里除我以外的人。`id` 是会话号（名册里没有的人给 `-1`），`title` 来自
`identity.md`，给 @ 浮窗显示「名字 / 职位 / @slug」三层。频道不存在时给
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
  role: "owner" | "lead" | "member";   // 我 / 团队管理员 / 成员
  unread: number;
}

type ViewMessage = {
  seq: number;
  at: number;
  from: number;          // 会话号；我是 0
  fromSlug: string;
  fromLabel: string;
  kind: string;          // chat | say | question | decision | report | note | ...
  text: string;
  mentions: { id: number, label: string, read: boolean, offset: number }[];
  replyTo?: { seq: number, from: number, fromSlug: string, fromLabel: string, excerpt: string };
  read: boolean;         // 从我视角
  needsYou?: true;       // 只在这条需要我本人看一眼时出现
  attachments?: { id: string, name: string, kind: "image" | "file", bytes: number }[];
}
```

- `role` 只用三种**能从文件里读出来**的事实，不引岗位枚举：我 / 团队管理员（团队
  `README.md` 的 `lead`）/ 成员。
- `mentions[].offset` 是 `@label` 在正文里的位置，`-1` 表示算不出来（前端就不高亮）。
- `replyTo.excerpt` 最多 60 字。
- `needsYou` 的判据在核心（`view.ts` 的 `needsYou`）：**不是我自己发的**、且
  `mentions` 里有 `owner`。界面不自己猜关键词。
- `attachments` **没有附件时不出现这个键**，不要区分「空数组」和「没有」。
- `kind` 是 `string` 而不是联合类型：历史库里还躺着 `think` / `tool` / `work` / `step`
  这些不再产生的消息（ADR-081 不清理旧数据），前端 `buildRows()` 直接过滤掉，不画。
  消息上**没有** `status` / `pendingFor` / `processing` / `startedAt` 这些过程字段，
  占位（pending / processing）整套已经删了。
- 频道不存在 → 404 `{ error: "频道不存在或无权查看" }`。

## 7. `POST /api/channels/:id/messages`

```ts
// 请求
{
  text: string,          // 必填，trim 后不能为空（除非带附件）
  replyTo?: number,      // 引用回复的 seq
  from?: string,         // 发件人 slug；**默认忽略**，只有当进程里设了 SOLO_DEBUG_FROM=1 才生效
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
- 发件人**默认只认我**。这个接口是网页后端，能冒充任何人是审计里的 P0-4；调试要伪造
  身份时需显式开 `SOLO_DEBUG_FROM=1`（启动日志会警告一行）。
- 频道不存在 → 404。附件 id 对不上（被清理过）→ 400「附件不存在（可能已经被清理），
  重新发一次」。
- `kind` 由**说话的人自己声明**。团队频道（`team:<slug>`）里的消息会进团队记忆的沉淀
  队列（`src/core/team/settle.ts`）。
- 投递是异步的：`delivered` / `failed` 是本条消息唤醒了几个人，**不是**他们的回答。
- 前端拿到响应后不要自己插一条消息，等 SSE 推新快照（`ui/app/src/lib/messages.ts` 的
  `localEcho()` 只做「已经落库」的乐观显示，不制造一条假消息）。

这里**没有**过程投影的 `kind` 了（`think` / `tool` / `say` 投影 / `work`）：运行时不再
订阅会话提交往频道里写思考或工具卡（ADR-081）。历史库里的这些消息还在，读的时候当
普通消息处理即可。

## 7.1 `GET /api/channels/:id/stream`

频道消息流（SSE）。查询参数 `?since=<seq>`：客户端已经拿到 seq N，服务端只补 N 之后
的消息；不带 `since` 时先推最近 60 条。

| 事件 | `data` | 含义 |
| --- | --- | --- |
| `create` | `ViewMessage` | 新增或原地更新一条消息（按 `seq` 幂等 upsert） |

- **只有 `create` 一个事件名。** `draft`（正在说）与 `done`（回复落库）随过程投影一起
  删掉了（ADR-081）；真消息一律走 `create`，前端不需要为同一句话准备两种形态。
- 任何文档提交去抖 120ms 后推增量，只推订阅了这个频道的连接。
- 空闲每 15s 一个 `: ping` 注释行保活。

## 8. `POST /api/channels/:id/read`

```ts
// 请求
{ seq: number }
// 响应
{ ok: true }
```

把我（`owner`）在这个频道里的已读位置推到 `seq`。只前进，不回退。

## 9. `GET /api/attention`

「找我」——全公司里**需要我本人看一眼**的消息，跨频道汇总，按时间倒序。

```ts
// 响应
{
  unread: number,
  items: {
    channelId: string, channelKind: "dm" | "group", channelTitle: string,
    seq: number, at: number,
    from: number, fromSlug: string, fromLabel: string,
    excerpt: string, read: boolean
  }[]
}
```

判定在 `src/core/shell/view.ts` 的 `needsYou(message)`：**不是我自己发的**，且
`mentions` 里有 `owner`（由 `say` 的 `decision` 或 `channel/state.ts` 的 `needsOwner()`
自动补上，ADR-037）。只收「说出口的话」（`chat` / `say` / `question` / `decision` /
`report`），窗口 7 天，最多 60 条。已读的也返回（带 `read: true`），前端淡化显示 ——
我要能回头看「哪些还没理」。

为什么需要它：实测我在 4804 条消息里回了 51 条（**1.06%**）。不是不想理，是**找不到**
—— 一条要拍板的消息埋在流水里，没有任何东西把它拎出来。

## 10. `GET /api/files?path=<相对路径>`

工作区的只读文件树，右栏「文件」页用。`path` 省略或为空就是根。
Query 还有 `limit`（默认 500，上限 2000）与 `offset`。

- 目录 → `{ path, parent, entries: [{ name, kind: "dir" | "file", bytes, at }], total, truncated }`
- 文件 → `{ path, parent, file: { name, bytes, binary, text } }`

`truncated` = 这一页之后还有；前端目前不用（默认一页够右栏用），脚本可以用它翻页。
顺序稳定（目录在前、再按名字），翻页不会漏也不会重。

**越界由服务端拦**：`path` 一律 `resolve` 成绝对路径再校验是否以工作区根开头，不满足就 403；
符号链接不跟随（`lstat` 查一次、`realpath` 再查一次）。前端不做 `..` 判断 —— 一件事有
两处判断就会有两套答案。

**不猜内容**：前 4 KB 有 NUL 就当二进制（只报 `bytes`，`text` 为空）；超过 200 KB 不往回传。
列表与直接访问都跳过 `.` 开头的文件、`node_modules` 与敏感文件（同一份 `fileHidden` 规则）
—— 那不是我要读的东西，只是噪音。

## 11. `GET /api/people/:slug`

详情面板的**一次取全**：点开会话右上角的「详情」，要的就是这一份。

```ts
// 响应
{
  slug: string, label: string,
  title: string,                    // identity.md 的 title，没有就是 ""
  team?: string,                    // identity.md 的 team，没有就不出现
  manager: string,                  // 我 是 ""
  managerLabel: string,             // 同上
  body: string,                     // identity.md 正文（预置提示词）
  skills: { name: string, description: string, scope: "personal" | "company", overrides: boolean }[],
  memory: { exists: boolean, entries: number, digest: string | null },
  channels: { id: string, kind: "dm" | "group", title: string }[]
}
```

`channels` 里的 `kind` 同样是 `chatKind()` 的投影（`dm` / `group`），**不再按 id 前缀分
`company` / `leadership` / `project`**。`skills` 来自 `listSkills()`，个人层覆盖公司同名时
`overrides: true`（界面显示「覆盖公司同名」）。`slug` 必须是名册里存在的 agent 且不是
`owner`，否则 404。

## 12. `GET /api/people/:slug/memory`

```ts
// 响应
{ slug: string, label: string, exists: boolean, digest: string | null,
  entries: { heading: string, body: string,
             at: string | null, by: string | null, op: "add" | "edit" | null }[],
  raw: string }
```

`entries` 按 Markdown 的 `##` 标题拆（标题就是记下的日期）。`raw` 是 `agents/<slug>/memory.md`
全文。`slug` 必须是名册里存在的 agent（且不是 `owner`）—— 这既挡路径穿越，也让不存在的人
老实 404。

`at` / `by` / `op` 是这一节的**来历**，由 `memoryTimeline()` 从 `agents/<slug>/.memory-journal.jsonl`
反推（每行都有写入前后的全文，切段比较即得）：`by` 是 `human` / `remember` / `agent`，
`op` 是「新加」还是「改过」。手写进 `memory.md`、没有日志的条目一律 `null` ——
**不拿「现在」冒充「当时」**（ADR-016）。

## 13. `POST /api/people/:slug/memory`

```ts
// 删一条
{ op: "forget", heading: "2026-10-28" }
// 加一条
{ op: "add", text: "汇报要简短" }
// 响应
{ ok: true, entries: number }      // 改动后这一共有几条
```

失败：`op` 不是这两个 → 400；`forget` 找不到那一节 → 404；`add` 的正文不合格
（空 / 超长 / 像密钥）→ 400。

（注意：`ui/app/src/api/client.ts` 的 `editPersonMemory` 把这个响应的类型写成了整份
`PersonMemory`，与后端不符 —— 界面改完会重新拉一次，所以没出事。以本节的字段为准。）

记忆是**不可信的模型写的**，所以要有人能审、能删。写入走 `src/core/agent/memory.ts` 的
同一道闸（`entryProblem` 拒空/超长/像密钥，`appendMemory` 串行 + 落 journal），
和 agent 自己写没有第二条路。

## 14. `POST /api/uploads` / `GET /api/uploads/:id`

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
  `?download=1` 强制下载。带 `Cache-Control: immutable` 与
  `X-Content-Type-Options: nosniff`（id 一旦生成内容不变）。

**模型看不见图片内容**（ADR-051）：附件在投递正文里只有一行占位。agent 应该说
「我读不了图里的内容，请用文字说一下要我做什么」，而不是猜。

## 14.1 `POST /api/diag`

浏览器自报卡顿。请求体自由（前端发 `{ kind: "jank", at, entries: [...] }`），服务端补
`at` 后追加到 `<workspace>/logs/jank.jsonl`；单条 4KB、单文件 5MB 封顶，满了轮转一次。
永远回 `{ ok: true }` —— 诊断写不进去不该影响任何事。

来源是 `ui/app/src/lib/jank.ts`：只在长帧 > 240ms 或长任务 > 200ms 时记一条，攒够 5 秒
或 `pagehide` 时发上来。每条带「当时在干什么」（`doing`）和可见性状态（`hidden` /
`resumed` / `foreground`），用来区分「真卡」和「切后台被节流」。

## 15. 静态文件

其余所有路径都当静态文件处理，根目录是 `ui/web/`（`serve.ts` 的 `uiDir` 默认值）：

- 越界保护：解析后的路径必须仍在根目录下。
- 无扩展名的路径回退到 `index.html`（SPA）。
- 入口 `index.html` 不缓存（`no-cache`），其余 `max-age=300, must-revalidate`。
- 带 ETag，支持 `br` / `gzip` 协商。

界面源码在 `ui/app/`（React + TypeScript + Vite，ADR-079），构建产物写回 `ui/web/`。
**改完界面必须 `npm run ui:build`** —— 服务端只发 `ui/web/`，源码改动不会自己出现。

## 16. 已知限制

- **没有鉴权**。服务监听 `127.0.0.1`，只在可信内网用。不要做公网端口映射。
- **没有待办 / 任务 / 成本**。第一代有，当前核心一个都没有，界面相应位置是空的
  （ADR-016：不画后端没有的东西）。「它还在干」这类活性信号也不在接口里 ——
  打算以后从 `harness.inspect()` 派生，而不是把思考落库（ADR-081）。
- **SSE 连接数**：浏览器的同源并发连接上限是 6，同时开很多标签页会碰上限。

## 17. 兼容性纪律

1. 加字段随便加（前端忽略未知字段）。
2. **不许改字段含义**，尤其是 `read` / `unread` / `mentions` 这种带状态的 —— 宁可加新字段。
3. 删字段前先 grep `ui/app/src` 确认没有消费者，然后同步删这段文档。
4. 新增路由必须在前端有消费者，否则 `npm run check` 会失败（`check-boundaries.mjs`）。
