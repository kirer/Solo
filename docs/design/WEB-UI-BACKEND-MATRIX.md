# 网页界面 × 后端能力对照

> ⚠️ **已部分过时**：右侧对话面板已在后续改动中删除（`ui/js/chat.js` /
> `ui/js/ask.js` / `ui/css/chat.css` 移除），下表里「对话面板」「对话流」「发消息」
> 「对话拖宽」几行的前端实现已改为频道视图 + `ui/js/pending.js`。
> 后端能力（`/api/stream/feed/:id`、`/api/message`、`/api/answer`）仍然存在，
> 只是网页端不再使用对话面板入口。
>
> 2026-10-24 审计。结论以当前 `ui/` 与 `src/server/` 的磁盘状态为准。
> 目的：回答「前端这些功能，后端是不是都支持」，并记录仍缺的后端能力。

| 功能 | 前端实现 | 后端来源 | 状态 |
| --- | --- | --- | --- |
| 组织架构 / CEO / 高管 / 项目 / 员工 | `ui/js/org.js` + `org-view.ts` | `GET /api/org`、`/api/stream/org` | ✅ |
| 卡片的忙 / 待你 / 空闲 / 已终止 | 状态色边框 + 光边 | `inspect()` 任务、pending、project.status | ✅ |
| 活动一句话 / token | 卡片副行 | `describeActivity()`、UsageDoc | ✅ |
| 项目翻面看团队 | `rotateX` + 高度过渡 | 项目 lead/staff 数据 | ✅ |
| 待你拍板 | 对话面板顶部卡片 + CEO 卡计数 | `PendingDoc` / `/api/answer` | ✅ |
| 对话流（正文/思考/工具/流式/排队） | `chat.js` + `markdown.js` | `GET /api/stream/feed/:id` | ✅ |
| 发消息 / 立即处理 | composer + 排队卡 | `POST /api/message`、`/api/interrupt` | ✅ |
| 工具参数/输出折叠、复制 | 前端 | feed item 的 args/output/state | ✅ |
| Markdown | 前端渲染器 | feed 文本 | ✅ |
| 成本 / 默认模型 | 设置浮层 | `org.costs`、`org.company.model` | ✅（只读） |
| 主题 深/浅/跟随系统 | `tokens.css` + `app.js` | 无（localStorage） | ✅（纯前端） |
| 对话拖宽 / 收起 / 手机抽屉 | 前端 | 无 | ✅（纯前端） |
| 沟通连线（实时） | SVG 边 + 流动光点 | `beginLiveTrail()` → `org.links` | ✅（本轮补齐） |
| 沟通连线（历史派活/回报） | 同上 | `TrailDoc`（recordMessage） | ✅ |
| 沟通连线（升级/决定） | 同上 | `TrailDoc` 端点本轮改为真实岗位会话 | ✅ 新记录；老数据仍是自环 |
| 旧员工/归档员工的连线 | 聚合到项目卡 | `links[].project` | ✅（本轮补齐） |
| 模型添加 / 切换 | 设置里只展示默认模型 | **无 HTTP API** | ⏳ 待做（用户已说明后期） |
| 新建会话 / 分支 / 改主题同步到服务端 | 无 | 无 | ⏳ 未做（当前产品不需要） |
| 会话物理删除 | 无 | 底层无删除 API（README 已注明） | ⛔ 已知限制 |

## 本轮修掉的连线问题

1. **只在答完后才有历史边** → 新增进程内 live registry：派活/转交一开始就挂临时边，答完释放并转为历史边。
2. **旧端点找不到锚点就整条丢弃** → 带 `project` 的未知端点聚合到项目卡。
3. **升级/决定边的两个端点都写成发起方会话** → 新记录解析成真实岗位会话（ceo/cto/owner）。
4. **时间窗太短**（20 分钟，很多真实沟通早已过期）→ 改为 24 小时、最多 16 条；越新越亮。
5. **岗位之间转交没有历史留痕** → `delegate_to_role` / `delegate_to_project_leader` 完成后补写 delegate/report。

## 验证

```bash
npm test                 # 203 passed
npm run ui:check         # 47/47
node scripts/ui-shot.mjs --url "http://127.0.0.1:7788/?theme=light" \
  --out .taste-skill/audit --name links-real --sizes 1440x900
```

- 真实库 7788：4 条线可见（含旧员工端点聚合到项目卡）。
- 演示库 7789：5 条线（种子数据内置了 demo 沟通）。
- `?dev` + `__company.useMock()`：5 条实时/近期边 + 流动光点。
