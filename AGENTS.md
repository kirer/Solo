# AGENTS.md

> 这是**任何 AI agent（Claude Code / Cursor / Codex / pi / 别的）在本仓库工作时先读的那一份**。
> 它只写三件事：**这是什么**、**改代码前后必须做什么**、**要动某处该读哪份文档**。
> 文档地图见 [`docs/README.md`](docs/README.md)。**改完行为请同步改本文档中相关的表**，这是硬要求，见 §4。

---

## 1. 这是什么

「一人公司」：一个老板 + 一个 AI 公司的多 agent 运行时。

```
老板 ── 对话 ── CEO ── 领导层（CTO/CFO/CPO/COO/CMO/CHRO）── 项目负责人 ── 项目员工
```

- 每个 agent 是一个独立的 pi 会话，有自己的模型、提示词、能力包（工具集）。
- agent 之间通过**频道消息**通信（不是同步函数调用），通过**任务文档**记录工作。
- 每个项目 = 一个工作空间文件夹，员工在里面真的写代码、跑命令、跑测试。
- 已真实产出过一个能玩的网页坦克大战（`archive/examples/tank-battle/`）。

**技术地基**：`@earendil-works/pi-durable@1.4.0`（experimental，每个 minor 都有破坏性变更）。
外壳（网页 / TUI / 业务逻辑）全部自己写。

---

## 2. 目录与边界（30 秒版）

```
src/runtime/   防腐层：唯一 import pi-durable / pi-ai / chord 的地方
src/domain/    纯函数：频道、任务、成员、记忆的状态迁移与判定，**不做 IO**
src/company/   业务编排：文档、角色、工具、投递、成本、看门狗
src/server/    网页服务：HTTP 路由表 + SSE + 视图投影
src/tui/       终端界面
ui/            网页界面（原生 ES module，无框架；`npm run ui:build` 可打包到 ui/dist/）
test/          contract（钉底层行为）/ unit（纯函数）/ e2e（真 boot 一家公司）
scripts/       验收与运维脚本
docs/          文档（索引见 docs/README.md）
archive/       归档：验证脚本、Pi 源码、产出的游戏（不参与运行）
workspace/     运行时数据：数据库、项目文件夹、日志（gitignore）
```

**三条不可越过的边界**（详见 [`docs/DECISIONS.md`](docs/DECISIONS.md)）：

1. **只有 `src/runtime/` 能导入底层库**。`npm run check` 会强制检查（`scripts/check-boundaries.mjs`）。
2. **权限靠「工具不存在」，不靠提示词**。员工的能力包里没有任何管理工具（ADR-004 / ADR-010）。
3. **成本只从用量文档取，不按历史消息求和**（分叉会话会重复计账，ADR-003）。

另外两条容易踩的：

4. **`src/domain/` 不做 IO**。状态迁移是纯函数，写消息/投递是 `src/company/` 的职责。
5. **新建会话必须显式指定能力包**（ADR-009）；**能力包名必须全局唯一**（ADR-014）。

---

## 3. 改代码的固定动作

### 3.1 开工前

```bash
cat docs/CODE.md            # 找到你要改的文件在第几节
cat docs/DECISIONS.md       # 你改的地方碰不碰边界
```

- 你的改动会碰某条 ADR 的边界 → **不要偷偷改，追加一条新 ADR 说明原因**（`docs/DECISIONS.md` 的规矩：只追加，不改旧条目）。
- 你的改动会让某条现有行为**不再成立** → 在 `docs/SYSTEM.md` / `docs/COMMS.md` 里改掉它，别让文档描述一个已经不存在的系统。

### 3.2 提交前（必须全绿，缺一不可）

```bash
npm run check                                  # tsc --noEmit + 边界检查（含「路由必须有消费者」）
npm run verify                                 # 全量测试 + 机器可读收据；跳过 0 才算过
npm run ui:build                               # 改了 ui/ 就必须跑
node scripts/ui-check.mjs --url http://127.0.0.1:7788/   # 改了界面就必须跑（66 项真浏览器断言）
```

- **`npm test` 不再是验收标准，`npm run verify` 才是。** `verify` 跑完写
  `.taste/verify-receipt.json`（`ok` / `numTotalTests` / `numPendingTests` / `commit` / `at`），
  `numPendingTests > 0` 即失败：**跳过的测试等于没测**。想跳过真模型测试必须显式
  `SKIP_REAL_MODEL=1`，不设就探测网关，探不到直接红。`npm run verify:check` 校验收据新鲜
  （同一 commit ∧ 24 小时内）。
