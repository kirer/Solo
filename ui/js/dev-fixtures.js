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
			text: "把坦克大战的渲染层拆出来，先跑一遍冒烟测试。",
			at: t - 8 * 60_000,
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
	];

	return {
		conversationId,
		title: "林越",
		role: "开发 · 坦克大战 项目 · 向 CTO 汇报",
		kind: "staff",
		items,
		streaming: "现在补 HUD 的响应式：768px 以下把雷达挪到右上角，血条压成两行，",
		thinking: "看看 768px 下 HUD 会不会压住画布，顺便确认触摸屏的按钮尺寸…",
		running: [{ name: "bash", args: '{"command":"npm test -- --run"}' }],
		busy: true,
		queued: [
			{ id: 901, text: "顺便把移动端的虚拟摇杆也看一下。", mode: "steer" },
			{ id: 902, text: "测试通过后把截图发我。", mode: "followUp" },
		],
		tokens: 12_480,
		awaitingOwner: false,
	};
}

/** 在 ?dev 下把假数据灌进界面。 */
export function useMock() {
	const api = window.__company;
	if (api === undefined) return false;
	const org = mockOrg();
	api.setOrg(org);
	api.select(20, { openSheet: false, focus: false });
	api.setFeed(mockFeed(20));
	return true;
}
