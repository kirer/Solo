# 网页 API 契约

前端只按这份写；后端改字段必须同步这里。**代码是唯一事实**，本文档与
`src/core/interface/http/routes.ts` 冲突时以代码为准，并回来改这份文档。

## 0. 总览

只有 **22** 条路由（按方法+路径算；按路径去重是 **21** 条 —— `check-boundaries.mjs`
数的是去重后的路径），全部在 `src/core/interface/http/routes.ts` 的 `routes` 表里声明。
handler 只做「解析参数 → 调 `app/` 里的一个用例 → 序列化」，业务校验不在这一层。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/stream/org` | 组织快照流（SSE） |
| `GET` | `/api/org` | 组织快照（一次） |
| `GET` | `/api/channels` | 频道列表 |
| `POST` | `/api/people/:slug/dm` | 和一个人开私聊（唯一的建频道入口） |
| `GET` | `/api/channels/:id/mentionable` | 这个频道能 @ 谁 |
| `GET` | `/api/channels/:id` | 频道详情（含消息） |
| `GET` | `/api/channels/:id/turns` | 一段消息窗口里每一轮的轨迹（折叠版，不带步骤） |
| `GET` | `/api/channels/:id/turn` | 一轮的完整轨迹（带步骤） |
| `GET` | `/api/channels/:id/stream` | 频道消息流（SSE：`create` 与 `trace`） |
| `POST` | `/api/channels/:id/messages` | 发一条消息 |
| `POST` | `/api/channels/:id/read` | 标已读到某条 |
| `GET` | `/api/attention` | 「找我」：跨频道、需要我本人看一眼的消息 |
| `GET` | `/api/people/:slug` | 一个人的档案：身份 / 技能 / 记忆概况 / 所在频道 |
| `GET` | `/api/people/:slug/turns` | 一个人在所有频道里的轮次（私聊页的工作记录，折叠版） |
| `GET` | `/api/people/:slug/memory` | 一个人的记忆全文 + 按小节拆开的条目 |
| `POST` | `/api/people/:slug/memory` | 删掉一条记忆 / 加一条 |
| `GET` | `/api/teams/:slug` | 一个团队的档案：README 正文 / 管理员 / 团队记忆 |
| `POST` | `/api/uploads` | 上传一个文件，拿回 id |
| `GET` | `/api/uploads/:id` | 取回这个文件（图片内联，其余下载） |
| `GET` | `/api/avatar/:seed` | 一个人的头像（SVG，服务端按名字画好） |
| `POST` | `/api/diag` | 浏览器自报卡顿，落 `workspace/logs/jank.jsonl` |
| `GET` | `/api/diag` | 最近一条**运行报告**（底座报上来的失败），没有就是 `null` |
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
data: {"workspace":{...},"people":[...]}

: ping
```

- 任何文档提交都会触发推送，**去抖 120ms**。
- 空闲时每 15s 一个 `: ping` 注释行保活。
- 每帧是**完整快照**，不是增量。前端收到就重拉需要的列表。
- 断线由 `EventSource` 自己重连。
- 组织流只有这一个事件名。以前的 `draft`（正在说）与 `done`（回复落库）随过程投影一起
  删掉了。

## 2. `GET /api/org`

