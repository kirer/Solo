/**
 * Kokoro v1.1-zh 音色表的护栏。
 *
 * 这张表的 sid 顺序不是我们定的，是 sherpa-onnx 官方转换脚本按「先 3 个英文、
 * 再按编号遍历 zf、再遍历 zm、只收 `.pt` 真存在的文件」排出来的。
 *
 * **最大的风险不是第一次取错，是以后换模型只改了文件、忘了改表。** 那时
 * `voices.bin` 的段数变了、表还是旧长度，每个 sid 都会静默指向另一个人，
 * 界面不报错、不静音、不回落 —— 用户只会觉得「声音怎么变了」。
 *
 * 所以这里钉三条硬账：表长、sid 连续、`voices.bin` 字节数除以每段字节数正好等于表长。
 */
import { describe, expect, test } from "vitest";
import {
	KOKORO_DEFAULT_VOICE,
	KOKORO_V11_SPEAKER_BYTES,
	KOKORO_V11_VOICES,
	KOKORO_V11_VOICES_BIN_BYTES,
	KOKORO_V11_VOICE_COUNT,
	KOKORO_V11_ZH_VOICES,
	isKokoroVoice,
	sidOfVoice,
	voiceOfSid,
} from "../../seed/plugins/悬浮球/kokoro.js";

/**
 * 老版本（v1.0）的 8 个音色，sid 45–52。放在测试里而不是 seed 里：生产代码一行都不用它们，
 * 只用来钉「同一个 sid 在 v1.1 里指向的确实是另一个人」，而 seed 有体积上限。
 */
const KOKORO_OLD_VOICES = [
	{ id: 45, name: "zf_xiaobei", label: "晓北" },
	{ id: 46, name: "zf_xiaoni", label: "晓妮" },
	{ id: 47, name: "zf_xiaoxiao", label: "晓晓" },
	{ id: 48, name: "zf_xiaoyi", label: "晓伊" },
	{ id: 49, name: "zm_yunjian", label: "云健" },
	{ id: 50, name: "zm_yunxi", label: "云希" },
	{ id: 51, name: "zm_yunxia", label: "云夏" },
	{ id: 52, name: "zm_yunyang", label: "云扬" },
];

describe("Kokoro v1.1-zh 音色表", () => {
	test("表长 103：3 英文 + 55 女 + 45 男", () => {
		expect(KOKORO_V11_VOICES).toHaveLength(KOKORO_V11_VOICE_COUNT);
		expect(KOKORO_V11_VOICES).toHaveLength(103);
		expect(KOKORO_V11_VOICES.filter((v) => v.name.startsWith("zf_"))).toHaveLength(55);
		expect(KOKORO_V11_VOICES.filter((v) => v.name.startsWith("zm_"))).toHaveLength(45);
	});

	test("sid 就是下标，0–102 连续不留空", () => {
		KOKORO_V11_VOICES.forEach((voice, index) => {
			expect(voice.id, `第 ${String(index)} 条的 sid`).toBe(index);
		});
		expect(voiceOfSid(0)).toBe("af_maple");
		expect(voiceOfSid(102)).toBe(KOKORO_V11_VOICES[102]?.name);
		expect(voiceOfSid(103)).toBeNull();
		expect(voiceOfSid(-1)).toBeNull();
	});

	test("voices.bin 的段数等于表长——换模型忘了换表，这条先红", () => {
		expect(KOKORO_V11_VOICES_BIN_BYTES % KOKORO_V11_SPEAKER_BYTES).toBe(0);
		expect(KOKORO_V11_VOICES_BIN_BYTES / KOKORO_V11_SPEAKER_BYTES).toBe(KOKORO_V11_VOICES.length);
	});

	test("名字不重复（重复会让 sidOfVoice 静默取到前一个）", () => {
		const names = new Set(KOKORO_V11_VOICES.map((v) => v.name));
		expect(names.size).toBe(KOKORO_V11_VOICES.length);
	});

	test("界面上只上中文：100 个，3 个英文不露", () => {
		expect(KOKORO_V11_ZH_VOICES).toHaveLength(100);
		expect(KOKORO_V11_ZH_VOICES.every((v) => /^(zf|zm)_\d{3}$/.test(v.name))).toBe(true);
	});

	test("默认音色在表里，是 zf_001、sid 3", () => {
		expect(KOKORO_DEFAULT_VOICE).toBe("zf_001");
		expect(sidOfVoice(KOKORO_DEFAULT_VOICE)).toBe(3);
		expect(isKokoroVoice(KOKORO_DEFAULT_VOICE)).toBe(true);
	});

	test("查名字和查 sid 互为逆运算", () => {
		for (const voice of KOKORO_V11_VOICES) {
			expect(sidOfVoice(voice.name)).toBe(voice.id);
			expect(voiceOfSid(voice.id)).toBe(voice.name);
		}
		expect(sidOfVoice("zf_xiaoxiao")).toBeNull();
		expect(isKokoroVoice("zf_xiaoxiao")).toBe(false);
	});

	/**
	 * 这一条钉的不是表，是**为什么必须改存储**。
	 *
	 * v1.0 存的数字 sid 在 v1.1 里全都落在别人身上，而且没有一个越界、没有一个会触发回落。
	 * 界面没有任何办法发现这件事。所以客户端改成存名字、老库一律回默认 + 打横幅，
	 * 不是保守，是这种错从代码里根本看不出来。
	 */
	test("老 8 个音色的 sid 在新表里指向的都是别人", () => {
		const expected: Record<number, string> = {
			45: "zf_078",
			46: "zf_079",
			47: "zf_083",
			48: "zf_084",
			49: "zf_085",
			50: "zf_086",
			51: "zf_087",
			52: "zf_088",
		};
		expect(KOKORO_OLD_VOICES).toHaveLength(8);
		expect(new Set(KOKORO_OLD_VOICES.map((v) => v.id)).size).toBe(8);
		for (const old of KOKORO_OLD_VOICES) {
			const landed = voiceOfSid(old.id);
			expect(landed, `老 sid ${String(old.id)} 应该落在新表里`).not.toBeNull();
			expect(expected[old.id], `老 sid ${String(old.id)}（${old.name}）`).toBe(landed);
			expect(landed, `老 ${old.name} 不该在新表里还叫这个名字`).not.toBe(old.name);
		}
		// 四个男声全落女声，这是最容易让人以为「坏了」的一条。
		for (const old of KOKORO_OLD_VOICES.filter((v) => v.name.startsWith("zm_"))) {
			expect(voiceOfSid(old.id)?.startsWith("zf_"), `老 ${old.name} 落到了 ${String(voiceOfSid(old.id))}`).toBe(true);
		}
	});
});
