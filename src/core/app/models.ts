/**
 * 模型注册表的只读出口。
 *
 * 界面上「给某个人换模型」只该列出**装配好的、真能用的**那些：`settings.json` 里刚加的
 * 提供商要重启才进注册表（ADR-021），列出来点了只会 400。这份清单就是「现在真能用」。
 */
import type { CoreServices } from "./types.ts";

export function createModels(services: CoreServices) {
	return {
		/** 现在生效的模型（`provider/modelId`）与默认模型；一个都没有时都是空。 */
		list(): { models: string[]; defaultModel: string } {
			const models = (services.models?.getModels() ?? []).map((model) => `${model.provider}/${model.id}`);
			const ref = services.defaultModel;
			return { models, defaultModel: ref === undefined ? "" : `${ref.provider}/${ref.modelId}` };
		},
	};
}
