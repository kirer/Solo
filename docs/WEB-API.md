# 网页 API 契约

前端只按这份写；后端改字段必须同步这里。**代码是唯一事实**，本文档与
`src/interface/http/routes.ts` 冲突时以代码为准，并回来改这份文档。

## 0. 总览

只有 **29** 条路由（按方法 + 路径；`check-boundaries.mjs` 的口径），全部在
`src/interface/http/routes.ts` 的 `routes` 表里声明。
handler 只做「解析参数 → 调 `app/` 里的一个用例 → 序列化」，业务校验不在这一层。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/stream/org` | 组织快照流（SSE） |
| `GET` | `/api/org` | 组织快照（一次） |
| `GET` | `/api/channels` | 频道列表 |
| `POST` | `/api/channels` | 我拉一个群（`group:` 频道） |
| `POST` | `/api/people/:slug/dm` | 和一个人开私聊（幂等） |
| `GET` | `/api/channels/:id/mentionable` | 这个频道能 @ 谁 |
| `GET` | `/api/channels/:id` | 频道详情（含消息） |
| `GET` | `/api/channels/:id/turn` | 一轮的完整轨迹（带步骤） |
| `GET` | `/api/channels/:id/stream` | 频道消息流（SSE：`create` 与 `trace`） |
| `POST` | `/api/channels/:id/messages` | 发一条消息 |
| `POST` | `/api/channels/:id/read` | 标已读到某条 |
| `GET` | `/api/attention` | 「找我」：跨频道、需要我本人看一眼的消息 |
| `GET` | `/api/people/:slug` | 一个人的档案：身份 / 技能 / 记忆概况 / 所在频道 |
| `GET` | `/api/people/:slug/turns` | 一个人在所有频道里的轮次（私聊页的工作记录，折叠版） |
| `GET` | `/api/people/:slug/memory` | 一个人的记忆全文 + 按小节拆开的条目 |
| `POST` | `/api/people/:slug/memory` | 删掉一条记忆 / 加一条 |
| `GET` | `/api/models` | 现在生效的模型清单（装配好的注册表）+ 默认模型 |
| `POST` | `/api/people/:slug/model` | 换这个人用的模型（当场生效，写进 `settings.json` 的 `agentModels`） |
| `GET` | `/api/teams/:slug` | 一个团队的档案：README 正文 / 管理员 / 团队记忆 |
| `POST` | `/api/uploads` | 上传一个文件，拿回 id |
| `GET` | `/api/uploads/:id` | 取回这个文件（图片内联，其余下载） |
| `GET` | `/api/avatar/:seed` | 一个人的头像（SVG，服务端按名字画好） |
| `POST` | `/api/diag` | 浏览器自报卡顿，落 `<userRoot>/logs/jank.jsonl` |
| `GET` | `/api/diag` | 最近一条**运行报告**（底座报上来的失败），没有就是 `null` |
| `GET` | `/api/plugins` | 插件清单：slug / 名字 / 说明 / 开关状态 / 有没有前端入口 / 它带来了什么 / 没装上的原因 |
| `POST` | `/api/plugins` | 装一个插件：把一整个文件夹（`{ slug, files }`，base64）写进 `plugins/<slug>/` |
| `DELETE` | `/api/plugins/:slug` | 删掉一个插件（整个目录，不可恢复） |
| `GET` | `/api/plugins/:slug/client.js` | 一个插件的前端入口（浏览器 `import` 它） |
| `POST` | `/api/plugins/:slug/enabled` | 开关一个插件（写回 `plugin.md` 的 `enabled`，下次启动生效） |
| `POST` | `/api/reset` | 清空所有数据并重启（设置 → 数据；确认后以退出码 75 退出） |
| `POST` | `/api/restart` | 重启应用（装完带前端的插件；确认后以退出码 75 退出，不删数据） |
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

- 任何文档提交都会触发推送，**去抖 120ms**；内容指纹没变就不发。
- **有人在跑时每秒补推一次**：`activity`（在想 / 在做）来自会话的 live 文档，思考期间
  不落盘，只靠提交总线会让头像不亮圈。闲下来立刻停。
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
  assistant?: true;     // 助理（身份目录在应用根 assistant/ 下，ADR-058）
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
  doing?: string;                   // 仅团队频道且写了 doing：一句话现状
  title: string;                    // 私聊 = 对方的名字；群聊/团队 = 频道/团队名
  team?: string;                    // 仅团队频道（id 形如 team:<slug>）
  unread: number;
  mentions: number;                 // 未读里**点名找我**的条数（判据同 needsYou：正文第一个被点名的是我）
  preview: string;                  // 最后一条**人说的话**的第一行，最多 60 字
  lastAt: number;                   // 毫秒时间戳
  lastSeq: number;
  memberCount: number;
  members: string[];                // 频道成员（**不含我**），按加入顺序；侧栏 / 右栏画群头像用
}
```