- **`npm run check` 的边界检查会往 stderr 打「已知缺口」清单**（有消费计划但界面还没接上的
  路由）。那是待办，不是失败；真违规才 exit 1。加新路由而没人消费，要么接上、要么删掉、
  要么写进 `scripts/check-boundaries.mjs` 的 `NO_CONSUMER_PENDING` 并写清谁来收尾。
- **`ui-check.mjs` 默认连 7789 端口**，本机服务通常在 7788，必须显式传 `--url`。它断言的是
  **默认落在频道视图**；要验组织图相关行为（翻面 / 连线 / 状态光边）必须先 `#view-org`。
- 改了界面**不能只读代码就交付**，要真实浏览器截图验收：`npm run ui:shot -- --url ... --out /tmp/shots`。

### 3.3 改了行为 → 同步这几个地方（硬要求）

| 你改了什么 | 必须同步 |
|---|---|
| 一个不显然的取舍 | `docs/DECISIONS.md` 追加一条 ADR |
| 文件/模块的位置、职责 | `docs/CODE.md` |
| 系统的运转方式（流程、数据文档、唤醒规则） | `docs/SYSTEM.md` |
| 频道 / 消息 / 任务 / 投递 | `docs/COMMS.md` |
| HTTP 接口的字段 | `docs/WEB-API.md`（**先改它，再改代码**） |
| 本文件的表 | `AGENTS.md` |

**文档里的数字和行号会漂**。写文档时优先写**名字**（函数名、文件名、ADR 号），少写行号；非要写行号，交付前用 `grep -n` 核一遍。

---

## 4. 文档的组织规矩

**一份事实只有一个家。** 现状型事实只能出现在这四份里：

| 家 | 装什么 |
|---|---|
| `docs/SYSTEM.md` | 系统怎么运转 |
| `docs/CODE.md` | 代码在哪、谁负责什么 |
| `docs/DECISIONS.md` | 哪些边界不能碰、为什么 |
| `docs/WEB-API.md` | 接口字段 |

**`docs/history/` 是冻结区**：只记录「当时的推理」。里面的行号、路径、数量、截图链接都可能已经失效，不要以它为准，也不要往里加新内容（要加就加一条 ADR 或新文档）。

**截图不入库**：用 `npm run ui:shot`，输出到 `.taste-skill/shots/`（已 gitignore）。需要长期留证的图放 `workspace/`，不进版本库。

**不要新增「临时契约」「XX 轮施工说明」这类文档**。一次性的施工语境写在 PR/提交信息里；跨迭代有效的结论进 ADR。

---

## 5. 常见任务 → 读哪份

| 我要… | 先读 | 再动 |
|---|---|---|
| 加一个工具（能力） | `docs/CODE.md` §4 能力包 | `src/company/capabilities.ts` + `src/company/tools/` |
| 改 agent 的提示词 / 职责 | `docs/SYSTEM.md` §角色 | `src/company/prompts.ts`、`src/company/roles.ts` |
| 改频道 / 唤醒规则 | `docs/COMMS.md` §3 | `src/domain/channels.ts`、`src/domain/membership.ts` |
| 改派活 / 上报 | `docs/COMMS.md` §5 | `src/company/deliver.ts` |
| 加一次 HTTP 接口 | `docs/WEB-API.md` | `src/server/routes.ts`（表驱动）+ `src/server/http.ts`（handler） |
| 改网页界面 | `docs/CODE.md` §6 + `docs/WEB-API.md` | `ui/index.html`、`ui/js/*.js`、`ui/css/*.css` + 跑 `ui:build` & `ui-check` |
| 改任务状态机 | `docs/COMMS.md` §2.2 | `src/domain/tasks.ts`（纯函数）+ `src/company/tasks.ts`（IO） |
| 换 / 升级 pi-durable | `docs/history/PLAN.md` 附录 B（15 个坑） | `src/runtime/*` + `test/contract/` |
| 部署 / 排障 | `docs/RUNBOOK.md`、`docs/DEPLOY.md` | — |

---

## 6. 上手三条命令

```bash
npm install
npm start                        # 起网页服务，默认 http://127.0.0.1:7788
npm run verify                   # 741 个测试，约 2 分钟（跳过 0 才算过）
```

`workspace/company.sqlite` 是真实数据；做实验前先备份（`docs/RUNBOOK.md` §备份）。
`archive/spikes/` 里的 9 个脚本可以独立复跑，验证底层机制，不需要 API key。
