# Tasks

本次只补规格，实现早已完成。任务清单逐条核对「规格里描述的每个行为，代码里是否真有对应实现与测试」。

## 1. 项目生命周期

- [x] 1.1 确认终止会中断项目负责人与全部员工在跑的工作：`terminateProject` 对每个会话调 `abort({ background: true })`，验证 `test/e2e/terminate.test.ts`「正在跑的活被中断」
- [x] 1.2 确认终止不删文件、员工只归档：验证「员工全部归档」与磁盘文件仍在
- [x] 1.3 确认终止记录可追溯：`ProjectEntry.terminated` 带 at/by/reason，验证「状态变终止并记下原因」
- [x] 1.4 确认终止会关闭该项目待办：`TerminationProject` 内把未答复的 pending 标为已关闭，验证「该项目挂着的待办自动关闭」
- [x] 1.5 确认重复终止被拒：验证「重复终止返回明确提示而不是报错」
- [x] 1.6 确认未终止的项目不能删除：`deleteProject` 校验 `status === "terminated"`，验证「未终止的项目不能删」
- [x] 1.7 确认删除会清除索引、名册与产物：验证「终止后删除：项目、员工、产物全部清掉」
- [x] 1.8 确认删除后不再出现在组织视图：验证「删除后组织视图里不再出现该项目」
- [x] 1.9 确认删除会留痕：验证「删除会留下审计记录」
- [x] 1.10 确认删除前校验路径：验证「路径不在工作空间根下时拒绝删文件」
- [x] 1.11 确认删除结果如实说明会话历史保留：`deleteProject` 的返回 message 里写明

## 2. 消息排队与插队

- [x] 2.1 确认忙碌时消息显示为已排队：`/api/feed` 返回 `queued`，验证 `test/e2e/web.test.ts`「忙碌时发的消息出现在 queued 里」
- [x] 2.2 确认默认排队语义是 steer：`postMessage` 默认 `whenBusy: "steer"`，同一用例断言 mode
- [x] 2.3 确认插队会打断当前工作：`/api/interrupt` 先 abort 再 submit，验证「立即处理会打断当前工作并让消息生效」
- [x] 2.4 确认插队只保留被点击的那一条：规格已写明，代码行为一致
- [x] 2.5 确认界面渲染排队消息并提供入口：`ui/app.js` 渲染 `.queued` 与 `[data-interrupt]`，浏览器实测通过

## 3. 项目卡翻转

- [x] 3.1 确认点击翻转且是三维动画：`.proj-inner` 加 `rotateX(180deg)`，浏览器实测
- [x] 3.2 确认背面是「负责人 + 员工」层级：浏览器实测背面文本包含负责人与全部员工
- [x] 3.3 确认翻转时高度平滑过渡：`sizeProjects` 量两面高度，`toggleFlip` 设目标高度，实测 107px → 266px
- [x] 3.4 确认未翻转的卡不被撑高：容器高度由 JS 显式控制，脱离内容流
- [x] 3.5 确认已终止项目不提供翻转且显示终止信息：浏览器实测 `.proj.is-terminated` 渲染

## Workflow follow-up

- 跑 `openspec validate add-project-lifecycle --strict` 确认规格合法。
- 归档本变更（`openspec archive add-project-lifecycle --yes`），把三个 delta 合并进正式规格。
- 归档后确认 `openspec list --specs` 显示 `project-lifecycle` 为新能力，且 `delegation` / `tui-workspace` 的需求数增加了。
