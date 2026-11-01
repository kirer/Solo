/**
 * 模型注册表的只读出口。
 *
 * 界面上「给某个人换模型」只该列出**装配好的、真能用的**那些。`settings.json` 改过
 * 就先就地重装一遍（ADR-025），所以这里列出来的就是「现在真能用」，不用等重启。
 */
import type { CoreServices } from "./types.ts";

export function createModels(services: CoreServices) {
	return {
		/** 现在生效的模型（`provider/modelId`）与默认模型；一个都没有时都是空。 */
		async list(): Promise<{ models: string[]; defaultModel: string }> {
			await services.refreshModels?.();
			const models = (services.models?.getModels() ?? []).map((model) => `${model.provider}/${model.id}`);
			const ref = services.defaultModel;
			return { models, defaultModel: ref === undefined ? "" : `${ref.provider}/${ref.modelId}` };
		},
	};
}