```ts
{
  workspace: { name: string },          // 固定 "Solo"
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
  activity?: ViewActivity; // 此刻在干什么；**没有这个键 = 待命**
}

// 由会话的 live 状态派生（run / generation / running 的工具），结算即消失。
// 不落库、不读消息、不猜（ADR-001）。
type ViewActivity = {
  state: "thinking" | "working";
  since: number;        // 这一轮的开始时刻（唤醒记录里那条消息的 at）
  channelId?: string;   // 这一轮在哪个频道
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

**`kind` 只有两种，由 id 前缀 + 成员表一起推出来**（`channel/types.ts` 的 `chatKind()`，
`app/project.ts` 的投影直接转它的结果，`dto.ts` 的 `ViewChannelKind` 只有这两个值）：

| id + 成员表 | kind |
| --- | --- |
| `dm:` 前缀，且恰好两个人、其中一个是 `owner` | `dm` |
| 其余全部（全员频道、团队频道、多人房间、历史无前缀房间） | `group` |

团队频道就是 `team:<slug>` 这个**普通的群**，即使只有我和管理员两个人也永远是 `group`
—— 它和别的群的区别只有「有一份 `teams/<slug>/README.md`」，界面上体现在
`team` / `lead` / `leadLabel` / `doing` 这四个字段上。

**`dm`**：一对一房间，id 是 `dm:<两个 slug 排序后拼接>`，成员就是 `{owner, 那个人}`。
**每个成员都由系统建好一条私聊**（`ensureOwnerDm`，装配 / 招人时幂等补齐）—— 他的工作
过程在那里看。仍然没有「个人频道」，agent 也不能私下找另一个人：房间永远是
`{owner, 他}`，不是他的私人档案。

`preview` 只取「人说的话」（`chat` / `say` / `question` / `decision` / `report`）：
`note`（系统留痕）与历史遗留的 `think` / `tool` / `work` / `step` 都不进预览。

## 4. `POST /api/people/:slug/dm`（新建私聊）

```ts
// 响应
{ ok: true, id: string }   // id = `dm:<slug>-owner`（排序后拼接）
```

**这是唯一显式的建频道接口**。通用的 `POST /api/channels` 已删：频道要么由装配
投影出来（全员 `all` / 团队 `team:<slug>` / 每个成员的私聊），要么就是这里开的一对一私聊。
私聊现在由装配 / 招人自动建好，这个接口仍保留，用来显式确保它在（幂等）。

- 对方必须真的在名册里（`agents/<slug>/identity.md` 存在），否则 `404`；
- 不能和我自己开 → `400`；slug 为空 → `400`；
- 已存在则原样返回（幂等，不覆盖标题与成员）；
- 新房间：成员 `{owner, slug}`、标题 = 对方名字、`wakeOnAll` 为空。

界面侧栏点「和这个人说话」时走它（`store.openWithPerson`）。

## 4.1 `GET /api/people/:slug/turns?from=&to=`（私聊页的工作记录）

```ts
{ turns: ViewTurn[] }   // 折叠版（不带 steps）；每轮自带 channelId
```

和 `/api/channels/:id/turns` 的区别：**切轮时不按频道过滤** —— 他在团队频道里干活、
在私聊里被插话，都算这个人的工作记录，按 `startedAt` 排在一起。`seq` 是频道内序号，
跨频道不可比，所以排序用时间。`from` / `to` 仍然按 seq 过滤（作用于每一轮自己的频道）。

私聊频道的 `GET /api/channels/:id/stream` 推的 `trace` 事件也是**这个人的跨频道轮次**：
SSE 先用 `personOfChannel()` 认出私聊，再走 `readPersonTurns`。

## 5. `GET /api/channels/:id/mentionable`

```ts
{ candidates: { id: number, label: string, slug: string, title: string }[] }
```

成员里除我以外的人。`id` 是会话号（名册里没有的人给 `-1`），`title` 来自
`identity.md`，给 @ 浮窗显示「名字 / 身份 / @slug」三层。频道不存在时给
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

- `role` 只用三种**能从文件里读出来**的事实，不引身份枚举：我 / 团队管理员（团队
  `README.md` 的 `lead`）/ 成员。
- `mentions[].offset` 是 `@label` 在正文里的位置，`-1` 表示算不出来（前端就不高亮）。
- `replyTo.excerpt` 最多 60 字。
- `needsYou` 的判据在核心（`view/index.ts` 的 `needsYou`）：**不是我自己发的**、且
  `mentions` 里有 `owner`。界面不自己猜关键词。
- `attachments` **没有附件时不出现这个键**，不要区分「空数组」和「没有」。
- `kind` 是 `string` 而不是联合类型：历史库里还躺着 `think` / `tool` / `work` / `step`
  这些不再产生的消息（不清理旧数据），前端 `buildRows()` 直接过滤掉，不画。
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
- 前端拿到响应后不要自己插一条消息，等 SSE 推新快照（不制造一条假消息）。

这里**没有**过程投影的 `kind` 了（`think` / `tool` / `say` 投影 / `work`）：运行时不再
订阅会话提交往频道里写思考或工具卡。历史库里的这些消息还在，读的时候当
普通消息处理即可。

## 7.1 `GET /api/channels/:id/stream`

频道消息流（SSE）。查询参数 `?since=<seq>`：客户端已经拿到 seq N，服务端只补 N 之后
的消息；不带 `since` 时先推最近 60 条。

| 事件 | `data` | 含义 |
| --- | --- | --- |
| `create` | `ViewMessage` | 新增或原地更新一条消息（按 `seq` 幂等 upsert） |
| `trace` | `ViewTurn`（瘦身版） | 正在跑的那一轮的整轮快照；结算时补最后一帧 |

- `draft`（正在说）与 `done`（回复落库）随过程投影一起删掉了；真消息一律走 `create`。
- `trace` **不是过程投影**：它推的是会话条目派生出的**整轮快照**，不按 token 推（C-007），
  也不进消息表（ADR-001）。步骤没变就不重推（服务端按指纹去重）；单步输出在推送版里
  压到 2 KB，展开那一步时再走 §7.3 拉全文。
- 任何文档提交去抖 120ms 后推增量，只推订阅了这个频道的连接。
- 空闲每 15s 一个 `: ping` 注释行保活。

## 7.2 `GET /api/channels/:id/turns?from=&to=`

一段消息窗口里**每一轮**的轨迹，折叠版（不带 `steps`）。

```ts
// 查询参数：from / to 是消息 seq（含端点）；缺省 = 全部
{ turns: ViewTurn[] }
```

- 一轮 = 一次唤醒：会话条目里 `core.channel` 且 `data.channelId/seq` 对上的那条，到**下一条**
  `core.channel` 之间。一条消息可以叫醒多个人 → 同一个 `seq` 会出现多条（按 `slug` 区分）。
- 找不到（没被叫醒 / 条目已被压缩）就没有那一条，**不是错误**。
- 折叠版只给 `stepCount` 与 `summary`：一屏十几轮、每轮八步，一次全带会把响应撑到几百 KB。

```ts
type ViewTurn = {
  channelId: string;
  seq: number;                  // 触发这一轮的消息
  slug: string;
  label: string;
  status: "running" | "done" | "failed" | "aborted";
  startedAt: number;            // = 触发消息的 at
  endedAt?: number;             // = 回复消息的 at；还在跑就没有
  replySeq?: number;            // 他最终说出口的那条
  stepCount: number;
  summary: string;              // 确定性摘要：运行 N 条命令 · 读了 N 个文件 · 写了 N 个文件
  truncated?: true;             // 步骤超过 200 步
  steps?: ViewStep[];           // 只在 §7.3 与 SSE trace 里出现
}
```

## 7.3 `GET /api/channels/:id/turn?seq=&slug=`

一轮的完整轨迹（带 `steps`）。

```ts
{ turn: ViewTurn | null }       // 找不到就是 null
```

```ts
type ViewStep = {
  id: string;                   // 会话条目里的 toolCall id
  kind: "think" | "run" | "file-read" | "file-write" | "chats" | "history" | "remember" | "hire" | "tool";
                               // 没有 say：说出口的话是频道消息，不进过程
  title: string;                // 服务端算好的一行人话（运行 npm test / 读了 a.ts）
  status: "running" | "ok" | "failed";
  ms?: number;                  // 工具结果时间 − 调用时间；拿不到就不出现
  startedAt?: number;
  command?: string;             // run
  output?: string;              // run / 其他工具：≤ 8 KB，已剥 ANSI，尾部带截断说明
  exitCode?: number;            // run：能从输出里读到「退出码 N」时
  truncated?: true;
  path?: string;                // file-*
  added?: number;               // file-write：写入行数
  text?: string;                // think 正文
  tool?: string;                // 未知工具的原名
}
```

规矩（ADR-001）：

- **不落库。** 轨迹是会话条目的投影，频道文档与 SQLite 里都不多一个字段。
- **拿不到就不画。** 没有耗时不编耗时，没有 diff 不画 diff —— 界面上每个数字都要有出处。
- 一轮结束了还挂着 `running` 的步骤 = 那次调用没回来，服务端把它标成 `failed`，
  整轮 `status` 是 `aborted`。

## 8. `POST /api/channels/:id/read`

```ts
// 请求
{ seq: number }
// 响应
{ ok: true }
```

把我（`owner`）在这个频道里的已读位置推到 `seq`。只前进，不回退。

## 9. `GET /api/attention`

「找我」——全员里**需要我本人看一眼**的消息，跨频道汇总，按时间倒序。

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

判定在 `src/core/view/index.ts` 的 `needsYou(message)`：**不是我自己发的**，且
`mentions` 里有 `owner` —— 也就是**正文显式 @了我**。`kind=decision` 不会再自动
把我算进来（ADR-009）：助理几乎每条公告都打 decision，自动补会让「找你」被通告淹掉。
只收「说出口的话」（`chat` / `say` / `question` / `decision` /
`report`），窗口 7 天，最多 60 条。已读的也返回（带 `read: true`），前端淡化显示 ——
我要能回头看「哪些还没理」。

为什么需要它：实测我在 4804 条消息里回了 51 条（**1.06%**）。不是不想理，是**找不到**
—— 一条要拍板的消息埋在流水里，没有任何东西把它拎出来。

## 10. `GET /api/people/:slug`

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
  skills: { name: string, description: string, scope: "personal" | "team" | "all", overrides: boolean }[],
  memory: { exists: boolean, entries: number, digest: string | null },
  channels: { id: string, kind: "dm" | "group", title: string }[]
}
```

