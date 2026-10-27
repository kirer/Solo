# 网页 API 契约（WEB-API）

> 这份文档是 `src/server/http.ts` 暴露给 `ui/` 的**唯一契约**。
> 前端只按这里的字段写，后端改字段必须同步这里；原则：**只增不改**。
>
> 所有接口都在同一个端口（默认 `127.0.0.1:7788`）下，无鉴权、无 CORS
> （同源页面直接调）。JSON 一律 UTF-8；错误统一为 `{ "error": "人话" }` 加非 2xx 状态码。

## 0. 快速索引

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/org` | 组织快照（CEO/高管/项目/员工/待办/成本/连线） |
| GET | `/api/stream/org` | 组织快照 SSE |
| GET | `/api/profile/:conversationId` | 角色档案（章程 / 技能 / 工具） |
| GET | `/api/pending` | 待决问题列表 |
| POST | `/api/answer` | 拍板回答一条待决问题 |
| **GET / PATCH** | **`/api/settings`** | **设置：网络 / 模型** |
| **POST / PATCH / DELETE** | **`/api/models`** | **新增 / 编辑 / 删除模型（含内置模型的改名、隐藏、设默认）** |
| **GET** | **`/api/board`** | **任务看板（doing / todo / done）** |
| GET | `/api/channels/:id` | 频道视图（消息 + `acks` 受理回执，见 §10.6） |

加粗的是本轮新增。以下逐条写清字段、边界与错误。

---

## 1. `GET /api/settings`

一次拿全设置页需要的两段。**`network` 报的是实际监听值**（不是 settings.json
里的期望值）；`models.default` 报的是当前生效 / 期望的默认模型。

```jsonc
{
  "network": {
    "port": 7788,
    "host": "127.0.0.1",          // 实际监听地址；0.0.0.0 表示所有网卡
    "lanUrls": ["http://192.168.1.71:7788/"], // 非回环 IPv4；只监听回环时为空
    "url": "http://127.0.0.1:7788/"           // 浏览器应打开的地址
  },
  "models": {
    "default": "commandcode/auto/deepseek-v4.1-flash",
    "catalog": [
      {
        "id": "auto/deepseek-v4.1-flash",
        "name": "DeepSeek v4.1 Flash（本地网关）",
        "provider": "commandcode",
        "inputPerMTok": 0,          // 美元 / 百万输入 token（可选）
        "outputPerMTok": 0,         // 美元 / 百万输出 token（可选）
        "source": "builtin"         // builtin | custom
      },
      {
        "id": "gpt-5-mini",
        "name": "GPT-5 mini",
        "provider": "openai",
        "baseUrl": "https://api.openai.com/v1", // 仅自定义模型有
        "inputPerMTok": 0.25,
        "outputPerMTok": 2,
        "contextWindow": 400000,    // 仅自定义模型有
        "maxOutput": 128000,        // 仅自定义模型有
        "source": "custom"
      }
    ],
    // true = settings.json 与进程启动时不一致，改动要重启服务才生效
    "restartRequired": true
  },
  "im": {
    "enabled": false,
    "outboundWebhook": "",
    "inboundToken": "",
    "accounts": [
      { "id": "a1", "channel": "wechat", "name": "老板微信", "enabled": true, "note": "可选" }
    ]
  }
}
```

说明：

- `models.default` 用 `provider/modelId` 表示；但 PATCH 时传 catalog 里的 `id`
  （或唯一的 modelId）也可以。
- 自定义模型只有在**重启后**才会真正出现在运行时模型集合里（`restartRequired` 的由来）。
- `network.lanUrls` 的规则：监听 `127.0.0.1` → `[]`；监听 `0.0.0.0` / `::`
  → 全部非回环 IPv4；监听具体网卡地址 → 只列它自己。IPv6 不列（手机输入体验差）。

## 2. `PATCH /api/settings`

请求体是上面的**结构子集**，按段浅合并：

```jsonc
{
  "network": { "host": "0.0.0.0", "port": 7788 },
  "models": { "default": "gpt-5-mini" },
  "im": {
    "enabled": true,
    "outboundWebhook": "http://127.0.0.1:9700/hook",
    "inboundToken": "change-me",
    "accounts": [ /* 整段替换：传什么就是什么，传 [] 清空 */ ]
  }
}
```

- `im.accounts` **整段替换**，不做逐项 merge。
- `models.catalog` 只读，不参与 PATCH；增删模型用 `/api/models`。
- `network` / `models` 的改动写入 `workspace/settings.json`，**下次启动生效**；
  `restartRequired`。
- 校验失败返回 `400`；成功返回**完整 GET 结构**（含 `restartRequired`），
  前端不用再补一次 GET。

## 3. `POST /api/models`

请求体是**扁平的模型对象**（没有包裹层）：

```jsonc
{
  "id": "gpt-5-mini",              // 必填，字母数字开头，可含 . _ - : @ /
  "name": "GPT-5 mini",            // 可选，默认 = id
  "provider": "openai",            // openai-responses | anthropic | openai，默认 openai-responses
  "baseUrl": "https://api.openai.com/v1", // 可选，必须是 http(s)
  "apiKey": "sk-...",              // 可选，明文本机存储（见安全提醒）
  "inputPerMTok": 0.25,
  "outputPerMTok": 2,
  "contextWindow": 400000,
  "maxOutput": 128000
}
```

响应 `200`：

```jsonc
{
  // 同时返回完整 GET /api/settings 结构（network / models / im），
  // 前端可以一次 applySettings，不用再补一次 GET。
  "network": { /* ... */ },
  "models": { /* ... */ },
  "im": { /* ... */ },
  "ok": true,
  "model": { /* 与 GET catalog 里的 custom 项同结构 */ },
  "restartRequired": true
}
```

错误：`400` 参数不合法（id 非法 / baseUrl 非 http(s) / 设置不是对象）；
`409` id 重复或与内置模型重名。

## 4. `PATCH /api/models?id=<id>`

**编辑**一条已存在的模型。老板 2026-10 追加（原契约只有 POST/DELETE，
设置页里模型只能增不能改）。

- 内置模型（`source: "builtin"`）不能改 `id` / `provider` / `baseUrl`，
  只能改 `name`（显示名）、`inputPerMTok`、`outputPerMTok`、
  `contextWindow`、`maxOutput`、以及 `default?: boolean`。
- 自定义模型字段可全改；改 `id` 等价于「新建一条 + 隐藏旧的」。
- `default: true` 会把 `models.defaultRef` 指向本模型（重启后生效）。
- 内置条目发生覆盖时，落库的是一条 `{ builtin: <原 id>, hidden?: false, ... }`
  的覆盖项（`CustomModelSettings.builtin`），**不改代码里的内建目录**。

响应与 POST 同款：完整 GET 结构 + `{ ok, model, restartRequired }`。
`404` 表示这个 id 不存在。

## 5. `DELETE /api/models?id=<id>`

- **自定义模型**：真删（`settingsStore.removeModel`），响应带完整 GET 结构。
- **内置模型**：不能真删（它来自代码里的内建目录），改为写一条
  `{ builtin: id, hidden: true }` 覆盖项把它**从视图里隐藏**，并就地改
  `models.defaultRef` 退到剩下的第一条（`fallbackDefaultAfterRemoving`），
  否则重启后默认模型会指向一个已隐藏的 id。
- 完全不认识的 id：`404`。

两者都需要重启才从运行时模型集合里消失。

## 8. `GET /api/board`

看板数据全部由现有运行时推导（不建新表），三列固定：

```jsonc
{
  "generatedAt": 1792903266540,
  "columns": [
    { "id": "doing", "title": "进行中", "items": [ /* BoardItem */ ] },
    { "id": "todo",  "title": "待办",   "items": [ /* BoardItem */ ] },
    { "id": "done",  "title": "最近完成", "items": [ /* BoardItem */ ] }
  ]
}
```

`BoardItem`：

```jsonc
{
  "id": "doing-12",             // 列内唯一
  "title": "正在实现登录页",     // 一句话摘要（≤200 字）
  "project": "tank-battle",     // 可选：项目 slug
  "projectName": "坦克大战",     // 可选：项目显示名
  "owner": 12,                  // 可选：负责人会话标识（与 conversationId 相同）
  "ownerLabel": "林越",          // 显示名
  "status": "busy",             // busy | waiting | queued | idle | done
  "conversationId": 12,         // 前端跳转以此为准
  "href": "#/c/12",             // 便利字段：hash 路由
  "at": 1792900000000           // 可选：发生/提问时间（毫秒）
}
```

数据来源：

| 列 | 来源 | status |
| --- | --- | --- |
| doing | 忙碌会话（`inspectLiveness`）+ 最近活动一句话 | `busy` |
| todo | 未答复的待决项（`listPending`） | `waiting` |
| todo | 已提交但还在排队的消息（`InboxDoc`） | `queued` |
| done | 最近 24 小时完成的一轮助手回复（每会话取最新一条） | `done` |

## 10. 局域网访问

- 默认监听 `127.0.0.1`：只有本机能访问。
- `--host 0.0.0.0`（或 `AI_COMPANY_HOST=0.0.0.0`）监听所有网卡；启动日志与
  `GET /api/settings.network.lanUrls` 会列出全部非回环 IPv4 地址。
- 服务**没有鉴权**：任何能访问该端口的人都能读全部对话、发消息、改设置。
  只应在可信内网使用；不要做公网端口映射 / 反向代理。安全边界见
  [DEPLOY.md](DEPLOY.md)。

## 10.5 待办与拍板投递

待办（`pending`）现在由两个入口下发：

- **频道视图**（`GET /api/channels/:id` 的 `pending` 字段，见 §10.6）——界面在读的地方。
- **组织快照**（`GET /api/org` 的 `pending[]` + `ceoQueue`）——运维脚本与看板用。

每条的形状：

```jsonc
{
  "key": "esc:7:1",
  "question": "要不要把公司搬到杭州？",
  "from": "CTO",
  "decisionOwner": "owner",
  "askedAt": 1792900000000,
  "disposition": false,          // true = 处置类（暂搁 / 放弃）
  "options": [{ "id": "shelve", "label": "暂搁", "recommended": true }]
}
```

三点约定（都是踩过的坑）：

1. **待办和聊天是同一件事**。一条待决问题本质就是「有人在等你回话」，所以它
   出现在频道消息流里，不另开顶部黄框区域。同一条问题渲染两次、答完还没反应，
   是用户明确报过的问题。
2. **答复必须投递给真实提问方**。`POST /api/answer` 成功后，`deliverDecision()`
   会把拍板结果落成一条 **`kind: "decision"` 的频道消息**（有私聊投私聊，否则投
   公司大群，必要时现场建那条私聊），`mentions` 指向真实发起人
   （`pending.originConversationId`，不是被改写成 CEO 的 `fromConversationId`），
   由频道机制唤醒它继续干活。
   落地在频道而不是会话流，是因为拍板结果要能被翻回去、能被 @ 回、能进未读摘要
   ——会话流里一条 note 三样都做不到（ADR-040）。
3. `options` 由服务端给（解析在服务端一处），界面不再自己猜：
   把「1. 读文件」这种步骤渲染成可点按钮，点一下就会把步骤当答案发出去。

## 10.6 频道视图 `GET /api/channels/:id`

`?limit=`（默认 50，夹在 1–200）、`?before=`（取 `seq` 更早的一页）。返回
`{ channel, members, messages, hasMore, tasks, pending, serverNow }`，字段定义见
`src/server/channels-view.ts` 的 `ChannelView`。这里只钉易错的那部分：`MessageView.acks`。

### `MessageView.acks`：老板消息的受理回执

`app.ack` 是**会话流里的 `write` 条目**（CEO/项目负责人自己的对话里），不是频道消息；
频道视图把它投影成 `acks`，老板才能在**自己发的那条消息下面**看到「已排队 / 处理中」。

```jsonc
"messages": [
  {
    "seq": 12, "at": 1793046450628, "from": 0, "fromLabel": "老板",
    "kind": "chat", "text": "看下进度", "mentions": [], "read": true,
    "acks": [
      {
        "at": 1793046450700,
        "plan": "立即处理",              // 或 "当前工具结束后处理"
        "busy": false,                   // 写回执时对方是否正忙
        "busyWith": null,               // busy 时它手上的工具名
        "conversationId": 1              // 回执发给了谁（对应 members[].id）
      }
    ]
  }
]
```

约定（都是踩过的坑）：

1. **关联靠 `messageSeq`，不靠时间也不靠顺序**。服务端写 `app.ack` 时把它指向的频道消息
   `seq` 一起落库；投影只收 `data.channelId === 本频道 && data.messageSeq === 这条消息 seq`
   的条目，所以**别的消息的回执不会串过来**。`acks` 缺省（字段不存在）= 这条消息没有回执。
2. **不回显 `text`**。`app.ack` 的 `text` 只是老板发言的前 280 字，频道里已有全文，
   再显示一遍就是重复；界面只显示状态（`plan` / `busy` / `busyWith`）。
3. **不是每种消息都有 `acks`**。只有老板（`from === 0`）发言才写回执；员工报告、系统消息、
   任务卡永远没有。
4. **装填有上限**：`readChannelView` 只对**最新 20 条老板消息**回查回执（每个目标会话扫最新
   60 条条目，再按 `messageSeq` 过滤）。更早的消息要靠翻页、翻页后重新装填。理由：这个
   接口被轮询，逐条扫全库会话条目会拖慢大频道；20 / 60 足够覆盖「刚发完等反馈」这个场景。
5. **`ack` 不是 `deliveredTo`**。`deliveredTo` 是给看门狗用的 submission 回执，语义不同，
   两者不要混用；`acks` 只读、不影响投递与重投。

## 10.7 频道列表 `GET /api/channels`

频道列表项（`ChannelListItem`，`src/server/channels-view.ts`）里有两个**容易混淆**的
计数字段，别用错：

```jsonc
{
  "unread": [
    {
      "id": "proj:dino-game",
      "kind": "project",
      "title": "dino-game",
      "mentions": 2,          // 未读的 @ 我 的条数 —— 需要我点开
      "unread": 7,            // 未读消息总条数
      "openTasks": 3,         // 本项目未完成（非终态）任务数 —— 只是背景信息
      "preview": "…", "lastAt": 0, "lastSeq": 0, "memberCount": 2
    }
  ],
  "mentions": 2,              // 全站 @ 我 的总数（顶栏徽章）
  "total": 9
}
```

- **`openTasks` 只在列表级有**。频道详情（`GET /api/channels/:id`）给的是
  `tasks: TaskEntry[]`（完整对象），没有 `openTasks` 这个数字——需要计数时自己数
  `tasks.length`。这个不对称是有意的：列表要轻，详情要全。
- **三个数的视觉权重不一样**（`ui/css/channels.css` 的 `.ch-row-tasks` 注释）：
  `mentions` 是最强的（要你动手指），`unread` 次之，`openTasks` 最弱
  （`var(--surface-3)` 底、`var(--muted)` 字、10px）——任务是背景，不是待办提醒。
- **`openTasks` 会漏掉终态任务**：口径是 `!isTerminal(status)`，即 `todo` / `doing` /
  `blocked` / `review` 都算。`done` 与 `cancelled` 不算。

## 11. 已知限制

- **没有附件上传能力**（ADR-040 删掉了 `/api/upload` 与 `/uploads/*`）：
  后端与接口文档曾经都有，但界面从来没有接上过入口，于是两边都当它不存在。
  要重新加，先想清楚「谁在什么场景下真的会传文件」，再一起加前后端。

## 12. 兼容性纪律

- 字段**只增不改**：删字段 / 改语义必须同步改前端与本文档。
- 新增错误码只用 `400 / 403 / 404 / 409 / 413 / 503`，不要发明 4xx 之外的业务码。
