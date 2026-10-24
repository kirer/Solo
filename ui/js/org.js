/**
 * 组织图：CEO → L1 高管层 → L2 项目组。
 *
 * 三件事：把组织快照画成三层卡片、点项目卡翻面看成团队、把沟通交给 edges.js。
 *
 * 增量原则（契约第 7 条）：结构签名（CEO / 角色 / 项目 / 员工 id 与静态文案）
 * 不变时只打补丁 —— data-status、活动文本、token、待办数、团队头像点，
 * 绝不整块 innerHTML 重绘。所以点员工、SSE 推送都不会让主视图跳一下。
 */
import {
	escapeAttr,
	escapeHtml,
	formatTokens,
	relTime,
	clockTime,
	statusLabel,
	statusOf,
} from "./format.js";
import { icon } from "./icons.js";
import { createEdges } from "./edges.js";

const SVG_NS = "http://www.w3.org/2000/svg";
/** 一屏最多几个带流动光边的节点。 */
const MAX_LIVE = 8;
const FLIP_MS = 460;

export function initOrg({ onSelect } = {}) {
	const graph = document.getElementById("graph");
	const select = typeof onSelect === "function" ? onSelect : () => {};

	let root = null;
	let svg = null;
	let edges = null;

	let org = null;
	let signature = "";
	let selected = null;
	let hover = null;
	let hoverEl = null;

	/** 翻过面的项目（slug）：组织数据更新后要保持。 */
	const flipped = new Set();
	/** conversationId → 卡片引用（CEO / 高管）。 */
	const nodes = new Map();
	/** slug → 项目卡引用。 */
	const projects = new Map();
	/** conversationId → 当前可见的宿主元素（连线锚点 + 选中高亮）。 */
	const hosts = new Map();

	let ceoRefs = null;
	let ceoSlot = null;
	let rolesSlot = null;
	let projectsSlot = null;
	let rolesMeta = null;
	let projectsMeta = null;

	// ── 小工具 ────────────────────────────────────────────────────────────

	const setText = (element, text) => {
		if (element !== null && element !== undefined && element.textContent !== text) {
			element.textContent = text;
		}
	};

	const setAttr = (element, name, value) => {
		if (element !== null && element.getAttribute(name) !== value) element.setAttribute(name, value);
	};

	/** 卡片状态色：忙 → 待你 → 空闲（与 format.statusOf 对齐）。 */
	function projectStatus(project) {
		if (project?.status === "terminated") return "error";
		const people = [project?.lead, ...(project?.staff ?? [])];
		if (people.some((person) => person?.status === "busy")) return "busy";
		if (people.some((person) => (person?.awaitingYou ?? 0) > 0 || person?.status === "waiting")) {
			return "waiting";
		}
		return "idle";
	}

	function teamStats(project) {
		const all = project?.staff ?? [];
		const staff = all.filter((person) => person.archived !== true);
		const busy = staff.filter((person) => person.status === "busy").length;
		const waiting = staff.filter(
			(person) => (person.awaitingYou ?? 0) > 0 || person.status === "waiting",
		).length;
		const ask = [project?.lead, ...staff].reduce(
			(total, person) => total + Number(person?.awaitingYou ?? 0),
			0,
		);
		return { staff, busy, waiting, ask, total: staff.length, archived: all.length - staff.length };
	}

	function activityOf(actor) {
		const text = String(actor?.activity ?? "").trim();
		if (text !== "") return text;
		if (actor?.archived === true) return "已归档";
		// 有待办徽标时不再重复一行「待你」；纯空闲才补一个状态词
		if (Number(actor?.awaitingYou ?? 0) > 0) return "";
		return statusLabel(statusOf(actor));
	}

	function actorLabel(actor, askOverride, statusOverride) {
		const status = statusOverride ?? statusOf(actor);
		const ask = Number(askOverride ?? actor?.awaitingYou ?? 0);
		const parts = [String(actor?.label ?? ""), statusLabel(status)];
		if (ask > 0) parts.push(`${ask} 件等你拍板`);
		const activity = String(actor?.activity ?? "").trim();
		if (activity !== "") parts.push(activity.slice(0, 40));
		return parts.filter(Boolean).join("，");
	}

	function projectLabel(project) {
		const stats = teamStats(project);
		const parts = [project.name, `${stats.total} 名员工`];
		if (stats.busy > 0) parts.push(`${stats.busy} 人在跑`);
		if (stats.ask > 0) parts.push(`${stats.ask} 件等你拍板`);
		if (project.status === "terminated") parts.push("已终止");
		else parts.push("点击展开团队");
		return parts.join("，");
	}

	// ── 结构签名 ──────────────────────────────────────────────────────────

	function signatureOf(next) {
		const ceo = [next.ceo?.conversationId, next.ceo?.label, next.ceo?.subtitle];
		const roles = (next.roles ?? []).map((role) => [
			role.conversationId,
			role.label,
			role.subtitle,
		]);
		const projectList = (next.projects ?? []).map((project) => [
			project.slug,
			project.status === "terminated" ? "t" : "a",
			project.name,
			[project.lead?.conversationId, project.lead?.label, project.lead?.subtitle],
			(project.staff ?? []).map((person) => [
				person.conversationId,
				person.label,
				person.subtitle,
				person.archived === true ? 1 : 0,
			]),
			project.terminated === undefined
				? 0
				: [project.terminated.at, project.terminated.by, project.terminated.reason],
		]);
		return JSON.stringify([ceo, roles, projectList]);
	}

	// ── DOM：骨架 ─────────────────────────────────────────────────────────

	function build() {
		if (graph === null) return;
		graph.textContent = "";

		svg = document.createElementNS(SVG_NS, "svg");
		svg.id = "links";
		svg.setAttribute("class", "links");
		svg.setAttribute("aria-hidden", "true");
		svg.setAttribute("focusable", "false");

		root = document.createElement("div");
		root.className = "org-graph";
		root.innerHTML = `
			<div class="org-ceo" data-slot="ceo"></div>
			<div class="org-spine" aria-hidden="true"></div>
			<section class="org-tier">
				<h2 class="tier-head">
					<span class="tier-name">高管层</span>
					<span class="tier-meta" data-slot="roles-meta"></span>
				</h2>
				<div class="tier-grid tier-grid--roles" data-slot="roles"></div>
			</section>
			<div class="org-spine org-spine--mid" aria-hidden="true"></div>
			<section class="org-tier">
				<h2 class="tier-head">
					<span class="tier-name">项目组</span>
					<span class="tier-meta" data-slot="projects-meta"></span>
				</h2>
				<div class="tier-grid tier-grid--projects" data-slot="projects"></div>
			</section>`;

		graph.append(svg, root);

		ceoSlot = root.querySelector('[data-slot="ceo"]');
		rolesSlot = root.querySelector('[data-slot="roles"]');
		projectsSlot = root.querySelector('[data-slot="projects"]');
		rolesMeta = root.querySelector('[data-slot="roles-meta"]');
		projectsMeta = root.querySelector('[data-slot="projects-meta"]');

		nodes.clear();
		projects.clear();
		hosts.clear();
		ceoRefs = null;
		edges = createEdges(svg);
	}

	// ── HTML ──────────────────────────────────────────────────────────────

	/** 卡片级状态点：5px 静态圆点，不发光。 */
	function dotHtml(status) {
		return `<span class="dot" data-status="${status}" aria-hidden="true"></span>`;
	}

	/** 成员级状态方块：4px，朴素，不发光。 */
	function sqHtml(status) {
		return `<i class="sq" data-status="${status}" aria-hidden="true"></i>`;
	}

	/** 项目成员：一行名字，最多 4 个，超出 +N。 */
	function membersHtml(project) {
		const staff = project.staff ?? [];
		if (staff.length === 0) return `<span class="members-empty">还没有员工</span>`;
		const visible = staff.slice(0, 4);
		const extra = staff.length - visible.length;
		return (
			visible
				.map((person) => {
					const status = statusOf(person);
					return `<span class="member" data-status="${status}">${sqHtml(status)}${escapeHtml(person.label)}</span>`;
				})
				.join("") +
			(extra > 0 ? `<span class="member member--more">+${extra}</span>` : "")
		);
	}

	function countsHtml(stats) {
		const parts = [];
		if (stats.busy > 0) {
			parts.push(`<span class="prj-count"><span class="num">${stats.busy}</span> 在跑</span>`);
		}
		if (stats.ask > 0) {
			parts.push(`<span class="prj-count prj-count--ask"><span class="num">${stats.ask}</span> 等你</span>`);
		}
		return parts.join(`<span class="prj-sep" aria-hidden="true">·</span>`);
	}

	function whoText(stats) {
		const parts = [`${stats.total} 名员工`];
		if (stats.archived > 0) parts.push(`${stats.archived} 已归档`);
		return parts.join(" · ");
	}

	/** 团队行里只放真实活动，没有就留白（状态由方块表示）。 */
	function rowActivityOf(actor) {
		const text = String(actor?.activity ?? "").trim();
		if (text !== "") return text;
		return actor?.archived === true ? "已归档" : "";
	}

	/** 人物卡（CEO 以外的高管）。 */
	function nodeHtml(actor) {
		const status = statusOf(actor);
		const ask = Number(actor.awaitingYou ?? 0);
		return `
			<button class="card node" type="button"
				data-conv="${actor.conversationId}" data-focus="${actor.conversationId}"
				data-status="${status}" aria-label="${escapeAttr(actorLabel(actor))}">
				<span class="card-beam" aria-hidden="true"></span>
				<span class="card-face node-face">
					<span class="node-top">
						${dotHtml(status)}
						<span class="node-name">${escapeHtml(actor.label)}</span>
						<span class="node-ask"${ask > 0 ? "" : " hidden"}>待你 ${ask}</span>
						<span class="node-tok num">${formatTokens(actor.tokens)}</span>
					</span>
					<span class="node-sub truncate">${escapeHtml(actor.subtitle ?? "")}</span>
					<span class="node-act truncate">${escapeHtml(activityOf(actor))}</span>
				</span>
			</button>`;
	}

	/** CEO 卡：和别的卡一样，只是多一行小号待办提示。 */
	function ceoHtml(actor, askCount) {
		const status = org?.ceo?.status === "busy" ? "busy" : askCount > 0 ? "waiting" : statusOf(actor);
		return `
			<button class="card node node--ceo" type="button"
				data-conv="${actor.conversationId}" data-focus="${actor.conversationId}"
				data-status="${status}" aria-label="${escapeAttr(actorLabel(actor, askCount, status))}">
				<span class="card-beam" aria-hidden="true"></span>
				<span class="card-face node-face ceo-face">
					<span class="ceo-main">
						<span class="ceo-ident">
							<span class="node-top">
								${dotHtml(status)}
								<span class="node-name">CEO</span>
							</span>
							<span class="node-sub truncate">${escapeHtml(actor.subtitle ?? "")}</span>
							<span class="node-act truncate">${escapeHtml(activityOf(actor))}</span>
						</span>
						<span class="ceo-pending" data-empty="${askCount > 0 || Number(org.ceoQueue ?? 0) > 0 ? 0 : 1}">
							${sqHtml("waiting")}<span class="ceo-pending-text">${pendingLabel(askCount, org.ceoQueue)}</span>
						</span>
					</span>
				</span>
			</button>`;
	}

	/**
	 * CEO 卡上的待办文案。
	 *
	 * 只有 owner 级才是「待老板拍板」；CEO 自己队列里的问题是 CEO 的活，
	 * 单独标出来，避免老板把它当成又一堆积压。
	 */
	function pendingLabel(forYou, ceoQueue) {
		const mine = Number(forYou ?? 0);
		const ceo = Number(ceoQueue ?? 0);
		if (mine === 0 && ceo === 0) return "没有待你拍板的事";
		const parts = [];
		if (mine > 0) parts.push(`${mine} 件待你拍板`);
		if (ceo > 0) parts.push(`CEO 队列 ${ceo} 件`);
		return parts.join(" · ");
	}

	/** 项目卡正面。 */
	function frontFaceHtml(project, stats) {
		const lead = project.lead;
		return `
			<span class="card-face">
				<span class="prj-head">
					${dotHtml(projectStatus(project))}
					<span class="prj-name truncate">${escapeHtml(project.name)}</span>
					<span class="prj-slug">${escapeHtml(project.slug)}</span>
					<span class="prj-tok num">${formatTokens(project.tokens)}</span>
				</span>
				<span class="prj-lead">
					<span class="prj-lead-k">负责人</span>
					<span class="prj-lead-name">${escapeHtml(lead.label)}</span>
				</span>
				<span class="prj-members">${membersHtml(project)}</span>
				<span class="prj-foot">
					<span class="prj-meta">
						<span class="prj-who">${escapeHtml(whoText(stats))}</span>
						<span class="prj-counts">${countsHtml(stats)}</span>
					</span>
					<span class="prj-hint" aria-hidden="true">展开团队 ↓</span>
				</span>
			</span>`;
	}

	/** 团队里的一行：负责人与员工共用。 */
	function rowHtml(actor, { lead = false } = {}) {
		const status = statusOf(actor);
		const ask = Number(actor.awaitingYou ?? 0);
		return `
			<button class="prj-row ${lead ? "prj-row--lead" : "prj-row--staff"}${actor.archived === true ? " is-archived" : ""}" type="button"
				data-conv="${actor.conversationId}" data-focus="${actor.conversationId}" data-status="${status}"
				aria-label="${escapeAttr(actorLabel(actor))}">
				${sqHtml(status)}
				<span class="prj-row-main">
					<span class="prj-row-top">
						<span class="prj-row-name">${escapeHtml(actor.label)}</span>
						<span class="prj-row-role truncate">${escapeHtml(lead ? "项目负责人" : actor.subtitle ?? "")}</span>
						<span class="prj-row-ask"${ask > 0 ? "" : " hidden"}>待你 ${ask}</span>
						<span class="prj-row-tok num">${formatTokens(actor.tokens)}</span>
					</span>
					<span class="prj-row-act truncate">${escapeHtml(rowActivityOf(actor))}</span>
				</span>
			</button>`;
	}

	/** 项目卡背面：负责人 + 员工列表。 */
	function backFaceHtml(project, stats) {
		const staff = project.staff ?? [];
		return `
			<div class="card project-back" id="project-back-${escapeAttr(project.slug)}" data-status="${projectStatus(project)}">
				<div class="card-face project-back-face">
					<div class="prj-back-head">
						<span class="prj-back-title">${escapeHtml(project.name)} · 团队</span>
						<span class="prj-back-count">${stats.total} 名员工</span>
						<button class="prj-return" type="button" data-flip="${escapeAttr(project.slug)}"
							aria-label="返回 ${escapeAttr(project.name)} 项目概览">返回</button>
					</div>
					${rowHtml(project.lead, { lead: true })}
					${
						staff.length === 0
							? `<p class="prj-empty">还没有员工。让 CHRO 配人，或直接对负责人说需求。</p>`
							: `<div class="prj-rows">${staff.map((person) => rowHtml(person)).join("")}</div>`
					}
				</div>
			</div>`;
	}

	function projectHtml(project) {
		const status = projectStatus(project);
		const stats = teamStats(project);
		return `
			<div class="project" data-project="${escapeAttr(project.slug)}">
				<div class="project__inner">
					<div class="project-face project-face--front" inert>
						<button class="card project-front" type="button"
							data-flip="${escapeAttr(project.slug)}" data-conv="${project.lead.conversationId}" data-focus="${project.lead.conversationId}"
							data-status="${status}" aria-expanded="false" aria-label="${escapeAttr(projectLabel(project))}">
							<span class="card-beam" aria-hidden="true"></span>
							${frontFaceHtml(project, stats)}
						</button>
					</div>
					<div class="project-face project-face--back" inert>${backFaceHtml(project, stats)}</div>
				</div>
			</div>`;
	}

	/** 已终止项目：不翻面，直接把结果摊开。 */
	function terminatedHtml(project, stats) {
		const terminated = project.terminated ?? {};
		const when = terminated.at
			? `${relTime(terminated.at)} · ${clockTime(terminated.at)}`
			: "时间未记录";
		return `
			<div class="project project--terminated" data-project="${escapeAttr(project.slug)}">
				<div class="card project-front project-front--static" data-status="error"
					data-focus="${project.lead.conversationId}" aria-label="${escapeAttr(projectLabel(project))}">
					<span class="card-face">
						<span class="prj-head">
							${dotHtml("error")}
							<span class="prj-name truncate">${escapeHtml(project.name)}</span>
							<span class="prj-slug">${escapeHtml(project.slug)}</span>
							<span class="prj-tok num">${formatTokens(project.tokens)}</span>
						</span>
						<span class="prj-term-reason">${escapeHtml(terminated.reason || "项目已终止")}</span>
						<span class="prj-term-meta">${escapeHtml(terminated.by || "CEO")} 于 ${escapeHtml(when)} 终止 · ${escapeHtml(whoText(stats))}</span>
						<span class="prj-term-hint">产出文件保留。要彻底删除，对 CEO 说「删除 ${escapeHtml(project.name)} 项目」。</span>
					</span>
				</div>
			</div>`;
	}

	function emptyHtml(ceo) {
		return `
			<div class="org-empty">
				<p class="org-empty-lead">还没有项目。</p>
				<p class="org-empty-example">对 CEO 说一句需求就能立项。例如：<span class="org-empty-eg">「做一个网页坦克大战，配齐产品、设计、开发和测试」</span></p>
				<button class="org-empty-cta" type="button" data-conv="${ceo.conversationId}" data-focus="${ceo.conversationId}">
					对 CEO 说第一句
				</button>
			</div>`;
	}

	// ── DOM 引用 ──────────────────────────────────────────────────────────

	function nodeRefs(rootEl) {
		return {
			root: rootEl,
			dot: rootEl.querySelector(".dot"),
			act: rootEl.querySelector(".node-act"),
			tok: rootEl.querySelector(".node-tok"),
			ask: rootEl.querySelector(".node-ask"),
			pending: rootEl.querySelector(".ceo-pending"),
			pendingText: rootEl.querySelector(".ceo-pending-text"),
		};
	}

	function rowRefs(rootEl) {
		return {
			root: rootEl,
			dot: rootEl.querySelector(".dot"),
			act: rootEl.querySelector(".prj-row-act"),
			tok: rootEl.querySelector(".prj-row-tok"),
			ask: rootEl.querySelector(".prj-row-ask"),
		};
	}

	function projectEntry(rootEl, project) {
		const entry = {
			root: rootEl,
			slug: project.slug,
			card: rootEl.querySelector(".card"),
			dot: rootEl.querySelector(".prj-head .dot"),
			tok: rootEl.querySelector(".prj-tok"),
			members: rootEl.querySelector(".prj-members"),
			counts: rootEl.querySelector(".prj-counts"),
			who: rootEl.querySelector(".prj-who"),
			faceFront: rootEl.querySelector(".project-face--front"),
			faceBack: rootEl.querySelector(".project-face--back"),
			backCard: rootEl.querySelector(".project-back"),
			backCount: rootEl.querySelector(".prj-back-count"),
			leadRow: null,
			leadRefs: null,
			rows: new Map(),
			statsSignature: "",
			timer: 0,
		};
		if (entry.faceBack !== null) {
			const leadRow = entry.faceBack.querySelector(".prj-row--lead");
			if (leadRow !== null) {
				entry.leadRow = leadRow;
				entry.leadRefs = rowRefs(leadRow);
			}
			for (const row of entry.faceBack.querySelectorAll(".prj-row--staff")) {
				const id = Number(row.dataset.conv);
				if (Number.isFinite(id)) entry.rows.set(id, rowRefs(row));
			}
		}
		return entry;
	}

	// ── 重建（结构变了才走这里）───────────────────────────────────────────

	function rebuild() {
		if (root === null || org === null) return;
		const askCount = (org.pending ?? []).filter((item) => item.forYou).length;

		if (ceoSlot !== null) ceoSlot.innerHTML = ceoHtml(org.ceo, askCount);

		if (rolesSlot !== null) {
			const roles = org.roles ?? [];
			rolesSlot.innerHTML =
				roles.length === 0
					? `<p class="tier-empty">高管层还没配人。对 CEO 说一句需求，它会自己组队。</p>`
					: roles.map((role) => nodeHtml(role)).join("");
		}

		if (projectsSlot !== null) {
			const list = org.projects ?? [];
			projectsSlot.innerHTML =
				list.length === 0
					? emptyHtml(org.ceo)
					: list
							.map((project) =>
								project.status === "terminated"
									? terminatedHtml(project, teamStats(project))
									: projectHtml(project),
							)
							.join("");
		}

		// 收集引用
		ceoRefs = null;
		nodes.clear();
		projects.clear();

		const ceoEl = ceoSlot?.querySelector(".node");
		if (ceoEl !== null && ceoEl !== undefined) ceoRefs = nodeRefs(ceoEl);

		for (const role of org.roles ?? []) {
			const element = rolesSlot?.querySelector(`[data-conv="${role.conversationId}"]`);
			if (element !== null && element !== undefined) nodes.set(Number(role.conversationId), nodeRefs(element));
		}

		for (const project of org.projects ?? []) {
			const element = projectsSlot?.querySelector(
				`[data-project="${CSS.escape(project.slug)}"]`,
			);
			if (element !== null && element !== undefined) {
				projects.set(project.slug, projectEntry(element, project));
			}
		}

		// 复原翻面状态（组织数据更新后保持）
		for (const [slug, entry] of projects) {
			if (entry.faceFront === null || entry.faceBack === null) continue;
			applyFlip(entry, flipped.has(slug), { animate: false });
		}
	}

	// ── 打补丁（结构没变只走这里）─────────────────────────────────────────

	function patchActor(refs, actor, options = {}) {
		if (refs === null || refs === undefined) return;
		const status = options.status ?? statusOf(actor);
		const rootEl = refs.root;
		if (rootEl.dataset.status !== status) rootEl.dataset.status = status;
		if (refs.dot !== null && refs.dot.dataset.status !== status) refs.dot.dataset.status = status;
		setText(refs.act, activityOf(actor));
		setText(refs.tok, formatTokens(actor.tokens));
		const ask = Number(options.ask ?? actor?.awaitingYou ?? 0);
		if (refs.ask !== null) {
			if (ask > 0) {
				setText(refs.ask, `待你 ${ask}`);
				if (refs.ask.hidden) refs.ask.hidden = false;
			} else if (!refs.ask.hidden) {
				refs.ask.hidden = true;
			}
		}
		if (rootEl.tagName === "BUTTON") {
			setAttr(rootEl, "aria-label", actorLabel(actor, options.ask, status));
		}
	}

	function patchProject(entry, project) {
		const status = projectStatus(project);
		const stats = teamStats(project);

		if (entry.card !== null && entry.card.dataset.status !== status) {
			entry.card.dataset.status = status;
		}
		if (entry.backCard !== null && entry.backCard.dataset.status !== status) {
			entry.backCard.dataset.status = status;
		}
		if (entry.dot !== null && entry.dot.dataset.status !== status) {
			entry.dot.dataset.status = status;
		}
		if (entry.card !== null && entry.card.dataset.focus !== undefined) {
			setAttr(entry.card, "aria-label", projectLabel(project));
		}
		setText(entry.tok, formatTokens(project.tokens));

		// 团队点头像 + 在跑/等你计数：只在真的变了才重建这一小块
		const nextStatsSignature = [
			stats.total,
			stats.busy,
			stats.waiting,
			stats.ask,
			stats.archived,
			...(project.staff ?? []).map((person) => `${person.conversationId}:${statusOf(person)}`),
		].join("|");
		if (entry.statsSignature !== nextStatsSignature) {
			entry.statsSignature = nextStatsSignature;
			if (entry.members !== null) entry.members.innerHTML = membersHtml(project);
			if (entry.counts !== null) entry.counts.innerHTML = countsHtml(stats);
		}
		setText(entry.who, whoText(stats));
		if (entry.backCount !== null) setText(entry.backCount, `${stats.total} 名员工`);

		patchActor(entry.leadRefs, project.lead, { status: statusOf(project.lead) });
		if (entry.leadRow !== null) {
			entry.leadRow.classList.toggle("is-archived", project.lead?.archived === true);
		}
		for (const person of project.staff ?? []) {
			const refs = entry.rows.get(Number(person.conversationId));
			if (refs === undefined) continue;
			patchActor(refs, person);
			refs.root.classList.toggle("is-archived", person.archived === true);
		}
	}

	function tierMetaRoles(roles) {
		if (roles.length === 0) return "还没配人";
		const busy = roles.filter((role) => role.status === "busy").length;
		const waiting = roles.filter((role) => statusOf(role) === "waiting").length;
		const parts = [`${roles.length} 人在岗`];
		if (busy > 0) parts.push(`${busy} 人在跑`);
		if (waiting > 0) parts.push(`${waiting} 人等你`);
		return parts.join(" · ");
	}

	function tierMetaProjects(list) {
		if (list.length === 0) return "0 个在办";
		const active = list.filter((project) => project.status !== "terminated");
		const terminated = list.length - active.length;
		const staff = active.reduce(
			(total, project) => total + (project.staff ?? []).filter((person) => person.archived !== true).length,
			0,
		);
		const parts = [`${active.length} 个在办`];
		if (staff > 0) parts.push(`${staff} 名员工`);
		if (terminated > 0) parts.push(`${terminated} 个已终止`);
		return parts.join(" · ");
	}

	function patch() {
		if (org === null || root === null) return;
		const askCount = (org.pending ?? []).filter((item) => item.forYou).length;
		const ceoQueue = Number(org.ceoQueue ?? 0);

		if (ceoRefs !== null) {
			const status =
				org.ceo?.status === "busy" ? "busy" : askCount > 0 ? "waiting" : statusOf(org.ceo);
			patchActor(ceoRefs, org.ceo, { status, ask: askCount });
			if (ceoRefs.pending !== null) {
				const empty = askCount > 0 || ceoQueue > 0 ? "0" : "1";
				if (ceoRefs.pending.dataset.empty !== empty) ceoRefs.pending.dataset.empty = empty;
			}
			setText(ceoRefs.pendingText, pendingLabel(askCount, org.ceoQueue));
		}

		for (const role of org.roles ?? []) {
			const refs = nodes.get(Number(role.conversationId));
			if (refs !== undefined) patchActor(refs, role);
		}

		for (const project of org.projects ?? []) {
			const entry = projects.get(project.slug);
			if (entry !== undefined) patchProject(entry, project);
		}

		if (rolesMeta !== null) setText(rolesMeta, tierMetaRoles(org.roles ?? []));
		if (projectsMeta !== null) setText(projectsMeta, tierMetaProjects(org.projects ?? []));
	}

	// ── 可见宿主 / 选中 / 焦点 ────────────────────────────────────────────

	function refreshHosts() {
		hosts.clear();
		if (org === null) return;
		if (ceoRefs !== null) hosts.set(Number(org.ceo.conversationId), ceoRefs.root);
		for (const [id, refs] of nodes) hosts.set(id, refs.root);
		for (const project of org.projects ?? []) {
			const entry = projects.get(project.slug);
			if (entry === undefined) continue;
			const isFlipped = entry.faceFront !== null && flipped.has(project.slug);
			if (isFlipped) {
				if (entry.leadRefs !== null) hosts.set(Number(project.lead.conversationId), entry.leadRefs.root);
				for (const [id, refs] of entry.rows) hosts.set(id, refs.root);
			} else {
				hosts.set(Number(project.lead.conversationId), entry.card);
				for (const person of project.staff ?? []) {
					hosts.set(Number(person.conversationId), entry.card);
				}
			}
		}

		// 历史边可能指向已经换过/归档的员工会话；带 project 的边找不到锚点时，
		// 聚合到项目卡，避免「有沟通记录但一条线都画不出来」。
		for (const link of Array.isArray(org.links) ? org.links : []) {
			if (link.project === undefined) continue;
			const entry = projects.get(link.project);
			if (entry === undefined) continue;
			const anchor = entry.root;
			const from = Number(link.from);
			const to = Number(link.to);
			const fromKnown = hosts.has(from);
			const toKnown = hosts.has(to);
			if (fromKnown && !toKnown && hosts.get(from) !== anchor) hosts.set(to, anchor);
			else if (!fromKnown && toKnown && hosts.get(to) !== anchor) hosts.set(from, anchor);
		}
	}

	function applySelection() {
		if (root === null) return;
		for (const element of root.querySelectorAll(".is-selected")) {
			element.classList.remove("is-selected");
			element.removeAttribute("aria-current");
		}
		if (selected === null) return;
		const host = hosts.get(selected);
		if (host === undefined) return;
		host.classList.add("is-selected");
		host.setAttribute("aria-current", "true");
	}

	function applyFocus() {
		edges?.setFocus(hover !== null ? hover : selected);
	}

	function applyLive() {
		if (root === null) return;
		const candidates = [
			...root.querySelectorAll(
				".node[data-status='busy'], .node[data-status='waiting'], .project-front[data-status='busy'], .project-front[data-status='waiting']",
			),
		];
		const live = new Set(candidates.slice(0, MAX_LIVE));
		for (const card of root.querySelectorAll(".card.is-live")) {
			if (!live.has(card)) card.classList.remove("is-live");
		}
		for (const card of live) card.classList.add("is-live");
	}

	// ── 翻面 ──────────────────────────────────────────────────────────────

	function measureAll() {
		for (const entry of projects.values()) {
			// 正在翻转 / 已经交还给内容高度的卡片不动它
			if (entry.faceFront === null || entry.faceBack === null) continue;
			if (entry.timer !== 0) continue;
			const isFlipped = flipped.has(entry.slug);
			const height = isFlipped ? entry.faceBack.offsetHeight : entry.faceFront.offsetHeight;
			const next = height > 0 ? `${Math.round(height)}px` : "";
			if (entry.root.style.height !== next) entry.root.style.height = next;
		}
	}

	function applyFlip(entry, isFlipped, { animate = true } = {}) {
		if (entry.faceFront === null || entry.faceBack === null) return;
		if (entry.card !== null) {
			entry.card.setAttribute("aria-expanded", isFlipped ? "true" : "false");
			entry.card.setAttribute("aria-controls", entry.faceBack.id || `project-back-${entry.slug}`);
		}
		const targetHeight = isFlipped ? entry.faceBack.offsetHeight : entry.faceFront.offsetHeight;

		if (entry.timer !== 0) window.clearTimeout(entry.timer);

		// 翻转过程中抬到相邻卡之上：两页的透视不会互相压住
		entry.root.classList.toggle("is-flipping", animate);

		if (animate) {
			// 先钉住当前高度，才有过渡起点
			entry.root.style.height = `${entry.root.offsetHeight}px`;
			void entry.root.offsetHeight;
			entry.root.classList.toggle("is-flipped", isFlipped);
			entry.root.style.height = `${Math.round(targetHeight)}px`;
			// 过渡走完把高度交还给内容：之后文案变长也不会被旧高度裁掉
			entry.timer = window.setTimeout(() => {
				entry.timer = 0;
				entry.root.classList.remove("is-flipping");
				entry.root.style.height = "";
				measureAll();
				refreshHosts();
				applySelection();
				edges?.refresh();
			}, FLIP_MS + 30);
		} else {
			entry.root.classList.toggle("is-flipped", isFlipped);
			entry.root.style.height = targetHeight > 0 ? `${Math.round(targetHeight)}px` : "";
		}

		// 隐藏的那一面不参与 Tab / 读屏
		entry.faceFront.toggleAttribute("inert", isFlipped);
		entry.faceBack.toggleAttribute("inert", !isFlipped);
	}

	function toggleFlip(slug) {
		const entry = projects.get(slug);
		if (entry === undefined || entry.faceFront === null || entry.faceBack === null) return;
		const willFlip = !flipped.has(slug);
		if (willFlip) flipped.add(slug);
		else flipped.delete(slug);
		applyFlip(entry, willFlip, { animate: true });
		refreshHosts();
		applySelection();
		// 翻转后原来的触发按钮变成 inert，焦点会掉到 body；把它交给新的一面
		const focusTarget = willFlip
			? entry.faceBack.querySelector(".prj-return")
			: entry.faceFront.querySelector("[data-flip]");
		requestAnimationFrame(() => focusTarget?.focus({ preventScroll: true }));
	}

	// ── 对外 API ──────────────────────────────────────────────────────────

	function update(next) {
		if (graph === null || next === null || next === undefined) return;
		if (next.ceo === undefined || next.ceo === null) {
			// 真实服务端一定有 CEO；这里只防止手工注入坏数据时整页崩掉
			graph.innerHTML = '<div class="graph-loading">组织数据缺少 CEO，暂时无法渲染。</div>';
			root = null;
			svg = null;
			edges = null;
			return;
		}
		org = next;
		if (root === null || !graph.contains(root)) build();

		const nextSignature = signatureOf(org);
		if (nextSignature !== signature) {
			signature = nextSignature;
			rebuild();
		}
		patch();
		refreshHosts();
		measureAll();
		applySelection();
		applyLive();
		// 旧服务端可能没有 links（或给的不是数组）：安全退化为空，不报错
		edges?.render(Array.isArray(org.links) ? org.links : [], hosts, hover !== null ? hover : selected);
	}

	function setSelected(conversationId) {
		const id = Number(conversationId);
		const next = Number.isFinite(id) ? id : null;
		if (next === selected) return;
		selected = next;
		applySelection();
		applyFocus();
	}

	function refreshLayout() {
		if (org === null || root === null) return;
		measureAll();
		refreshHosts();
		applySelection();
		edges?.refresh();
	}

	// ── 交互 ──────────────────────────────────────────────────────────────

	function focusTargetOf(target) {
		if (!(target instanceof Element)) return null;
		const host = target.closest("[data-focus]");
		if (host === null) return null;
		const id = Number(host.dataset.focus);
		return Number.isFinite(id) ? id : null;
	}

	if (graph !== null) {
		graph.addEventListener("pointerover", (event) => {
			const host = event.target instanceof Element ? event.target.closest("[data-focus]") : null;
			if (host === null || host === hoverEl) return;
			hoverEl = host;
			hover = focusTargetOf(host);
			applyFocus();
		});

		graph.addEventListener("pointerout", (event) => {
			if (hoverEl === null) return;
			const related = event.relatedTarget;
			if (related instanceof Node && hoverEl.contains(related)) return;
			hoverEl = null;
			hover = null;
			// 只在 hover 丢失时清焦点；选中态由 setSelected 负责
			applyFocus();
		});

		graph.addEventListener("click", (event) => {
			if (!(event.target instanceof Element)) return;
			const flipTarget = event.target.closest("[data-flip]");
			if (flipTarget !== null) {
				event.preventDefault();
				toggleFlip(flipTarget.dataset.flip);
				return;
			}
			const convTarget = event.target.closest("[data-conv]");
			if (convTarget === null) return;
			const id = Number(convTarget.dataset.conv);
			if (Number.isFinite(id)) select(id);
		});

		// 对话面板拖宽 / 外层容器变宽时，卡片会重排：连线要跟着走。
		if (typeof ResizeObserver === "function") {
			let lastWidth = 0;
			let scheduled = false;
			const observer = new ResizeObserver((records) => {
				const box = records[0]?.contentRect;
				if (box === undefined) return;
				// 只有宽度变了才需要重算：高度变化是卡片在长高，连线自己会跟着走
				if (lastWidth !== 0 && Math.abs(box.width - lastWidth) < 1) return;
				lastWidth = box.width;
				if (scheduled) return;
				scheduled = true;
				requestAnimationFrame(() => {
					scheduled = false;
					refreshLayout();
				});
			});
			observer.observe(graph);
		}
	}

	return { update, setSelected, refreshLayout };
}
