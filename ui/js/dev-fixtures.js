/**
 * 视觉验收用的假数据（只在 ?dev 下动态加载）。
 *
 * 真实演示库没有「正在跑」「正在沟通」的状态，光看它验收不了光边与连线。
 * 在 URL 后加 ?dev，然后在控制台执行：
 *   __company.useMock()
 * 就能把组织图、连线、对话（思考 / 工具 / Markdown / 排队 / 流式）一次性灌满。
 */

const now = () => Date.now();

function actor(conversationId, label, subtitle, kind, status, options = {}) {
	return {
		conversationId,
		label,
		subtitle,
		kind,
		status,
		tokens: options.tokens ?? 0,
		awaitingYou: options.awaitingYou ?? 0,
		activity: options.activity ?? "",
		...(options.archived ? { archived: true } : {}),
	};
}

export function mockOrg() {
	const t = now();
	return {
		company: { name: "晨光科技", model: "auto/deepseek-v4.1-flash" },
		ceo: actor(1, "CEO", "唯一真人 · 主 Agent 代你调度", "owner", "waiting", {
			tokens: 21_400,
			awaitingYou: 1,
			activity: "等你决定坦克大战要不要加联机",
		}),
		roles: [
			actor(7, "CTO", "技术战略与架构决策", "role", "busy", {
				tokens: 12_800,
				activity: "拆渲染层，等林越回报冒烟测试",
			}),
			actor(8, "CFO", "成本核算与预算控制", "role", "idle", { tokens: 3_120 }),
			actor(9, "CPO", "需求分析与立项", "role", "busy", {
				tokens: 9_640,
				activity: "写客户门户的二期需求",
			}),
			actor(10, "COO", "运营与流程", "role", "idle", { tokens: 1_280 }),
			actor(11, "CMO", "市场与获客", "role", "idle", { tokens: 640 }),
			actor(12, "CHRO", "团队组建与人员配置", "role", "waiting", {
				tokens: 4_460,
				awaitingYou: 0,
				activity: "等 CTO 确认测试岗编制",
			}),
		],
		projects: [
			{
				slug: "tank-battle",
				name: "坦克大战",
				status: "active",
				lead: actor(30, "陆沉", "坦克大战 项目负责人", "project", "busy", {
					tokens: 18_200,
					activity: "派活给林越，等冒险测试结果",
				}),
				staff: [
					actor(20, "林越", "开发", "staff", "busy", {
						tokens: 8_720,
						activity: "拆渲染层，跑冒烟测试",
					}),
					actor(21, "周牧", "开发", "staff", "waiting", {
						tokens: 6_180,
						awaitingYou: 1,
						activity: "等你拍板：联机对战要不要做",
					}),
					actor(22, "何晓", "设计", "staff", "idle", { tokens: 2_340 }),
					actor(23, "沈舟", "测试", "staff", "busy", {
						tokens: 5_020,
						activity: "验收第一关与第二关",
					}),
				],
				tokens: 52_600,
			},
			{
				slug: "customer-portal",
				name: "客户门户",
				status: "active",
				lead: actor(31, "苏晚", "客户门户 项目负责人", "project", "idle", {
					tokens: 7_400,
					activity: "等 CPO 的需求文档",
				}),
				staff: [
					actor(32, "阿舟", "开发", "staff", "idle", { tokens: 2_180 }),
					actor(33, "阿禾", "开发", "staff", "idle", { tokens: 1_640 }),
					actor(34, "阿宁", "测试", "staff", "waiting", {
						tokens: 980,
						activity: "等开发交付登录页",
					}),
				],
				tokens: 14_200,
			},
		],
		// CEO 自己队列里待拍板的条数（与「待老板拍板」分开计数）
		ceoQueue: 2,
		pending: [
			{
				key: "demo-esc-1",
				question: "坦克大战要不要加联机对战？加了要多两周工期，不加只能本地双人。",
				from: "周牧",
				level: "owner",
				askedAt: t - 9 * 60_000,
				forYou: true,
			},
			{
				// 处置待办：options 是后端 DispositionPayload.options 的结构（id/label/recommended）。
				// 没有这个字段时选项卡片也能从 question 的「① ②」里解析出来。
				key: "demo-disp-1",
				question:
					"被打断的工作：坦克大战 / pi.task#t_42\n进度：第 3 步 / 共 5 步，已完成 2 次工具调用\n选项：① 暂搁（推荐）② 永久放弃\n若暂搁：需要恢复条件（默认 30 分钟后提醒下达人）",
				from: "陆沉",
				level: "owner",
				decisionOwner: "owner",
				askedAt: t - 4 * 60_000,
				forYou: true,
				isDisposition: true,
				disposition: {
					type: "disposition",
					options: [
						{ id: "shelve", label: "暂搁", recommended: true },
						{ id: "abandon", label: "永久放弃", recommended: false },
					],
				},
			},
		],
		costs: {
			totalTokens: 128_400,
			totalCostUsd: 1.84,
			byProject: [
				{ slug: "tank-battle", tokens: 52_600 },
				{ slug: "customer-portal", tokens: 14_200 },
			],
		},
		links: [
			{ from: 30, to: 20, kind: "delegate", at: t - 12_000, label: "陆沉 → 林越" },
			{ from: 20, to: 30, kind: "report", at: t - 4_000, label: "林越 → 陆沉" },
			{ from: 1, to: 7, kind: "delegate", at: t - 40_000, label: "CEO → CTO" },
			{ from: 7, to: 30, kind: "delegate", at: t - 28_000, label: "CTO → 陆沉" },
			{ from: 9, to: 31, kind: "delegate", at: t - 3 * 60_000, label: "CPO → 苏晚" },
			{ from: 21, to: 1, kind: "escalate", at: t - 9 * 60_000, label: "周牧 → CEO" },
			{ from: 12, to: 7, kind: "delegate", at: t - 6 * 60_000, label: "CHRO → CTO" },
		],
	};
}

