/**
 * Kokoro v1.1-zh 的音色表：103 个 speaker，sid 0–102。
 *
 * 这张表**不是猜的**，是照 sherpa-onnx 官方转换脚本的顺序重建的
 * （`scripts/kokoro/v1.1-zh/generate_voices_bin.py`）：
 *
 * 1. 先放 3 个英文：`af_maple`、`af_sol`、`bf_vale`，占 sid 0–2；
 * 2. 再按编号升序遍历 `zf_001`–`zf_099`，**只收 `.pt` 文件真的存在的**，占 sid 3 起，实有 55 个；
 * 3. 最后按编号升序遍历 `zm_009`–`zm_100`，同样只收存在的，实有 45 个。
 *
 * `sid` 就是这个数组的下标。**编号是稀疏的**（zf 有 55 个但不是 001–055 连着，zm 同理），
 * 所以绝不能用「sid 减几」推名字，只能查这张表。
 *
 * ## 为什么单独一个文件
 *
 * 老版本（v1.0）只有 8 个音色、sid 45–52。换到 v1.1 之后，**同样一个 sid 指向的是完全不同的人**：
 * 老的 47 是晓晓，新的 47 是 `zf_083`。这中间不报错、不静音、不回落，用户只会觉得「声音变了」。
 * 把表钉成一份可测的数据，配 `test/seed/kokoro-voices.test.ts` 守着三件事：
 * 表长 103、sid 0–102 连续、`voices.bin` 的字节数除以每个 speaker 的字节数正好等于表长。
 * 以后谁换模型忘了换表，那条测试先红。
 *
 * 每个 speaker 在 `voices.bin` 里占 522240 字节 = 130560 个 float32，即一个 [510, 1, 256] 张量。
 */

/** `voices.bin` 里每个 speaker 占的字节数。[510, 1, 256] 的 float32。 */
export const KOKORO_V11_SPEAKER_BYTES = 522_240;

/** v1.1-zh 的 `voices.bin` 实测字节数（53,790,720 ÷ 522,240 = 103）。 */
export const KOKORO_V11_VOICES_BIN_BYTES = 53_790_720;

/** 表全长：3 英文 + 55 女声 + 45 男声。 */
export const KOKORO_V11_VOICE_COUNT = 103;

/** 默认音色。旧的默认 `zf_xiaoxiao` 在 v1.1 里没有，落在这里。 */
export const KOKORO_DEFAULT_VOICE = "zf_001";

/**
 * 老版本（v1.0）的 8 个音色。**只用来记录和迁移判断，不做映射。**
 *
 * v1.1 里这 8 个名字一个都不存在，所以「保持原样」在物理上做不到。
 * 留着这张表是为了事后能回答「我原来的声音去哪了」，以及测试里钉住
 * 「老 sid 在新表里指向的确实是另一个人」。
 */
export const KOKORO_OLD_VOICES = [
	{ id: 45, name: "zf_xiaobei", label: "晓北" },
	{ id: 46, name: "zf_xiaoni", label: "晓妮" },
	{ id: 47, name: "zf_xiaoxiao", label: "晓晓" },
	{ id: 48, name: "zf_xiaoyi", label: "晓伊" },
	{ id: 49, name: "zm_yunjian", label: "云健" },
	{ id: 50, name: "zm_yunxi", label: "云希" },
	{ id: 51, name: "zm_yunxia", label: "云夏" },
	{ id: 52, name: "zm_yunyang", label: "云扬" },
];