`channels` 里的 `kind` 同样是 `chatKind()` 的投影（`dm` / `group`）：私聊只认 `dm:` 前缀 +
恰好 `{owner, 一人}`，**不按频道 id 前缀分**。`skills` 来自 `listSkills()`：全员层打底，
这个人所在团队的团队层压上，个人层最后覆盖；被更靠下的层盖住的那一份带
`overrides: true`（界面显示「覆盖同名的上层技能」）。`slug` 必须是名册里存在的 agent 且不是
`owner`，否则 404。

## 10.1 `GET /api/teams/:slug`

团队频道的「详情」一次取全：`teams/<slug>/README.md` 的正文（目标 / 验收标准 /
不做什么 / 当前进展）+ 管理员的显示名 + 团队层技能（`teams/<slug>/skills/`）+
`teams/<slug>/memory.md` 按小节拆开的条目。

```ts
// 响应
{
  slug: string, name: string, status: string,
  doing?: string,                   // README 头的 doing，没写就不出现
  lead?: string, leadLabel: string, // lead 是 slug，leadLabel 是名册里的显示名
  body: string,                     // README 正文
  skills: { name: string, description: string, scope: "team", overrides: boolean }[],  // 团队层技能
  memory: {
    exists: boolean, digest: string | null,
    // at / by / op 恒为 null：团队记忆没有逐条日志，不拿「现在」冒充「当时」（ADR-016）
    entries: { heading: string, body: string, at: null, by: null, op: null }[]
  }
}
```

