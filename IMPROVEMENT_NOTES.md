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
- **Section files still accumulated in WASM memory:** sectional PCM was bounded, but every
  lossless cleaned part remained in MEMFS until the final mux. A long recording could still
  exhaust the fixed WASM heap late in the run. Completed FLAC parts now spool to per-run
  browser-origin private storage, are removed immediately from MEMFS, and are mounted
  read-only for concat and strength re-exports. Per-part and second-mount fallbacks preserve
  compatibility, while run tokens and scoped cleanup prevent one tab or cancelled job from
  deleting another run's files.
- **Missing browser duration metadata:** the old fallback risked decoding an unbounded file
  before knowing whether sectional mode was required. A tiny ffmpeg header probe now obtains
  duration and stream presence without allocating the full PCM timeline; an unprobeable file
  over 128 MB fails safely instead of gambling on memory.
- **Relative A/V start drift:** normalized replacement audio moved delayed audio to time zero,
  changing lip sync even when total duration matched. A disposable probe worker measures the
  first audio and video timestamps without leaking `-copyts` state into production ffmpeg;
  both normal and sectional exports restore positive or negative relative offsets.
- **Unweighted sectional Automatic strength:** a short tail could dictate the recommendation
  for a much longer recording. Recommendations now use a duration-weighted conservative
  percentile, so equal sections remain protective while tiny tails cannot dominate.
- **Non-finite numeric inputs:** malformed metadata and PCM could propagate `NaN` or infinity
  into memory planning, analysis and export. Planner inputs are validated, explicit zero
  budgets are honored, frame analysis sanitizes samples, and cleanup output is always finite
  and clamped to the encoder-safe float range.
- **Real WebM decoder trap:** VP8/VP9 with Opus or Vorbis consistently triggered an upstream
  `memory access out of bounds` trap in the current official ffmpeg.wasm core, even with
  direct mounting and timestamp probing disabled. WebM is now rejected before processing
  with actionable alternatives and a privacy assurance, leaving the page usable for another
  file instead of crashing its media engine.

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
- Lossless section storage is also duration-independent inside the WASM heap: after each FLAC
  part reaches private browser storage, its MEMFS copy is deleted. Only the final muxed result
  remains whole in ffmpeg's virtual filesystem.
- Progress aggregation is now O(1) per worker message instead of repeatedly reducing the
  whole task list.

### Automatic strength design

- The default remains visually familiar at 70% before a file is known.
- After denoising, Shaant measures the 20th-percentile frame level as a quiet-floor proxy
  and the 88th-percentile energy above that floor as a speech proxy.
- It estimates the wet/dry amount needed to bring residual ambience down while respecting
  model-specific safety bounds. RNNoise retains its broad 55–96% range; protected DFN3 uses
  84–94% because its native attenuation and envelope guards bound speech damage separately.
- The recommendation is deterministic and local. Moving the slider turns Automatic off;
  turning Automatic back on restores the content-based value without re-running the model.
- For sectional recordings, analysis is aggregated by actual decoded duration rather than
  section count; truncated final frames and one-second tails therefore carry proportionate
  influence.

### Stronger cleanup without chopped speech

- The first full real-world result selected 55% and objectively removed only 6.2 dB on
  average from the quietest fifth of the recording. The user's report of clearly audible
  residual noise was correct: the safety policy was too timid for this source.
- A red regression demonstrated that comparing dry and wet loud-frame percentiles directly
  counts removed background energy as lost speech. Voice retention now compares energy above
  each signal's own measured floor, so successful denoising no longer penalizes Automatic.
- DeepFilterNet3 previously used a 100 dB attenuation limit, effectively allowing an
  unbounded mask. Its native attenuation ceiling is now 30 dB. Representative 20/30/40 dB
  tests found 30 dB retained almost all measured floor reduction and gave the strongest local
  speech-recognition confidence of the bounded candidates.
- A red collapse fixture drove a new speech-envelope guard. It leaves normal model
  attenuation and quiet frames untouched, but if a loud speech-like frame falls below about
  one-fifth of its input envelope, aligned dry signal is restored to a conservative floor.
  A one-frame lookahead protects consonant onsets; fast attack and slower release avoid
  chopping and flutter.
- With those two independent safeguards, DeepFilterNet3 Automatic now operates from 84–94%
  instead of falling to 55%. A representative montage showed that protected 90% and raw 100%
  both degraded transcription stability, while protected 84% stayed markedly closer to the
  original and was selected as the balance point.

### Source-specific native studio pass

- The difficult full-length recording uses highly correlated stereo (0.9994 correlation;
  side/mid RMS ratio 1.75%) and a roughly 48 kbps AAC source. A mono speech path is therefore
  appropriate and avoids running a heavy model twice without discarding meaningful ambience.
- Audacity-style spectral cleanup, FFmpeg `afftdn`, raw MossFormer2-SE and two-stage neural
  mixes were evaluated on the same stratified 80-second montage. Microsoft DNSMOS P.835 was
  used for speech/background/overall quality, while cached Whisper large-v3-turbo checked
  word stability without conditioning on earlier text.
- The protected browser DFN baseline scored SIG 2.502, BAK 3.256 and OVRL 2.069. Raw
  MossFormer improved BAK to 3.349 but lowered SIG to 2.377, so it was rejected as a direct
  replacement. Gentle `afftdn` variants also improved background scores while lowering SIG.
