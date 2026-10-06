// og-listen — the floating assistant's ears (src/lib/server/assistantListen.ts).
// Free and local: macOS's own speech recognizer (on-device whenever the
// language supports it), so no paid voice API and no key. Prints one JSON
// object per line on stdout:
//   {"type":"ready"}                 listening
//   {"type":"partial","text":"…"}    what it has heard so far
//   {"type":"final","text":"…"}      one finished utterance (after a pause —
//                                    short after a finished sentence, long after
//                                    a dangling particle: pauseFor)
//   {"type":"error","reason":"denied"|"unavailable"|"failed"}  then exits
// Keeps listening, utterance after utterance, until killed or stdin closes
// (the parent died). `og-listen <locale> --file <audio>` recognizes one file
// and exits — the only way to check recognition without speaking.
// `og-listen <locale> --feed <audio>` listens as from the mic but to the file,
// played in at real time and then silence, with {"type":"fed"} the moment its
// last sample is in: how long the end of speech takes to become "final", on
// this Mac's recognizer, without a speaker or a mic (scripts/measure-voice-latency.mjs).
//
// SFSpeechRecognizer, not SpeechAnalyzer: the release build runs on a macOS 14
// SDK. ponytail: switch to SpeechTranscriber (no speech-recognition prompt)
// once the release runner builds with the macOS 26 SDK.
import AVFoundation
import CoreAudio
import Foundation
import IOKit
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
// Checks without listening: `--choose <default channels> <built-in 0|1> <lid shut 0|1> [<default is built-in 0|1>]`
// prints the rule's answer; `--which` prints what this Mac would listen on now.
if let i = args.firstIndex(of: "--choose"), i + 3 < args.count, let ch = Int(args[i + 1]) {
  let defaultIsBuiltIn = i + 4 < args.count && args[i + 4] == "1"
  emit(["type": "choice", "device": chooseInput(defaultChannels: ch, defaultIsBuiltIn: defaultIsBuiltIn, hasBuiltIn: args[i + 2] == "1", lidClosed: args[i + 3] == "1")])
  exit(0)
}
// `--pause <words>` prints how long a pause would end them (no listening).
if let i = args.firstIndex(of: "--pause"), i + 1 < args.count {
  emit(["type": "pause", "seconds": String(pauseFor(args[i + 1]))])
  exit(0)
}
let feedArg: String? = args.firstIndex(of: "--feed").flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil }
if args.contains("--which") {
  let d = pickInput()
  emit(["type": "which", "device": deviceName(d), "channels": String(inputChannels(d)), "lidClosed": String(lidClosed())])
  exit(0)
}

/** How long a pause after the last new word ends the utterance, by how the
 *  words end (owner 2026-10-07: answer as soon as a person would). A finished
 *  sentence — a full stop, or a Japanese sentence ending — is answered after a
 *  short pause; a dangling particle or conjunction (「〜で」「〜けど」, "and")
 *  waits longer, the owner is still mid-thought; anything else in between.
 *  The pause is counted from the last NEW word the recognizer reported, which
 *  itself trails the voice by a moment, so the silence heard is a bit longer.
 *  ponytail: a word list, not a model; a misread ending costs the middle value. */
func pauseFor(_ text: String) -> Double {
  let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
  let lower = t.lowercased()
  if t.range(of: "(、|,|けど|けれど|から|ので|のに|たら|れば|とか|[はがをにでとへもやし])$", options: .regularExpression) != nil { return 1.4 }
  if lower.range(of: "\\b(and|but|so|or|because|the|a|an|to|of|with|um|uh|if|then)$", options: .regularExpression) != nil { return 1.4 }
  // Not a lone 「ね」「か」: 「あのね」「なにか」「どこか」 are how a thought starts.
  if t.range(of: "([。．？！?!.]|です|ます|ました|でした|ません|ですか|ますか|ください|ちょうだい|お願い|よね|かな|だっけ|だよ|だね|よ)$", options: .regularExpression) != nil { return 0.5 }
  return 0.8
}

guard let recognizer = SFSpeechRecognizer(locale: locale) else { fail("unavailable") }

// The parent going away closes our stdin: stop listening with it.
DispatchQueue.global().async {
  while readLine() != nil {}
  exit(0)
}


// Which microphone. The system's default input, unless it is a multi-channel
// audio interface (an RME Babyface reports 12 inputs): those are set up for
// recording, their channels are usually silent when nobody sits at the mic,
// and the owner talking to the Mac is heard by the Mac's own mic instead
// (measured 2026-10-06: Babyface peak 0.0001 vs built-in 0.0875 for the same
// voice). A headset or a USB mic (1–2 inputs) set as default still wins.
// ponytail: a fixed rule; a "which mic" setting if someone needs the interface.
/** A UInt32 property (a device id, a transport type), 0 when unreadable. */
func prop(_ id: AudioObjectID, _ sel: AudioObjectPropertySelector) -> UInt32 {
  var a = AudioObjectPropertyAddress(mSelector: sel, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var v: UInt32 = 0
  var size = UInt32(MemoryLayout<UInt32>.size)
  return AudioObjectGetPropertyData(id, &a, 0, nil, &size, &v) == noErr ? v : 0
}

func inputChannels(_ d: AudioDeviceID) -> Int {
  var a = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreamConfiguration, mScope: kAudioDevicePropertyScopeInput, mElement: kAudioObjectPropertyElementMain)
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(d, &a, 0, nil, &size) == noErr, size > 0 else { return 0 }
  let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
  defer { raw.deallocate() }
  guard AudioObjectGetPropertyData(d, &a, 0, nil, &size, raw) == noErr else { return 0 }
  return UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self)).reduce(0) { $0 + Int($1.mNumberChannels) }
}