`slug` 必须是 `teams/` 下真实存在的目录，否则 404。团队记忆**只读**：它由
`team/settle.ts` 在收工结算时自动沉淀（判据在 `seed/prompt/95-settle.md`），
界面上没有增删入口。

## 11. `GET /api/people/:slug/memory`

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
**不拿「现在」冒充「当时」**。

## 12. `POST /api/people/:slug/memory`

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
  `?download=1` 强制下载。带 `Cache-Control: immutable` 与
  `X-Content-Type-Options: nosniff`（id 一旦生成内容不变）。

**模型看不见图片内容**：附件在投递正文里只有一行占位。agent 应该说
「我读不了图里的内容，请用文字说一下要我做什么」，而不是猜。

## 13.3 `GET /api/avatar/:seed`

一个人的头像，**一张插画**，服务端画好直接吐 SVG。`seed` 是 slug（URL 编码）。

```ts
// GET /api/avatar/林越?size=64
// → image/svg+xml，约 5 KB
```

- `size` 夹在 **16–256**（缺省 64，不是数字也用 64）。界面按显示尺寸的 **2 倍** 要
  （高清屏），由浏览器缩到实际大小。
- **同一个 seed 永远是同一张脸**：画风（DiceBear `micah`）、取景（`scale 170` /
  `translateY 18`，把脸放到圆里）、底色（6 支淡彩按 seed 挑一支）都不掺时间与随机数。
