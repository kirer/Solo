---
skip-empty: team.brief
---
## 你的团队：{{team}}

状态：{{team.status ?? 还没有状态}}
目录：`{{root.user}}/{{team.dir}}` · 工作区：`{{root.user}}/{{team.dir}}workspace/` · 团队技能：`{{root.user}}/{{team.dir}}skills/`

{{team.brief}}

团队记忆（只有目录，正文自己读）：
{{team.memory ?? （这个团队还没有记忆。踩到的坑自己记下来。）}}
