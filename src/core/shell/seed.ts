/**
 * 播种：把仓库自带的起手技能与「离老板最近的那个人」装进一个新工作区。
 *
 * 只在**工作区空的时候**发生一次。之后 `agents/` 与 `skills/` 里的内容属于使用者，
 * 播种代码没有权力覆盖 —— 所以这里所有写入都是「不存在才写」。
 */
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SKILLS_DIR, copySkillDir } from "../agent/skills.ts";
import { OWNER_SLUG } from "../agent/identity.ts";

/**
 * 把仓库自带的技能拷进工作区的公司层（`<workspace>/skills/`）。
 *
 * 只拷 `seed/skills/` 下真有的目录，且**不覆盖已存在的**：播种只该发生一次，
 * 之后 `skills/` 里的内容属于用户，代码没有权力改。
 *
 * 找不到 `seed/skills/` 时静默跳过 —— 打包/部署方式可能不带这个目录，
 * 缺几份起手技能不该让服务起不来。
 */
export async function seedCompanySkills(agentsRoot: string): Promise<readonly string[]> {
	return copySeedSkills(seedRoot("skills"), join(dirname(agentsRoot), SKILLS_DIR));
}

/**
 * 给某一个人的个人层播种技能（`agents/<slug>/skills/`）。
 *
 * 为什么有些技能属于个人而不是公司：一份技能属于谁，取决于「谁该为这条做法负责」。
 * 「怎么立项」「怎么招人」是助理的判断，它自己会迭代 —— 写在公司层就等于宣布全公司
 * 都得按助理那一套招人，而实际上别人不该招人。`写技能` / `找现成技能` 反过来是
 * 所有人都该会的手艺，所以它们在公司层。
 */
export async function seedPersonalSkills(agentsRoot: string, slug: string, folder: string): Promise<readonly string[]> {
	return copySeedSkills(seedRoot(folder), join(agentsRoot, slug, SKILLS_DIR));
}

async function copySeedSkills(from: string, skillsRoot: string): Promise<readonly string[]> {
	let entries: import("node:fs").Dirent[];
	try {
		entries = await readdir(from, { withFileTypes: true });
	} catch {
		return [];
	}
	const copied: string[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const written = await copySkillDir(join(from, entry.name), skillsRoot);
		copied.push(written.name);
	}
	return copied;
}

/**
 * 仓库自带的播种目录（`seed/<folder>`）。
 *
 * 用「从本文件往上找」而不是写死绝对路径：`src/core/shell/` 到仓库根是固定深度，
 * 但源码（`src/`）与构建产物（`dist/`）深度不同，所以往上找而不是数层级。
 */
function seedRoot(folder: string): string {
	let dir = dirname(fileURLToPath(import.meta.url));
	for (let index = 0; index < 6; index += 1) {
		const candidate = join(dir, "seed", folder);
		if (existsSync(candidate)) return candidate;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return join(dirname(fileURLToPath(import.meta.url)), "seed", folder);
}

/**
 * 给一个工作区播种「老板身边的人」。
 *
 * 这是**唯一**一处预置身份的地方，而且只写文件、不写代码：一个 `manager: owner` 的
 * agent，正文说清「你是老板唯一直接对话的人，其余的人由你按需要创建」。
 * 之后它自己就会 `hire` 别人 —— 那些人的身份是它写的，不是代码写的。
 */
export async function seedOwnerAssistant(
	agentsRoot: string,
	options: { readonly name: string; readonly body?: string },
): Promise<string> {
	const { createAgent } = await import("../agent/create.ts");
	const identity = await createAgent({
		root: agentsRoot,
		name: options.name,
		title: "负责人",
		manager: OWNER_SLUG,
		body:
			options.body ??
			[
				"你是老板唯一直接对话的人。老板不直接管别人，只跟你说话。",
				"",
				"## 你做什么",
				"老板说一件事，你判断它需要谁，用 `hire` 建人，用 `write_project` 立项目。",
				"招人、分工、定边界都是你的活，不必请示。做完在频道里向老板说清楚。",
				"",
				"## 你的边界",
				"你不写代码、不做设计。你决定「谁来做、做什么、做到什么程度」，然后验收。",
				"一个任务需要三个人时，就建三个人；需要一个人时，就一个人做到底。",
				"",
				"## 怎么说话",
				"对老板：结论先行，一句话说清做完了什么、卡在哪、要他定什么。不铺垫、不罗列过程。",
				"对下属：说清目标与验收标准，不说做法。",
				"",
				"## 你自己也在变",
				"你可以用 `update_identity` 改自己的身份。发现「我该更关注成本」这类结论，就写进自己的 identity.md。",
				"经验用 `remember` 记下来，下次先 `recall` 再动手。",
			].join("\n"),
	});

	// 技能：和身份一样，是文件，不是代码。
	//
	// 两层，各自管各自的事：
	// - 公司层 `seed/skills/`（`写技能`、`找现成技能`）—— 所有人都该会的手艺。
	// - 助理自己的 `seed/assistant/`（`立项`、`招人`）—— 它的判断，不属于别人。
	//   招人、立项是助理的职权，别人本来就不该招人；写进公司层等于宣布全公司都这么干。
	//
	// 正文以前是写在本函数里的字符串字面量 —— 那等于把「做法」硬编码进代码：改一句话
	// 要改 TS、要重新编译、要重启。现在它们和 agent 自己写的技能是同一种东西
	// （同一个文件夹结构），改完下一条消息就生效。
	await seedCompanySkills(agentsRoot);
	await seedPersonalSkills(agentsRoot, identity.slug, "assistant");
	return identity.slug;
}
