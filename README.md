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

| Engine | Speed (M-series Mac, 60 s clip end-to-end) | Best at | Download |
|---|---|---|---|
| **Fast** — [RNNoise](https://github.com/xiph/rnnoise) (WASM SIMD by [Shiguredo](https://github.com/shiguredo/rnnoise-wasm)) | ~5 s (≈12× realtime incl. demux/remux) | Steady noise: fans, AC, hiss, hum | in base ~36 MB |
| **High quality** — [DeepFilterNet3](https://github.com/Rikorose/DeepFilterNet) (official `wasm` feature, tract runtime, built via `scripts/build-dfn3-wasm.sh`) | ~7 s (≈9× realtime incl. demux/remux) | Non-stationary noise: traffic, horns, babble, keyboards | +17 MB |

Denoising is **parallelized across CPU cores**: the audio is split into 6 s chunks
(each prefixed with 1 s of state-priming audio that is discarded, seams stitched with
a 20 ms crossfade) and fanned out to a pool of Web Workers — up to 8 for RNNoise and
6 for DeepFilterNet3. Worker pools stay warm between runs, and the page preloads
ffmpeg and the default engine while you're still picking a file.

Both are 48 kHz fullband (no muffled highs) and language-agnostic — they model the
acoustics of human voice, not any particular language, so Hindi and other languages
work the same as English. On the bundled test clip (speech + white noise), RNNoise
cuts the noise floor by ~43 dB; DeepFilterNet3 takes it to digital silence, with
speech level preserved by both.

The measured algorithmic delay of each engine (960 samples for RNNoise, 1440 for
DFN3, found by cross-correlation at runtime) is compensated automatically, so A/V
sync is sample-exact and the strength slider never comb-filters.

## Features

- Drag & drop a video (MP4 / MOV / MKV / WebM) or an audio file (MP3 / WAV / M4A / …) —
  the video shows immediately and processing starts automatically
- Engine and strength are selectable **before** dropping a file; defaults to
  **DeepFilterNet3 at 70%** (a touch of natural ambience is kept — set 100% for
  maximum removal)
- Switching engines mid-processing cancels the in-flight run (worker pool is
  terminated) and restarts with the new engine
- **Instant iMovie-style A/B switch**: original and processed files play in two
  synchronized players, and the switch just swaps which one is audible — flick it
  mid-playback with zero glitch
- Live progress bar with stage and percentage
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
