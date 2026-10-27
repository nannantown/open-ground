// The few VOICEVOX core 0.17.0 declarations og-listen calls (voicevox_core.h,
// MIT, built with VOICEVOX_LOAD_ONNXRUNTIME), as function-pointer types: the
// library is not linked nor shipped — og-listen opens it by path at run time
// (`Vox` in main.swift; src/lib/server/voicevox.ts downloads it). Same layouts
// as the official header, so the structs pass by value exactly as it expects.
#include <stdbool.h>
#include <stdint.h>

struct VoicevoxOnnxruntime;
struct OpenJtalkRc;
struct VoicevoxSynthesizer;
struct VoicevoxVoiceModelFile;

typedef struct { const char *filename; } VoicevoxLoadOnnxruntimeOptions;
typedef struct { int32_t acceleration_mode; uint16_t cpu_num_threads; } VoicevoxInitializeOptions;
typedef struct { int32_t on_existing; } VoicevoxLoadVoiceModelOptions;
typedef struct { bool enable_interrogative_upspeak; } VoicevoxTtsOptions;

typedef VoicevoxLoadOnnxruntimeOptions (*vv_make_default_load_onnxruntime_options)(void);
typedef int32_t (*vv_onnxruntime_load_once)(VoicevoxLoadOnnxruntimeOptions, const struct VoicevoxOnnxruntime **);
typedef int32_t (*vv_open_jtalk_rc_new)(const char *, struct OpenJtalkRc **);
typedef VoicevoxInitializeOptions (*vv_make_default_initialize_options)(void);
typedef int32_t (*vv_synthesizer_new)(const struct VoicevoxOnnxruntime *, const struct OpenJtalkRc *, VoicevoxInitializeOptions, struct VoicevoxSynthesizer **);
typedef void (*vv_synthesizer_delete)(struct VoicevoxSynthesizer *);
typedef int32_t (*vv_voice_model_file_open)(const char *, struct VoicevoxVoiceModelFile **);
typedef void (*vv_voice_model_file_delete)(struct VoicevoxVoiceModelFile *);
typedef VoicevoxLoadVoiceModelOptions (*vv_make_default_load_voice_model_options)(void);
typedef int32_t (*vv_synthesizer_load_voice_model)(const struct VoicevoxSynthesizer *, const struct VoicevoxVoiceModelFile *, VoicevoxLoadVoiceModelOptions);
typedef VoicevoxTtsOptions (*vv_make_default_tts_options)(void);
typedef int32_t (*vv_synthesizer_tts)(const struct VoicevoxSynthesizer *, const char *, uint32_t, VoicevoxTtsOptions, uintptr_t *, uint8_t **);
typedef void (*vv_wav_free)(uint8_t *);
typedef const char *(*vv_error_result_to_message)(int32_t);