**`kind` 只有两种，由 id 前缀 + 成员表一起推出来**（`channel/types.ts` 的 `chatKind()`，
`app/project.ts` 的投影直接转它的结果，`dto.ts` 的 `ViewChannelKind` 只有这两个值）：

| id + 成员表 | kind |
| --- | --- |
| `dm:` 前缀，且恰好两个人、其中一个是 `owner` | `dm` |
| 其余全部（全员频道、团队频道、组群 `group:<slug>`、多人房间、历史无前缀房间） | `group` |

团队频道就是 `team:<slug>` 这个**普通的群**，即使只有我和管理员两个人也永远是 `group`
—— 它和别的群的区别只有「有一份 `teams/<slug>/README.md`」，界面上体现在
`team` / `doing` 这两个字段上。

**`dm`**：一对一房间，id 是 `dm:<两个 slug 排序后拼接>`，成员就是 `{owner, 那个人}`。
**每个成员都由系统建好一条私聊**（`ensureOwnerDm`，装配 / 招人时幂等补齐）—— 他的工作
过程在那里看。仍然没有「个人频道」，agent 也不能私下找另一个人：房间永远是
`{owner, 他}`，不是他的私人档案。

`preview` 只取「人说的话」（`chat` / `say` / `question` / `decision` / `report`）：
`note`（系统留痕）与历史遗留的 `think` / `tool` / `work` / `step` 都不进预览。

## 3.1 `POST /api/channels`（我拉一个群）

```ts
// 请求
{ title: string, members: string[] }   // members = 名字或 slug；我自己由服务端加

// 响应
{ ok: true, id: string }               // id = `group:<slug>`
```

- 建出来是一个普通群聊频道（`kind: "group"`），**没有** README、团队记忆、负责人；
  `wakeOnAll` 是全部成员 —— 群里每个人都会收到新消息，自己判断要不要接（ADR-063）。
- 至少两个人（我 + 至少一个成员），成员必须真的在名册里；同名（slug 相同）不建第二份。
- 第一个 `members` 不认识 → `400`，`error` 里列出可以拉的人；标题为空 / 不足两人同样是 `400`。
- 界面：侧栏品牌行的「＋」→ 拉群浮层（`store.makeGroup`）。
- agent 侧的同一个动作是 `chats action=create`（任何成员都能拉群）。

## 4. `POST /api/people/:slug/dm`（新建私聊）

```ts
// 响应
{ ok: true, id: string }   // id = `dm:<slug>-owner`（排序后拼接）
```

**建频道的入口只有三个**：装配投影（全员 `all` / 团队 `team:<slug>` / 每个成员的私聊）、
这里的私聊、以及 §3.1 的 `POST /api/channels`（组群）。私聊现在由装配 / 招人自动建好，
这个接口仍保留，用来显式确保它在（幂等）。

- 对方必须真的在名册里（`members/<slug>/identity.md` 存在），否则 `404`；
- 不能和我自己开 → `400`；slug 为空 → `400`；
- 已存在则原样返回（幂等，不覆盖标题与成员）；
- 新房间：成员 `{owner, slug}`、标题 = 对方名字、`wakeOnAll` 为空。

界面侧栏点「和这个人说话」时走它（`store.openWithPerson`）。

## 4.1 `GET /api/people/:slug/turns?from=&to=&limit=`（一个人的轮次）

