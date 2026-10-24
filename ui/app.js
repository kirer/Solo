/**
 * 一人公司 · 网页界面
 *
 * 只做四件事：看、聊、拍板、接受结果。
 * 数据全部来自 SSE，界面不做轮询。
 */
'use strict';

// ── 状态 ────────────────────────────────────────────────────────────────────
const state = {
	org: null,
	feed: null,
	/** 当前打开的会话标识。 */
	openId: null,
	/** 会话流的 EventSource。 */
	feedSource: null,
	/** 组织流的 EventSource。 */
	orgSource: null,
	/** 正在拍的板（key）。 */
	answering: null,
	/** 已经渲染过的 feed 签名，避免无变化时重绘。 */
	feedSignature: '',
	/** 用户是否贴着底部（决定要不要自动滚）。 */
	stickToBottom: true,
};

const $ = (id) => document.getElementById(id);

// ── 工具函数 ────────────────────────────────────────────────────────────────
function escapeHtml(text) {
	return String(text ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function formatTokens(value) {
	const tokens = Number(value ?? 0);
	if (tokens >= 1_000_000) return (tokens / 1_000_000).toFixed(2) + 'M';
	if (tokens >= 1_000) return (tokens / 1_000).toFixed(1) + 'k';
	return String(tokens);
}

function statusLabel(status) {
	return status === 'busy' ? '在跑' : status === 'waiting' ? '等你' : '空闲';
}

/** 极简 Markdown：代码块、行内代码、标题、加粗、列表、换行。 */
function renderMarkdown(raw) {
	const text = String(raw ?? '');
	const blocks = [];
	// 先抽走围栏代码块，避免里面的符号被当成 Markdown
	const withoutCode = text.replace(/```([\w-]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
		const index = blocks.length;
		blocks.push({ lang, code });
		return `\u0000CODE${index}\u0000`;
	});

	let html = escapeHtml(withoutCode);

	// 行内代码
	html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
	// 标题
	html = html.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
	html = html.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
	html = html.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');
	// 加粗
	html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
	// 分隔线
	html = html.replace(/^---$/gm, '<hr>');

	// 列表：连续的 - 或数字项包成 ul / ol
	html = html.replace(/(?:^[-*]\s+.+(?:\n|$))+/gm, (chunk) => {
		const items = chunk
			.trim()
			.split('\n')
			.map((line) => `<li>${line.replace(/^[-*]\s+/, '')}</li>`)
			.join('');
		return `<ul>${items}</ul>`;
	});
	html = html.replace(/(?:^\d+\.\s+.+(?:\n|$))+/gm, (chunk) => {
		const items = chunk
			.trim()
			.split('\n')
			.map((line) => `<li>${line.replace(/^\d+\.\s+/, '')}</li>`)
			.join('');
		return `<ol>${items}</ol>`;
	});

	// 段落：空行分段，单换行保留为 <br>
	html = html
		.split(/\n{2,}/)
		.map((part) => {
			const trimmed = part.trim();
			if (trimmed === '') return '';
			if (/^<(h[123]|ul|ol|hr|pre)/.test(trimmed)) return trimmed;
			return `<p>${trimmed.replace(/\n/g, '<br>')}</p>`;
		})
		.join('');

	// 还原代码块
	html = html.replace(/\u0000CODE(\d+)\u0000/g, (_, index) => {
		const block = blocks[Number(index)];
		return `<pre><code>${escapeHtml(block.code.replace(/\n$/, ''))}</code></pre>`;
	});

	return html;
}

// ── 组织视图 ────────────────────────────────────────────────────────────────
function statusDot(status) {
	return `<i class="dot" data-state="${status}"></i>`;
}

function actorCard(actor, options = {}) {
	const ask =
		actor.awaitingYou > 0
			? `<span class="tag tag--amber">等你 ${actor.awaitingYou}</span>`
			: actor.status === 'busy'
				? '<span class="tag tag--teal">在跑</span>'
				: '';
	const selected = state.openId === actor.conversationId ? ' is-selected' : '';
	return `
	<button class="card${selected}" data-open="${actor.conversationId}">
		<span class="card-head">
			${statusDot(actor.status)}
			<span class="card-title">${escapeHtml(actor.label)}</span>
			${ask}
			<span class="badge mono">${formatTokens(actor.tokens)}</span>
		</span>
		<span class="card-sub">${escapeHtml(actor.subtitle)}</span>
		<span class="card-task">${escapeHtml(actor.activity || statusLabel(actor.status))}</span>
	</button>`;
}

function projectCard(project) {
	const flipKey = `proj:${project.slug}`;
	const flipped = state.flipped?.has(flipKey) ? ' is-flipped' : '';
	const leader = project.lead;
	const team = project.staff;
	const terminated = project.status === 'terminated';
	const activeTeam = team.filter((person) => !person.archived);

	const front = `
	<button class="proj-front card" data-flip="${flipKey}" aria-label="${escapeHtml(project.name)}，点击展开团队">
		<span class="card-head">
			${statusDot(leader.status)}
			<span class="card-title">${escapeHtml(project.name)}</span>
			<span class="tag mono">${escapeHtml(project.slug)}</span>
			<span class="badge mono">${formatTokens(project.tokens)}</span>
		</span>
		<span class="card-sub">${escapeHtml(leader.label)} · 项目负责人</span>
		<span class="card-task">${activeTeam.length} 员工 · ${activeTeam.filter((p) => p.status === 'busy').length} 在跑 · ${activeTeam.filter((p) => p.status === 'waiting').length} 等你</span>
	</button>`;

	const back = `
	<div class="proj-back">
		<div class="proj-back-head">
			<span class="dot" data-state="${leader.status}"></span>
			<span class="name">${escapeHtml(project.name)}</span>
			<span class="tag mono">${team.length} 员工</span>
			<button class="back" data-flip="${flipKey}">返回 ↑</button>
		</div>
		<button class="lead-row" data-open="${leader.conversationId}">
			<span class="dot" data-state="${leader.status}"></span>
			<span class="lead-t">
				<b>${escapeHtml(leader.label)}</b>
				<em>项目负责人 · ${escapeHtml(leader.activity || '空闲')}</em>
			</span>
			<span class="badge mono">${formatTokens(leader.tokens)}</span>
		</button>
		${
			team.length === 0
				? '<div class="note">还没有员工。让 CHRO 配人。</div>'
				: `<div class="team">${team
						.map(
							(person) => `
					<button class="emp${person.archived ? ' is-archived' : ''}" data-open="${person.conversationId}">
						<span class="dot" data-state="${person.status}"></span>
						<span class="emp-n">${escapeHtml(person.label)}</span>
						<span class="emp-r">${escapeHtml(person.subtitle)}</span>
						<span class="emp-k">${person.archived ? '已归档' : statusLabel(person.status)}${person.awaitingYou > 0 ? ` · 等你 ${person.awaitingYou}` : ''}</span>
					</button>`,
						)
						.join('')}</div>`
		}
	</div>`;

	if (terminated) {
		// 已终止：不再提供翻转，直接把结果摊开——终止原因比团队名单更重要
		return `
		<div class="proj is-terminated" data-project="${project.slug}">
			<div class="proj-front card">
				<span class="card-head">
					<i class="dot" data-state="idle"></i>
					<span class="card-title">${escapeHtml(project.name)}</span>
					<span class="tag">已终止</span>
					<span class="badge mono">${formatTokens(project.tokens)}</span>
				</span>
				<span class="card-sub">${escapeHtml(project.terminated?.reason ?? '项目已终止')}</span>
				<span class="card-task">${activeTeam.length === 0 ? '全部员工已归档' : `${activeTeam.length} 员工仍在岗`} · 产出文件保留</span>
				<span class="card-stats">
					<span>由 ${escapeHtml(project.terminated?.by ?? 'CEO')} 终止</span>
					<span class="mono">${project.terminated ? new Date(project.terminated.at).toLocaleString('zh-CN', { hour12: false }) : ''}</span>
				</span>
				<span class="card-hint" data-open="1">要彻底删除？对 CEO 说「删除 ${escapeHtml(project.name)} 项目」</span>
			</div>
		</div>`;
	}

	return `
	<div class="proj${flipped}" data-project="${project.slug}">
		<div class="proj-inner">
			<div class="proj-face proj-face--front">${front}</div>
			<div class="proj-face proj-face--back">${back}</div>
		</div>
	</div>`;
}

function renderOrg() {
	const org = state.org;
	if (!org) return;

	$('company-name').textContent = org.company.name || '一人公司';
	$('company-model').textContent = org.company.model;
	$('total-tokens').textContent = formatTokens(org.costs.totalTokens);

	const forYou = org.pending.filter((item) => item.forYou);
	$('ask-count').textContent = String(forYou.length);

	$('ask-area').innerHTML = forYou.length === 0 ? '' : forYou
		.slice(0, 3)
		.map(
			(item) => `
		<div class="ask-bar">
			<div class="k">等你拍板 · 来自 ${escapeHtml(item.from)}</div>
			<div class="q">${renderMarkdown(item.question)}</div>
			<div class="row">
				<textarea rows="1" data-answer="${escapeHtml(item.key)}" placeholder="给出你的决定…"></textarea>
				<button class="send" data-answer-send="${escapeHtml(item.key)}" aria-label="提交">↑</button>
			</div>
		</div>`,
		)
		.join('');

	const ceo = org.ceo;
	const ceoAsk = ceo.awaitingYou > 0 ? `<button class="ask" data-open="${ceo.conversationId}">等你 ${ceo.awaitingYou} 件 →</button>` : '';

	const projectsHtml =
		org.projects.length === 0
			? `<div class="empty">
					<b>还没有项目</b>
					<p>在下面的对话框对 CEO 说一句需求即可。例如：<br>「做一个网页坦克大战，配齐产品设计开发测试」</p>
					<button class="card" data-open="${ceo.conversationId}" style="margin-top:13px">＋ 对 CEO 说第一句需求</button>
				</div>`
			: `<div class="grid-2">${org.projects.map(projectCard).join('')}</div>`;

	$('graph').innerHTML = `
		<div class="ceo-row">
			<button class="card ceo" data-open="${ceo.conversationId}">
				<span class="dot" data-state="${ceo.status}"></span>
				<span class="who">
					<b>CEO</b>
					<em>${escapeHtml(ceo.activity || '唯一真人 · 你在最上层拍板')}</em>
				</span>
				${ceoAsk}
				<span>
					<span class="num">${forYou.length}</span>
					<span class="num-cap">待你拍板</span>
				</span>
			</button>
		</div>

		<div class="connector"></div>

		<div class="sec-head">
			<span class="t">L1 · 高管层</span>
			<span class="n">${org.roles.length} 在岗</span>
			<span class="r">在跑 ${org.roles.filter((r) => r.status === 'busy').length} · 等你 ${org.roles.filter((r) => r.status === 'waiting').length}</span>
		</div>
		<div class="grid-3">
			${org.roles.map((role) => actorCard(role)).join('')}
		</div>

		<div class="connector"></div>

		<div class="sec-head">
			<span class="t">L2 · 项目组</span>
			<span class="n">${org.projects.filter((project) => project.status !== 'terminated').length} 个在办${org.projects.some((project) => project.status === 'terminated') ? ` · ${org.projects.filter((project) => project.status === 'terminated').length} 个已终止` : ''}</span>
			<span class="r">共 ${org.projects.reduce((total, project) => total + project.staff.filter((person) => !person.archived).length, 0)} 员工 · 点击卡片展开团队</span>
		</div>
		${projectsHtml}
	`;

	bindGraph();
	sizeProjects();
}

/**
 * 项目卡：正反面绝对定位，容器高度由这里控制。
 *
 * 不这么做的话，背面（负责人 + 员工列表）会把没翻转的卡片也撑高，
 * 正面内容被挤到角落。
 */
function sizeProjects() {
	for (const wrapper of document.querySelectorAll('.proj')) {
		const front = wrapper.querySelector('.proj-front');
		const back = wrapper.querySelector('.proj-back');
		if (!front || !back) continue;

		// 量自然高度：临时把容器设成 auto，量完立刻恢复
		const saved = wrapper.style.height;
		wrapper.style.height = 'auto';
		const frontHeight = front.scrollHeight;
		const backHeight = back.scrollHeight;
		wrapper.dataset.hFront = String(frontHeight);
		wrapper.dataset.hBack = String(backHeight);

		// 按当前朝向设高度
		const flipped = wrapper.classList.contains('is-flipped');
		wrapper.style.height = `${flipped ? backHeight : frontHeight}px`;
		void saved;
	}
}

/** 翻转项目卡，高度跟着动画。 */
function toggleFlip(element) {
	const wrapper = element.closest('.proj');
	if (!wrapper) return;

	const willFlip = !wrapper.classList.contains('is-flipped');
	const target = Number(willFlip ? wrapper.dataset.hBack : wrapper.dataset.hFront);
	if (!Number.isFinite(target)) return;

	// 先钉住当前高度，才能有过渡起点
	wrapper.style.height = `${wrapper.offsetHeight}px`;

	// 强制一次布局，让浏览器记下起点高度
	void wrapper.offsetHeight;

	wrapper.classList.toggle('is-flipped', willFlip);
	wrapper.style.height = `${target}px`;
}

function bindGraph() {
	// 打开对话
	for (const element of document.querySelectorAll('[data-open]')) {
		element.addEventListener('click', (event) => {
			event.stopPropagation();
			openActor(Number(element.dataset.open));
		});
	}

	// 翻转项目卡
	for (const element of document.querySelectorAll('[data-flip]')) {
		element.addEventListener('click', (event) => {
			event.stopPropagation();
			const key = element.dataset.flip;
			state.flipped ??= new Set();
			if (state.flipped.has(key)) state.flipped.delete(key);
			else state.flipped.add(key);
			toggleFlip(element);
		});
	}

	// 排队消息的「立即处理」：打断当前工作，让这条消息马上生效
	for (const element of document.querySelectorAll('[data-interrupt]')) {
		element.addEventListener('click', async (event) => {
			event.stopPropagation();
			const conversationId = Number(element.dataset.interrupt);
			const text = element.dataset.text;
			element.disabled = true;
			element.textContent = '处理中…';
			await fetch('/api/interrupt', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ conversationId, text }),
			});
		});
	}

	// 顶部待拍板条的提交
	for (const element of document.querySelectorAll('[data-answer-send]')) {
		element.addEventListener('click', () => {
			const key = element.dataset.answerSend;
			const textarea = document.querySelector(`textarea[data-answer="${CSS.escape(key)}"]`);
			void submitAnswer(key, textarea?.value ?? '');
		});
	}
	for (const element of document.querySelectorAll('textarea[data-answer]')) {
		element.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' && !event.shiftKey) {
				event.preventDefault();
				void submitAnswer(element.dataset.answer, element.value);
			}
		});
	}
}

// ── 对话面板 ────────────────────────────────────────────────────────────────
function openActor(conversationId) {
	if (state.openId === conversationId) {
		closePanel();
		return;
	}

	state.openId = conversationId;
	state.feed = null;
	state.feedSignature = '';
	state.stickToBottom = true;

	$('panel').classList.add('is-open');
	$('panel-body').innerHTML = '<div class="note">正在加载…</div>';
	$('panel-title').textContent = '—';
	$('panel-role').textContent = '';

	// 关掉旧流
	state.feedSource?.close();
	state.feedSource = new EventSource(`/api/stream/feed/${conversationId}`);
	state.feedSource.addEventListener('feed', (event) => {
		const feed = JSON.parse(event.data);
		const signature = JSON.stringify({
			items: feed.items.length,
			last: feed.items[feed.items.length - 1]?.id,
			streaming: (feed.streaming ?? '').length,
			thinking: (feed.thinking ?? '').length,
			running: feed.running.length,
			queued: (feed.queued ?? []).map((item) => `${item.id}:${item.mode}`).join(','),
		});
		state.feed = feed;
		renderPanelHead(feed);
		if (signature !== state.feedSignature) {
			state.feedSignature = signature;
			renderFeed(feed);
		}
	});
	state.feedSource.onerror = () => {
		$('panel-body').insertAdjacentHTML(
			'beforeend',
			'<div class="alert">连接断开，正在重连…</div>',
		);
	};

	renderOrg();
	requestAnimationFrame(sizeProjects);
	$('input')?.focus();
}

function closePanel() {
	state.openId = null;
	state.feed = null;
	state.feedSignature = '';
	state.feedSource?.close();
	state.feedSource = null;
	$('panel').classList.remove('is-open');
	renderOrg();
	requestAnimationFrame(sizeProjects);
}

function renderPanelHead(feed) {
	$('panel-title').textContent = feed.title || '会话';
	$('panel-role').textContent = feed.role || '';
	const dot = $('panel-dot');
	dot.dataset.state = feed.busy ? 'busy' : feed.awaitingOwner ? 'waiting' : 'idle';
	$('panel-tokens').textContent = `本会话 ${formatTokens(feed.tokens)} tokens`;
}

/** 记住哪些可折叠项是打开的，重绘后恢复。 */
function captureOpenKeys() {
	const keys = new Set();
	for (const element of document.querySelectorAll('[data-key][open]')) keys.add(element.dataset.key);
	return keys;
}

function renderFeed(feed) {
	const body = $('panel-body');
	const openKeys = captureOpenKeys();
	const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 80;

	const parts = [];
	let toolIndex = 0;

	for (const item of feed.items) {
		if (item.kind === 'user') {
			parts.push(`<div class="item item--user"><span class="who">你</span><div class="bubble">${escapeHtml(item.text)}</div></div>`);
		} else if (item.kind === 'assistant') {
			parts.push(`<div class="item item--assistant"><span class="who">${escapeHtml(feed.title || '')}</span><div class="bubble md">${renderMarkdown(item.text)}</div></div>`);
		} else if (item.kind === 'thinking') {
			const key = `think:${item.id}:${parts.length}`;
			parts.push(`
				<details class="think" data-key="${key}" ${openKeys.has(key) ? 'open' : ''}>
					<summary>思考 · ${item.text.length} 字</summary>
					<div class="body">${escapeHtml(item.text)}</div>
				</details>`);
		} else if (item.kind === 'tool') {
			const key = `tool:${item.id}:${toolIndex++}`;
			const stateText = item.state === 'running' ? '运行中' : item.state === 'error' ? '失败' : '完成';
			parts.push(`
				<details class="tool" data-state="${item.state}" data-key="${key}" ${openKeys.has(key) || item.state === 'running' ? 'open' : ''}>
					<summary>
						<span class="tname">${escapeHtml(item.name)}</span>
						<span class="targs">${escapeHtml(item.args)}</span>
						<span class="tstate">${stateText}</span>
					</summary>
					<pre>${escapeHtml(item.output || '（等待输出）')}</pre>
				</details>`);
		} else if (item.kind === 'note') {
			parts.push(`<div class="note">${escapeHtml(item.text)}</div>`);
		} else if (item.kind === 'alert') {
			parts.push(`<div class="alert">${escapeHtml(item.text)}</div>`);
		}
	}

	// 实时部分：正在思考、正在生成、正在跑的工具
	if (feed.thinking) {
		parts.push(`
			<details class="think" data-key="live:think" open>
				<summary>正在思考…</summary>
				<div class="body">${escapeHtml(feed.thinking)}</div>
			</details>`);
	}
	if (feed.streaming) {
		parts.push(`<div class="item item--assistant"><div class="bubble md">${renderMarkdown(feed.streaming)}</div></div>`);
	}
	for (const tool of feed.running) {
		parts.push(`
			<details class="tool" data-state="running" open>
				<summary>
					<span class="tname">${escapeHtml(tool.name)}</span>
					<span class="targs">${escapeHtml(tool.args)}</span>
					<span class="tstate">运行中</span>
				</summary>
				<pre>（正在执行）</pre>
			</details>`);
	}
	if (feed.busy && !feed.streaming) {
		parts.push('<div class="typing"><span class="dots"><i></i><i></i><i></i></span><span>工作中…</span></div>');
	}

	// 排队中的消息：必须显示，否则老板会以为消息没发出去
	for (const item of feed.queued ?? []) {
		parts.push(`
			<div class="queued">
				<span class="q-tag">已排队${item.mode === 'steer' ? ' · 本轮工具结束后处理' : ' · 当前工作结束后处理'}</span>
				<span class="q-text">${escapeHtml(item.text)}</span>
				<button class="q-now" data-interrupt="${feed.conversationId}" data-text="${escapeHtml(item.text)}">
					立即处理
				</button>
			</div>`);
	}
	if (feed.items.length === 0 && !feed.busy) {
		parts.push('<div class="note">还没有对话。在下面说第一句。</div>');
	}

	body.innerHTML = parts.join('');

	if (nearBottom || state.stickToBottom) {
		body.scrollTop = body.scrollHeight;
	}
}

// ── 动作 ────────────────────────────────────────────────────────────────────
async function sendMessage() {
	const input = $('input');
	const text = input.value.trim();
	if (text === '' || state.openId === null) return;

	input.value = '';
	input.style.height = 'auto';
	state.stickToBottom = true;

	// 乐观显示：先按「已排队」显示出来，别让老板等下一次推送才知道发出去了
	if (state.feed) {
		state.feed = {
			...state.feed,
			queued: [...(state.feed.queued ?? []), { id: -Date.now(), text, mode: 'steer' }],
		};
		renderFeed(state.feed);
	}

	const response = await fetch('/api/message', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ conversationId: state.openId, text }),
	});

	if (!response.ok) {
		$('panel-body').insertAdjacentHTML('beforeend', '<div class="alert">消息发送失败，请重试</div>');
	}
}

async function submitAnswer(key, text) {
	const value = String(text ?? '').trim();
	if (value === '') return;

	await fetch('/api/answer', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ key, text: value }),
	});

	// 清空那一条的输入框
	const textarea = document.querySelector(`textarea[data-answer="${CSS.escape(key)}"]`);
	if (textarea) textarea.value = '';
}

// ── 事件绑定 ────────────────────────────────────────────────────────────────
$('panel-close').addEventListener('click', closePanel);

$('send').addEventListener('click', () => void sendMessage());

$('input').addEventListener('keydown', (event) => {
	if (event.key === 'Enter' && !event.shiftKey) {
		event.preventDefault();
		void sendMessage();
	}
});

// 输入框随内容长高
$('input').addEventListener('input', (event) => {
	const element = event.target;
	element.style.height = 'auto';
	element.style.height = Math.min(element.scrollHeight, 160) + 'px';
});

document.addEventListener('keydown', (event) => {
	if (event.key === 'Escape' && state.openId !== null) closePanel();
});

// 记住用户是否在底部
$('panel-body').addEventListener('scroll', () => {
	const body = $('panel-body');
	state.stickToBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 80;
});

// ── 启动 ────────────────────────────────────────────────────────────────────
state.flipped = new Set();

state.orgSource = new EventSource('/api/stream/org');
state.orgSource.addEventListener('org', (event) => {
	state.org = JSON.parse(event.data);
	renderOrg();
});
state.orgSource.onerror = () => {
	$('graph').innerHTML =
		'<div class="empty"><b>连接断开</b><p>终端里的服务可能已经退出。重新运行 npm start 后刷新本页。</p></div>';
};
