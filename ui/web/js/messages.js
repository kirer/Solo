/**
 * 消息列表的纯操作。与界面无关，可以单独测。
 *
 * 为什么单独一个文件：`app.js` 在模块顶层就拿 DOM（`const el = { … }`），
 * 测试环境是 `environment: "node"`，import 它就会炸。把这类「能脱离浏览器跑」
 * 的东西挪出来，是这套前端唯一的可测边界。
 */

/**
 * 按 `seq` 合并两批消息：去重 + 升序。
 *
 * 为什么要去重：补历史时 `before=<当前最早那条的 seq>` 由服务端保证不重叠，但客户端
 * 仍会遇到重叠 —— 两次翻页之间插进来一条 SSE 增量、或者一次重试。实测补两轮后
 * DOM 里出现 20 个重复的 `data-seq`，而 `[data-seq="N"]` 查到的就不是那条消息了
 * （高亮亮错行、动作条挂到另一条上）。前端自己兜住这一层，比要求「每次请求恰好不重叠」稳。
 *
 * 顺序上的取舍：同一条 seq 出现两次时**后一批赢**（`newer` 覆盖 `older`），因为
 * 新的一批更可能带着更新的字段（已读、编辑后的正文）。
 */
export function mergeMessages(older, newer) {
	const bySeq = new Map();
	for (const message of [...(older ?? []), ...(newer ?? [])]) {
		if (!message || typeof message.seq !== "number") continue;
		bySeq.set(message.seq, message);
	}
	return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/**
 * 「这条消息之前的那一条」是谁 —— 连发合并、时间分隔都靠它判断。
 *
 * 两种情况必须分开：
 *   - **追加**（新消息落在列表末尾）：上一条就是列表最后一条。
 *   - **原地替换**（占位被真实回复覆盖）：上一条是 `index - 1`。
 *
 * 以前这里一律取列表最后一条 —— 而占位填充时被替换的占位**通常就是最后一条**，
 * 等于拿「自己」当上一条：同一个人 2 分钟内必然满足「连发合并」，头像和名字被吃掉，
 * 那条回复看起来像上一条的续写。替换时必须往前看一位。
 */
export function previousOf(messages, index, isAppend) {
	const list = Array.isArray(messages) ? messages : [];
	if (isAppend) return list[list.length - 1] ?? null;
	if (index > 0) return list[index - 1] ?? null;
	return null;
}

/**
 * 用同一条 seq 的新消息覆盖旧消息（SSE 占位填充走这里）。
 *
 * 坑在「省略的键」：服务端填充占位时不再带 `processing`（false 会被 JSON 省掉），
 * 而 `{...旧, ...新}` 里旧对象的 `processing: true` 不会被覆盖 —— 于是界面继续
 * 按处理中画，动画点永远停在那儿。所以这几个「只可能变没」的键，新消息没带就显式删掉。
 * `status` 同理：它跟着新值走，新值没有就说明这条已经不是 pending 了。
 */
const DROP_WHEN_ABSENT = ["processing", "status"];

export function mergeMessage(older, newer) {
	const merged = { ...(older ?? {}), ...(newer ?? {}) };
	for (const key of DROP_WHEN_ABSENT) {
		if (newer == null || !Object.prototype.hasOwnProperty.call(newer, key)) delete merged[key];
	}
	return merged;
}

/**
 * 本地先画一条自己刚发的消息（POST 成功、SSE 还没回显时用）。
 *
 * 老板的验收口径：发送成功之后不能只靠 SSE 回显 —— 断线重连那几秒里消息不出现，
 * 看起来就是「没发出去」，于是他会再发一遍。POST 的返回里有 `seq`，本地先按这个
 * seq 落一条，SSE 到达时 `merge` 按 seq 覆盖（幂等），同一条不会变成两条。
 */
export function localEcho({ seq, text, at = Date.now(), fromSlug = "owner", fromLabel = "老大", attachments, replyTo, kind = "say" }) {
	return {
		seq,
		fromSlug,
		fromLabel,
		kind,
		text: String(text ?? ""),
		at,
		...(typeof replyTo === "number" ? { replyTo } : {}),
		...(Array.isArray(attachments) && attachments.length > 0 ? { attachments } : {}),
		// 只是给界面一个「这条还没被服务端回显」的标记，SSE 覆盖后自然消失。
		local: true,
	};
}

/** 把本地这条按 seq 插进列表：同 seq 已存在就原地替换，最后按 seq 升序。 */
export function insertLocalMessage(messages, message) {
	const list = Array.isArray(messages) ? messages : [];
	if (message == null || typeof message.seq !== "number") return list;
	const index = list.findIndex((item) => item?.seq === message.seq);
	if (index >= 0) {
		const next = [...list];
		next[index] = { ...list[index], ...message };
		return next;
	}
	return [...list, message].sort((left, right) => (left?.seq ?? 0) - (right?.seq ?? 0));
}
