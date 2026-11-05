# V3 seed 契约

> V3 的第一条纪律：**一条事实只能有一个家。**
> 这句话被写进两个地方，agent 就会收到两个版本；措辞再有一点点差别，它就会挑对自己有利的那个。

## 0. 一句话

`seed/` 是出厂内容，第一次启动播种进两个根（应用私有的进 `appRoot`，组织的进 `userRoot`），
之后以磁盘为准。
代码只负责**排版**和**填插槽**，不负责讲道理。

## 1. 五个家，各管一段

| 家 | 每轮进上下文 | 写什么 | 上限 | 例子 |
| --- | --- | --- | --- | --- |
| `<userRoot>/rules.md` | 是 | **不说就会立刻出错**的硬规矩 | 15 条，一行一条，不带解释 | 「只回叫你的那个频道」「像成员说话：一两句，先给结论」 |
| `<appRoot>/prompt/*.md` | 是 | 怎么组织信息、怎么用工具（带插槽） | 一段 ≤ 12 行 | 「助理：{{assistant}}」「同团队的人：{{peers}}」 |
| `<userRoot>/skills/<n>/SKILL.md` | 否，查了才读 | 分场景的长做法 | ≤ 4 KB（自律 3 KB），四段 | 拍板链、怎么汇报、怎么建团队 |
| `<userRoot>/members/<slug>/identity.md` | 是（正文） | 这个人的职责与边界 | ≤ 20 行 | 「你负责 X；不做 Y」 |
| `<appRoot>/text/*.md` | 是（工具描述每轮随工具发） | 工具的描述、参数说明、拒绝与回话、投递头、附件说明 | 无行数上限，一句一条 | `say.param.text`、`attachments.image.gone` |

**判据**：这句话不说，他下一句就会做错 → `rules`。要分三步做、只在某种场合才用 → `skill`。
同一层意思出现在两个家里，就是缺陷，必须删掉一个。三条重复的自动检查在
`test/core/seed-contract.test.ts` 的 `ONE_HOME`。

## 2. V3 seed 目标结构

```
seed/
  rules.md                       # 15 条以内，每轮都看见
  text/                          # 机械文案：`## key` 分节，代码里只留键名
    tools.md                     # 8 个工具的描述 / 参数 / 拒绝与回话（装配时读，改完重启）
    channel.md                   # 投递头 / 附件说明 / 未答留痕 / 提示词兜底句
  prompt/                        # 9 段进系统提示词 + 10 段投递时用
    00-who.md                    # 你叫 {{self.name}}（{{self.title}}）
    05-body.md                   # {{self.body}}（空则整段消失）
    10-rules.md                  # {{rules}}
    20-position.md               # 助理 / 团队 / 同团队的人（带 title）/ 群与私聊
    30-team.md                   # 团队简报 + 团队记忆目录（成员名单在 20-position）
    40-tools.md                  # 从注册表实拍，插槽 {{tools}}
    50-memory.md                 # 记忆目录
    60-skills.md                 # 技能目录
    70-directory.md              # 你的目录（两个根 + `file` 怎么分流 + `run` 在哪跑）
    80-reply.md                  # 每轮贴在投递正文末尾的「怎么回话」
    81-alone.md                  # 只有你被叫醒时的那一句（投递条件片段）
    82-shared.md                 # 还有别人在场时的那一句
    83-colleagues.md             # 同频道有同事时的那一句
    84-dm.md                     # 私聊尾注
    85-multi.md                  # 多人被叫醒时的提醒
    86-digest.md                 # 未读摘要尾注
    87-merged.md                 # 合并唤醒尾注
    88-task.md                   # 插话时提醒「手上的活属于哪个频道」
    90-interrupted.md            # 插话时的额外一句
  assistant/                     # 助理（Solo）：播种进 appRoot/assistant/<slug>/
    identity.md                  # 助理身份（从代码挪出来）
    skills/建立团队/SKILL.md
    skills/招人/SKILL.md
  skills/                        # 全员层：只放「全员都该这么干」的
    工作规矩/SKILL.md             # 和 rules.md 分工：rules 短硬，skill 长细
    记忆整理/SKILL.md
    写技能/SKILL.md
    找现成技能/SKILL.md
    静默复现/SKILL.md             # 报障先在后台复现，复现不出来就不说话
  plugins/                       # 出厂插件：补一次、删了不回来（账本记在 .seed-manifest.json）
    模型管理/                    # 设置里的「模型」一节：改 <appRoot>/settings.json（DEPLOY §3）
    文件树/                      # 右栏「文件」页签：当前频道那个工作区的目录树 + 预览