/** A MacBook's lid is shut (clamshell, an external display): its built-in mic
 *  is still listed but hears nothing. IOPMrootDomain's AppleClamshellState;
 *  false where there is no lid (or it cannot be read). */
func lidClosed() -> Bool {
  let root = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOPMrootDomain"))
  guard root != 0 else { return false }
  defer { IOObjectRelease(root) }
  return (IORegistryEntryCreateCFProperty(root, "AppleClamshellState" as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue() as? Bool) ?? false
}

/** The rule, on its own so it can be tested (`og-listen --choose`):
 *  "builtin" only when the default is a multi-channel interface, there is a
 *  built-in mic, and the lid is open; "elsewhere" when the default IS the
 *  built-in mic and the lid is shut (another mic, or none); else "default".
 *  A shut lid's mic would say "ready" and stay silent forever — the very
 *  symptom this rule is for. */
func chooseInput(defaultChannels: Int, defaultIsBuiltIn: Bool, hasBuiltIn: Bool, lidClosed: Bool) -> String {
  if lidClosed && defaultIsBuiltIn { return "elsewhere" }
  return defaultChannels > 2 && hasBuiltIn && !lidClosed ? "builtin" : "default"
}

func isBuiltIn(_ d: AudioDeviceID) -> Bool { prop(d, kAudioDevicePropertyTransportType) == kAudioDeviceTransportTypeBuiltIn }

func inputDevices() -> [AudioDeviceID] {
  let system = AudioObjectID(kAudioObjectSystemObject)
  var a = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(system, &a, 0, nil, &size) == noErr else { return [] }
  var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
  guard AudioObjectGetPropertyData(system, &a, 0, nil, &size, &ids) == noErr else { return [] }
  return ids.filter { inputChannels($0) > 0 }
}

func builtInMic() -> AudioDeviceID? { inputDevices().first(where: isBuiltIn) }

/** The device to listen on, chosen afresh at every (re)start and checked every
 *  2 s while listening (Listener.watch) — so switching the default to a headset
 *  later, or opening/shutting the lid, is followed. 0 = no usable input.
 *  ponytail: a Mac mini's built-in line-in counts as built-in; not checked. */
func pickInput() -> AudioDeviceID {
  let def = prop(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultInputDevice)
  guard def != 0 else { return 0 }
  let builtIn = builtInMic()
  switch chooseInput(defaultChannels: inputChannels(def), defaultIsBuiltIn: isBuiltIn(def), hasBuiltIn: builtIn != nil, lidClosed: lidClosed()) {
  case "builtin": return builtIn ?? def
  case "elsewhere": return inputDevices().first { !isBuiltIn($0) } ?? 0
  default: return def
  }
}

func deviceName(_ d: AudioDeviceID) -> String {
  var a = AudioObjectPropertyAddress(mSelector: kAudioObjectPropertyName, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var name: Unmanaged<CFString>?
  var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
  guard AudioObjectGetPropertyData(d, &a, 0, nil, &size, &name) == noErr, let n = name else { return "" }
  return n.takeRetainedValue() as String
}


/** One channel for the recognizer. An interface's inputs are summed (the voice
 *  sits on one of them, the rest are silent); a stereo mic is averaged (summing
 *  its two copies of the same voice would double it into clipping). */
func mono(_ buf: AVAudioPCMBuffer, _ format: AVAudioFormat) -> AVAudioPCMBuffer? {
  guard buf.format.channelCount > 1 else { return buf }
  guard let src = buf.floatChannelData, let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: buf.frameLength), let dst = out.floatChannelData?[0] else { return nil }
  out.frameLength = buf.frameLength
  for i in 0..<Int(buf.frameLength) {
    var v: Float = 0
    for c in 0..<Int(buf.format.channelCount) { v += src[c][i] }
    dst[i] = buf.format.channelCount > 2 ? max(-1, min(1, v)) : v / 2
  }
  return out
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
  var task: SFSpeechRecognitionTask?
  var begunAt = Date()
  /** Failures right after starting, in a row: a recognizer that cannot work at all. */
  var quickFails = 0

  /** The device the engine was last started on. */
  var using: AudioDeviceID = 0

  init(_ recognizer: SFSpeechRecognizer) { self.recognizer = recognizer }

  func restart(_ why: String) {
    // On stderr (the app ignores it): lets a check count restarts — setting the
    // device must not raise another change and loop.
    FileHandle.standardError.write(Data("og-listen: restart (\(why))\n".utf8))
    engine.stop()
    engine.inputNode.removeTap(onBus: 0)
    startEngine()
  }

  /** Shutting the lid raises no audio notification (the built-in mic stays
   *  listed), so look every 2 s whether the rule now picks another input. */
  func watch() {
    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
      guard let self else { return }
      if pickInput() != self.using { self.restart("input changed") }
      self.watch()
    }
  }

  func start() {
    if let feedArg { return feed(feedArg) }
    startEngine()
    watch()
    // Another mic plugged in (AirPods…) stops the engine silently: start it again.
    NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
      self?.restart("audio configuration changed")
    }
    begin()
    emit(["type": "ready"])
  }

  func startEngine() {
    let input = engine.inputNode
    // Set only when it differs: setting the same device again would raise
    // another configuration change and restart us in a loop.
    var device = pickInput()
    // Nothing that can hear (no mic, or only a shut lid's): say so, not "ready".
    guard device != 0 else { fail("unavailable") }
    using = device
    if let unit = input.audioUnit {
      var current: AudioDeviceID = 0
      var size = UInt32(MemoryLayout<AudioDeviceID>.size)
      AudioUnitGetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &current, &size)
      if current != device {
        AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &device, UInt32(MemoryLayout<AudioDeviceID>.size))
      }
    }
    // inputFormat, not outputFormat: after a device switch only it is current.
    let format = input.inputFormat(forBus: 0)
    // No input device at all (a desktop Mac without a mic): not a permission problem.
    guard format.sampleRate > 0, format.channelCount > 0,
      let one = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: format.sampleRate, channels: 1, interleaved: false)
    else { fail("unavailable") }
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buf, _ in
      if let m = mono(buf, one) { self?.request?.append(m) }
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
    task = recognizer.recognitionTask(with: r) { [weak self] result, error in
      DispatchQueue.main.async { self?.handle(r, result, error) }
    }
  }

  /** --feed: the file instead of the mic, at real time in 0.1 s pieces, then silence. */
  func feed(_ path: String) {
    guard let file = try? AVAudioFile(forReading: URL(fileURLWithPath: path)),
      let all = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)),
      (try? file.read(into: all)) != nil,
      let one = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: file.processingFormat.sampleRate, channels: 1, interleaved: false),
      let m = mono(all, one), let src = m.floatChannelData?[0]
    else { fail("failed") }
    let step = AVAudioFrameCount(one.sampleRate / 10)
    var at: AVAudioFrameCount = 0
    var fed = false
    let timer = DispatchSource.makeTimerSource(queue: .main)
    timer.schedule(deadline: .now(), repeating: 0.1)
    timer.setEventHandler { [weak self] in
      guard let piece = AVAudioPCMBuffer(pcmFormat: one, frameCapacity: step), let dst = piece.floatChannelData?[0] else { return }
      piece.frameLength = step
      let n = at < m.frameLength ? min(step, m.frameLength - at) : 0
      for i in 0..<Int(step) { dst[i] = i < Int(n) ? src[Int(at) + i] : 0 }
      at += n
      self?.request?.append(piece)
      if !fed && at >= m.frameLength {
        fed = true
        emit(["type": "fed"])
      }
    }
    timer.resume()
    feeding = timer
    begin()
    emit(["type": "ready"])
  }
  var feeding: DispatchSourceTimer?

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
        // After the pause the words heard so far ARE the utterance: handed on at
        // once. (Before 2026-10-07 it then closed the audio and waited — up to
        // 3 s — for the recognizer's own "final", which only re-says them.)
        let w = DispatchWorkItem { [weak self] in
          guard let self, r === self.request else { return }
          self.finish(self.heard)
        }
        pause = w
        DispatchQueue.main.asyncAfter(deadline: .now() + pauseFor(text), execute: w)
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
    // The utterance is over: its recognition stops (what it would still say is not listened to).
    request?.endAudio()
    task?.cancel()
    let line = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if !line.isEmpty { emit(["type": "final", "text": line]) }
    begin()
  }
}

// Fed through mono() like the mic, so a test can check that a voice on any
// channel of a multi-channel recording is heard (og-listen.test.ts).
func recognizeFile(_ path: String) {
  guard let file = try? AVAudioFile(forReading: URL(fileURLWithPath: path)),
    let all = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)),
    (try? file.read(into: all)) != nil,
    let one = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: file.processingFormat.sampleRate, channels: 1, interleaved: false),
    let m = mono(all, one)
  else { fail("failed") }
  let r = SFSpeechAudioBufferRecognitionRequest()
  if recognizer.supportsOnDeviceRecognition { r.requiresOnDeviceRecognition = true }
  recognizer.recognitionTask(with: r) { result, error in
    if let result, result.isFinal {
      emit(["type": "final", "text": result.bestTranscription.formattedString])
      exit(0)
    }
    if error != nil { fail("failed") }
  }
  r.append(m)
  r.endAudio()
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
