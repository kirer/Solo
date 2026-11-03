/**
 * 通讯录：这个组织里有谁。应用的第二屏，不是浮层。
 *
 * 一栏人名，宽窄和聊天列表一样（288px）—— 同一个人在这两处的脸、名字、
 * 状态落在同一条竖线上。右边空着：点一行就是去他的私聊，通讯录里没有
 * 「某个人的详情」可看，也就不摆一块假的详情板（docs/DESIGN.md §1.5）。
 */

import { avatarSvg } from "../lib/avatar.ts";
import { openWithPerson, setTeam } from "../state/store.ts";
import { useStore } from "../state/useStore.ts";
import { presenceOfActor } from "./Overlays.tsx";

export function TeamPage(): JSX.Element {
	const people = useStore((state) => state.people);
	const presence = useStore((state) => state.presence);

	return (
		<section className="page page-single" id="page-team" aria-label="通讯录">
			<div className="page-side">
				<header className="page-side-head">
					<h2 className="page-title">
						通讯录 <span className="team-count" id="team-count">{people.length}</span>
					</h2>
				</header>

				<div className="page-side-body" id="team-list">
					{people.map((actor) => {
						const look = presenceOfActor(presence, actor.slug);
						return (
							<button
								type="button"
								key={actor.slug}
								className="crew"
								title={`和 ${actor.label} 私聊`}
								onClick={() => {
									setTeam(false);
									void openWithPerson(actor.slug);
								}}
							>
								<span
									className="crew-av"
									dangerouslySetInnerHTML={{
										__html: avatarSvg({ slug: actor.slug, name: actor.label, size: 32, state: "idle" }),
									}}
								/>
								<span className="crew-main">
									<span className="crew-name">{actor.label}</span>
									<span className="crew-sub">{actor.title}</span>
								</span>
								<span className="crew-state" data-state={look.state}>
									{look.label}
								</span>
							</button>
						);
					})}
				</div>
			</div>

			{/* 右边空着是这一屏的意思，不是漏画了东西。 */}
			<div className="page-main page-main-blank" aria-hidden="true" />
		</section>
	);
}
