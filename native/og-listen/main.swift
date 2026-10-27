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
// `og-listen <locale> --call` is also the call's VOICE (owner 2026-10-07, talking
// over the assistant): it reads aloud what stdin asks, one JSON per line —
//   {"say":"…","id":"3","lang":"ja-JP"}  read it after what is already queued
//   {"stop":true}  quiet now (then a "say" in the same line starts afresh)
//   {"mute":true|false}  hear nothing / hear again
//   {"pause":true} / {"resume":true}  hold the reading (someone may be talking) / go on
//   {"forget":true}  drop the words being heard (scraps of its own voice)
// through the SAME audio engine it listens on, with Apple's voice processing on,
// so its own voice is taken out of what the mic hears (WWDC19 510: only audio
// that engine plays is the echo reference; another app's is only ducked —
// WWDC23 10235). It then also prints
//   {"type":"ready","echo":"on"|"apart"|"off"}   see Listener.echoMode
//   {"type":"speak","id":"3"} / {"type":"spoke","id":"3"}   heard now / read to the end
//   {"type":"level","level":-31}   the mic every 0.1 s while it reads (dBFS)
//   {"type":"paused"} / {"type":"resumed"}   as asked
// and partial/final carry "level": the mic's recent peak after echo removal, in
// dBFS. `--call --feed <audio>` (a mono file at the mic's rate) adds the file to
// what the mic hears from the moment stdin says {"feed":true} ({"type":"fed"}
// then): a voice talking over the reading, on a Mac where nobody can speak
// (scripts/measure-barge-in.mts). Whether heard words count while it reads is the server's call
// (assistantListen.ts isBargeIn). Plain listening (typing by voice) never turns
// voice processing on: it ducks other apps' sound (music production), so it is
// on only while a call is.
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

func emit(_ obj: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: obj), let line = String(data: data, encoding: .utf8) else { return }
  print(line)
}

func fail(_ reason: String) -> Never {
  emit(["type": "error", "reason": reason])
  exit(2)
}

