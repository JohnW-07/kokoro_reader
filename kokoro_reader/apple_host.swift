// Siri-voice host for apple_engine.py. Run as `swift -O apple_host.swift serve`: the swift
// interpreter is Apple-signed, and only Apple-signed processes can see the Siri natural voices
// (an ad-hoc `swiftc` binary cannot). One JSON request per stdin line,
// {"voice","text","out","rate"?} → one JSON result line {"ok","sr","audio_s","error"?}.
// Measured in ~/local/apple-tts-lab (tts.swift is the full probe this is trimmed from).
import AVFoundation

let TIMEOUT_S = 120.0
let IDLE_END_S = 3.0  // fallback end-of-utterance if the delegate never reports didFinish

final class FinishWatcher: NSObject, AVSpeechSynthesizerDelegate {
  var finished = false
  func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) { finished = true }
}

let synth = AVSpeechSynthesizer()
let finishWatcher = FinishWatcher()
synth.delegate = finishWatcher

func emit(_ obj: [String: Any]) {
  let data = try! JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])
  print(String(data: data, encoding: .utf8)!)
  fflush(stdout)
}

func synthesize(voiceId: String, text: String, outPath: String, rate: Float?) -> [String: Any] {
  guard let voice = AVSpeechSynthesisVoice(identifier: voiceId) else { return ["ok": false, "error": "unknown voice: \(voiceId)"] }
  let utterance = AVSpeechUtterance(string: text)
  utterance.voice = voice
  if let rate { utterance.rate = rate }

  var file: AVAudioFile?, frames: AVAudioFrameCount = 0, sampleRate = 0.0, emptyBuffers = 0
  var writeError: String?, lastBufferAt = Date()
  finishWatcher.finished = false
  synth.write(utterance) { buffer in
    guard let pcm = buffer as? AVAudioPCMBuffer else { return }
    lastBufferAt = Date()
    if pcm.frameLength == 0 { emptyBuffers += 1; return }  // also emitted mid-utterance, at segment boundaries
    do {
      if file == nil {
        sampleRate = pcm.format.sampleRate
        file = try AVAudioFile(forWriting: URL(fileURLWithPath: outPath), settings: pcm.format.settings,
                               commonFormat: pcm.format.commonFormat, interleaved: pcm.format.isInterleaved)
      }
      try file!.write(from: pcm)
      frames += pcm.frameLength
    } catch { writeError = "\(error)" }
  }
  // write() delivers its callbacks on the main run loop, so it has to be spun here.
  let deadline = Date().addingTimeInterval(TIMEOUT_S)
  func isIdleEnd() -> Bool { emptyBuffers > 0 && Date().timeIntervalSince(lastBufferAt) > IDLE_END_S }
  while !finishWatcher.finished && !isIdleEnd() && writeError == nil && Date() < deadline {
    RunLoop.main.run(until: Date().addingTimeInterval(0.02))
  }
  file = nil  // closes the file before the caller reads it
  let isDone = finishWatcher.finished || isIdleEnd()
  var result: [String: Any] = ["ok": isDone && writeError == nil && frames > 0, "sr": sampleRate,
                               "audio_s": sampleRate > 0 ? Double(frames) / sampleRate : 0]
  if let writeError { result["error"] = writeError }
  else if !isDone { result["error"] = "timeout after \(TIMEOUT_S)s" }
  else if frames == 0 { result["error"] = "no audio" }
  return result
}

guard CommandLine.arguments.dropFirst().first == "serve" else {
  FileHandle.standardError.write("usage: swift apple_host.swift serve\n".data(using: .utf8)!)
  exit(2)
}
while let line = readLine() {
  guard let data = line.data(using: .utf8),
        let req = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let voiceId = req["voice"] as? String, let text = req["text"] as? String, let out = req["out"] as? String
  else { emit(["ok": false, "error": "bad request"]); continue }
  emit(synthesize(voiceId: voiceId, text: text, outPath: out, rate: (req["rate"] as? NSNumber)?.floatValue))
}
