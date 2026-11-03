# Solo

一个人 + 一个 AI 组织。**组织不是代码里的角色枚举，是磁盘上的一堆文件夹**：
每个人的身份、记忆、技能都是文本文件，随时可改、改了立刻就生效。

```
我 ── 直接对话 ── 助理 ── 助理招的人 ── 团队（一个频道 + 一份 README）
                    （组织是平的：没有上级，也没有团队负责人）
```

## 它到底在解决什么

让一堆 agent 像一个团队一样运转，而不需要为每一个身份写一份代码：

- **身份是文件**：`~/.solo/members/<slug>/identity.md`。加一个人 = 加一个目录，不用改代码、不用重启。
- **提示词是投影**：模板在 `<appRoot>/prompt/*.md`（出厂在 `seed/prompt/`），每次发消息前从
  文件夹重新渲染（在哪个团队、同团队有谁、助理是谁、全员多少人、有哪些技能），不是启动时算好存起来。
  改文件或改措辞，下一条消息就变 —— 改文案不用编译。
- **能力是热的**：工具从注册表实拍，不分「管理层工具/成员工具」，现在是 8 个。
- **技能是文档**：要教 agent 一套做法就写 `SKILL.md`，不要写代码。
- **记忆在磁盘**：个人 `memory.md`、团队 `teams/<slug>/memory.md`。

## 快速开始

需要 Node ≥ 22.19。

```bash
npm install
npm start                 # http://127.0.0.1:7788
```

首次启动会在两个根（默认 `.solo-app/` 与 `~/.solo/`）里播种一个叫「知言」的助理（带《建立团队》《招人》两份个人技能），
外加全员层技能《工作规矩》《记忆整理》《写技能》《找现成技能》。然后你就可以跟他说话了。

**模型**：没有兜底模型 —— 没配就是没配，界面写「还没有配置模型」。在
`<appRoot>/settings.json` 里配，或走环境变量（`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`）。
见 [docs/DEPLOY](docs/DEPLOY.md) §3。

## 一次怎么用

1. 打开界面，在「全员」频道里跟助理说话。
2. 说「帮我做个贪吃蛇」——他有《建立团队》技能，会建一个团队、写 `teams/<slug>/README.md`。
3. 说「招个人写前端」——他有《招人》技能，会建 `members/<名字>/identity.md`，人会立刻出现在界面上。
4. 团队频道里每条新消息先到助理，它在后台把相关的那条交给相关的人（频道里不显示「转交」）；
   组群（临时拉几个人）里每个人自己判断。成员拍不了板（花钱、超范围、改别人）就直接 @我，没有中间层。

## 目录

```
src/core/     核心（57 个文件，约 1.07 万行）
  fsx.ts      工作区内的相对路径入口（与 runtime/io.ts 是唯二碰 node:fs 的地方）
  naming.ts   名字 → 目录名的唯一规则（agent / 团队 / 技能共用）
  md/         markdown 流水线：doc（frontmatter）/ text（插槽）/ prompt（模板拼段）/ oneline
  runtime/    防腐层：唯一 import pi-durable / pi-ai 的地方 + 模型装配
  agent/      一个人：身份 / 提示词装配 / 记忆 / 技能 / 名册（含两层唤醒记录）
  team/       一个团队：README.md / memory.md
  channel/    说话：频道规则 / 写一条（含投递） / 唤醒 / 收尾 / 附件 / 8 个工具
  app/        用例：读（含人 + 投影）/ 说话 / 上传（含附件）/ 诊断（不 import node:http）
  view/       契约层：只有 dto.ts，零 import
  interface/  唯一 import node:http 的地方：路由 / 原语与静态资源 / SSE
  shell/      装配与启动：assemble / main / serve / seed
ui/app/       网页界面源码（React + TS + Vite，构建到 ui/web/，改完必须 npm run ui:build）
seed/         出厂内容：规矩 / 提示词模板 / 技能 / 助理身份 / pool（默认不装的技能）
scripts/      边界检查 + 真实模型冒烟 / 多 agent 场景 + 提示词黄金渲染
test/         57 文件 / 589 例
```

## 命令

| 命令 | 作用 |
| --- | --- |
| `npm start` | 起服务（`--port` `--host` `--app-root` `--user-root` `--no-seed`） |
| `npm run check` | 类型检查 + 边界检查（唯 runtime 层能碰底层库、路由必须有前端消费者） |
| `npm test` | 单测，57 文件 589 例，<3s |
| `npm run prompt:check` | 提示词黄金渲染：确定性、插槽全填、每段 ≤12 行、模板里零工具名 |
| `npm run live` | **真实模型**端到端 16 项（会花 token，改行为后跑） |
| `npm run live:scenarios` | **真实模型**多 agent 场景 6 个 × 3 轮（会花 token；`--list` 看场景） |
| `npm run ui:build` | 构建界面到 `ui/web/`（改完 `ui/app/` 必跑） |

## 文档

| 文档 | 内容 |
| --- | --- |
| [AGENTS.md](AGENTS.md) | **AI agent 在本仓库工作前先读这个** |
| [docs/CORE](docs/CORE.md) | 概念地基：组织为什么是文件夹、提示词怎么投影、团队记忆怎么写 |
| [docs/CODE](docs/CODE.md) | 代码地图：「我想改 X → 动这里」 |
| [docs/design/SEED-CONTRACT](docs/design/SEED-CONTRACT.md) | 出厂内容契约：四个家、插槽表、一条事实一个家 |
| [docs/WEB-API](docs/WEB-API.md) | 网页 API 的完整契约 |
| [docs/DECISIONS](docs/DECISIONS.md) | 90 条架构决策（每条写了替代方案与理由） |
| [docs/DEPLOY](docs/DEPLOY.md) | 部署、局域网、Docker、排障 |

## 已知不做

没有鉴权、没有成本核算、没有 IM 出站。这些第一代都有，V2 全部删掉了 —— 见
[docs/DECISIONS](docs/DECISIONS.md) 里各条「替代方案」。