let args = CommandLine.arguments
let locale = Locale(identifier: args.count > 1 && !args[1].hasPrefix("-") ? args[1] : "ja-JP")
let callMode = args.contains("--call")
let fileArg: String? = args.firstIndex(of: "--file").flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil }
/** `--voicevox <dir>`: the call's VOICEVOX voices are made from there (Vox). */
let vox: Vox? = args.firstIndex(of: "--voicevox").flatMap { $0 + 1 < args.count ? Vox(dir: args[$0 + 1]) : nil }
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
// `--parts <text>` prints the pieces VOICEVOX would make it in (vvParts; null = the system voice reads it).
if let i = args.firstIndex(of: "--parts"), i + 1 < args.count {
  emit(["type": "parts", "parts": vvParts(args[i + 1]) as Any? ?? NSNull()])
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

// The parent going away closes our stdin: stop listening with it. In a call
// stdin also carries what to say (Voice.handle). --tts listens to nothing and ends by itself.
if !args.contains("--tts") {
  DispatchQueue.global().async {
    while let line = readLine() {
      guard callMode, let data = line.data(using: .utf8), let cmd = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
      DispatchQueue.main.async { listener.command(cmd) }
    }
    exit(0)
  }
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

/** VOICEVOX core 0.17.0 — the call's Nemo / 冥鳴ひまり (owner 2026-10-27: the
 *  iPhone's voices, made on this Mac). Not linked nor shipped: opened by path
 *  from `dir`, where src/lib/server/voicevox.ts puts the library, ONNX Runtime,
 *  the dictionary and the voices (voicevox.h has the declarations). Everything
 *  native runs on its own queue, one call at a time (a model is never used twice
 *  at once); `wav` takes about a short sentence. One voice resident (about
 *  0.5 GB), two for a moment while a switch loads the new one. Only `warm` loads:
 *  `wav` reads with the loaded voice or not at all, so no line ever waits seconds
 *  for a load. nil = not now: the system voice reads that line, never silence. */
final class Vox {
  let dir: String
  private let queue = DispatchQueue(label: "voicevox", qos: .userInitiated)
  /** The newest warm asked for (main thread writes, the queue reads): an older one still waiting is
   *  skipped. `settled` = the last one through the queue; while they differ a load is waiting or under
   *  way, and `wav` answers nil at once instead of queueing behind it. */
  private let asked = NSLock()
  private var newest = 0
  private var settled = 0
  // `queue` only:
  private var api: API?
  private var broken = false // the library, ONNX Runtime, the dictionary or the engine would not start: the system voice until the call ends
  private var ort: OpaquePointer?
  private var jtalk: OpaquePointer?
  private var synth: OpaquePointer?
  private var model: String?
  /** Voices that would not load: not tried again this call (each try costs seconds before the system voice reads). */
  private var failed: Set<String> = []

  init(dir: String) { self.dir = dir }

  struct API {
    let ortOptions: vv_make_default_load_onnxruntime_options
    let ortLoad: vv_onnxruntime_load_once
    let jtalkNew: vv_open_jtalk_rc_new
    let initOptions: vv_make_default_initialize_options
    let synthNew: vv_synthesizer_new
    let synthDelete: vv_synthesizer_delete
    let fileOpen: vv_voice_model_file_open
    let fileDelete: vv_voice_model_file_delete
    let modelOptions: vv_make_default_load_voice_model_options
    let loadModel: vv_synthesizer_load_voice_model
    let ttsOptions: vv_make_default_tts_options
    let tts: vv_synthesizer_tts
    let wavFree: vv_wav_free
    let message: vv_error_result_to_message

    init?(_ h: UnsafeMutableRawPointer) {
      func f<T>(_ name: String) -> T? { dlsym(h, name).map { unsafeBitCast($0, to: T.self) } }
      guard let a: vv_make_default_load_onnxruntime_options = f("voicevox_make_default_load_onnxruntime_options"),
        let b: vv_onnxruntime_load_once = f("voicevox_onnxruntime_load_once"),
        let c: vv_open_jtalk_rc_new = f("voicevox_open_jtalk_rc_new"),
        let d: vv_make_default_initialize_options = f("voicevox_make_default_initialize_options"),
        let e: vv_synthesizer_new = f("voicevox_synthesizer_new"),
        let g: vv_synthesizer_delete = f("voicevox_synthesizer_delete"),
        let i: vv_voice_model_file_open = f("voicevox_voice_model_file_open"),
        let j: vv_voice_model_file_delete = f("voicevox_voice_model_file_delete"),
        let k: vv_make_default_load_voice_model_options = f("voicevox_make_default_load_voice_model_options"),
        let l: vv_synthesizer_load_voice_model = f("voicevox_synthesizer_load_voice_model"),
        let m: vv_make_default_tts_options = f("voicevox_make_default_tts_options"),
        let n: vv_synthesizer_tts = f("voicevox_synthesizer_tts"),
        let o: vv_wav_free = f("voicevox_wav_free"),
        let p: vv_error_result_to_message = f("voicevox_error_result_to_message")
      else { return nil }
      (ortOptions, ortLoad, jtalkNew, initOptions, synthNew, synthDelete) = (a, b, c, d, e, g)
      (fileOpen, fileDelete, modelOptions, loadModel, ttsOptions, tts, wavFree, message) = (i, j, k, l, m, n, o, p)
    }
  }

  /** Loads `name` (seconds) — the only way a voice gets loaded — then says {"type":"warmed"} (or
   *  calls `done`): the server sends lines to a voice only after that (assistantListen.ts). A warm
   *  with a newer one behind it is skipped (quick switches A→B→A: no stale load, no stale warmed). */
  func warm(_ name: String, _ done: ((Bool) -> Void)? = nil) {
    asked.lock()
    newest += 1
    let mine = newest
    asked.unlock()
    queue.async {
      self.asked.lock()
      let stale = mine != self.newest
      self.asked.unlock()
      let ok = !stale && self.load(name)
      self.asked.lock()
      self.settled = mine
      self.asked.unlock()
      DispatchQueue.main.async {
        if let done { return done(ok) }
        if ok { emit(["type": "warmed", "model": name]) }
      }
    }
  }

  /** One line in `name`'s voice `style`, as a WAV, on the main thread. nil = not now — also when
   *  `name` is not the loaded voice or a warm is waiting (a switch underway): never loaded here, never
   *  queued behind a load — the system voice reads it. */
  func wav(_ text: String, model name: String, style: UInt32, _ done: @escaping (Data?) -> Void) {
    asked.lock()
    let switching = settled != newest
    asked.unlock()
    if switching { return DispatchQueue.main.async { done(nil) } }
    queue.async {
      var out: Data?
      if !self.broken, self.model == name, let api = self.api, let synth = self.synth {
        var length: UInt = 0
        var bytes: UnsafeMutablePointer<UInt8>?
        let r = text.withCString { api.tts(synth, $0, style, api.ttsOptions(), &length, &bytes) }
        if r == 0, let bytes {
          out = Data(bytes: bytes, count: Int(length))
          api.wavFree(bytes)
        } else { self.note("tts", r) }
      }
      DispatchQueue.main.async { done(out) }
    }
  }

  private func note(_ what: String, _ r: Int32) {
    let m = api.flatMap { $0.message(r) }.map { String(cString: $0) } ?? "\(r)"
    FileHandle.standardError.write("voicevox \(what): \(m)\n".data(using: .utf8)!)
  }

  /** `queue` only. The synthesizer with `name` in it; false = cannot now. */
  private func load(_ name: String) -> Bool {
    if broken { return false }
    if api == nil {
      guard let h = dlopen("\(dir)/libvoicevox_core.dylib", RTLD_NOW | RTLD_LOCAL), let a = API(h) else {
        broken = true
        FileHandle.standardError.write("voicevox: \(String(cString: dlerror()))\n".data(using: .utf8)!)
        return false
      }
      api = a
    }
    guard let api else { return false }
    if ort == nil {
      var o = api.ortOptions()
      let r = "\(dir)/libvoicevox_onnxruntime.dylib".withCString { path -> Int32 in
        o.filename = path
        return api.ortLoad(o, &ort)
      }
      guard r == 0, ort != nil else { broken = true; note("onnxruntime", r); return false }
    }
    if jtalk == nil {
      let r = api.jtalkNew("\(dir)/open_jtalk_dic_utf_8-1.11", &jtalk)
      guard r == 0 else { broken = true; note("dictionary", r); return false }
    }
    if synth != nil, model == name { return true }
    if failed.contains(name) { return false }
    // Into a synthesizer of its own: the loaded voice (another picked mid-call) is let go only once
    // this one is in, so a voice that cannot be read leaves it in place.
    var file: OpaquePointer?
    var r = api.fileOpen("\(dir)/\(name)", &file)
    defer { if let file { api.fileDelete(file) } }
    guard r == 0 else { failed.insert(name); note("model \(name)", r); return false }
    var fresh: OpaquePointer?
    r = api.synthNew(ort, jtalk, api.initOptions(), &fresh)
    guard r == 0, let fresh else { broken = true; note("engine", r); return false }
    r = api.loadModel(fresh, file, api.modelOptions())
    guard r == 0 else { api.synthDelete(fresh); failed.insert(name); note("model \(name)", r); return false }
    if let synth { api.synthDelete(synth) }
    synth = fresh
    model = name
    return true
  }
}

/** A VOICEVOX line in pieces of at most `VVPiece.part` characters, cut after 、。！？ and the like: each
 *  piece is made on its own, so a stop leaves at most one short piece being made (a render cannot
 *  be cancelled) and the next answer is not kept waiting behind a long line. nil = a stretch with
 *  no break longer than `VVPiece.longest`: the system voice reads the line. ponytail: fixed lengths,
 *  measured 2026-10-27 (scripts/measure-voice-first.mts); a setting if another Mac needs another. */
enum VVPiece {
  static let part = 12
  /// A stretch with no break longer than this goes to the system voice (its render would hold a stop up).
  static let longest = 48
}
func vvParts(_ text: String) -> [String]? {
  let chars = Array(text)
  var clauses: [String] = []
  var cur = ""
  for (i, ch) in chars.enumerated() {
    // A closing bracket right after a break belongs to the piece it closes (「了解しました。」).
    if cur.isEmpty, !clauses.isEmpty, "」』）)】〉》\"'”’".contains(ch) {
      clauses[clauses.count - 1].append(ch)
      continue
    }
    cur.append(ch)
    // Full-width marks and ! ? always (never inside a number); half-width , . ; : only before a space
    // or the end, so 1,234 / 10:30 / 3.5 stay whole.
    let last = i + 1 == chars.count || chars[i + 1].isWhitespace
    if "、。，．！？；：\n!?".contains(ch) || (",.;:".contains(ch) && last) {
      clauses.append(cur)
      cur = ""
    }
  }
  if !cur.isEmpty { clauses.append(cur) }
  var parts: [String] = []
  for c in clauses {
    if c.count > VVPiece.longest { return nil }
    // Joined up to VVPiece.part, never across a sentence end (its fall in pitch belongs at the end of a piece).
    if let last = parts.last, let end = last.last, !"。．！？!?\n".contains(end), last.count + c.count <= VVPiece.part {
      parts[parts.count - 1] = last + c
    } else {
      parts.append(c)
    }
  }
  parts = parts.filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
  return parts.isEmpty ? nil : parts
}

/** A 16-bit mono WAV (what VOICEVOX makes: 24 kHz) as a float buffer at its own rate. */
func pcm(wav: Data) -> AVAudioPCMBuffer? {
  let b = [UInt8](wav)
  func u16(_ i: Int) -> Int { Int(b[i]) | Int(b[i + 1]) << 8 }
  func u32(_ i: Int) -> Int { u16(i) | u16(i + 2) << 16 }
  guard b.count >= 12, b[8..<12].elementsEqual("WAVE".utf8) else { return nil }
  var at = 12, rate = 0, channels = 0, bits = 0
  while at + 8 <= b.count {
    let size = u32(at + 4), body = at + 8
    if b[at..<at + 4].elementsEqual("fmt ".utf8), body + 16 <= b.count {
      (channels, rate, bits) = (u16(body + 2), u32(body + 4), u16(body + 14))
    } else if b[at..<at + 4].elementsEqual("data".utf8) {
      guard channels == 1, bits == 16, rate > 0,
        let f = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Double(rate), channels: 1, interleaved: false)
      else { return nil }
      let n = max(0, min(size, b.count - body)) / 2
      guard n > 0, let buf = AVAudioPCMBuffer(pcmFormat: f, frameCapacity: AVAudioFrameCount(n)), let x = buf.floatChannelData?[0] else { return nil }
      for i in 0..<n { x[i] = Float(Int16(bitPattern: UInt16(u16(body + 2 * i)))) / 32768 }
      buf.frameLength = AVAudioFrameCount(n)
      return buf
    }
    at = body + size + (size & 1)
  }
  return nil
}

/** The call's voice: the system voice (what Chromium's speechSynthesis used on
 *  macOS — the same voices) rendered to buffers and played on the listening
 *  engine, so echo removal knows it. One line at a time, in order. Main thread. */
final class Voice {
  let synth = AVSpeechSynthesizer() // held: its buffers stop if it goes
  let player = AVAudioPlayerNode()
  var format: AVAudioFormat?
  /** `vv`: the VOICEVOX voice to read it with (Vox), nil = the system voice. */
  typealias Line = (id: String, text: String, lang: String, vv: (model: String, style: UInt32)?)
  var queue: [Line] = []
  /** The lines begun (being rendered or played), by id: what a restart reads again. */
  var begun: [String: Line] = [:]
  var writingId: String?
  /** Ids with sound scheduled, in playing order (the first is being heard). */
  var ahead: [String] = []
  var writing = false
  /** Bumped by halt(): what was underway for an older one is dropped. */
  var gen = 0
  var converter: AVAudioConverter?
  /** The speaker side's loudness per tap buffer, newest last (audio thread, under lock). */
  let lock = NSLock()
  var played: [Float] = []
  /** The loudest of what it played over the last `seconds` (echo arrives a little late and rings on). */
  func playing(_ seconds: Double, rate: Double) -> Int {
    lock.lock(); defer { lock.unlock() }
    let n = max(1, Int(seconds * rate / 1024))
    return Int((played.suffix(n).max() ?? -120).rounded())
  }

  /** Without echo removal the voice plays on its own engine: one engine driving a
   *  mic and a speaker of different boxes at different rates will not start
   *  (measured: built-in mic 48 kHz + an interface at 44.1 kHz). */
  let own = AVAudioEngine()
  private var watchingOwn = false

  func attach(to engine: AVAudioEngine) {
    // Its own engine, still playing across a restart of the listening one: left as it is.
    if player.engine === engine && engine.isRunning { return next() }
    if engine === own && !watchingOwn {
      watchingOwn = true
      // Headphones in or out stop it silently: the lines go (said so), it starts again.
      NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: own, queue: .main) { [weak self] _ in
        guard let self, self.player.engine === self.own else { return }
        self.again { try? self.own.start() }
      }
    }
    if let old = player.engine, old !== engine {
      // The listening engine no longer plays: nothing of it left driving the speaker
      // (an engine on a mic and a speaker of different boxes will not start).
      old.stop()
      old.mainMixerNode.removeTap(onBus: 0)
      old.detach(player)
      old.disconnectNodeOutput(old.mainMixerNode)
    }
    if player.engine == nil { engine.attach(player) }
    // The mixer at the output's own rate: with voice processing on, a mixer left
    // at the device's old rate keeps the engine from starting (-10875, measured).
    let out = engine.outputNode.outputFormat(forBus: 0)
    engine.connect(engine.mainMixerNode, to: engine.outputNode, format: out.sampleRate > 0 ? out : nil)
    let f = AVAudioFormat(standardFormatWithSampleRate: out.sampleRate > 0 ? out.sampleRate : 48000, channels: 1)!
    format = f
    converter = nil
    engine.connect(player, to: engine.mainMixerNode, format: f)
    // How loud it is reading right now (what goes to the speaker, before the
    // system volume): the server weighs the mic against it — what leaks back of
    // its own voice rises and falls with it.
    engine.mainMixerNode.removeTap(onBus: 0)
    engine.mainMixerNode.installTap(onBus: 0, bufferSize: 1024, format: nil) { [weak self] buf, _ in
      guard let self, let x = buf.floatChannelData?[0], buf.frameLength > 0 else { return }
      var sum: Float = 0
      for i in 0..<Int(buf.frameLength) { sum += x[i] * x[i] }
      let db = 10 * log10(max(sum / Float(buf.frameLength), 1e-12))
      self.lock.lock(); self.played.append(db); if self.played.count > 32 { self.played.removeFirst() }; self.lock.unlock()
    }
    next() // a line asked for before the engine was up
  }

  func say(_ text: String, id: String, lang: String, vv: (model: String, style: UInt32)? = nil) {
    queue.append((id, text, lang, vv))
    next()
  }

  /** A restart (another device): the lines underway are gone — said so, or the
   *  server would wait for them, not counting what it hears, for good. */
  func drop() {
    for id in ahead + (writingId.map { ahead.contains($0) ? [] : [$0] } ?? []) + queue.map(\.id) { emit(["type": "spoke", "id": id]) }
    halt()
  }

  /** Paused for someone who may be talking: a line arriving meanwhile must not start it again. */
  var held = false

  /** The engine under it restarted (a device change): the lines underway are read
   *  again from their start once `start` has it running — not dropped unheard. */
  func again(_ start: () -> Void) {
    let ids = ahead + (writingId.map { ahead.contains($0) ? [] : [$0] } ?? [])
    let lines = ids.compactMap { begun[$0] } + queue
    halt()
    start()
    for l in lines { say(l.text, id: l.id, lang: l.lang, vv: l.vv) }
  }

  func halt() {
    gen += 1
    begun = [:]
    writingId = nil
    held = false
    queue = []
    ahead = []
    writing = false
    synth.stopSpeaking(at: .immediate)
    if player.engine != nil { player.stop() }
  }

  /** Renders the next line; its buffers are scheduled as they come. */
  func next() {
    guard !writing, !queue.isEmpty, format != nil else { return }
    let line = queue.removeFirst()
    begun[line.id] = line
    writingId = line.id
    writing = true
    let g = gen
    // A VOICEVOX piece comes whole (vvParts); while one plays the next is made.
    if let vv = line.vv, vox != nil, let parts = vvParts(line.text) { return render(line, vv, parts[...], g, begun: false) }
    system(line, g)
  }

  /** The VOICEVOX pieces of `line`, one after another. Anything that fails: the rest in the system voice. */
  func render(_ line: Line, _ vv: (model: String, style: UInt32), _ parts: ArraySlice<String>, _ g: Int, begun: Bool) {
    guard let part = parts.first, let vox else { return }
    vox.wav(part, model: vv.model, style: vv.style) { [weak self] wav in
      // A stop meanwhile (gen): nothing more of this line is made.
      guard let self, g == self.gen, let format = self.format else { return }
      guard let wav, let p = pcm(wav: wav), let b = self.convert(p, to: format, whole: true) else {
        return self.system((line.id, parts.joined(), line.lang, nil), g, begun: begun)
      }
      if !begun { self.started(line.id) }
      self.play(b, nil)
      if parts.count > 1 { self.render(line, vv, parts.dropFirst(), g, begun: true) } else { self.ended(line.id, g, format) }
    }
  }

  /** Someone began to be heard: told when it is the first in line. */
  func started(_ id: String) {
    ahead.append(id)
    if ahead.count == 1 { emit(["type": "speak", "id": id]) }
  }

  /** All of `id` is scheduled: a moment of silence whose playing-out marks it heard; the next line is made. */
  func ended(_ id: String, _ g: Int, _ format: AVAudioFormat) {
    if let tail = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 1) {
      tail.frameLength = 1
      play(tail) { [weak self] in self?.done(id, g) }
    }
    writing = false
    writingId = nil
    next()
  }

  /** The system voice, its buffers scheduled as they come. `begun`: the line is already being heard (its rest). */
  func system(_ line: Line, _ g: Int, begun: Bool = false) {
    guard let format else { return }
    let (id, text, lang) = (line.id, line.text, line.lang)
    var started = begun
    let u = AVSpeechUtterance(string: text)
    u.voice = AVSpeechSynthesisVoice(language: lang)
    synth.write(u) { [weak self] buffer in
      guard let pcm = buffer as? AVAudioPCMBuffer else { return }
      DispatchQueue.main.async {
        guard let self, g == self.gen else { return }
        if !started {
          started = true
          self.started(id)
        }
        if pcm.frameLength == 0 {
          self.ended(id, g, format)
        } else if let b = self.convert(pcm, to: format) {
          self.play(b, nil)
        }
      }
    }
  }

  func play(_ b: AVAudioPCMBuffer, _ then: (() -> Void)?) {
    // The engine stopped under it (a device change): the lines are gone — said so,
    // or the server and the window would wait for their end for good.
    guard player.engine?.isRunning == true else { return drop() }
    // Called on stop() too (AVAudioPlayerNode.h): gen tells the two apart.
    player.scheduleBuffer(b, completionCallbackType: .dataPlayedBack) { _ in
      if let then { DispatchQueue.main.async(execute: then) }
    }
    if !player.isPlaying && !held { player.play() }
  }

  func done(_ id: String, _ g: Int) {
    // Also called when the player stops under it — its engine stopped by a device
    // change (the restart reads the line again): only a player still playing has
    // played it to the end.
    guard g == gen, ahead.first == id, player.isPlaying, player.engine?.isRunning == true else { return }
    ahead.removeFirst()
    begun[id] = nil
    emit(["type": "spoke", "id": id])
    if let n = ahead.first { emit(["type": "speak", "id": n]) }
  }

  /** `whole`: all of a line in one buffer (VOICEVOX) — converted on its own and flushed to its last sample. */
  func convert(_ pcm: AVAudioPCMBuffer, to format: AVAudioFormat, whole: Bool = false) -> AVAudioPCMBuffer? {
    if pcm.format == format { return pcm }
    if !whole, converter?.inputFormat != pcm.format { converter = AVAudioConverter(from: pcm.format, to: format) }
    guard let converter = whole ? AVAudioConverter(from: pcm.format, to: format) : converter else { return nil }
    let cap = AVAudioFrameCount(Double(pcm.frameLength) * format.sampleRate / pcm.format.sampleRate) + 32
    guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: cap) else { return nil }
    var fed = false
    var err: NSError?
    converter.convert(to: out, error: &err) { _, status in
      if fed { status.pointee = whole ? .endOfStream : .noDataNow; return nil }
      fed = true
      status.pointee = .haveData
      return pcm
    }
    return err == nil ? out : nil
  }
}

