# Shaant (शांत)

**Live: https://nipunbatra.github.io/shaant/**

*Shaant* (Hindi: शांत, "quiet") removes background noise from a video's audio track —
entirely in the browser, like iMovie's one-switch noise reduction. No server, no
uploads: the whole pipeline runs locally via WebAssembly, so it works offline and on
GitHub Pages.

**Pipeline:** [ffmpeg.wasm](https://ffmpegwasm.netlify.app/) extracts the audio track
as raw 48 kHz float PCM → a speech-trained denoise engine processes it frame by
frame → an adaptive residual expander gently closes the floor between phrases →
ffmpeg.wasm re-encodes just the audio (AAC/Opus) and **copies the video stream
untouched**, so there's no picture-quality loss and no slow video re-encode.

## Engines

| Engine | Speed (M-series Mac, 60 s clip end-to-end) | Best at | Download |
|---|---|---|---|
| **Fast** — [RNNoise](https://github.com/xiph/rnnoise) (WASM SIMD by [Shiguredo](https://github.com/shiguredo/rnnoise-wasm)) | 3.4 s (≈17.6× realtime incl. demux/remux) | Steady noise: fans, AC, hiss, hum | in base ~36 MB |
| **High quality** — [DeepFilterNet3](https://github.com/Rikorose/DeepFilterNet) (official `wasm` feature, tract runtime, built via `scripts/build-dfn3-wasm.sh`) | 4.9 s (≈12.2× realtime incl. demux/remux) | Non-stationary noise: traffic, horns, babble, keyboards | +17 MB |

Denoising is **parallelized across CPU cores**: the audio is split into 8 s chunks
(each prefixed with 1 s of state-priming audio that is discarded, seams stitched with
a 20 ms crossfade) and fanned out to a pool of Web Workers — up to 8 for RNNoise and
6 for DeepFilterNet3. Pools start with one warm worker and grow only when a clip has
enough chunks to benefit, avoiding the old short-clip startup penalty.

Long recordings use a bounded-memory pipeline automatically. Shaant decodes and
denoises 90-second sections with a one-second recurrent-state lead-in, stores each
cleaned section losslessly in browser-origin private storage, then mounts those compact
parts read-only for one final audio encode while copying the original video stream. The
source is also mounted read-only instead of copied into the WASM heap, and the full
decoded PCM timeline is never resident in memory.

**Smart Stereo** detects ordinary correlated camera/phone audio, denoises its coherent
mid channel once, and applies a smoothed model-derived attenuation to the side channel.
This keeps centred voices stable between left and right while roughly halving neural
inference. Unbalanced or decorrelated stereo automatically stays on the independent
dual-channel path.

Both are 48 kHz fullband (no muffled highs) and language-agnostic — they model the
acoustics of human voice, not any particular language, so Hindi and other languages
work the same as English. On the bundled test clip (speech + white noise), RNNoise
cuts the noise floor by ~43 dB; DeepFilterNet3 takes it to digital silence, with
speech level preserved by both.

The measured algorithmic delay of each engine (960 samples for RNNoise, 1440 for
DFN3, found by cross-correlation at runtime) is compensated automatically, so A/V
sync is sample-exact and the strength slider never comb-filters.

## Features

- Drag & drop a video (MP4 / MOV / MKV) or an audio file (MP3 / WAV / M4A / …) —
  the video shows immediately and processing starts automatically
- **Automatic strength by default**: after the model pass, Shaant compares quiet and
  speech-level energy above their respective noise floors and targets a substantially
  lower residual floor. DeepFilterNet3 uses a protected 84–94% range: a 30 dB model
  attenuation ceiling and a collapse-only speech-envelope guard prevent the stronger
  mix from deleting vulnerable syllables. The user gets a content-based recommendation
  instead of guessing a percentage; dragging the slider switches cleanly to manual mode.
- DeepFilterNet3 is the default quality model. RNNoise remains available under
  Fine-tune for a smaller, faster pass on fans, AC and hiss.
- Conservative adaptive residual cleanup lowers model leftovers between phrases
  without hard-gating breaths and low speech; it can be disabled under Fine-tune.
- DeepFilterNet3's spectral attenuation is capped at 30 dB. This retains nearly all of
  the noise reduction measured at the old effectively-unlimited setting while bounding
  damage when the model mistakes speech for background sound.
- Switching engines mid-processing cancels the in-flight run (worker pool is
  terminated) and restarts with the new engine
- **Instant iMovie-style A/B switch**: original and processed files play in two
  synchronized players, and the switch just swaps which one is audible — flick it
  mid-playback with zero glitch
- Live progress bar with stage and percentage
- Strength slider (0–100%) — changing it after processing only re-mixes and re-muxes;
  it does not re-run the neural model
- Long-file mode keeps only one decoded audio section in JavaScript at a time, so
  hour-scale, highly compressed recordings do not create multi-gigabyte PCM arrays
- Dual waveform preview and measured quiet-floor, voice-retention, and real-time stats
- Keyboard-accessible file picker, drag/drop and paste support, responsive audio-only
  mode, inline errors, and same-file reselection
- Download the result (video codec bit-identical to the input)
- 100% client-side: private, works offline once cached

WebM is temporarily rejected with a recoverable message. The current official
ffmpeg.wasm core can trap while decoding WebM audio; accepting it would risk losing
an in-progress browser run. Convert the container to MP4, MOV or MKV first. Shaant
does not upload or modify the rejected source.

## Run locally

Any static file server works, but it must serve `.js` as `text/javascript` and ideally
`.wasm` as `application/wasm` (ES modules don't load from `file://`):

```bash
python3 serve.py          # http://localhost:8000
# or
npx serve .
```

## Deploying

Hosted on GitHub Pages from the `main` branch, root `/`. Just push — there is no
build step, and no special headers are needed (the single-threaded ffmpeg.wasm core
is used precisely because GitHub Pages can't set the COOP/COEP headers that the
multi-threaded build would require). `.nojekyll` is included so the `vendor/` files
are served as-is.

## Optional Apple-silicon studio pass

Exceptionally difficult speech recordings can use a heavier, fully local second pass
after the browser's protected DeepFilterNet export. This is deliberately separate
from the web app: MossFormer2-SE is much larger, while the MLX version can use an
M-series GPU efficiently. The helper processes 30-second cores with two seconds of
context, writes incrementally, and restores any sub-STFT tail from the protected base
so long files keep their exact sample count.

```bash
# Requires ffmpeg plus mlx-audio, soundfile and webrtcvad-wheels.
ffmpeg -i browser-cleaned.mp4 -vn -af 'pan=mono|c0=0.5*c0+0.5*c1' \
  -ar 48000 -c:a pcm_f32le protected-base.wav
python3 scripts/run_mossformer_mlx.py protected-base.wav mossformer-wet.wav
ffmpeg -i protected-base.wav -i mossformer-wet.wav \
  -filter_complex "[0:a][1:a]amix=inputs=2:weights='0.60 0.40':normalize=0" \
  -c:a pcm_f32le studio-clean.wav
```

The 40% second-stage mix was selected for one especially noisy real recording using
DNSMOS P.835 and Whisper stability; it is not a universal strength. The optional
`blend_vad_protected.py` helper can explore speech-aware mixes, but fixed conservative
blending proved more stable on that recording.

## Testing

An end-to-end test drives the real page in headless Chromium: it builds a noisy test
clip (macOS `say` speech + white noise), uploads it, processes, downloads the result,
and asserts >20 dB noise-floor reduction, preserved speech, and a bit-identical video
stream. Requires `ffmpeg` and Python Playwright on the host.

```bash
bash test/make_test_video.sh
python3 serve.py 8000 &
node test/audio_utils_test.mjs
node test/engines_test.mjs
python3 -m unittest discover -s test -p 'native_pipeline_test.py'
URL=http://localhost:8000/ ENGINE=rnnoise python3 test/e2e_test.py
URL=http://localhost:8000/ ENGINE=dfn3 python3 test/e2e_test.py
# optional adversarial lifecycle pass
URL=http://localhost:8000/ ENGINE=rnnoise STREAMING=1 STREAMING_PART_SECONDS=3 \
  INTERRUPT_FILE=test/tmp/noisy_60s.mp4 STRESS_CYCLES=4 python3 test/e2e_test.py
```

The unit suites cover auto-strength aggregation and bounds, speech protection,
residual expansion, stereo-path selection, finite/clamped output, waveform analysis,
long-file planning and measured model-delay compensation. The browser suite exercises
the real WASM models, direct file mounting, private-storage section spooling, metadata
fallback, engine cancellation, repeated source replacement, live A/B playback, rapid
manual re-exports, multi-part seam continuity, A/V start offsets, recovery after invalid
media, noise reduction, duration preservation and bit-identical video copying.

## Rebuilding the DeepFilterNet3 WASM

`vendor/deepfilternet/` is built from the official repo's `wasm` feature (tract
inference of the ONNX export, plus the full Rust STFT/ERB/deep-filtering pipeline —
no DSP reimplemented in JS). Two local patches are applied: skip embedding the
default model (fetched separately at runtime) and add a `df_free` export. To
reproduce: `bash scripts/build-dfn3-wasm.sh` (needs rustup + wasm-pack).

## Notes

- **CPU vs WebGPU:** these are small *streaming* models — each 10 ms frame depends on
  the previous frame's recurrent state, so a GPU can't batch frames within one stream,
  and per-frame GPU dispatch overhead (~0.1–1 ms) would rival the compute itself.
  The parallelism that *is* available (independent chunks of the timeline) is
  exploited across CPU cores with Web Workers instead. On top of that, the DFN3 build
  uses tract (CPU-only Rust inference); a WebGPU path would mean onnxruntime-web plus
  reimplementing DFN3's STFT/ERB/deep-filter DSP in JS — lots of surface for little
  or negative gain at this model size. WebGPU becomes the right tool for much bigger
  models (Demucs-class), which don't fit a static-page budget anyway.
- Audio is processed as stereo 48 kHz; mono inputs are upmixed, so output audio is
  always stereo. Smart Stereo automatically falls back to independent channels when
  correlation or channel balance says the mid/side shortcut would be unsafe.
- The compressed source and lossless cleaned sections are mounted read-only from the
  browser rather than accumulated in ffmpeg.wasm memory. Decoded audio is bounded to
  one 90-second section. The final muxed output still occupies the WASM virtual FS, so
  the 1.5 GB source cap is an upper bound and practical capacity depends on the device
  and the output bitrate.
- First load fetches ~36 MB of WASM (ffmpeg core + RNNoise); the HQ engine lazily
  fetches another ~17 MB. Browsers cache both.
- Both models are trained on speech — they preserve voices and remove background
  noise. They are not music enhancers: music in the track will be treated as noise.

## Vendored libraries

| Library | Version | License |
|---|---|---|
| `@ffmpeg/ffmpeg` | 0.12.15 | MIT |
| `@ffmpeg/core` (single-thread) | 0.12.10 | MIT (FFmpeg: LGPL/GPL) |
| `@shiguredo/rnnoise-wasm` | 2025.1.5 | Apache-2.0 (RNNoise: BSD) |
| DeepFilterNet3 (libDF `wasm` build + ONNX model) | commit `d375b2d8` | MIT/Apache-2.0 |