/** 103 个 speaker，下标即 sid。 */
export const KOKORO_V11_VOICES = [
	{ id: 0, name: "af_maple", label: "af_maple" },
	{ id: 1, name: "af_sol", label: "af_sol" },
	{ id: 2, name: "bf_vale", label: "bf_vale" },
	{ id: 3, name: "zf_001", label: "女声 001" },
	{ id: 4, name: "zf_002", label: "女声 002" },
	{ id: 5, name: "zf_003", label: "女声 003" },
	{ id: 6, name: "zf_004", label: "女声 004" },
	{ id: 7, name: "zf_005", label: "女声 005" },
	{ id: 8, name: "zf_006", label: "女声 006" },
	{ id: 9, name: "zf_007", label: "女声 007" },
	{ id: 10, name: "zf_008", label: "女声 008" },
	{ id: 11, name: "zf_017", label: "女声 017" },
	{ id: 12, name: "zf_018", label: "女声 018" },
	{ id: 13, name: "zf_019", label: "女声 019" },
	{ id: 14, name: "zf_021", label: "女声 021" },
	{ id: 15, name: "zf_022", label: "女声 022" },
	{ id: 16, name: "zf_023", label: "女声 023" },
	{ id: 17, name: "zf_024", label: "女声 024" },
	{ id: 18, name: "zf_026", label: "女声 026" },
	{ id: 19, name: "zf_027", label: "女声 027" },
	{ id: 20, name: "zf_028", label: "女声 028" },
	{ id: 21, name: "zf_032", label: "女声 032" },
	{ id: 22, name: "zf_036", label: "女声 036" },
	{ id: 23, name: "zf_038", label: "女声 038" },
	{ id: 24, name: "zf_039", label: "女声 039" },
	{ id: 25, name: "zf_040", label: "女声 040" },
	{ id: 26, name: "zf_042", label: "女声 042" },
	{ id: 27, name: "zf_043", label: "女声 043" },
	{ id: 28, name: "zf_044", label: "女声 044" },
	{ id: 29, name: "zf_046", label: "女声 046" },
	{ id: 30, name: "zf_047", label: "女声 047" },
	{ id: 31, name: "zf_048", label: "女声 048" },
	{ id: 32, name: "zf_049", label: "女声 049" },
	{ id: 33, name: "zf_051", label: "女声 051" },
	{ id: 34, name: "zf_059", label: "女声 059" },
	{ id: 35, name: "zf_060", label: "女声 060" },
	{ id: 36, name: "zf_067", label: "女声 067" },
	{ id: 37, name: "zf_070", label: "女声 070" },
	{ id: 38, name: "zf_071", label: "女声 071" },
	{ id: 39, name: "zf_072", label: "女声 072" },
	{ id: 40, name: "zf_073", label: "女声 073" },
	{ id: 41, name: "zf_074", label: "女声 074" },
	{ id: 42, name: "zf_075", label: "女声 075" },
	{ id: 43, name: "zf_076", label: "女声 076" },
	{ id: 44, name: "zf_077", label: "女声 077" },
	{ id: 45, name: "zf_078", label: "女声 078" },
	{ id: 46, name: "zf_079", label: "女声 079" },
	{ id: 47, name: "zf_083", label: "女声 083" },
	{ id: 48, name: "zf_084", label: "女声 084" },
	{ id: 49, name: "zf_085", label: "女声 085" },
	{ id: 50, name: "zf_086", label: "女声 086" },
	{ id: 51, name: "zf_087", label: "女声 087" },
	{ id: 52, name: "zf_088", label: "女声 088" },
	{ id: 53, name: "zf_090", label: "女声 090" },
	{ id: 54, name: "zf_092", label: "女声 092" },
	{ id: 55, name: "zf_093", label: "女声 093" },
	{ id: 56, name: "zf_094", label: "女声 094" },
	{ id: 57, name: "zf_099", label: "女声 099" },
	{ id: 58, name: "zm_009", label: "男声 009" },
	{ id: 59, name: "zm_010", label: "男声 010" },
	{ id: 60, name: "zm_011", label: "男声 011" },
	{ id: 61, name: "zm_012", label: "男声 012" },
	{ id: 62, name: "zm_013", label: "男声 013" },
	{ id: 63, name: "zm_014", label: "男声 014" },
	{ id: 64, name: "zm_015", label: "男声 015" },
	{ id: 65, name: "zm_016", label: "男声 016" },
	{ id: 66, name: "zm_020", label: "男声 020" },
	{ id: 67, name: "zm_025", label: "男声 025" },
	{ id: 68, name: "zm_029", label: "男声 029" },
	{ id: 69, name: "zm_030", label: "男声 030" },
	{ id: 70, name: "zm_031", label: "男声 031" },
	{ id: 71, name: "zm_033", label: "男声 033" },
	{ id: 72, name: "zm_034", label: "男声 034" },
	{ id: 73, name: "zm_035", label: "男声 035" },
	{ id: 74, name: "zm_037", label: "男声 037" },
	{ id: 75, name: "zm_041", label: "男声 041" },
	{ id: 76, name: "zm_045", label: "男声 045" },
	{ id: 77, name: "zm_050", label: "男声 050" },
	{ id: 78, name: "zm_052", label: "男声 052" },
	{ id: 79, name: "zm_053", label: "男声 053" },
	{ id: 80, name: "zm_054", label: "男声 054" },
	{ id: 81, name: "zm_055", label: "男声 055" },
	{ id: 82, name: "zm_056", label: "男声 056" },
	{ id: 83, name: "zm_057", label: "男声 057" },
	{ id: 84, name: "zm_058", label: "男声 058" },
	{ id: 85, name: "zm_061", label: "男声 061" },
	{ id: 86, name: "zm_062", label: "男声 062" },
	{ id: 87, name: "zm_063", label: "男声 063" },
	{ id: 88, name: "zm_064", label: "男声 064" },
	{ id: 89, name: "zm_065", label: "男声 065" },
	{ id: 90, name: "zm_066", label: "男声 066" },
	{ id: 91, name: "zm_068", label: "男声 068" },
	{ id: 92, name: "zm_069", label: "男声 069" },
	{ id: 93, name: "zm_080", label: "男声 080" },
	{ id: 94, name: "zm_081", label: "男声 081" },
	{ id: 95, name: "zm_082", label: "男声 082" },
	{ id: 96, name: "zm_089", label: "男声 089" },
	{ id: 97, name: "zm_091", label: "男声 091" },
	{ id: 98, name: "zm_095", label: "男声 095" },
	{ id: 99, name: "zm_096", label: "男声 096" },
	{ id: 100, name: "zm_097", label: "男声 097" },
	{ id: 101, name: "zm_098", label: "男声 098" },
	{ id: 102, name: "zm_100", label: "男声 100" },
];

/** 界面上只上中文：100 个（55 女 + 45 男）。3 个英文不露。 */
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
