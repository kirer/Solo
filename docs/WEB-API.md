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
| GET | `/api/feed/:conversationId` | 会话流 |
| GET | `/api/stream/feed/:conversationId` | 会话流 SSE |
| GET | `/api/profile/:conversationId` | 角色档案（章程 / 技能 / 工具） |
| GET | `/api/pending` | 待决问题列表 |
| POST | `/api/message` | 老板发消息（可带附件） |
| POST | `/api/interrupt` | 打断当前工作并优先处理 |
| POST | `/api/answer` | 拍板回答一条待决问题 |
| **GET / PATCH** | **`/api/settings`** | **设置：网络 / 模型 / IM** |
| **POST / PATCH / DELETE** | **`/api/models`** | **新增 / 编辑 / 删除模型（含内置模型的改名、隐藏、设默认）** |
| **POST** | **`/api/upload`** | **上传附件（原始字节）** |
| **GET** | **`/uploads/:id/:name`** | **下载附件** |
| **GET** | **`/api/board`** | **任务看板（doing / todo / done）** |
| **POST** | **`/api/im/inbound?token=`** | **IM 入站投递到老板通道** |
| GET | `/api/channels/:id` | 频道视图（消息 + `acks` 受理回执，见 §10.6） |

加粗的是本轮新增。以下逐条写清字段、边界与错误。

---

## 1. `GET /api/settings`

一次拿全设置页需要的三段。**`network` 报的是实际监听值**（不是 settings.json
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
  `im` 改动**立即生效**（入站/出站每次请求都读最新设置），因此 IM 改动不算
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

## 6. `POST /api/upload` + `GET /uploads/:id/:name`

上传是**原始字节**，不是 multipart：

```http
POST /api/upload
Content-Type: text/plain; charset=utf-8
x-file-name: report%202026.txt   # encodeURIComponent(file.name)，服务端 decode
x-file-size: 12345               # 可选，只做预检；以实际读取字节数为准
<原始字节>
```

响应 `200`：

```jsonc
{
  "id": "7b11d6043532f55e",
  "name": "report 2026.txt",
  "size": 23,
  "mime": "text/plain",
  "url": "/uploads/7b11d6043532f55e/report%202026.txt"
}
```

- 单文件上限 **20MiB**，超过返回 `413`（`x-file-size` 预检能提前拒绝）。
- 文件落盘到 `workspace/uploads/<id>/<name>`，元数据在同目录 `meta.json`。
- `GET /uploads/<id>/<name>` 返回原始字节（`Content-Type` 为上传时的 mime，
  `Content-Disposition: inline`）；名字与记录不符返回 `404`（防手改 URL）。
- 文件名会被净化（去掉路径与控制字符，只留 basename），不会写出目录外。

## 7. `POST /api/message`（新增 `attachments`）

原有字段不变，新增可选数组：

```jsonc
{
  "conversationId": 1,
  "text": "看看这个附件",
  "mode": "now",                 // now（默认，老板通道立刻生效）| steer | followUp
  "attachments": [
    { "id": "7b11d6043532f55e", "name": "report.pdf", "mime": "application/pdf", "size": 12345 }
  ]
}
```

服务端把每份附件转成一句文本引用注入消息：

```text
看看这个附件

[附件] report.pdf → /abs/path/workspace/uploads/7b11d6043532f55e/report.pdf
```

- 任何模型都能用 `read` / `bash` 工具读这个绝对路径，**不需要多模态支持**。
- 附件 id 查不到时返回 `400`（明确报错，不静默丢弃）；`text` 与 `attachments`
  至少有一样。
- 受理回执（`app.receipt`）记录的是注入后的完整正文。

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

## 9. `POST /api/im/inbound?token=<inboundToken>`

外部 IM 桥（微信 / 企微 / 飞书 / 自建 webhook）把消息投给老板通道：

```jsonc
// 请求
{ "text": "帮我看下部署", "from": "微信" }   // from 可选
// 响应
{ "ok": true, "conversationId": 1 }
```

- `im.enabled !== true`、`inboundToken` 为空、或 token 不匹配 → **`403`**。
- 投递文本会加来源前缀：`[IM] 帮我看下部署` / `[IM · 微信] 帮我看下部署`，
  CEO 能区分这句话不是老板在网页里打的。