func firstChannel(_ buf: AVAudioPCMBuffer, _ format: AVAudioFormat) -> AVAudioPCMBuffer? {
  guard buf.format.channelCount > 1 else { return buf }
  guard let src = buf.floatChannelData?[0], let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: buf.frameLength), let dst = out.floatChannelData?[0] else { return nil }
  out.frameLength = buf.frameLength
  dst.update(from: src, count: Int(buf.frameLength))
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
  /** A call: voice processing (echo removal) is on — the voice reads through this engine. */
  var echo = false
  /** What the server is told: "on" | "apart" | "off" (startEngine). */
  var echoMode = "off"
  /** This device would not take voice processing: not tried again. */
  var echoRefused = false
  var muted = false
  let voice = Voice()
  /** Loudness of the mic per 0.1 s, dBFS, the last five (the audio thread writes, under lock). */
  private var levels = [Float](repeating: -120, count: 5)
  private var levelAt = 0
  private var sum: Float = 0
  private var frames = 0
  var level: Int {
    lock.lock(); defer { lock.unlock() }
    return Int((levels.max() ?? -120).rounded())
  }
  /** Every 0.1 s of mic: its level, and — while the voice is heard — told as
   *  {"type":"level"}: the server pauses the reading on a loud one at once (the
   *  recognizer's first word comes ~0.8 s after the voice, measured), then
   *  stops it or lets it go on by the words. */
  func note(_ buf: AVAudioPCMBuffer) {
    guard let x = buf.floatChannelData?[0], buf.frameLength > 0 else { return }
    lock.lock()
    for i in 0..<Int(buf.frameLength) { sum += x[i] * x[i] }
    frames += Int(buf.frameLength)
    guard Double(frames) >= buf.format.sampleRate / 10 else { return lock.unlock() }
    let db = 10 * log10(max(sum / Float(frames), 1e-12))
    sum = 0
    frames = 0
    levels[levelAt] = db
    levelAt = (levelAt + 1) % levels.count
    lock.unlock()
    DispatchQueue.main.async { [weak self] in
      guard let self, !self.voice.ahead.isEmpty else { return }
      emit(["type": "level", "level": Int(db.rounded()), "play": self.voice.player.isPlaying ? self.voice.playing(0.25, rate: self.voice.format?.sampleRate ?? 48000) : -120])
    }
  }

  init(_ recognizer: SFSpeechRecognizer) { self.recognizer = recognizer }

  func restart(_ why: String) {
    // On stderr (the app ignores it): lets a check count restarts — setting the
    // device must not raise another change and loop.
    FileHandle.standardError.write(Data("og-listen: restart (\(why))\n".utf8))
    let go = {
      self.engine.stop()
      self.engine.inputNode.removeTap(onBus: 0)
      self.startEngine()
    }
    if callMode { voice.again(go) } else { go() }
    // Another device may change what echo removal can do: the server hears it again.
    if callMode { emit(["type": "ready", "echo": echoMode]) }
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
    if let feedArg, !callMode { return feed(feedArg) }
    if let feedArg, callMode { mix = loadMono(feedArg) }
    startEngine()
    watch()
    // Another mic plugged in (AirPods…) stops the engine silently: start it again.
    NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
      self?.restart("audio configuration changed")
    }
    begin()
    emit(callMode ? ["type": "ready", "echo": echoMode] : ["type": "ready"])
  }

  func startEngine() {
    let input = engine.inputNode
    // Set only when it differs: setting the same device again would raise
    // another configuration change and restart us in a loop.
    var device = pickInput()
    // Nothing that can hear (no mic, or only a shut lid's): say so, not "ready".
    guard device != 0 else { fail("unavailable") }
    using = device
    // A call: echo removal (voice processing) — set while stopped, before the
    // formats are read (it changes them). It covers both ends: what this engine
    // plays is the reference. It only ever uses the system's DEFAULT input and
    // output (AVAudioIONode.h; set to another mic it hands over no audio at all,
    // measured 2026-10-07), so it is on only when the mic picked IS the default.
    let system = AudioObjectID(kAudioObjectSystemObject)
    let defaultIn = prop(system, kAudioHardwarePropertyDefaultInputDevice)
    let wantEcho = callMode && !echoRefused && device == defaultIn
    if input.isVoiceProcessingEnabled != wantEcho, (try? input.setVoiceProcessingEnabled(wantEcho)) == nil, wantEcho { echoRefused = true }
    echo = input.isVoiceProcessingEnabled
    // Its gain control lifts what is left of its own voice too (to -28 dBFS on a
    // MacBook's speakers at half volume; -45 without it, measured 2026-10-07).
    if echo { input.isVoiceProcessingAGCEnabled = false }
    if echo, #available(macOS 14, *) {
      // Other apps' sound as loud as voice processing allows (the owner makes music).
      input.voiceProcessingOtherAudioDuckingConfiguration = AVAudioVoiceProcessingOtherAudioDuckingConfiguration(enableAdvancedDucking: false, duckingLevel: .min)
    }
    // No echo removal: "apart" when the mic is an interface's stand-in (pickInput)
    // and the voice comes out of that interface (measured: the built-in mic hears
    // it at -47 dB); "off" otherwise — a display's or a Bluetooth speaker next to
    // the Mac is heard loud (the server then lets nothing heard while it reads count).
    let speaker = prop(system, kAudioHardwarePropertyDefaultOutputDevice)
    echoMode = echo ? "on" : callMode && device != defaultIn && speaker == defaultIn ? "apart" : "off"
    if !echo, let unit = input.audioUnit {
      var current: AudioDeviceID = 0
      var size = UInt32(MemoryLayout<AudioDeviceID>.size)
      AudioUnitGetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &current, &size)
      if current != device {
        AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &device, UInt32(MemoryLayout<AudioDeviceID>.size))
      }
    }
    // After the mic is set: the output side touched first leaves the input unit on no device.
    if callMode { voice.attach(to: echo ? engine : voice.own) }
    // inputFormat, not outputFormat: after a device switch only it is current.
    let format = input.inputFormat(forBus: 0)
    if let unit = input.audioUnit {
      var now: AudioDeviceID = 0
      var size = UInt32(MemoryLayout<AudioDeviceID>.size)
      AudioUnitGetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &now, &size)
      FileHandle.standardError.write(Data("og-listen: wanted \(deviceName(device)), unit on \(deviceName(now)), echo \(echo), \(format.channelCount) ch \(format.sampleRate)\n".utf8))
    }
    // No input device at all (a desktop Mac without a mic): not a permission problem.
    guard format.sampleRate > 0, format.channelCount > 0,
      let one = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: format.sampleRate, channels: 1, interleaved: false)
    else { fail("unavailable") }
    // Voice processing hands over its own odd layout: the one processed voice
    // copied onto every channel (9 on a MacBook, measured) — the first is taken.
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buf, _ in
      guard let self, let m = self.echo ? firstChannel(buf, one) : mono(buf, one) else { return }
      if callMode { self.add(m); self.note(m) }
      if !self.muted { self.request?.append(m) }
    }
    engine.prepare()
    if callMode && !echo { try? voice.own.start() }
    do { try engine.start() } catch {
      // The device would not take echo removal: listen without it (the server then
      // lets nothing heard while it reads count) rather than not at all.
      guard echo else { fail("failed") }
      FileHandle.standardError.write(Data("og-listen: no echo removal (\(error))\n".utf8))
      input.removeTap(onBus: 0)
      engine.stop()
      echoRefused = true
      return startEngine()
    }
  }

  /** --call --feed: the file's samples, mixed in from `mixAt` once fed (audio thread, under lock). */
  var mix: [Float] = []
  private var mixAt: Int?
  func add(_ m: AVAudioPCMBuffer) {
    lock.lock(); defer { lock.unlock() }
    guard let at = mixAt, at < mix.count, let x = m.floatChannelData?[0] else { return }
    if at == 0 {
      let t = ProcessInfo.processInfo.systemUptime
      DispatchQueue.main.async { emit(["type": "fed", "t": t]) }
    }
    let n = min(Int(m.frameLength), mix.count - at)
    for i in 0..<n { x[i] += mix[at + i] }
    mixAt = at + n
  }

  /** stdin in a call: what to say, stop, mute. */
  func command(_ cmd: [String: Any]) {
    if cmd["feed"] as? Bool == true { lock.lock(); mixAt = 0; lock.unlock() }
    if let m = cmd["warm"] as? String { vox?.warm(m) }
    if let m = cmd["mute"] as? Bool, m != muted {
      muted = m
      if echo { engine.inputNode.isVoiceProcessingInputMuted = m }
      forget()
    }
    if cmd["stop"] as? Bool == true { voice.halt() }
    if cmd["forget"] as? Bool == true { forget() }
    if cmd["pause"] as? Bool == true, voice.player.isPlaying {
      voice.held = true
      voice.player.pause()
      emit(["type": "paused", "t": ProcessInfo.processInfo.systemUptime])
    }
    if cmd["resume"] as? Bool == true, voice.held {
      voice.held = false
      if voice.player.engine?.isRunning == true { voice.player.play() }
      emit(["type": "resumed"])
    }
    if let text = cmd["say"] as? String, let id = cmd["id"] as? String {
      let vv = (cmd["vv"] as? [String: Any]).flatMap { v -> (model: String, style: UInt32)? in
        guard let m = v["model"] as? String, let s = v["style"] as? Int, s >= 0 else { return nil }
        return (m, UInt32(s))
      }
      voice.say(text, id: id, lang: cmd["lang"] as? String ?? "ja-JP", vv: vv)
    }
  }

  /** Drops what is being heard without handing it on: the scraps of its own
   *  voice once it has read to the end (they would be sent as the owner's words). */
  func forget() {
    pause?.cancel()
    request?.endAudio()
    task?.cancel()
    begin()
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
        emit(callMode ? ["type": "partial", "text": text, "level": level] : ["type": "partial", "text": text])
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
    if !line.isEmpty { emit(callMode ? ["type": "final", "text": line, "level": level] : ["type": "final", "text": line]) }
    begin()
  }
}