```ts
{ turns: ViewTurn[] }   // 折叠版（不带 steps）；每轮自带 channelId，按 startedAt 倒序
```

和 `/api/channels/:id/turn`（单轮）的区别：**切轮时不按频道过滤** —— 他在团队频道里干活、
在私聊里被插话，都算这个人的轮次，按 `startedAt` 排在一起。`seq` 是频道内序号，
跨频道不可比，所以排序用时间。`from` / `to` 仍然按 seq 过滤（作用于每一轮自己的频道）。

- `limit`：只取最近 N 轮（按 `startedAt` 倒序截断），默认 30，上限 100。后台任务面板用它翻
  一个人的历史，不需要一次搬完整个人生。
- 界面：后台任务面板（`docs/DESIGN.md` §2.3）。

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
}

type ViewMember = {
  id: number;
  slug: string;
  label: string;
  role: "owner" | "assistant" | "member";   // 我 / 助理 / 成员
  unread: number;
}

type ViewMessage = {
  seq: number;
  at: number;
  from: number;          // 会话号；我是 0
  fromSlug: string;
  fromLabel: string;
  kind: "chat" | "note"; // 发言 / 系统留痕。旧数据的 kind 在投影层已归一（ADR-061）
  noteOf?: "run" | "route"; // 系统留痕的种类：run = 后台命令跑完（收成一行）；route = 助理的一次后台分发（不画）
  text: string;
  mentions: { id: number, label: string, read: boolean, offset: number }[];
  replyTo?: { seq: number, from: number, fromSlug: string, fromLabel: string, excerpt: string };
  read: boolean;         // 从我视角
  needsYou?: true;       // 只在这条需要我本人看一眼时出现
  attachments?: { id: string, name: string, kind: "image" | "file", bytes: number }[];
  options?: string[];    // 等我拍板的 2–6 个选项（正文是问题；有没有选项就看这个字段）
}
```

- `role` 只用三种**能从文件里读出来**的事实，不引身份枚举：我 / 助理（身份目录在应用根
  的 `assistant/` 下，ADR-058）/ 成员。
- `noteOf` 只在 `kind` 是 `note` 时出现，现在有两种：`run`（后台命令跑完）的正文是命令、
  输出尾巴和退出码，给干活的那个人看的，界面把它收成一行（`后台命令跑完了。`），点开才看
  全文 —— 平铺的话一屏对话里会插进几十行日志；命令输出里的终端控制序列在写入前就洗掉了。
  `route`（助理在后台把某条交给谁看，ADR-063）是**审计留痕**：界面完全不画，只在
  「这一轮已经把消息交出去了」这件事上被收尾逻辑读（`saidLast`）。
- `text` 是**显示用**正文：`@owner` 一律投影成 `@我`（`owner` 只是内部 slug，我不叫这个名字），
  落盘的那份不动 —— 提示词与历史仍是模型自己写的字。
- `mentions[].offset` 是 `@label` 在正文里的位置，`-1` 表示算不出来（前端就不高亮）。
- `replyTo.excerpt` 最多 60 字。
- `needsYou` 的判据在核心（`app/project.ts` 的 `needsYou`）：**不是我自己发的**，且
  **正文里第一个被点名的人是我**。界面不自己猜关键词。
  为什么不是「mentions 里有 owner」：一句话可以顺手提到好几个人 —— 「@林越 放开做，
  改完 @沈舟 复测、@我 报一句」是派活给林越，里面的 `@我` 是让林越回头找我，不是现在找我。
- `attachments` **没有附件时不出现这个键**，不要区分「空数组」和「没有」。
- `options` 同理：没有选项就没有这个键。**回答不另开接口**：我发的下一条普通消息就是回答
  （`replyTo` 指向这条）。界面按「最后一条带 `options` 的消息、且它之后我没说过话」判定
  还在等我（`ui/app/src/composer/choice.ts` 的 `pendingChoice`，纯函数）。
- `kind` 读出来只有 `"chat"` / `"note"` 两种。历史库里的旧标签在投影层归一
  （ADR-061）：语义标签（`say` / `question` …）算 `chat`，过程行（`think` / `tool` /
  `work` / `step`）算 `note`。前端 `buildRows()` 只画 `chat` 与带 `noteOf` 的 `note`。
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
- 这个接口只写发言（`chat`），不接 `kind`：系统留痕（`note`）只由内核自己写。
  团队记忆不按消息类别自动整理：谁认为值得记，谁用 `remember(scope=team)` 写。
- 投递是异步的：`delivered` / `failed` 是本条消息唤醒了几个人，**不是**他们的回答。
- 前端拿到响应后不要自己插一条消息，等 SSE 推新快照（不制造一条假消息）。

这里**没有**过程投影的 `kind` 了（`think` / `tool` / `say` 投影 / `work`）：运行时不再
订阅会话提交往频道里写思考或工具卡。历史库里的这些消息还在，投影层把过程行归一成
`note`、语义旧标签归一成 `chat`（ADR-061）。

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
  压到 2 KB，展开那一步时再走 §7.2 拉全文。聊天流不画过程（ADR-062），`trace` 的消费者
  是后台任务面板。
- 任何文档提交去抖 120ms 后推增量，只推订阅了这个频道的连接。
- **有人在跑时每秒补推一次**（`trace` 与 `org` 都按指纹去重，没变就不发）：运行状态写在
  会话的 live 文档里，模型思考期间不落盘，只靠提交总线会让进度行停在「正在执行」、
  头像也不亮圈。闲下来立刻停。
- 空闲每 15s 一个 `: ping` 注释行保活。

## 7.2 `GET /api/channels/:id/turn?seq=&slug=`

一轮的完整轨迹（带 `steps`）。

```ts
{ turn: ViewTurn | null }       // 找不到就是 null
```

- 一轮 = 一次唤醒：会话条目里 `core.channel` 且 `data.channelId/seq` 对上的那条，到**下一条**
  `core.channel` 之间。一条消息可以叫醒多个人 → 同一个 `seq` 会出现多条（按 `slug` 区分）。
- 找不到（没被叫醒 / 条目已被压缩）就是 `null`，**不是错误**。
- 轨迹只服务后台任务面板与 SSE `trace`；聊天流不画过程（ADR-062）。

```ts
type ViewTurn = {
  channelId: string;
  channelTitle?: string;        // 频道的显示名；频道归档 / 删掉后列表里没有它，轮次仍说得出在哪儿跑
  seq: number;                  // 触发这一轮的消息
  slug: string;
  label: string;
  status: "running" | "done" | "failed" | "aborted";
  startedAt: number;            // = 触发消息的 at
  endedAt?: number;             // = 回复消息的 at；还在跑就没有
  replySeq?: number;            // 他最终说出口的那条
  trigger?: {                   // 触发这一轮的消息（任务面板的块头）
    from: string;               // 发这条消息的人（slug）
    text: string;               // 正文，截 200 字
  };
  stepCount: number;
  summary: string;              // 确定性摘要：运行 N 条命令 · 读了 N 个文件 · 写了 N 个文件
  truncated?: true;             // 步骤超过 200 步
  steps?: ViewStep[];           // 只在 §7.2 与 SSE trace 里出现
}
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
    channelId: string, channelTitle: string,
    seq: number, at: number,
    from: number, fromSlug: string, fromLabel: string,
    excerpt: string, read: boolean
  }[]
}
```

判定在 `src/app/project.ts` 的 `needsYou(message)`：**不是我自己发的**，且
**正文里第一个被点名的人是我**（别人在先、末尾顺手 @我 的那种是派活给别人，不进）。
标签不会把我算进来（ADR-009）：只有正文点赞才算。只收发言（`kind: "chat"`），
窗口 7 天，最多 60 条。已读的也返回（带 `read: true`），前端淡化显示 ——
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
  assistant: boolean,               // 是不是助理（文件夹事实，ADR-058）
  body: string,                     // identity.md 正文（预置提示词）
  skills: { name: string, description: string, scope: "personal" | "team" | "all", overrides: boolean }[],
  channels: { id: string, kind: "dm" | "group", title: string, members: string[] }[],
  model: string                     // 他此刻用的模型 "provider/modelId"；没有模型就是 ""
}
```

