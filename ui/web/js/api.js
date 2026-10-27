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