func loadMono(_ path: String) -> [Float] {
  guard let file = try? AVAudioFile(forReading: URL(fileURLWithPath: path)),
    let all = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)),
    (try? file.read(into: all)) != nil, let x = all.floatChannelData?[0]
  else { fail("failed") }
  return Array(UnsafeBufferPointer(start: x, count: Int(all.frameLength)))
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

/** `--tts <text> <out.wav> [--voicevox <dir> --vv <model> <style> [--after <text>] [--whole] [--warmed <m>] [--switch <m>]]`: makes one line into a file, never
 *  through the speaker, and prints how long the first sound took (ms) — the call's first-sentence wait,
 *  per voice (scripts/measure-voice-first.mts). `load`: VOICEVOX's one-time start, before the line. */
if let i = args.firstIndex(of: "--tts"), i + 2 < args.count {
  let (text, out) = (args[i + 1], URL(fileURLWithPath: args[i + 2]))
  let t0 = Date()
  let ms = { Int(Date().timeIntervalSince(t0) * 1000) }
  if let v = args.firstIndex(of: "--vv"), v + 2 < args.count, let style = UInt32(args[v + 2]), let vox {
    let model = args[v + 1]
    let whole = args.contains("--whole")
    let after = args.firstIndex(of: "--after").flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil }
    // `--warmed <m>`: the voice loaded is another than the line's (a switch underway).
    let warmed = args.firstIndex(of: "--warmed").flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil } ?? model
    // `--switch <m>`: once loaded, a warm of another voice is asked, then the line's first piece —
    // how long that piece waits (a switch mid-line), and whether VOICEVOX made it. Nothing written.
    let switchTo = args.firstIndex(of: "--switch").flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil }
    guard let parts = whole ? [text] : vvParts(text) else { fail("failed") }
    vox.warm(warmed) { ok in
      guard ok else { fail("failed") }
      if let switchTo {
        vox.warm(switchTo) { _ in }
        let t = Date()
        return vox.wav(parts[0], model: model, style: style) { wav in
          emit(["type": "switch", "made": wav != nil, "ms": Int(Date().timeIntervalSince(t) * 1000)])
          exit(0)
        }
      }
      let load = ms()
      // A stop left this being made (a render cannot be cancelled): the next line waits behind it.
      if let after { vox.wav(whole ? after : vvParts(after)?.first ?? after, model: model, style: style) { _ in } }
      let t1 = Date()
      var first = 0
      var made: [AVAudioPCMBuffer] = []
      func make(_ k: Int) {
        vox.wav(parts[k], model: model, style: style) { wav in
          if k == 0 { first = Int(Date().timeIntervalSince(t1) * 1000) }
          guard let wav, let p = pcm(wav: wav) else { fail("failed") }
          made.append(p)
          if k + 1 < parts.count { return make(k + 1) }
          // Through the call's own steps (read each WAV, convert it whole to the speaker's rate): the file is what a call plays.
          guard let f = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 1),
            let file = try? AVAudioFile(forWriting: out, settings: f.settings, commonFormat: f.commonFormat, interleaved: f.isInterleaved)
          else { fail("failed") }
          for p in made {
            guard let b = Voice().convert(p, to: f, whole: true), (try? file.write(from: b)) != nil else { fail("failed") }
          }
          emit(["type": "tts", "voice": "voicevox", "load": load, "first": first, "pieces": parts.count])
          exit(0)
        }
      }
      make(0)
    }
  } else {
    // Warmed first, as in a call (its voice is up long before the answer): only the line is timed.
    let synth = AVSpeechSynthesizer()
    let utter = { (t: String) -> AVSpeechUtterance in
      let u = AVSpeechUtterance(string: t)
      u.voice = AVSpeechSynthesisVoice(language: locale.identifier)
      return u
    }
    synth.write(utter("あ")) { warm in
      guard (warm as? AVAudioPCMBuffer)?.frameLength == 0 else { return }
      DispatchQueue.main.async {
        let t1 = Date()
        var file: AVAudioFile?
        var first: Int?
        synth.write(utter(text)) { buffer in
          guard let pcm = buffer as? AVAudioPCMBuffer else { return }
          if pcm.frameLength == 0 {
            guard let first, file != nil else { fail("failed") }
            file = nil // closed
            emit(["type": "tts", "voice": "system", "first": first])
            exit(0)
          }
          if first == nil { first = Int(Date().timeIntervalSince(t1) * 1000) }
          if file == nil { file = try? AVAudioFile(forWriting: out, settings: pcm.format.settings, commonFormat: pcm.format.commonFormat, interleaved: pcm.format.isInterleaved) }
          try? file?.write(from: pcm)
        }
      }
    }
    withExtendedLifetime(synth) { dispatchMain() }
  }
  dispatchMain()
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
