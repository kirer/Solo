# AI Company — 一人公司

一个老板 + 一个 AI 组织。**组织不是代码里的角色枚举，是磁盘上的一堆文件夹**：
每个人的身份、记忆、技能都是文本文件，随时可改、改了立刻就生效。

```
老板 ── 直接对话 ── 助理 ── 他招的人 ── 项目负责人 ── 项目成员
                      （谁都可以跟谁说话，层级只写在文件里）
```

## 它到底在解决什么

让一堆 agent 像一个公司一样运转，而不需要为每一个岗位写一份代码：

- **身份是文件**：`workspace/agents/<slug>/identity.md`。加一个人 = 加一个目录，不用改代码、不用重启。
- **提示词是投影**：每次发消息前从文件夹重新渲染（上级是谁、同项目有谁、公司多少人、有哪些技能），
  不是启动时算好存起来。改文件，下一条消息就变。
- **能力是热的**：工具从注册表实拍，不分「管理层工具/员工工具」。
- **技能是文档**：要教 agent 一套做法就写 `SKILL.md`，不要写代码。
- **记忆在磁盘**：个人 `memory.md`、项目 `memory.md`，项目结论由负责人整理进去。

## 快速开始

需要 Node ≥ 22.19。

```bash
npm install
npm start                 # http://127.0.0.1:7788
```

首次启动会在 `workspace/` 里播种一个叫「助理」的人（带《立项》《招人》两份技能），
外加公司层技能《写技能》《找现成技能》。然后你就可以跟他说话了。

**模型**：默认用本地网关 `http://127.0.0.1:3425/v1` 的 `auto/deepseek-v4.1-flash`。
换模型见 [docs/DEPLOY](docs/DEPLOY.md) §3。

## 一次怎么用

1. 打开界面，在「公司」频道里跟助理说话。
2. 说「帮我做个贪吃蛇」——他有《立项》技能，会建一个项目、写 `projects/<slug>/README.md`。
3. 说「招个人写前端」——他有《招人》技能，会建 `agents/<名字>/identity.md`，人会立刻出现在界面上。
4. 项目频道里负责人在，员工有事先找他；他决定不了再往上问。

## 目录

```
src/core/     核心（25 个文件，约 5.8K 行）
  runtime/    防腐层：唯一 import pi-durable / pi-ai 的地方 + 模型装配
  agent/      一个人：身份 / 提示词 / 记忆 / 技能 / 名册
  project/    一个项目：README.md / memory.md / 自动沉淀
  channel/    说话：纯规则 / 投递 / 写一条 / 20 个工具
  shell/      外壳：装配 / HTTP+SSE / 视图 / 启动
ui/web/       网页界面（原生 ES module，**无构建步骤**，改完刷新就生效）
seed/         播种技能
scripts/      边界检查 + 真实模型自测
test/core/    14 文件 / 137 例
```

## 命令

| 命令 | 作用 |
| --- | --- |
| `npm start` | 起服务（`--port` `--host` `--workspace` `--no-seed`） |
| `npm run check` | 类型检查 + 边界检查（唯 runtime 层能碰底层库、路由必须有前端消费者） |
| `npm test` | 单测，14 文件 137 例，<1s |
| `npm run live` | **真实模型**端到端 12 项（会花 token，改行为后跑） |

## 文档

| 文档 | 内容 |
| --- | --- |
| [AGENTS.md](AGENTS.md) | **AI agent 在本仓库工作前先读这个** |
| [docs/CORE](docs/CORE.md) | 概念地基：组织为什么是文件夹、提示词怎么投影、记忆怎么沉淀 |
| [docs/CODE](docs/CODE.md) | 代码地图：「我想改 X → 动这里」 |
| [docs/WEB-API](docs/WEB-API.md) | 8 条网页 API 的完整契约 |
| [docs/DECISIONS](docs/DECISIONS.md) | 23 条架构决策（每条写了替代方案与理由） |
| [docs/DEPLOY](docs/DEPLOY.md) | 部署、局域网、Docker、排障 |

## 已知不做

没有鉴权、没有成本核算、没有待办拍板界面、没有工具调用 trace、不能发图片、
没有看门狗与崩溃自愈、没有 IM 出站。这些第一代都有，V2 全部删掉了 —— 见
[docs/DECISIONS](docs/DECISIONS.md) 里各条「替代方案」。
