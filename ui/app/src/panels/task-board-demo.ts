/**
 * 假数据（2.9.20）。接口还没实现，先用它把看板的形状定下来。
 *
 * **接口接上就删这一个文件** —— 它不是一个「演示开关」，是脚手架的木头，留在树里
 * 就会有一天被人当真数据读。
 *
 * 数据故意把五种状态、三种「多久没动」、两种缺字段（`blocked` 没原因、`done` 没凭据）
 * 都排进去：形状要在这几种边上都站得住，才算定下来。
 */

import type { BoardTask } from "./task-board-model.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** 按 `now` 反推时刻，别让「多久没动」随着真实时间漂走。 */
export function demoTasks(now: number): BoardTask[] {
	return [
		{
			id: "t3",
			title: "2.9.15 更新弹窗真机验收",
			owner: "jiheng",
			ownerLabel: "季衡",
			status: "blocked",
			channelId: "team:Solo",
			channelTitle: "Solo",
			originSeq: 2380,
			note: "要开桌面窗口，老板说影响他用电脑；等发版后再说",
			changedAt: now - 3 * 24 * HOUR,
		},
		{
			id: "t5",
			title: "任务实体：`state.tasks` + `task` 工具 + write 一次落盘",
			owner: "luyuan",
			ownerLabel: "路远",
			status: "doing",
			channelId: "team:Solo",
			channelTitle: "Solo",
			originSeq: 2580,
			accept: "`route --goal` 建得出来，`task mine` 看得到",
			changedAt: now - 12 * MINUTE,
		},
		{
			id: "t6",
			title: "任务看板三处：顶上计数、抽屉一条一行、点行跳起源",
			owner: "shenchi",
			ownerLabel: "沈迟",
			status: "doing",
			channelId: "team:Solo",
			channelTitle: "Solo",
			originSeq: 2580,
			accept: "假数据跑得起来，接口接上只换数据源",
			changedAt: now - 40_000,
		},
		{
			id: "t7",
			title: "`task` 工具描述 + `route` 两个新参数写进提示词",
			owner: "yejue",
			ownerLabel: "叶决",
			status: "open",
			channelId: "team:Solo",
			channelTitle: "Solo",
			originSeq: 2580,
			changedAt: now - 2 * HOUR,
		},
		{
			id: "t8",
			title: "任务看板：卡住的没写原因也不许空着",
			owner: "shenchi",
			ownerLabel: "沈迟",
			status: "blocked",
			channelId: "team:Solo",
			channelTitle: "Solo",
			originSeq: 2601,
			// 故意不写 note：界面要显示「没写原因」，而不是留一行空白。
			changedAt: now - 26 * HOUR,
		},
		{
			id: "t2",
			title: "麦克风权限判据与三段日志",
			owner: "shenchi",
			ownerLabel: "沈迟",
			status: "done",
			channelId: "team:Solo",
			channelTitle: "Solo",
			originSeq: 2452,
			note: "全量 145 文件全绿；真机没验",
			changedAt: now - 3 * HOUR,
		},
		{
			id: "t1",
			title: "悬浮球录音起不来时留一行日志",
			owner: "shenchi",
			ownerLabel: "沈迟",
			status: "done",
			channelId: "team:Solo",
			channelTitle: "Solo",
			originSeq: 2453,
			// 故意不写 note：完成项要显示「没写凭据」。
			changedAt: now - 20 * HOUR,
		},
		{
			id: "t4",
			title: "去转圈弧",
			owner: "yejue",
			ownerLabel: "叶决",
			status: "dropped",
			channelId: "team:Solo",
			channelTitle: "Solo",
			originSeq: 2210,
			note: "老板说那个弧是他想要的，不去了",
			changedAt: now - 2 * 24 * HOUR,
		},
	];
}