- `Cache-Control: public, max-age=604800`（一周，**不是** `immutable`：画风会改，
  改了得能在缓存里过期），另有 `ETag`（seed + 尺寸）与 `304` 处理。
- `X-Content-Type-Options: nosniff`：SVG 是可执行的，别让它被嗅探成别的类型。
- 消费者只有一个：`ui/app/src/lib/avatar.ts` 拼的 `<img class="av" src="/api/avatar/…">`。

## 13.1 `POST /api/diag`

浏览器自报卡顿。请求体自由（前端发 `{ kind: "jank", at, entries: [...] }`），服务端补
`at` 后追加到 `<workspace>/logs/jank.jsonl`；单条 4KB、单文件 5MB 封顶，满了轮转一次。
永远回 `{ ok: true }` —— 诊断写不进去不该影响任何事。

来源是 `ui/app/src/lib/jank.ts`：只在长帧 > 240ms 或长任务 > 200ms 时记一条，攒够 5 秒
或 `pagehide` 时发上来。每条带「当时在干什么」（`doing`）和可见性状态（`hidden` /
`resumed` / `foreground`），用来区分「真卡」和「切后台被节流」。

## 13.2 `GET /api/diag`

最近一条**运行报告**。底座把失败经由 `onReport` 交给 `app/diag.ts`，落到
`<workspace>/logs/runtime.jsonl`；这条接口只把「最近一条非良性报告」露出来 ——
不需要人去读日志文件。

```json
{ "lastReport": { "type": "task_parked", "at": "2026-10-30T12:03:11.412Z",
                  "text": "任务 \"daily-digest\" 被挂起：任务连续重启超限，已挂起" } }
```

- **只有三个键**：`type` / `at` / `text`（`app/diag.ts` 的 `lastReport()` 原样转出）。
  任务信息是写进 `text` 的，没有单独的 `task` 字段。
- 没有报告时是 `{ "lastReport": null }` —— 前端据此显示「暂无异常」，不要把它当失败。
- `type` 是底座的原名（`task_parked` / `session_failed` / `task_faulted` /
  `migration_failed` / `extension_error` / `host_error` / `listener_error` / …），
  `text` 是已经写成中文的人话。**前端不认识新 `type` 时显示 `text`，不要按 `type`
  分支做文案。**
- `task_outdated` **不算异常**（每次启动都会出现），`lastReport` 跳过它。
- 口径是**快照**，不是流：要持续观察就轮询，或直接 tail 那个 jsonl。

## 14. 静态文件

其余所有路径都当静态文件处理，根目录是 `ui/web/`（`shell/serve.ts` 的 `uiDir` 默认值，
实际读盘在 `interface/http/static-assets.ts`）：

- 越界保护：解析后的路径必须仍在根目录下。
- 无扩展名的路径回退到 `index.html`（SPA）。
- 入口 `index.html` 不缓存（`no-cache`），其余 `max-age=300, must-revalidate`。
- 带 ETag，支持 `br` / `gzip` 协商。

界面源码在 `ui/app/`（React + TypeScript + Vite），构建产物写回 `ui/web/`。
**改完界面必须 `npm run ui:build`** —— 服务端只发 `ui/web/`，源码改动不会自己出现。

## 15. 已知限制

- **没有鉴权**。服务监听 `127.0.0.1`，只在可信内网用。不要做公网端口映射。
- **没有待办 / 任务 / 成本**。第一代有，当前核心一个都没有，界面相应位置是空的
  （不画后端没有的东西）。「它还在干」这类活性信号也不在接口里 ——
  打算以后从 `harness.inspect()` 派生，而不是把思考落库。
- **SSE 连接数**：浏览器的同源并发连接上限是 6，同时开很多标签页会碰上限。

## 16. 兼容性纪律

1. 加字段随便加（前端忽略未知字段）。
2. **不许改字段含义**，尤其是 `read` / `unread` / `mentions` 这种带状态的 —— 宁可加新字段。
3. 删字段前先 grep `ui/app/src` 确认没有消费者，然后同步删这段文档。
4. 新增路由必须在前端有消费者，否则 `npm run check` 会失败（`check-boundaries.mjs`）。