`channels` 里的 `kind` 同样是 `chatKind()` 的投影（`dm` / `group`）：私聊只认 `dm:` 前缀 +
恰好 `{owner, 一人}`，**不按频道 id 前缀分**。`skills` 来自 `listSkills()`：全员层打底，
这个人所在团队的团队层压上，个人层最后覆盖；被更靠下的层盖住的那一份带
`overrides: true`（界面显示「覆盖同名的上层技能」）。`slug` 必须是名册里存在的 agent 且不是
`owner`，否则 404。

## 10.1 `GET /api/teams/:slug`

团队频道的「详情」一次取全：`teams/<slug>/README.md` 的正文（目标 / 验收标准 /
不做什么 / 当前进展）+ 团队层技能（`teams/<slug>/skills/`）+
`teams/<slug>/memory.md` 按小节拆开的条目。

```ts
// 响应
{
  slug: string, name: string, status: string,
  doing?: string,                   // README 头的 doing，没写就不出现
  body: string,                     // README 正文
  skills: { name: string, description: string, scope: "team", overrides: boolean }[],  // 团队层技能
  memory: {
    // at / by / op 恒为 null：团队记忆没有逐条日志，不拿「现在」冒充「当时」（ADR-016）
    entries: { heading: string, body: string, at: null, by: null, op: null }[]
  }
}
```

