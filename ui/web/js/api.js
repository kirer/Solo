/**
 * 后端接口的唯一入口。
 *
 * 为什么要包一层而不是各处 `fetch`：错误处理必须统一。后端失败时回的是
 * `{ error: "人话" }`，直接 `res.json()` 会让调用处拿到一个没有 error 字段的
 * 对象然后静默当成成功 —— 这正是旧前端最常吞掉的那类失败。
 */

async function readError(response) {
	try {
		const body = await response.json();
		if (typeof body?.error === "string" && body.error !== "") return body.error;
	} catch {
		/* 非 JSON：用状态码兜底 */
	}
	return `请求失败（${response.status}）`;
}

export async function getJSON(path) {
	const response = await fetch(path, { headers: { Accept: "application/json" } });
	if (!response.ok) throw new Error(await readError(response));
	return await response.json();
}

export async function postJSON(path, body) {
	const response = await fetch(path, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify(body ?? {}),
	});
	if (!response.ok) throw new Error(await readError(response));
	return await response.json();
}

/**
 * 订阅组织快照（SSE）。
 *
 * 后端只在有提交时推，没有就只发心跳 —— 所以这里不需要轮询。
 * 断线由 EventSource 自己重连（后端给了 `retry: 1500`）。
 */
export function streamOrg(onEvent, onState) {
	const source = new EventSource("/api/stream/org");
	source.addEventListener("org", (event) => {
		try {
			onEvent(JSON.parse(event.data));
		} catch {
			/* 半条 JSON 不该让整个页面安静下来 */
		}
	});
	source.addEventListener("open", () => onState?.("open"));
	source.addEventListener("error", () => onState?.("closed"));
	return () => source.close();
}

/**
 * 「找你的 N 件事」：跨频道摊平的待老板开口消息。
 *
 * 频道列表只能给每个频道一个红点，回答不了「我现在该看哪一条」。这个接口返回
 * `{ items: [{ channelId, seq, fromSlug, fromLabel, excerpt, at, read, ... }], unread }`，
 * 按时间倒序。点一条 = 切到那个频道并滚到该 seq。
 */
export function attention() {
	return getJSON("/api/attention");
}

/**
 * 一个人的记忆（`agents/<slug>/memory.md`）。
 *
 * 老板要能看见「这个人到底记住了什么」并按条删 —— 记忆是不可信模型写的，必须有人能审。
 * 返回 `{ slug, label, exists, digest, entries: [{ heading, body }], raw }`，
 * `entries` 每个小节一条（小节标题就是记下的日期）。
 */
export function personMemory(slug) {
	return getJSON(`/api/people/${encodeURIComponent(slug)}/memory`);
}

/** 删掉某一条（按小节标题）。或加一条：`{ op: 'add', text }`。 */
export function editPersonMemory(slug, body) {
	return postJSON(`/api/people/${encodeURIComponent(slug)}/memory`, body);
}

/** 一个人的全部档案（详情面板一次要的东西）：身份、技能、记忆概况、所在频道。 */
export function personProfile(slug) {
	return getJSON(`/api/people/${encodeURIComponent(slug)}`);
}
