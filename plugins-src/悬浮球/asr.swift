// 悬浮球的本地转写器：一段录音 → 一行文字。
//
// 用 macOS 26 的 SpeechAnalyzer（系统自带的端侧模型），不联网、不要 API key。
// 由 plugin.js 在第一次转写时用 `swiftc` 编到临时目录，之后复用。
//
// 用法：solo-asr <audio-file> [locale]
// 成功：stdout 一行文字，退出码 0
// 失败：stderr 一句人话，退出码 3（模型不可用）/ 4（语言不支持）/ 1（转写失败）

import AVFoundation
import Foundation
import Speech

@main
struct Main {
	static func main() async {
		let args = CommandLine.arguments
		guard args.count > 1 else { fail(64, "用法：solo-asr <audio-file> [locale]") }
		let path = args[1]
		let requested = args.count > 2 ? args[2] : "zh-CN"

		do {
			guard SpeechTranscriber.isAvailable else {
				fail(3, "这台机器上的语音模型不可用（需要 macOS 26 或更新）")
			}

			// 浏览器给的是 BCP-47（zh-CN / en-US）；系统只认它自己有的那几种。
			var locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: requested))
			if locale == nil {
				locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: "zh-CN"))
			}
			guard let chosen = locale else { fail(4, "系统没有可用的转写语言") }

			let transcriber = SpeechTranscriber(locale: chosen, preset: .transcription)

			// 第一次用要下载语言模型（几百 MB 以内），之后一直命中本地。
			if await AssetInventory.status(forModules: [transcriber]) != .installed {
				if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
					FileHandle.standardError.write("正在下载语音模型…\n".data(using: .utf8)!)
					try await request.downloadAndInstall()
				}
			}

			let file = try AVAudioFile(forReading: URL(fileURLWithPath: path))
			let analyzer = SpeechAnalyzer(modules: [transcriber])
			try await analyzer.start(inputAudioFile: file, finishAfterFile: true)

			var text = ""
			for try await result in transcriber.results {
				text += String(result.text.characters)
			}
			print(text.trimmingCharacters(in: .whitespacesAndNewlines))
		} catch {
			fail(1, "转写失败：\(error.localizedDescription)")
		}
	}

	static func fail(_ code: Int32, _ message: String) -> Never {
		FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
		exit(code)
	}
}
