# Shaant improvement notes

**Date:** 2026-07-14

This is the running design, DSP, performance and correctness log for the current
product pass.

## Audit report: original browser app

### Critical issues

- None found in the baseline that exposed user data or corrupted the source file.
  The local-only architecture and video-stream copy behavior were both worth keeping.

### Warnings fixed

- **Stale export race:** an old strength export could update the preview after a new
  file had already been selected. Processing and export now use immutable run contexts
  and verify both the run token and file before touching UI state.
- **Duplicate cold-start pools:** concurrent prewarm and processing calls could create
  separate worker pools for the same engine. Pool creation is now single-flight.
- **Eager model instances:** every run initialized the maximum worker count even for a
  short clip with one or two tasks. Pools now prewarm one worker and grow to the actual
  task count on demand.
- **Incomplete cancellation window:** a pool could not be stopped while it was growing,
  only after a WASM task became active. Pool growth now tracks pending initialization,
  rejects it on cancellation, and disposes the whole run.
- **Same-file selection:** browser file inputs do not emit `change` when the same path is
  chosen twice. The input value is cleared after capture, so retrying the same file works.
- **Sticky ffmpeg progress:** an exception could leave progress routing enabled for a
  later unrelated command. Every ffmpeg stage now clears routing in `finally`.
- **Unsupported original preview:** an early media decode error could happen before the
  processed URL existed, leaving no later fallback. The failure is remembered and the
  cleaned MP4/M4A becomes the preview when ready.
- **Port reuse bug:** `allow_reuse_address` was assigned after the test server had already
  bound its socket. It now lives on the server class, where `socketserver` reads it.
- **Compressed-size memory estimate:** file size alone misses long, highly compressed
  recordings whose decoded float PCM would require several gigabytes across the pipeline.
  Processing now uses duration and device memory to select a bounded-memory path: decode,
  denoise and losslessly pack one 90-second section at a time, then join the cleaned track
  for one final encode. The full decoded timeline is never allocated.
- **Whole-source WASM copy:** the first long-file implementation still copied the entire
  compressed source into MEMFS and failed on a 330 MB real-world file before the sectional
  PCM work could help. The browser `File` is now mounted read-only with WORKERFS, so ffmpeg
  seeks directly through the source without duplicating it in the WASM heap.
- **Missing chunk override parsed as zero:** `Number(null)` silently selected the three-second
  test minimum and planned 721 ffmpeg jobs for a 36-minute file. Chunk parsing now treats
  missing and blank values as the 90-second production default and has a regression test.
- **Microscopic final section:** floating container metadata could turn an exact boundary
  into a nearly empty extra model job. Sub-second rounding tails are merged into the prior
  bounded section by the shared, unit-tested segment planner.

### Performance and quality changes

- Kept DeepFilterNet3 as the default full-band model and RNNoise as the fast model.
  The current official alternatives reviewed were either training/evaluation frameworks
  or larger PyTorch-oriented toolkits without a comparable, production-ready browser
  WASM path. A heavier model would work against the local/fast product constraint.
- Increased kept chunks from 6 s to 8 s, reducing recurrent-state priming overhead while
  retaining enough tasks for multicore work on long clips.
- Added Smart Stereo: correlated, balanced stereo uses one coherent mid-channel model
  pass, then reconstructs the side channel with a smoothed model-derived gain. Independent
  stereo remains on the dual-channel path. Its bounded profile is stratified across the
  whole section; a red regression showed that inspecting only a correlated intro could
  misclassify later decorrelated audio.
- Added an explicit float-PCM clamp after Smart Stereo reconstruction. A red regression
  test showed that model overshoot plus a strong side channel could exceed `[-1, 1]` and
  leave clipping behavior to the encoder; reconstruction now owns and enforces the contract.
- Added a conservative residual downward expander. It only closes when a frame is near
  the measured wet floor *and* the neural model has already removed most input energy.
  It opens quickly and interpolates gains to avoid clipped consonants and zipper noise.
- Removed one full PCM copy after ffmpeg extraction and avoided the extra export copy when
  the wet/dry mix is already a disposable buffer.