- 走老板通道的「now」语义（与 `POST /api/message` 相同）：打断当前轮、
  写受理回执、投递失败补追认条目并返回 `503`。
- 空 `text` → `400`；公司还没初始化出老板通道 → `503`。

### 出站：`settings.im.outboundWebhook`

`im.enabled = true` 且 `outboundWebhook` 非空时，老板通道**每条助手回复**
都会 `POST` 一次：

```jsonc
{ "text": "好的，我看一下……", "conversationId": 1, "at": 1792900000000 }
```

- 只推**本进程启动之后**的回复，不会把历史消息灌给桥。
- 失败（超时 3s / 连接拒绝 / 非 2xx）**静默忽略**，不影响对话与提交。
- webhook 只接受 `http(s)`；桥要保证幂等-ish（至少不要对同一 `text+at` 重复刷屏）。

## 10. 局域网访问

- 默认监听 `127.0.0.1`：只有本机能访问。
- `--host 0.0.0.0`（或 `AI_COMPANY_HOST=0.0.0.0`）监听所有网卡；启动日志与
  `GET /api/settings.network.lanUrls` 会列出全部非回环 IPv4 地址。
- 服务**没有鉴权**：任何能访问该端口的人都能读全部对话、发消息、改设置。
  只应在可信内网使用；不要做公网端口映射 / 反向代理。安全边界见
  [DEPLOY.md](DEPLOY.md)。

## 10.5 待办与拍板投递

`GET /api/feed/:conversationId` 除消息条目外，还下发 `pending`——**这个会话主人要亲自拍的事**：

```jsonc
"pending": [
  {
    "key": "esc:7:1",
    "question": "要不要把公司搬到杭州？",
    "from": "CTO",
    "decisionOwner": "owner",
    "askedAt": 1792900000000,
    "disposition": false,          // true = 处置类（暂搁 / 放弃）
    "options": [{ "id": "shelve", "label": "暂搁", "recommended": true }]
  }
]
```

三点约定（都是踩过的坑）：

1. **待办只出现在对话流里**。界面不再另开顶部区域——一条待决问题本质就是
   「有人在等你回话」，它属于这段对话。同一条问题渲染两次、答完还没反应，
   是用户明确报过的问题。
2. **答复必须投递给真实提问方**。`POST /api/answer` 成功后，服务端会往
   `pending.originConversationId`（真实发起人，不是被改写成 CEO 的
   `fromConversationId`）的会话流写一条 `app.decision` 条目，并投一条 input
   **唤醒它**继续干活。只写 `PendingDoc` / `AuditDoc` 会造成「拍板的人以为没生效、
   被拍板的人永远等不到」。
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

## 11. 已知限制

- **历史消息不还原附件 chip**：附件元数据不落在 `pi.user` 条目里（不新增持久化
  字段），所以刷新页面后只有正文里的 `[附件] name → /abs/path` 文本引用，
  输入区的本地附件托盘 chip 只在当次发送后保留。要补需要改 `feed.ts` 的条目
  构建与持久化协议，收益小、风险大，本轮明确不做。
- **二进制附件在无工具会话里读不到内容**：老板通道（CEO）只装了管理类工具
  （组织/项目/人员），没有 `read` / `bash`。为此服务端对**文本类附件**
  （`.txt/.md/.json/.csv/.ts/.tsx/.js/.css/.html/.sh/.py/...`，见 `TEXTUAL_FILE`）
  自动附一段前 8KB 的内联摘录，所以 csv/md/txt 这类老板能直接给 CEO 看；
  图片、PDF、压缩包不摘录（塞进去只会是乱码 token），仍需要员工/项目会话
  的工具或视觉模型才能读。
- `POST /api/message` 不做 OCR / 文档格式转换（不解析 docx/xlsx/pdf），
  需要时让模型在项目会话里用工具处理。

## 12. 兼容性纪律

- 字段**只增不改**：删字段 / 改语义必须同步改前端与本文档。
- `Feed` 里被标记 `@deprecated` 的字段仍然保留（例如 `awaitingOwner`），
  新代码用新字段。
- 新增错误码只用 `400 / 403 / 404 / 409 / 413 / 503`，不要发明 4xx 之外的业务码。
