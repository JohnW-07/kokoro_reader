// Page summaries on Apple's on-device model (N9) for summary.py. Run as
// `swift apple_summary.swift`: one JSON request on stdin, {"instructions","text","max_tokens"},
// one JSON line out: {"ok":true,"summary","tokens_in","tokens_out"} or
// {"ok":false,"unavailable":Bool,"error"}. One process per request, so nothing stays resident;
// the caller owns the timeout. FoundationModels needs macOS 26 (token usage needs macOS 27).
import Foundation
import FoundationModels

let TEMPERATURE = 0.2

func emit(_ obj: [String: Any]) {
  let data = try! JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])
  print(String(data: data, encoding: .utf8)!)
  fflush(stdout)
}

func unavailableReason() -> String? {
  switch SystemLanguageModel.default.availability {
  case .available: return nil
  case .unavailable(.deviceNotEligible): return "this Mac cannot run Apple Intelligence"
  case .unavailable(.appleIntelligenceNotEnabled): return "Apple Intelligence is turned off in System Settings"
  case .unavailable(.modelNotReady): return "the Apple Intelligence model is still downloading"
  case .unavailable: return "the Apple on-device model is unavailable"
  }
}

func summarize(instructions: String, text: String, maxTokens: Int) async -> [String: Any] {
  if let reason = unavailableReason() { return ["ok": false, "unavailable": true, "error": reason] }
  let session = LanguageModelSession(instructions: instructions)
  let options = GenerationOptions(temperature: TEMPERATURE, maximumResponseTokens: maxTokens)
  do {
    let response = try await session.respond(to: text, options: options)
    var reply: [String: Any] = ["ok": true, "summary": response.content, "tokens_in": 0, "tokens_out": 0]
    if #available(macOS 27.0, *) {
      reply["tokens_in"] = response.usage.input.totalTokenCount
      reply["tokens_out"] = response.usage.output.totalTokenCount
    }
    return reply
  } catch {
    return ["ok": false, "unavailable": false, "error": "\(error)"]
  }
}

let input = FileHandle.standardInput.readDataToEndOfFile()
guard let req = try? JSONSerialization.jsonObject(with: input) as? [String: Any],
      let instructions = req["instructions"] as? String, let text = req["text"] as? String,
      let maxTokens = (req["max_tokens"] as? NSNumber)?.intValue
else {
  emit(["ok": false, "unavailable": false, "error": "bad request"])
  exit(2)
}
emit(await summarize(instructions: instructions, text: text, maxTokens: maxTokens))
