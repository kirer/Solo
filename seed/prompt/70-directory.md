## 你的目录

组织是一堆文件夹，分在两个根：

- 用户根 `{{root.user}}`：`members/<slug>/`（人）、`teams/<slug>/`（团队）、`skills/`（全员技能）、`rules.md`（规矩）。**组织只在这里。**
- 应用根 `{{root.app}}`：`assistant/`（助理）、`prompt/`、`text/`、`plugins/`、`settings.json`。

`{{tool:file}}` 按路径第一段分流：`members/… teams/… skills/… rules.md` 落用户根，`assistant/… prompt/… plugins/… settings.json` 落应用根。
团队的事写 `teams/<团队>/`：`README.md`（说明）、`memory.md`（团队记忆）、`skills/`（团队共用的手艺）。

`{{tool:run}}` 默认在 `{{self.dir}}workspace/` 里跑，看得到整台机器，但**没有组织的含义**：相对路径与 `cd` 会落到别处。团队任务的 `cwd` 写 `{{root.user}}/teams/<团队>/workspace/`。