- Long-file staging does not create a browser-side whole-file `ArrayBuffer` at all. Per-section
  raw PCM is deleted immediately after its lossless cleaned section is written, keeping peak
  JavaScript PCM memory duration-independent.
- Progress aggregation is now O(1) per worker message instead of repeatedly reducing the
  whole task list.

### Automatic strength design

- The default remains visually familiar at 70% before a file is known.
- After denoising, Shaant measures the 20th-percentile frame level as a quiet-floor proxy
  and the 88th-percentile level as a speech proxy.
- It estimates the wet/dry amount needed to bring residual ambience near -14 dB, caps that
  amount if representative speech would fall below roughly -1.7 dB, and clamps the final
  recommendation to 55–96%.
- The recommendation is deterministic and local. Moving the slider turns Automatic off;
  turning Automatic back on restores the content-based value without re-running the model.

### UI and experience changes

- Reframed the app around one primary action: choose a recording and let Automatic decide.
- Replaced the generic purple card UI with a calm, high-contrast studio surface, a single
  soft-green accent, stronger typography, responsive layout and intentional empty state.
- Moved engine selection and DSP switches into progressive disclosure.
- Added a real original/cleaned waveform, measured result strip, clearer stage progress,
  compact selected-file state, audio-only presentation and a more legible export action.
- Added keyboard activation, visible focus, reduced-motion handling, live status semantics,
  inline file validation and accessible disabled state on export.

## Verification log

- `node test/audio_utils_test.mjs`: passed.
- RNNoise browser E2E: passed; automatic strength 80%, 73.2 dB quiet-floor reduction,
  speech preservation bound passed, video stream bit-identical, 1.4 s test-clip total.
- DeepFilterNet3 browser E2E: passed; automatic strength 80%, 89.5 dB quiet-floor
  reduction (test reports its -120 dB silence floor), speech preservation bound passed,
  video stream bit-identical, 1.7 s test-clip total.
- Existing 60 s fixture: RNNoise completed end to end in 3.4 s (17.6× realtime) and
  DeepFilterNet3 in 4.9 s (12.2× realtime), versus the previous documented estimates
  of about 5 s and 7 s. Both 60 s runs passed noise, speech and bit-identical video checks.
- Mid-run engine cancellation and restart: passed.
- Instant A/B during playback and manual strength re-export: passed.
- Forced four-part sectional E2E: passed with 69.0 dB synthetic quiet-floor reduction,
  31 ms duration delta (AAC framing) and bit-identical video.
- Adversarial lifecycle E2E: an in-flight 60 s job was interrupted by three rapid engine
  flips and source replacement, then the replacement completed four sequential multi-part
  reruns, cleanup rebuilds, rapid strength changes and live A/B playback without stale state,
  console errors or artifact collisions.
- Audio-only DeepFilterNet3 E2E: passed engine cancellation, re-exports, exact duration and
  preserved audio-only container semantics. The harness now saves the actual app-selected
  extension instead of hard-coding MP4.
- Full 36:02 real-world video: DeepFilterNet3 completed 25 memory-safe parts in 117.1 s
  (about 18.5× realtime), selected 55% automatically, produced a 367.5 MB result, lowered
  the measured quiet opening by 5.1 dB, preserved duration exactly and copied the video
  stream bit-identically.
- Desktop 1440 px and narrow 390 px visual checks: passed after fixing the mobile hero
  line-break spacing.

## Deliberate non-changes / future candidates

- No WebGPU rewrite. These recurrent streaming models cannot batch time frames, and the
  existing Rust/tract DeepFilterNet path is CPU-oriented. Browser GPU dispatch plus a DSP
  reimplementation is not justified by the current model size.
- No server model. Privacy and zero-upload behavior remain core constraints.
- Before adopting another neural model, benchmark it against DeepFilterNet3 on model bytes,
  cold start, peak memory, 48 kHz output, DNSMOS/P.835-style quality, speech attenuation and
  real browser real-time factor. A paper score alone is not enough.