`slug` 必须是 `teams/` 下真实存在的目录，否则 404。团队记忆**只读**：写入只有
`remember(scope=team)`（成员或助理）与直接 `file` 写 `teams/<slug>/memory.md`，
界面上没有增删入口。

## 10.2 `GET /api/models`

```ts
// 响应
{ models: string[], defaultModel: string }   // "provider/modelId"；一个都没有时都是 ""
```

**现在生效**的那些。读这个接口之前，内核会看一眼 `settings.json` 改过没有，改过就把它就地
重装进注册表（ADR-025），所以刚加的提供商/模型这里立刻就有 —— 不用重启。装不上的（地址 /
协议不对）不会出现，界面上「给某个人换模型」的下拉只列这一份。

## 10.3 `POST /api/people/:slug/model`

换这个人用的模型。**当场生效**（改的是会话的模型，不用重启），同时记进
`<appRoot>/settings.json` 的 `agentModels`（slug → `provider/modelId`），重启后装配仍认这一份。

```ts
// 请求
{ model: string }   // "provider/modelId"；空串 = 跟默认（删掉这条记录）

// 响应
{ model: string }   // 落定后的值；空串表示跟默认
```

- 模型 id 自己可以带 `/`：只按**第一个**斜杠切 provider。
- `model` 必须在装配好的模型注册表里存在，否则 400（写一个解析不到的引用，这个人此后
  每轮都 `no_model`，界面上只留一句「他这一轮没答上来」）。
- 空串要改回默认时，得先有默认模型（`settings.json` 的 `defaultModel` 或环境变量），
  没有就 400。
- `slug` 必须是名册里的人，否则 404。

## 11. `GET /api/people/:slug/memory`

```ts
// 响应
{ slug: string, label: string,
  entries: { heading: string, body: string,
             at: string | null, by: string | null, op: "add" | "edit" | null }[] }
```

`entries` 按 Markdown 的 `##` 标题拆（标题就是记下的日期）。`slug` 必须是名册里存在的
agent（且不是 `owner`）—— 这既挡路径穿越，也让不存在的人老实 404。

`at` / `by` / `op` 是这一节的**来历**，由 `memoryTimeline()` 从 `members/<slug>/.memory-journal.jsonl`
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
- 落盘在 `<appRoot>/uploads/<id>` + `<id>.json`（`{name, mime, bytes, at}`）。一个
  文件一份元数据，并发写不会互相覆盖。
- `GET /api/uploads/:id` 图片内联，其余 `Content-Disposition: attachment`；带
  `?download=1` 强制下载。带 `?preview=1` 时**能内联的才内联**：图片、PDF、`text/*`
  按**真实 mime** 发（`Content-Type` 补 charset），**HTML 永远降成 `text/plain`**，
  其余仍然走附件下载。前端看**响应头**决定怎么画，不看文件名（名字是用户起的）。带 `Cache-Control: immutable` 与
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
{ "lastReport": { "type": "task_interrupted", "at": "2026-11-05T12:03:11.412Z",
                  "text": "任务连续重启超限，已结束（任务 `generation`#t-1，原因 restart_limit）" } }
