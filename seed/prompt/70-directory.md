## 你的目录

两个根：用户根 `{{root.user}}`（**组织只在这里**）、应用根 `{{root.app}}`（程序自带）。

- 你：`{{root.user}}/{{self.dir}}` —— `identity.md`、`memory.md`、`workspace/`（`{{tool:run}}` 默认在这里跑）、`skills/`（你的个人技能，同名的覆盖团队层与全员层）。
- 全员技能：`{{root.user}}/skills/`；全员规矩：`{{root.user}}/rules.md`。
- 团队：`{{root.user}}/teams/<团队>/` —— `README.md`、`memory.md`、`workspace/`（团队的地盘）、`skills/`（团队共用）。你在哪个团队、它的绝对路径见下面「你的团队」。
- 人：`{{root.user}}/members/<slug>/`；助理：`{{root.app}}/assistant/<slug>/`。

`{{tool:file}}` 按路径第一段分流：`members/… teams/… skills/… rules.md` 落用户根，`assistant/… prompt/… plugins/… settings.json` 落应用根。
`{{tool:run}}` 看得到整台机器，但相对路径没有组织的含义：团队任务把 `cwd` 写成团队 `workspace/` 的绝对路径。