export function mockFeed(conversationId = 20) {
	const t = now();
	const items = [
		{
			id: 1,
			kind: "user",
			// 派活方：老板自己发的是 owner，别的 agent 派来的是对应岗位。
			from: { label: "老板", kind: "owner" },
			text: "把坦克大战的渲染层拆出来，先跑一遍冒烟测试。",
			// 附件回显：真实后端会把附件引用拼进正文，假数据保留结构化附件字段，
			// 让「历史消息里的附件 chip」也能被视觉验收覆盖。
			attachments: [
				{
					id: "fixture-render-spec",
					name: "render-spec.png",
					size: 184_320,
					mime: "image/png",
					url: "<svg xmlns='http://www.w3.org/2000/svg' width='96' height='72'><rect width='96' height='72' fill='%23e8ebf0'/><rect x='12' y='12' width='48' height='8' fill='%239098a4'/><rect x='12' y='28' width='72' height='4' fill='%23c4cad4'/><rect x='12' y='40' width='60' height='4' fill='%23c4cad4'/><rect x='12' y='52' width='40' height='4' fill='%23c4cad4'/></svg>",
				},
				{ id: "fixture-notes", name: "拆分说明.md", size: 4_096, mime: "text/markdown", url: "" },
			],
			at: t - 8 * 60_000,
		},
		{
			id: 11,
			kind: "user",
			from: { conversationId: 30, label: "陆沉", kind: "project" },
			text: "补一条：拆的时候 draw 接口不能变，测试在等这个。",
			at: t - 7 * 60_000,
		},
		{
			id: 2,
			kind: "thinking",
			text: "先看现有目录结构，再决定拆哪一层。render.js 里应该还混着输入处理，一起看。",
			at: t - 7 * 60_000,
		},
		{
			id: 3,
			kind: "tool",
			name: "bash",
			args: '{"command":"ls -la src && wc -l src/*.js"}',
			output: "game-core.js\nrender.js\ninput.js\nlevels.js\nstorage.js\n\n  412 src/render.js\n   88 src/input.js\n  260 src/game-core.js",
			state: "ok",
			collapsible: true,
			at: t - 7 * 60_000,
		},
		{
			id: 4,
			kind: "tool",
			name: "read",
			args: '{"path":"src/render.js"}',
			output: "export function draw(ctx, state) {\n  drawMap(ctx, state.map);\n  drawTanks(ctx, state.tanks);\n  drawHud(ctx, state);\n}",
			state: "ok",
			collapsible: false,
			at: t - 6 * 60_000,
		},
		{
			id: 5,
			kind: "assistant",
			text: `## 现状

渲染层目前和 \`input\` 耦合在同一个文件里，拆起来不复杂。

- \`src/render.js\` 负责 draw
- \`src/input.js\` 负责键盘
- **必须先抽公共的 \`viewport\`**

| 模块 | 行数 | 依赖 |
| --- | ---: | --- |
| render | 412 | viewport |
| input | 88 | — |

> 拆分后先跑 \`npm test\`，再截一张图对比。

\`\`\`js
// src/viewport.js
export function fit(canvas, game) {
  const scale = Math.min(canvas.width / game.width, canvas.height / game.height);
  return { scale, dx: (canvas.width - game.width * scale) / 2, dy: 0 };
}
\`\`\`

详细说明见 [渲染层拆分记录](https://example.com/render)。`,
			at: t - 5 * 60_000,
		},
		{
			id: 6,
			kind: "tool",
			name: "edit",
			args: '{"path":"src/render.js","old":"export function draw","new":"export function draw"}',
			output: "已修改 src/render.js（+18 −6）",
			state: "ok",
			collapsible: false,
			at: t - 4 * 60_000,
		},
		{
			id: 7,
			kind: "tool",
			name: "write",
			args: '{"path":"src/viewport.js"}',
			output: "Error: EACCES: permission denied, open 'src/viewport.js'",
			state: "error",
			collapsible: false,
			at: t - 3 * 60_000,
		},
		{
			id: 8,
			kind: "note",
			from: { conversationId: 30, label: "陆沉", kind: "project" },
			to: { conversationId: 20, label: "林越", kind: "staff" },
			text: "派活 · 陆沉 → 林越：拆分渲染层，保持 draw 接口不变",
			at: t - 3 * 60_000,
		},
		{
			id: 9,
			kind: "assistant",
			text: "渲染层已经拆出来了，冒烟测试 **32 / 32** 通过。还剩一个 `viewport` 的写入权限问题，我换个路径再试。",
			at: t - 2 * 60_000,
		},
		{
			id: 10,
			kind: "alert",
			text: "一次工具调用失败：没有写入权限。已自动重试。",
			at: t - 2 * 60_000,
		},
		// 插话（mode=steer）复现数据：受理回执 → 插入的 user 条目 → 它的 assistant 回复。
		// 回归点：这三条必须都出现在聊天里，且回执只有一行极小提示、不重复正文。
		{
			id: 11.4,
			kind: "note",
			// app.receipt 无 from：界面渲染成一行「已收到 · 正在切换」
			text: "已收到 · 正在切换",
			at: 0,
		},
		{
			id: 11.5,
			kind: "user",
			from: { label: "老板", kind: "owner" },
			text: "插入：先停一下，用一句话说现在项目数。",
			at: t - 90_000,
		},
		{
			id: 11.6,
			kind: "assistant",
			text: "已暂停手上的拆分。当前 1 个项目（坦克大战），2 个在跑。",
			at: t - 80_000,
		},
		{
			id: 12,
			kind: "user",
			from: { label: "老板", kind: "owner" },
			text: "接下来先做哪一块？",
			at: t - 60_000,
		},
		{
			// 选项卡片：最后一条 assistant 的编号列表 → DSH 风格单选卡片。
			// 普通回复里的编号清单不会触发（解析器要求「确实在问你选一个」）。
			id: 13,
			kind: "assistant",
			text: "渲染层拆完、冒烟测试通过，下一步有三条路。你选一个，我马上开工：\n\n1. 先补 HUD 响应式\n2. 先接移动端虚拟摇杆\n3. 先清掉 viewport 的权限问题",
			at: t - 40_000,
		},
	];

	return {
		conversationId,
		title: "林越",
		role: "开发 · 坦克大战 项目 · 向 CTO 汇报",
		kind: "staff",
		// 会话主人：assistant / thinking / tool 条目的发言人都是它
		actor: { conversationId, label: "林越", kind: "staff" },
		items,
		streaming: "现在补 HUD 的响应式：768px 以下把雷达挪到右上角，血条压成两行，",
		thinking: "看看 768px 下 HUD 会不会压住画布，顺便确认触摸屏的按钮尺寸…",
		running: [{ name: "bash", args: '{"command":"npm test -- --run"}' }],
		busy: true,
		queued: [
			// ADR-026 决策 7.3「老板通道永不排队」：排队的只可能是 agent 派来的任务，
			// 老板自己的消息到达即受理（默认 now 档）。假数据必须与这条规则一致，
			// 否则 ?dev 下会渲染出一个真实后端永远不会出现的「老板排队」状态。
			{ id: 901, text: "顺便把移动端的虚拟摇杆也看一下。", mode: "steer", origin: "agent", from: "CTO" },
			{ id: 902, text: "测试通过后把截图发我。", mode: "followUp", origin: "agent", from: "CTO" },
		],
		tokens: 12_480,
		awaitingOwner: false,
		// ADR-026 决策 2（落地第 3 步）：界面现在读结构化字段。
		// 假数据必须与后端同一形状，否则 ?dev 下的界面会走兼容分支，测不到真路径。
		awaitingDecision: { pending: false, decider: "none", label: "", count: 0 },
		// 待办随 feed 下发（界面在对话流里渲染成 .pend）。
		// 假数据必须与后端同一形状，否则 ?dev 下测不到真实渲染路径。
		pending: [
			{
				key: "demo-pend-1",
				question: "坦克大战要不要加联机对战？加了要多两周工期，不加只能本地双人。",
				from: "周牧",
				decisionOwner: "owner",
				askedAt: Date.now() - 9 * 60_000,
				disposition: false,
				options: [],
			},
			{
				key: "demo-pend-2",
				question: [
					"被打断的工作：坦克大战 / pi.task#t_42",
					"进度：第 3 步 / 共 5 步，已完成 2 次工具调用，已耗 1200 token",
					"选项：① 暂搁（推荐）② 永久放弃",
					"若暂搁：需要恢复条件（默认 30 分钟后提醒下达人）",
				].join("\n"),
				from: "陆沉",
				decisionOwner: "owner",
				askedAt: Date.now() - 4 * 60_000,
				disposition: true,
				options: [
					{ id: "shelve", label: "暂搁", recommended: true },
					{ id: "abandon", label: "永久放弃", recommended: false },
				],
			},
		],
	};
}

