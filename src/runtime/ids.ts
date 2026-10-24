/**
 * 语义化请求标识。
 *
 * 崩溃恢复是「至少一次」语义：进程重开后重复投递依靠请求标识去重（见 ADR-006）。
 * 因此标识必须由稳定输入推导，绝不能随机生成或使用时间戳——否则会重复派活、
 * 重复计费、重复执行。
 */

/**
 * 标识里允许的字符：字母（含中文）、数字、连字符、下划线。
 *
 * 这些标识只用于底层去重，不进文件路径，所以中文是安全的——
 * 员工叫「林越」是完全合法的，不该因为它不是 ASCII 就报错。
 */
const UNSAFE = /[^\p{L}\p{N}_-]+/gu;

/** 把任意字符串规范化为标识片段。 */
function slug(value: string): string {
	const normalized = value
		.trim()
		.toLowerCase()
		.replace(/\s+/g, "-")
		.replace(UNSAFE, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "");

	// 极端情况（全是符号）兜底：用稳定哈希，保证同输入同输出（ADR-006）
	if (normalized === "") return `x${stableHash(value)}`;
	return normalized;
}

/** 稳定的短哈希：同输入永远同输出，跨进程一致。 */
function stableHash(value: string): string {
	let hash = 0;
	for (let index = 0; index < value.length; index += 1) {
		hash = (hash * 31 + value.charCodeAt(index)) | 0;
	}
	return (Math.abs(hash) >>> 0).toString(36);
}

/**
 * 派活的请求标识。
 *
 * 同一次派活（同一个派活任务 + 同一个员工 + 同一个序号）永远得到同一个标识，
 * 所以崩溃重开后重复投递会被底层去重，而不会让员工重复干活。
 *
 * @param taskId 发起派活的任务标识
 * @param employee 员工名（在项目内唯一）
 * @param attempt 同一任务的第几次派活，默认 0
 */
export function delegationRequestId(taskId: string | number, employee: string, attempt = 0): string {
	return `delegate:${slug(String(taskId))}:${slug(employee)}:${attempt}`;
}

/** 向会话投递一条消息的请求标识（老板发言、管理层内部沟通等）。 */
export function messageRequestId(scope: string, conversationId: string | number, sequence: number): string {
	return `msg:${slug(scope)}:${slug(String(conversationId))}:${sequence}`;
}

/** 员工向派活方回报的请求标识。 */
export function reportRequestId(delegationId: string, employee: string): string {
	return `report:${slug(delegationId)}:${slug(employee)}`;
}

/** 升级流程的标识（用于关联审计记录与沟通留痕）。 */
export function escalationId(originConversationId: string | number, sequence: number): string {
	return `esc:${slug(String(originConversationId))}:${sequence}`;
}

/** 老板拍板后回传答复的请求标识。 */
export function ownerDecisionRequestId(escalation: string): string {
	return `owner:${slug(escalation)}`;
}

/**
 * 项目目录标识：只含小写字母、数字与连字符（见 project-workspace 规格）。
 *
 * 目录标识必须由拉丁字符构成——中文名无法可靠转写成稳定路径（拼音有歧义，
 * 哈希不可读）。所以项目名与目录标识是分开的两个字段：显示名可以任意，
 * 目录标识必须由调用方显式给出英文 slug。
 */
export function projectSlug(name: string): string {
	const result = name
		.toLowerCase()
		.replace(/\s+/g, "-")
		.replace(/[^a-z0-9-]/g, "")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "");
	if (result === "") {
		throw new Error(
			`无法从 ${JSON.stringify(name)} 生成目录标识：目录名必须由拉丁字母、数字或连字符构成。请另外提供一个英文 slug（例如 "tank-battle"），项目显示名可以是任意语言。`,
		);
	}
	return result;
}
