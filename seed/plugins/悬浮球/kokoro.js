/**
 * Kokoro v1.1-zh 的音色表：103 个 speaker，sid 0–102。
 *
 * 顺序照 sherpa-onnx 的 `scripts/kokoro/v1.1-zh/generate_voices_bin.py`：3 个英文占 sid 0–2，
 * 再 zf 只收真存在的 55 个、zm 只收存在的 45 个。**编号是稀疏的，不能靠算术推名字。**
 *
 * 名字串是唯一来源：id 就是下标，label 只截 `xx_` 前缀。别在代码里写第二套编号规则。
 * 为什么必须钉成数据、老用户的 sid 为什么会静默换人，见 `test/seed/kokoro-voices.test.ts`。
 */

/** `voices.bin` 里每个 speaker 占的字节数。[510, 1, 256] 的 float32。 */
export const KOKORO_V11_SPEAKER_BYTES = 522_240;

/** v1.1-zh 的 `voices.bin` 实测字节数（53,790,720 ÷ 522,240 = 103）。 */
export const KOKORO_V11_VOICES_BIN_BYTES = 53_790_720;

/** 表全长：3 英文 + 55 女声 + 45 男声。 */
export const KOKORO_V11_VOICE_COUNT = 103;

/** 默认音色。旧的默认 `zf_xiaoxiao` 在 v1.1 里没有，落在这里。 */
export const KOKORO_DEFAULT_VOICE = "zf_001";

/** 103 个 speaker 的名字，逗号分隔 —— **顺序就是 sid**。按 10 个一行排，只为好看。 */
const KOKORO_V11_VOICE_NAMES =
	"af_maple,af_sol,bf_vale,zf_001,zf_002,zf_003,zf_004,zf_005,zf_006,zf_007,zf_008,zf_017,zf_018,zf_019,zf_021,zf_022,zf_023,zf_024,zf_026,zf_027," +
	"zf_028,zf_032,zf_036,zf_038,zf_039,zf_040,zf_042,zf_043,zf_044,zf_046,zf_047,zf_048,zf_049,zf_051,zf_059,zf_060,zf_067,zf_070,zf_071,zf_072," +
	"zf_073,zf_074,zf_075,zf_076,zf_077,zf_078,zf_079,zf_083,zf_084,zf_085,zf_086,zf_087,zf_088,zf_090,zf_092,zf_093,zf_094,zf_099,zm_009,zm_010," +
	"zm_011,zm_012,zm_013,zm_014,zm_015,zm_016,zm_020,zm_025,zm_029,zm_030,zm_031,zm_033,zm_034,zm_035,zm_037,zm_041,zm_045,zm_050,zm_052,zm_053," +
	"zm_054,zm_055,zm_056,zm_057,zm_058,zm_061,zm_062,zm_063,zm_064,zm_065,zm_066,zm_068,zm_069,zm_080,zm_081,zm_082,zm_089,zm_091,zm_095,zm_096," +
	"zm_097,zm_098,zm_100";

/** 名字串 → 表。`id` 是下标；`label` 只截掉 `xx_` 前缀（`zf_001` → `001`），不掺别的规则。 */
export const KOKORO_V11_VOICES = KOKORO_V11_VOICE_NAMES.split(",").map((name, id) => ({
	id,
	name,
	label: name.slice(3),
}));

/** 界面只上中文：100 个（55 女 + 45 男），3 个英文不露。 */
export const KOKORO_V11_ZH_VOICES = KOKORO_V11_VOICES.filter(
	(voice) => voice.name.startsWith("zf_") || voice.name.startsWith("zm_"),
);

const BY_NAME = new Map(KOKORO_V11_VOICES.map((voice) => [voice.name, voice]));
const BY_ID = new Map(KOKORO_V11_VOICES.map((voice) => [voice.id, voice]));

/** 名字 → sid；不认识的名字返回 `null`（调用方回落默认）。 */
export function sidOfVoice(name) {
	return BY_NAME.get(name)?.id ?? null;
}

/** sid → 名字；越界返回 `null`。 */
export function voiceOfSid(id) {
	return BY_ID.get(id)?.name ?? null;
}

/** 名字是不是这一版认识的。 */
export function isKokoroVoice(name) {
	return BY_NAME.has(name);
}