/** 假档案：让内嵌 dock 的「已加载」状态也能被视觉验收。 */
export function mockProfile(conversationId = 20) {
	const staff = conversationId === 20;
	return {
		conversationId,
		label: staff ? "林越" : "陆沉",
		subtitle: staff ? "开发 · 坦克大战 项目" : "坦克大战 项目负责人",
		kind: staff ? "staff" : "project",
		role: staff ? "开发" : "项目负责人",
		project: "坦克大战",
		parent: staff ? "陆沉" : "CTO",
		model: "auto/deepseek-v4.1-flash",
		charter:
			"你是坦克大战项目的开发工程师。负责渲染层、输入层与小游戏逻辑；改动前先读代码，改完必须跑一遍冒烟测试，接口不变优先。",
		guide:
			"先复现再修；不确定就报给项目负责人。回答里不要用「应该没问题」这种话，给出可验证的结果。",
		tools: [
			{ name: "read", description: "读文件" },
			{ name: "edit", description: "改文件" },
			{ name: "bash", description: "跑命令与测试" },
			{ name: "report", description: "向项目负责人回报" },
		],
	};
}

/** 假档案注入：只拦 /api/profile/*，其余请求原样放行。dev-only。 */
function installProfileMock() {
	if (window.__company.__profileMocked === true) return;
	window.__company.__profileMocked = true;
	const original = window.fetch.bind(window);
	window.fetch = async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
		const match = /\/api\/profile\/(\d+)/.exec(url);
		if (match !== null) {
			try {
				return new Response(JSON.stringify(mockProfile(Number(match[1]))), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			} catch {
				/* 下面回退到真实请求 */
			}
		}
		return original(input, init);
	};
}

/** 在 ?dev 下把假数据灌进界面。 */
export function useMock() {
	const api = window.__company;
	if (api === undefined) return false;
	installProfileMock();
	const org = mockOrg();
	api.setOrg(org);
	api.select(20, { openSheet: false, focus: false });
	api.setFeed(mockFeed(20));
	return true;
}
