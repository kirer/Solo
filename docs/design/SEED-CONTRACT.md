# V3 seed 契约

> V3 的第一条纪律：**一条事实只能有一个家。**
> 这句话被写进两个地方，agent 就会收到两个版本；措辞再有一点点差别，它就会挑对自己有利的那个。

## 0. 一句话

`seed/` 是出厂内容，第一次启动播种进 `workspace/`，之后以 workspace 为准。
代码只负责**排版**和**填插槽**，不负责讲道理。

## 1. 四个家，各管一段

| 家 | 每轮进上下文 | 写什么 | 上限 | 例子 |
| --- | --- | --- | --- | --- |
| `workspace/rules.md` | 是 | **不说就会立刻出错**的硬规矩 | 15 条，一行一条，不带解释 | 「只回叫你的那个频道」「群里一条最多 3 句」 |
| `workspace/prompt/*.md` | 是 | 怎么组织信息、怎么用工具（带插槽） | 一段 ≤ 12 行 | 「你的上级：{{manager}}」 |
| `workspace/skills/<n>/SKILL.md` | 否，查了才读 | 分场景的长做法 | ≤ 4 KB（自律 3 KB），四段 | 拍板链、怎么汇报、怎么立项 |
| `workspace/agents/<slug>/identity.md` | 是（正文） | 这个人的职责与边界 | ≤ 20 行 | 「你负责 X；不做 Y」 |

**判据**：这句话不说，他下一句就会做错 → `rules`。要分三步做、只在某种场合才用 → `skill`。
同一层意思出现在两个家里，就是缺陷，必须删掉一个。

## 2. 现状问题（改之前先认账）

1. **重复**：`rules.md` 与 `skills/工作规矩` 重复 5 条（说话长度、不要轮询、英文内心独白、汇报、群聊句数），
   而且措辞不一致——rules 说「一两句」，技能说「最多 3 句」。agent 收到两个版本的同一规矩。
2. **工具名硬编码 40 处**：`say`、`mention`、`hire`、`run`、`skills(action=write, scope=company)`、
   `read_history(scope=memory)`……工具一改名，seed 就在教错的东西。
3. **人名写死**：「知言」出现在 4 处；助理换名，seed 全错。
4. **体积**：`seed/skills/前端视觉设计` 3.6 MB 进公司层。它属于某个项目，不属于全公司；
   公司层技能会出现在每个人的提示词目录里，等于全员默认背着一个前端设计技能。
5. **身份不在文件里**：助理的身份在 `shell/seed.ts` 的代码里，和组织是文件矛盾。
6. **上报链没有完整表达**：成员 → 团队管理员 → 助理 → 我，这条链散在「拍板链」和 rules 里，
   没有一处能完整读出来。

## 3. V3 seed 目标结构

```
seed/
  rules.md                       # 15 条以内，每轮都看见
  prompt/                        # 8 段 + 2 段（每轮贴给模型的回话规矩）
    00-who.md                    # 你叫 {{self.name}}（{{self.title}}）
    10-rules.md                  # {{rules}}
    20-position.md               # 上级 / 下属 / 整条链 / 同团队的人
    30-team.md                   # 团队简报 + 团队记忆目录
    40-tools.md                  # 从注册表实拍，插槽 {{tools}}
    50-memory.md                 # 记忆目录
    60-skills.md                 # 技能目录
    70-directory.md              # 你的目录（identity/memory/skills 在哪）
    80-reply.md                  # 每轮贴在投递正文末尾的「怎么回话」
    90-interrupted.md            # 插话时的额外一句
    95-settle.md                 # 团队记忆沉淀那一轮的正文（插槽 {{team}} {{pending}} {{candidates}}）
  agents/
    assistant/identity.md        # 助理身份（从代码挪出来）
    assistant/skills/立项/SKILL.md
    assistant/skills/招人/SKILL.md
  skills/                        # 公司层：只放「全公司都该这么干」的
    工作规矩/SKILL.md             # 和 rules.md 分工：rules 短硬，skill 长细
    记忆整理/SKILL.md
    写技能/SKILL.md
    找现成技能/SKILL.md
```

`seed/pool/前端视觉设计/` 不进公司层（`seed/skills/` 才是公司层）：需要它的项目自己拷进
`workspace/skills/`，或用「找现成技能」现场装。

## 4. 插槽表

