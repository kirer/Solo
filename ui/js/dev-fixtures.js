/**
 * 视觉验收用的假数据（只在 ?dev 下动态加载）。
 *
 * 真实演示库没有「正在跑」「正在沟通」的状态，光看它验收不了光边与连线。
 * 在 URL 后加 ?dev，然后在控制台执行：
 *   __company.useMock()
 * 就能把组织图、连线与角色档案一次性灌满。
 *
 * 历史：右侧对话面板删掉之后（「去掉右侧聊天面板」），这里的 `mockFeed()`
 * 已经没有任何消费者——消息流现在由 `/api/channels/:id` 提供，待办卡片由
 * `ui/js/pending.js` 渲染，所以随面板一起删掉了。`mockProfile()` 保留：
 * 频道里的角色档案（`#ch-dock` / `#profile-layer`）还在用它做视觉验收。
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
	api.setOrg(mockOrg());
	return true;
}