```

- **只有三个键**：`type` / `at` / `text`（`app/diag.ts` 的 `lastReport()` 原样转出）。
  任务信息是写进 `text` 的，没有单独的 `task` 字段。
- 没有报告时是 `{ "lastReport": null }` —— 前端据此显示「暂无异常」，不要把它当失败。
- `type` 是底座的原名（`task_interrupted` / `storage_failed` / `task_faulted` /
  `migration_failed` / `extension_error` / `host_error` / `listener_error` / …），
  `text` 是已经写成中文的人话。**前端不认识新 `type` 时显示 `text`，不要按 `type`
  分支做文案。**
- `task_outdated` **不算异常**（每次启动都会出现），`lastReport` 跳过它。
- 口径是**快照**，不是流：要持续观察就轮询，或直接 tail 那个 jsonl。

## 13.4 `/api/plugins`（列 / 建 / 删 / 开关 / 前端入口）

插件是 `<appRoot>/plugins/<slug>/` 下的一个文件夹（`plugin.ts` 后端、`client.js` 前端）。
前端启动时**先拉清单，再逐个 `import` 前端入口**，然后才挂载界面 —— 插槽首帧就是满的。

```json
{
  "plugins": [
    {
      "slug": "天气", "name": "天气", "description": "看今天的天气", "enabled": true, "client": true,
      "brings": { "tools": ["weather"], "prompt": true, "routes": 0, "listens": false }
    },
    { "slug": "坏的", "name": "坏的", "description": "", "enabled": false, "error": "插件 坏的 缺少 plugin.md" },
    { "slug": "刚装的", "name": "刚装", "description": "", "enabled": true }
  ]
}
```

- `client` 只表示**有没有**前端入口，值恒为 `true`；地址由前端按 slug 拼：
  `/api/plugins/<slug>/client.js`（两边各写一份完整 URL 一定会漂）。
- `error` 出现 = 这个插件没装上（清单坏 / `import` 失败 / `apply` 抛错）。它照列，但 `enabled` 为 `false`。
- `enabled: false` 的插件不进后端（没有工具、没有提示词段），前端入口也不会被加载。
- 清单以**磁盘为准**：目录里有、这次进程没装上的（新建的、关掉的、装失败的）也列出来，
  它们正是人要知道的。`error` 仍然是这次装载炸在哪。
- `enabled` **每次从磁盘读**。开关、装、卸三个接口写完文件就重装一遍插件（ADR-026），
  所以这里的 `brings` 紧接着就是新的那一份，不用重启。
- `brings` 是**这次进程里真的注册出来的东西**：`tools` 是工具名，`prompt` 是不是加了提示词段，
  `routes` 是接口条数，`listens` 是不是听消息。没装上的（刚新建 / 关掉 / 出错 / 还没重启）
  就**没有这个键** —— 界面据此写「还没装上 · 看一眼日志」，不假装它什么都没带。

前端入口是一个原生 ESM，内容由插件自己写：

```js
export default {
  id: "天气",
  style: "…",                     // 可选，宿主插进 <head>
  apply(ui) {                     // ui = { h, React, api, store, useStore, register }
    ui.register("sidebar.footer", { id: "today", component: () => ui.h("div", {}, "…") });
    // 后端 api（apply 的参数）还有 scope(channelId)：这个频道的工作区根（私聊 → 那个人、
    // 团队频道 → 团队、全员频道 → undefined），以及 logsRoot：`<userRoot>/logs` 的绝对路径
    // （审计 `tools.jsonl` 在那里，按 token 算账读它，ADR-064）。都只给根，路径守卫在插件里做。
    // 格子 = { id, label?, icon?, order?, component }：label 是页签文字 / 设置分区名，
    // icon 是设置左栏那个图标（一个 SVG 元素）。能放进哪些位置见 docs/DESIGN.md §2.8
    // 的插槽表；读界面状态用 ui.useStore。
  },
};
```

### 装与删

```http
POST   /api/plugins
{ "slug": "天气", "files": [ { "path": "plugin.md", "base64": "…" }, { "path": "assets/icon.png", "base64": "…" } ] }
DELETE /api/plugins/天气
```

装 = 把**一个已经写好的插件文件夹**整份搬进来：`path` 相对文件夹根（用 `/` 分隔），内容一律 base64
（插件里有图片这类二进制，按文本传会坏）。界面用 `<input type="file" webkitdirectory>` 选文件夹，
把 `webkitRelativePath` 的第一段当 `slug`、剩下的当 `path`。

校验三条，任一不满足就**一个文件都不写**：名字合法且没有重名；每个 `path` 都在插件目录里面
（`../`、绝对路径一律 400）；根上有 `plugin.md`（没有清单的东西不是插件）。请求体上限 8 MB。
装完带 `client.js` 的插件，界面会问一句要不要重启：后端已经热装好，但前端入口只在页面启动时
`import` 一次（桌面壳走 §13.6，网页版刷新页面）。
**为什么不做「起个名字建空壳」**：插件的能力全在它自己的代码里，空壳装进去什么都不做 ——
那是占位，不是安装（ADR-018）。

删除 = **整目录递归删掉**，不可恢复；名字先过 `isSafeName`，`..` 与嵌套路径都到不了。
两个响应都是整个 `{ "plugins": [...] }`。

### 开关

```http
POST /api/plugins/天气/enabled
{ "enabled": false }
```

响应与 `GET /api/plugins` 同一个形状（`{ "plugins": [...] }`），值已经按新状态算过。
只改 `plugin.md` 头里的 `enabled` 一行，正文与其它字段原样留着；slug 不合法或没有清单 → 400 + `{ error }`。

**下一次启动生效**：这次进程里已经装上的工具 / 路由 / 提示词段不会因为关掉而消失（第一版没有热卸载）。

`client.js` 按 `no-store` 发：改完刷新页面就生效，不用重建 `ui/web/`。
插件自己注册的接口（`api.route`）是**普通的 JSON 路由**，插在静态兜底之前；
它们的形状由插件定义，这份文档不管。

## 13.5 `POST /api/reset`（清空所有数据）

设置 →「数据」里的危险操作：回到刚装好的样子。

```json
{ "confirm": true }
```

- 只认 `confirm: true`；少一个字都是 `400 { "error": "重置需要明确确认" }`。
- 成功回 `{ "ok": true, "restarting": true }`，**然后后端自己退出**（退出码 75）。
  桌面壳收到 75 会重开整个应用；网页版需要手动再起一次服务。
- 删掉两个根里的组织数据：成员、团队、技能、规矩、日志、附件、库、助理与提示词模板。
  下一次启动按 `seed/` 重新播种。
- **保留** `settings.json` 与 `.secrets.json`（模型配置 / 凭据）：重置是清数据，
  不是把应用打成不能说话的空壳。已装插件不保留，出厂插件会重新装回来。
- 删盘必须在库关掉之后做，所以 handler 只负责确认并把「该重置了」交给启动层
  （`shell/main.ts` 的 `resetAll`）；真正的 `rm` 在 `app/reset.ts` 的 `wipeAll`。

## 13.6 `POST /api/restart`（重启应用）

插件的前端入口只在页面启动时 `import` 一次。装上带 `client.js` 的插件后，后端已经热装好了
（工具、提示词、接口都能用），但它的页签 / 按钮要等界面重新加载才出现。界面因此会弹一句
「要不要重启」，确认后请求这里。

```json
{ "confirm": true }
```

- 只认 `confirm: true`；否则 `400 { "error": "重启需要明确确认" }`。
- 成功回 `{ "ok": true, "restarting": true }`，**然后后端自己退出**（退出码 75）。
- 和重置走同一条退出路径，但**不删任何文件**：桌面壳收到 75 就 `app.relaunch()`；
  网页版没有壳，刷新页面即可（前端入口会重新加载）。
- 正在跑的轮次会被打断；重启后 `assembleCore` 按 ADR-044 把被打断的人叫回来接着做。

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
