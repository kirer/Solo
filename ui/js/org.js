/**
 * 组织图（占位实现，由 graph-dev 替换）。
 * 契约见 docs/design/WEB-UI-CONTRACT.md 第 6 节。
 */
export function initOrg({ onSelect }) {
	const graph = document.getElementById("graph");
	return {
		update(org) {
			const projects = org.projects.map((p) => p.name).join(" · ");
			graph.innerHTML = `<div class="graph-loading">组织图正在重建 · ${org.ceo.label} · ${projects}</div>`;
			void onSelect;
		},
		setSelected() {},
		refreshLayout() {},
	};
}