| 插槽 | 值 | 来源 |
| --- | --- | --- |
| `{{self.name}}` `{{self.title}}` `{{self.slug}}` | 自己 | `identity.md` |
| `{{manager}}` | 上级的显示名 | `manager` 字段 + 名册 |
| `{{reports}}` | 向你汇报的人 | 名册反查 |
| `{{chain}}` | 往上的整条汇报线 | `chainUp` |
| `{{team}}` `{{peers}}` | 团队 slug / 同团队的人 | `identity.md` + 名册 |
| `{{chats}}` | 你在哪些群、私聊开没开 | 频道文档 |
| `{{skills}}` `{{memory}}` `{{tools}}` | 目录清单（只有名字和一句话） | 磁盘 / 注册表 |
| `{{rules}}` | `rules.md` 正文 | 文件 |
| `{{count}}` | 全公司 agent 数 | 名册 |
| `{{self.body}}` | 自己的身份正文（frontmatter 之后那段） | `agents/<slug>/identity.md` 的正文 |
| `{{team.brief}}` | 团队简报：目标 / 验收 / 不做 / 进展 | `teams/<slug>/README.md` 的正文 |
| `{{team.members}}` | 团队成员的 slug | `teams/<slug>/` 下的 agent |
| `{{team.memory}}` | 团队记忆目录（小节标题，正文另读） | `teams/<slug>/memory.md` 的 digest |
| `{{reply.alone}}` | 「这一轮只有你被叫醒：必须回，回的就是结果」 | 投递时拼（这一轮只有他一个收件人） |
| `{{reply.colleagues}}` | 「成员的事就在这个频道说，要问谁就 @ 他」 | 投递时拼（同频道还有其他成员） |
| `{{pending}}` | 这一轮要整理进团队记忆的消息条数 | settle 候选 |
| `{{candidates}}` | 候选消息列表，一行一条：`#seq [kind] 谁：正文` | 频道消息（`settleCandidates`） |
| `{{tool:say}}` 等 | 工具名（唯一允许出现工具名的写法） | system 段：注册表实拍；delivery 段：`toolSlots()` 按后缀自解释 |

前 15 个是**单值**：一个名字、一串清单、一个数字（`pending` 是条数）。后 7 个
（`self.body` / `team.brief` / `team.members` / `team.memory` / `reply.*` / `candidates`）是
**复合值**：整段文字从别的文件或投递上下文搬过来。它们不违反下面第 2 条——那段文字本来
就住在那个文件里，模板只负责摆位置，不负责写它。

五条硬规矩：

1. **未知插槽不许静默变空**：渲染成 `（未设置）` 并 warn。静默空会让提示词里出现半句话。
2. **插槽只放会变的事实**，不放模板自己编的整段文字。整段文字属于 md 本身（从别的文件
   整段搬来的正文除外，见上）。
3. **一个 md = 一段 = 一个 cache section**，文件名前缀定序。加一段就是加个文件，不改代码。
   同一组文件必须渲染出**逐字节相同**的提示词，否则 prompt cache 每轮都被打穿。
4. **整句插槽只许出现在 delivery 段**（`80-reply.md` / `90-interrupted.md` / `95-settle.md`）：`reply.alone` /
   `reply.colleagues` 是**条件句**（这一轮只有你被叫醒 / 还有 X 在），不是事实值；写进 md
   就得给 md 发明一套条件语法。别的段不许用 `reply.*`。
5. **delivery 段的插槽面比 system 段窄，用错了会静默变「（未设置）」**：
   - `tool:*` 两段都能用，但机制不同 —— system 段从**注册表实拍**（工具改名自动跟），delivery 段
     没有注册表可查，由 `toolSlots(template)` **按后缀自解释**（`{{tool:say}}` → `say`）。代价是
     **名字写错不报错**（写 `{{tool:sayy}}` 就渲染成 `sayy`），靠 seed 侧检查把名字和真工具名对一遍。
   - 非 `tool:*` 的插槽各有各的填充面：`80-reply` 只填 `reply.alone` / `reply.colleagues`；
     `90-interrupted` 只填 `tool:*`；`95-settle` 只填 `team` / `pending` / `candidates` + `tool:*`。
     往这三段里加别的插槽，必须同时在填充处给值，否则模型看到的是「（未设置）」——
     `prompt:check` 只查 system 段的样例表，查不到这条。

## 5. 改写规则

- 工具名不写死：要么走 `{{tool:xxx}}`，要么写成自然语言（「发一条过程话」），参数细节交给工具自己的 description。
- 人名不写死：一律 `{{self.name}}`，或直接写「你」。
- 每个技能 ≤ 4 KB（`工作规矩` 是唯一被反复读的，用满上限；其余技能自律在 3 KB 以内），
  正文四段：**什么时候用 / 怎么做 / 怎么算做对了 / 踩过的坑**。缺第三段等于没写。
- `rules.md` 每行一条，不写解释；解释放技能里，用一句「见技能 X」指过去。
- 技能目录里那一行 `description` 是别人决定「读不读」的唯一依据，必须写清「什么时候用」。

## 6. 验收

- `npm run prompt:check`：seed/prompt 全渲染一遍，未知插槽 0 个，两次渲染逐字节相同。
- `rules.md` 里不出现任何工具名，≤ 15 条。
- seed 总体积 < 500 KB（不含 `前端视觉设计`）。
- 「一条事实一个家」：`grep` 同一句意思，只能命中一个文件。
