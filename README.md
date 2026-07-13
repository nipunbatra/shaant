# Shaant (शांत)

**Live: https://nipunbatra.github.io/shaant/**

*Shaant* (Hindi: शांत, "quiet") removes background noise from a video's audio track —
entirely in the browser, like iMovie's one-switch noise reduction. No server, no
uploads: the whole pipeline runs locally via WebAssembly, so it works offline and on
GitHub Pages.

**Pipeline:** [ffmpeg.wasm](https://ffmpegwasm.netlify.app/) extracts the audio track
as raw 48 kHz float PCM → a denoise engine processes it frame by frame → ffmpeg.wasm
re-encodes just the audio (AAC/Opus) and **copies the video stream untouched**, so
there's no quality loss and no slow video re-encode.

## Engines

| Engine | Speed (M-series Mac) | Best at | Download |
|---|---|---|---|
| **Fast** — [RNNoise](https://github.com/xiph/rnnoise) (WASM SIMD by [Shiguredo](https://github.com/shiguredo/rnnoise-wasm)) | ~50–100× realtime | Steady noise: fans, AC, hiss, hum | in base ~36 MB |
| **High quality** — [DeepFilterNet3](https://github.com/Rikorose/DeepFilterNet) (official `wasm` feature, tract runtime, built via `scripts/build-dfn3-wasm.sh`) | ~2.5× realtime (stereo) | Non-stationary noise: traffic, horns, babble, keyboards | +17 MB |

Both are 48 kHz fullband (no muffled highs) and language-agnostic — they model the
acoustics of human voice, not any particular language, so Hindi and other languages
work the same as English. On the bundled test clip (speech + white noise), RNNoise
cuts the noise floor by ~43 dB; DeepFilterNet3 takes it to digital silence, with
speech level preserved by both.

The measured algorithmic delay of each engine (960 samples for RNNoise, 1440 for
DFN3, found by cross-correlation at runtime) is compensated automatically, so A/V
sync is sample-exact and the strength slider never comb-filters.

## Features

- Drag & drop a video (MP4 / MOV / MKV / WebM) or an audio file (MP3 / WAV / M4A / …)
- Two engines: fast (RNNoise) and high quality (DeepFilterNet3), pick per file
- iMovie-style A/B switch to preview original vs. denoised while playing
- Strength slider (0–100%) — changing it after processing only re-mixes and re-muxes,
  it doesn't re-run the denoiser
- Download the result (video codec bit-identical to the input)
- 100% client-side: private, works offline once cached

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

## Testing

An end-to-end test drives the real page in headless Chromium: it builds a noisy test
clip (macOS `say` speech + white noise), uploads it, processes, downloads the result,
and asserts >20 dB noise-floor reduction, preserved speech, and a bit-identical video
stream. Requires `ffmpeg` and Python Playwright on the host.

```bash
bash test/make_test_video.sh
python3 serve.py 8000 &
URL=http://localhost:8000/ ENGINE=rnnoise python3 test/e2e_test.py
URL=http://localhost:8000/ ENGINE=dfn3 python3 test/e2e_test.py
```

## Rebuilding the DeepFilterNet3 WASM

`vendor/deepfilternet/` is built from the official repo's `wasm` feature (tract
inference of the ONNX export, plus the full Rust STFT/ERB/deep-filtering pipeline —
no DSP reimplemented in JS). Two local patches are applied: skip embedding the
default model (fetched separately at runtime) and add a `df_free` export. To
reproduce: `bash scripts/build-dfn3-wasm.sh` (needs rustup + wasm-pack).

## Notes

- **CPU vs WebGPU:** both engines are small enough that WASM SIMD on one CPU core is
  already faster than realtime — WebGPU would add transfer latency, not speed. The
  page detects and reports WebGPU availability; a WebGPU backend (e.g. onnxruntime-web)
  only becomes worthwhile for much larger models.
- Audio is processed as stereo 48 kHz; mono inputs are upmixed, so output audio is
  always stereo.
- Files are held in memory (ffmpeg.wasm virtual FS), so very large files
  (≳ 500 MB–1 GB) may fail depending on the device's RAM.
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