- A second MossFormer pass blended 40% over protected DFN scored SIG 2.524, BAK 3.321 and
  OVRL 2.096. Whisper kept 99.5% sequence similarity and improved average log probability
  from -0.755 to -0.714. This was selected as the speech-safe local winner.
- Fixed 55% produced the best DNSMOS OVRL (2.106) but transcript similarity fell to 52.9%; a
  VAD-adaptive 40–75% experiment also changed repeated low-confidence phrases. Both were
  rejected despite stronger background scores. The experiment confirms that maximum noise
  removal is not the same as the best intelligible result.
- The MLX wrapper runs MossFormer2-SE in bounded 30-second cores with two seconds of context.
  On the M2 Max, the complete 36:02 model pass took 59.4 seconds (about 40.3× realtime) with
  roughly 1.6 GB peak footprint. The web app remains CPU/WASM; only this optional studio pass
  uses the Apple GPU.
- Debugging the native path found four independent tooling faults: a removed checkpoint ID,
  an undeclared `webrtcvad` import in `mlx-audio`, the `mlx_whisper` CLI overwriting batch
  outputs with the first filename, and a non-frame-aligned final STFT block returning 256
  fewer samples. The helpers now use the maintained checkpoint, a deterministic batch
  transcriber, and exact-length fallback that preserves any sub-frame tail from the input.

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
- OPFS cancellation/reuse stress: an interrupted 60 s source, three rapid engine changes,
  source replacement and four subsequent four-part runs all completed without stale mounts,
  artifact collisions or console errors. The final section seams stayed below 2.13× their
  local 95th-percentile sample transition, with exact A/V start and bit-identical video.
- Forced metadata + MKV pass: browser metadata was deliberately bypassed, duration came from
  the bounded ffmpeg probe, four sections spooled to private storage, a mid-run engine switch
  recovered, and the result had exact duration/start timing and bit-identical video.
- A/V offset fixtures: both audio-delayed and video-delayed inputs preserve their original
  relative start within one AAC frame in normal and forced-sectional paths.
- Invalid-media recovery: a video-only file reports an actionable missing-audio error, leaves
  no stale download, and a valid replacement succeeds in the same page.
- WebM compatibility boundary: VP8, VP9, Opus and Vorbis crash fixtures now produce a clean,
  immediate format message with no console exception or stale output.
- Full 36:02 OPFS rerun after the final fixes: DeepFilterNet3 completed 25 parts in 119.6 s,
  selected 55%, produced the same 367.5 MB result, preserved duration and relative A/V start
  exactly, and copied the video stream bit-identically.
- Codex preview proxy: each full result is software-encoded to 960×540 H.264/AAC at about
  194 MiB, below Codex's 256 MiB preview ceiling, while the corresponding 367.5 MB
  original-quality master is preserved separately.
- Quality-focused 36:02 rerun: the protected 84% policy completed 25 OPFS-backed sections in
  121.5 s. Opening reduction improved from 5.1 to 7.5 dB. Against the earlier 55% render,
  average reduction improved by 8.0 dB in the quietest 10% of seconds, 6.4 dB in the quietest
  20%, and 3.8 dB across the quieter half. Duration and relative A/V start remained exact and
  the original video stream remained bit-identical.
- Final quality regressions: the normal DFN3 browser path reduced the synthetic floor by
  39.4 dB; forced four-part OPFS processing reduced it by 36.4 dB with a worst local seam
  ratio of 2.06×. Both preserved A/V start, duration and bit-identical video.
- Desktop 1440 px and narrow 390 px visual checks: passed after fixing the mobile hero
  line-break spacing.
- Native helper regressions: seven tests pass for clipping-safe downmix, short/long model
  output repair, invalid wet ranges, one-frame VAD padding, quiet weighting and exact-length
  bounded streaming output.
- Source-specific 36:02 studio render: protected DFN plus 40% MossFormer completed with
  103,779,328 finite samples, peak 0.672 (no clipping), exact 2162.066667 s container duration,
  and a video packet SHA-256 identical to the protected/browser master. Its maximum and
  99.9th-percentile sample transitions are lower than the base, so the added model cores did
  not introduce discontinuities. A 960×540 H.264/AAC proxy is 201 MiB, below Codex's 256 MiB
  preview ceiling; the original-quality copied-video master is 367,698,852 bytes.

## Deliberate non-changes / future candidates

- No WebGPU rewrite. These recurrent streaming models cannot batch time frames, and the
  existing Rust/tract DeepFilterNet path is CPU-oriented. Browser GPU dispatch plus a DSP
  reimplementation is not justified by the current model size.
- No server model. Privacy and zero-upload behavior remain core constraints.
- No silent WebM acceptance. The vendored core is already the latest official ffmpeg.wasm
  core release; a predictable preflight boundary is safer than a tab-killing WASM trap. Revisit
  support when an official core can pass the browser crash matrix.
- Before adopting another neural model, benchmark it against DeepFilterNet3 on model bytes,
  cold start, peak memory, 48 kHz output, DNSMOS/P.835-style quality, speech attenuation and
  real browser real-time factor. A paper score alone is not enough.
