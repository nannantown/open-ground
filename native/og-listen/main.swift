// og-listen — the floating assistant's ears (src/lib/server/assistantListen.ts).
// Free and local: macOS's own speech recognizer (on-device whenever the
// language supports it), so no paid voice API and no key. Prints one JSON
// object per line on stdout:
//   {"type":"ready"}                 listening
//   {"type":"partial","text":"…"}    what it has heard so far
//   {"type":"final","text":"…"}      one finished utterance (after a pause)
//   {"type":"error","reason":"denied"|"unavailable"|"failed"}  then exits
// Keeps listening, utterance after utterance, until killed or stdin closes
// (the parent died). `og-listen <locale> --file <audio>` recognizes one file
// and exits — the only way to check recognition without speaking.
//
// SFSpeechRecognizer, not SpeechAnalyzer: the release build runs on a macOS 14
// SDK. ponytail: switch to SpeechTranscriber (no speech-recognition prompt)
// once the release runner builds with the macOS 26 SDK.
import AVFoundation
import Foundation
import Speech

setvbuf(stdout, nil, _IOLBF, 0)

func emit(_ obj: [String: String]) {
  guard let data = try? JSONSerialization.data(withJSONObject: obj), let line = String(data: data, encoding: .utf8) else { return }
  print(line)
}

func fail(_ reason: String) -> Never {
  emit(["type": "error", "reason": reason])
  exit(2)
}

let args = CommandLine.arguments
let locale = Locale(identifier: args.count > 1 && !args[1].hasPrefix("-") ? args[1] : "ja-JP")
let fileArg: String? = args.firstIndex(of: "--file").flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil }
/** A pause this long after the last new word ends the utterance. */
let pauseSeconds = 1.2

guard let recognizer = SFSpeechRecognizer(locale: locale) else { fail("unavailable") }

// The parent going away closes our stdin: stop listening with it.
DispatchQueue.global().async {
  while readLine() != nil {}
  exit(0)
}


final class Listener {
  let recognizer: SFSpeechRecognizer
  let engine = AVAudioEngine()
  // Read by the audio thread (the tap), swapped on the main thread.
  private let lock = NSLock()
  private var _request: SFSpeechAudioBufferRecognitionRequest?
  var request: SFSpeechAudioBufferRecognitionRequest? {
    get { lock.lock(); defer { lock.unlock() }; return _request }
    set { lock.lock(); _request = newValue; lock.unlock() }
  }
  var heard = ""
  var pause: DispatchWorkItem?
  var begunAt = Date()
  /** Failures right after starting, in a row: a recognizer that cannot work at all. */
  var quickFails = 0

  init(_ recognizer: SFSpeechRecognizer) { self.recognizer = recognizer }

  func start() {
    startEngine()
    // Another mic plugged in (AirPods…) stops the engine silently: start it again.
    NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
      guard let self else { return }
      self.engine.stop()
      self.engine.inputNode.removeTap(onBus: 0)
      self.startEngine()
    }
    begin()
    emit(["type": "ready"])
  }

  func startEngine() {
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    // No input device at all (a desktop Mac without a mic): not a permission problem.
    guard format.sampleRate > 0, format.channelCount > 0 else { fail("unavailable") }
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buf, _ in
      self?.request?.append(buf)
    }
    engine.prepare()
    do { try engine.start() } catch { fail("failed") }
  }

  func begin() {
    let r = SFSpeechAudioBufferRecognitionRequest()
    r.shouldReportPartialResults = true
    if recognizer.supportsOnDeviceRecognition { r.requiresOnDeviceRecognition = true }
    if #available(macOS 13, *) { r.addsPunctuation = true }
    request = r
    heard = ""
    begunAt = Date()
    recognizer.recognitionTask(with: r) { [weak self] result, error in
      DispatchQueue.main.async { self?.handle(r, result, error) }
    }
  }

  func handle(_ r: SFSpeechAudioBufferRecognitionRequest, _ result: SFSpeechRecognitionResult?, _ error: Error?) {
    guard r === request else { return } // an utterance already handed on
    if let result {
      quickFails = 0
      let text = result.bestTranscription.formattedString
      if result.isFinal { return finish(text) }
      if text != heard {
        heard = text
        emit(["type": "partial", "text": text])
        pause?.cancel()
        // After the pause: close the utterance; if the recognizer never answers
        // that, hand on what was heard anyway.
        let w = DispatchWorkItem { [weak self] in
          r.endAudio()
          DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
            guard let self, r === self.request else { return }
            self.finish(self.heard)
          }
        }
        pause = w
        DispatchQueue.main.asyncAfter(deadline: .now() + pauseSeconds, execute: w)
      }
    } else if error != nil {
      let text = heard
      request = nil
      if !text.isEmpty { return finish(text) }
      // "No speech detected" after a quiet spell: start over. One that fails
      // straight away, again and again, cannot hear at all: say so, rather
      // than keep pulsing as if listening.
      quickFails = Date().timeIntervalSince(begunAt) < 2 ? quickFails + 1 : 0
      if !recognizer.isAvailable { fail("unavailable") }
      if quickFails >= 5 { fail("failed") }
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.begin() }
    }
  }

  func finish(_ text: String) {
    pause?.cancel()
    let line = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if !line.isEmpty { emit(["type": "final", "text": line]) }
    begin()
  }
}

func recognizeFile(_ path: String) {
  let r = SFSpeechURLRecognitionRequest(url: URL(fileURLWithPath: path))
  if recognizer.supportsOnDeviceRecognition { r.requiresOnDeviceRecognition = true }
  recognizer.recognitionTask(with: r) { result, error in
    if let result, result.isFinal {
      emit(["type": "final", "text": result.bestTranscription.formattedString])
      exit(0)
    }
    if error != nil { fail("failed") }
  }
}

let listener = Listener(recognizer)
SFSpeechRecognizer.requestAuthorization { status in
  DispatchQueue.main.async {
    guard status == .authorized else { fail("denied") }
    guard recognizer.isAvailable else { fail("unavailable") }
    if let fileArg { return recognizeFile(fileArg) }
    AVCaptureDevice.requestAccess(for: .audio) { granted in
      DispatchQueue.main.async { if granted { listener.start() } else { fail("denied") } }
    }
  }
}
dispatchMain()
