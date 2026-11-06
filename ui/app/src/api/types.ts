/**
 * 界面看到的接口形状 —— **从后端 DTO 直接再导出，不再手抄**。
 *
 * 权威定义只有一份：`src/view/dto.ts`。以前这里是一份手抄镜像，抄漏了编译会错，
 * 但「抄多/抄错名字」不会错 —— 于是真出现过 `scope: "own"`（后端是 `"personal"`）、
 * `memory.entries` 被写成数组（后端给的是条数）这类静默漂移。改成 type-only 再导出之后，
 * 后端改字段这里就编译不过，漂移无处可藏。
 *
 * 为什么用别名而不是直接用 `View*` 名字：界面里 `Channel` / `Message` 这种短名字读起来顺，
 * 而内核里必须带 `View` 前缀才不跟领域对象（`ChannelState`、`Message`）撞车。名字不同、
 * 形状同一个 —— 这正是「一份事实一个家」该有的样子。
 */
export type {
	AttentionItem,
	ViewActor as Actor,
	ViewAttachment as Attachment,
	ViewChannel as Channel,
	ViewChannelDetail as ChannelDetail,
	ViewChannelKind as ChannelKind,
	ViewChannelResponder as ChannelResponder,
	ViewMember as Member,
	ViewMemoryEntry as MemoryEntry,
	ViewMention as Mention,
	ViewMessage as Message,
	ViewOrg as Org,
	ViewPersonMemory as PersonMemory,
	ViewPersonProfile as PersonProfile,
	ViewPlugin as Plugin,
	ViewTeamProfile as TeamProfile,
	ViewSkill as SkillInfo,
	ViewActivity as Activity,
	ViewStep as Step,
	ViewTurn as Turn,
	ViewUploaded as Uploaded,
} from "../../../../src/view/dto.ts";