```

项目专用的手艺不放进 `seed/`：`seed/skills/` 是全员层，会出现在每个人的提示词目录里。
需要时用技能「找现成技能」现场装进 `~/.solo/skills/`，或者手工拷一份。

## 3. 插槽表

| 插槽 | 值 | 来源 |
| --- | --- | --- |
| `{{self.name}}` `{{self.title}}` `{{self.slug}}` | 自己 | `identity.md` |
| `{{self.dir}}` | 自己的目录（`assistant/<slug>/` 或 `members/<slug>/`） | `Layout` 的两个根 |
| `{{root.user}}` `{{root.app}}` | 两个根的**绝对路径**（组织 / 程序自带） | `Layout.userRoot` / `Layout.appRoot` |
| `{{assistant}}` | 助理的显示名（自己就是助理时是「你自己」） | `layout.assistantRoot` 下的身份目录（`assistantsOf`） |
| `{{team}}` `{{peers}}` | 团队 slug / 同团队的人 | `identity.md` + 名册 |
| `{{chats.groups}}` `{{chats.dm}}` | 你在哪些群 / 和我的私聊开没开（`已开`） | 频道文档 |
| `{{skills}}` `{{memory}}` `{{tools}}` | 目录清单（只有名字和一句话） | 磁盘 / 注册表 |
| `{{rules}}` | `rules.md` 正文 | 文件 |
| `{{self.body}}` | 自己的身份正文（frontmatter 之后那段） | 身份目录里 `identity.md` 的正文 |
| `{{team.brief}}` | 团队简报：目标 / 验收 / 不做 / 进展 | `teams/<slug>/README.md` 的正文 |
| `{{team.status}}` `{{team.dir}}` | 团队状态 / 目录 | `teams/<slug>/README.md` 的 YAML 头与路径 |
| `{{team.memory}}` | 团队记忆目录（小节标题，正文另读） | `teams/<slug>/memory.md` 的 digest |
| `{{reply.alone}}` | 「这一轮只有你被叫醒：必须回，回的就是结果」 | `81-alone.md` / `82-shared.md`（按收件人数选一份） |
| `{{reply.colleagues}}` | 「要问谁就在这个频道 @ 他」 | `83-colleagues.md` |
| `{{others}}` | 同一轮还被叫醒的其他人 | 投递名单（除自己） |
| `{{colleagues}}` | 同频道里除我和收件人之外的成员 | 频道成员表 |
| `{{total}}` | 别的频道未读总数 | 频道文档 |
| `{{rows}}` | 未读频道的行列表 | 频道文档 |
| `{{merged}}` | 这次合并掉的未唤醒条数 | `wake()` 返回值 |
| `{{task}}` | 插话时他手上那件活所在的频道标题 | 名册里上一次的唤醒记录（`wake.task`） |
| `{{tool:say}}` 等 | 工具名（唯一允许出现工具名的写法） | system 段：注册表实拍；delivery 段：`toolSlots()` 按后缀自解释 |

大部分是**单值**：一个名字、一串清单、一个数字（`pending` 是条数）。少数是**复合值**
（`self.body` / `team.brief` / `team.memory` / `reply.*`）：
整段文字从别的文件或投递上下文搬过来。它们不违反下面第 2 条——那段文字本来就住在那个
文件里，模板只负责摆位置，不负责写它。

**「这个事实现在没有」怎么说，也归模板**：写 `{{assistant ?? 还没有助理（要拍板的事直接 @我）}}`。
代码只给事实，没有就给 `undefined`；默认句写在 md 里（硬规矩 6）。

五条硬规矩：

1. **未知插槽不许静默变空**：渲染成 `（未设置）` 并 warn。静默空会让提示词里出现半句话。
2. **插槽只放会变的事实**，不放模板自己编的整段文字。整段文字属于 md 本身（从别的文件
   整段搬来的正文除外，见上）。
3. **一个 md = 一段 = 一个 cache section**，文件名前缀定序。加一段就是加个文件，不改代码。
   同一组文件必须渲染出**逐字节相同**的提示词，否则 prompt cache 每轮都被打穿。
4. **整句插槽只许出现在 delivery 段**（`80-reply.md` / `90-interrupted.md`）：`reply.alone` /
   `reply.colleagues` 是**条件句**（这一轮只有你被叫醒 / 还有 X 在），不是事实值；代码只按条件
   从 `81-alone.md` / `82-shared.md` / `83-colleagues.md` 三份片段里选一份填进去。别的段不许用 `reply.*`。
5. **delivery 段的插槽面比 system 段窄，用错了会静默变「（未设置）」**：
   - `tool:*` 两段都能用，但机制不同 —— system 段从**注册表实拍**（工具改名自动跟），delivery 段
     没有注册表可查，由 `toolSlots(template)` **按后缀自解释**（`{{tool:say}}` → `say`）。代价是
     **名字写错不报错**（写 `{{tool:sayy}}` 就渲染成 `sayy`），靠 seed 侧检查把名字和真工具名对一遍。
   - 非 `tool:*` 的插槽各有各的填充面：`80-reply` 只填 `reply.alone` / `reply.colleagues`；
     `81` / `82` 填 `others`；`83` 填 `colleagues`；`84` / `85` 不填；`86` 填 `total` / `rows`；
     `87` 填 `merged`；`88` 填 `task`；`90-interrupted` 只填 `tool:*`。
     往这些段里加别的插槽，必须同时在填充处给值，否则模型看到的是「（未设置）」——
     `prompt:check` 用样例表查所有段。

6. **「空的时候怎么说」也写在模板里**：`{{assistant ?? 还没有助理（要拍板的事直接 @我）}}`。
   代码只给事实（没有就给 `undefined`），句子归 md。写了默认值的插槽不再报 `unset`——
   作者已经替这个空做过决定。默认文案里不能有花括号，也不会二次展开。
   同理，delivery 片段（`81`–`83`）的正文被删空时用**同一个文件的 `default:` 头**顶上：
   「这一轮只有你被叫醒」少一句，模型就可能不说话，那句话不能只活在代码里。

## 4. 改写规则

- 工具名不写死：要么走 `{{tool:xxx}}`，要么写成自然语言（「发一条过程话」），参数细节交给工具自己的 description。例外是 `file` 的根分流与 `run` 没有组织含义（ADR-040）：这两句必须在 `70-directory.md` 里，光靠 description 挡住过真实的串根事故。
- 人名不写死：一律 `{{self.name}}`，或直接写「你」。
- 每个技能 ≤ 4 KB（`工作规矩` 是唯一被反复读的，用满上限；其余技能自律在 3 KB 以内），
  正文四段：**什么时候用 / 怎么做 / 怎么算做对了 / 踩过的坑**。缺第三段等于没写。
- `rules.md` 每行一条，不写解释；解释放技能里，用一句「见技能 X」指过去。
- 同一个意思只写一次：`rules.md` 讲硬规矩，技能讲为什么与分场景，投递片段只讲当前这一轮的条件。
- 技能目录里那一行 `description` 是别人决定「读不读」的唯一依据，必须写清「什么时候用」。

## 5. 验收

- `npm run prompt:check`：seed/prompt 全渲染一遍，未知插槽 0 个，两次渲染逐字节相同；
  同一支脚本再查 `seed/text/`：代码引用的键都存在、每条文案的插槽都填得上、两遍渲染一致。
- `test/core/no-hardcoded-text.test.ts`：点名的模块里不许出现中文字符串字面量（注释与日志除外）。
- `rules.md` 里不出现任何工具名，≤ 15 条。
- `npm run test` 的 `test/core/seed-contract.test.ts`：一条事实一个家、模板齐全、段 ≤ 12 行、技能 ≤ 4 KB。
- seed 总体积 < 500 KB。
