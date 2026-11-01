import { describe, expect, it } from "vitest";
import { join, relative, sep } from "node:path";
import {
	ASSISTANT_DIR,
	MEMBERS_DIR,
	memberWorkspace,
	resolveLayout,
	teamWorkspace,
	workspaceOf,
} from "../../src/core/layout.ts";

const layout = resolveLayout({ appRoot: "/tmp/solo/app", userRoot: "/tmp/solo/user" });

/** 一个位置在另一个位置里面（相等也算）。 */
function inside(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep));
}

describe("两个根", () => {
	it("应用自带的东西全在 appRoot，组织数据全在 userRoot", () => {
		for (const at of [layout.assistantRoot, layout.promptRoot, layout.pluginsRoot, layout.settingsFile]) {
			expect(at.startsWith(layout.appRoot)).toBe(true);
		}
		for (const at of [layout.databasePath, layout.uploadsRoot, layout.logsRoot, layout.seedManifestFile]) {
			expect(at.startsWith(layout.appRoot)).toBe(true);
		}
		for (const at of [layout.membersRoot, layout.teamsRoot, layout.skillsRoot, layout.rulesFile]) {
			expect(at.startsWith(layout.userRoot)).toBe(true);
		}
	});

	it("两个根不互相包含 —— 备份一边不会顺走另一边", () => {
		expect(inside(layout.appRoot, layout.userRoot)).toBe(false);
		expect(inside(layout.userRoot, layout.appRoot)).toBe(false);
	});

	it("扫人时助理在前、成员在后", () => {
		expect(layout.agentRoots).toEqual([layout.assistantRoot, layout.membersRoot]);
		expect(layout.assistantRoot).toBe(join(layout.appRoot, ASSISTANT_DIR));
		expect(layout.membersRoot).toBe(join(layout.userRoot, MEMBERS_DIR));
	});

	it("相对路径先解析成绝对路径", () => {
		const relativeLayout = resolveLayout({ appRoot: "a", userRoot: "b" });
		expect(relativeLayout.appRoot.startsWith("/")).toBe(true);
		expect(relativeLayout.userRoot.startsWith("/")).toBe(true);
	});
});

describe("工作目录", () => {
	it("成员和团队各有自己的 workspace", () => {
		expect(memberWorkspace(layout, "小恐龙")).toBe(join(layout.membersRoot, "小恐龙", "workspace"));
		expect(teamWorkspace(layout, "农场")).toBe(join(layout.teamsRoot, "农场", "workspace"));
	});

	it("助理的工作目录跟着它的身份目录走（在 app 根里）", () => {
		expect(workspaceOf(join(layout.assistantRoot, "知言"))).toBe(join(layout.assistantRoot, "知言", "workspace"));
	});
});
