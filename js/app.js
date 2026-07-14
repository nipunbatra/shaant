import { FFmpeg, FFFSType } from "../vendor/ffmpeg/index.js";
import {
  ENGINE_INFO,
  getPool,
  denoiseParallel,
  cancelEngineRun,
  measureDelay,
  compensateDelay,
} from "./engines.js";
import {
  adaptiveResidualCleanup,
  aggregateCleanupAnalyses,
  analyseCleanup,
  mediaExtension,
  parseAVStartOffset,
  parseChunkSeconds,
  planMediaSegments,
  planWorkingMemory,
  protectSpeechEnvelope,
  waveformPeaks,
} from "./audio-utils.mjs";

const SR = 48000;
const CH = 2;
const MAX_FILE_BYTES = 1.5 * 1024 * 1024 * 1024;
const MAX_UNPROBED_FILE_BYTES = 128 * 1024 * 1024;
const PCM_WORKING_SET_MULTIPLIER = 4.25;
const STREAM_PRIME_SECONDS = 1;
const QUERY = new URLSearchParams(location.search);
const STREAM_CHUNK_SECONDS = parseChunkSeconds(QUERY.get("stream-chunk"));
const FORCE_SEGMENTED = QUERY.has("streaming");
const FORCE_DURATION_PROBE = QUERY.has("probe-duration");
const FORCE_MEMORY_SOURCE = QUERY.has("memory-source");
const DISABLE_AV_PROBE = QUERY.has("no-av-probe");

const $ = (id) => document.getElementById(id);
const els = {
  dropZone: $("dropZone"), fileInput: $("fileInput"), pickBtn: $("pickBtn"),
  fileInfo: $("fileInfo"), fileName: $("fileName"), fileMeta: $("fileMeta"),
  fileKind: $("fileKind"), dropHint: $("dropHint"), dropTitle: $("dropTitle"),
  videoCard: $("videoCard"), workspaceTitle: $("workspaceTitle"),
  emptyState: $("emptyState"), mediaWorkbench: $("mediaWorkbench"),
  statusChip: $("statusChip"), bar: $("bar"), barTrack: $("barTrack"),
  progressLabel: $("progressLabel"), progressValue: $("progressValue"),
  player: $("player"), shadow: $("shadowPlayer"), playBtn: $("playBtn"),
  seek: $("seek"), timeLabel: $("timeLabel"),
  abToggle: $("abToggle"), abLabelOrig: $("abLabelOrig"), abLabelDen: $("abLabelDen"),
  strength: $("strength"), strengthVal: $("strengthVal"),
  autoStrength: $("autoStrength"), autoState: $("autoState"),
  autoDescription: $("autoDescription"), adaptiveCleanup: $("adaptiveCleanup"),
  smartStereo: $("smartStereo"), downloadBtn: $("downloadBtn"),
  resultInfo: $("resultInfo"), resultTitle: $("resultTitle"),
  playerHint: $("playerHint"), errorBox: $("errorBox"),
  engineBadge: $("engineBadge"), gpuBadge: $("gpuBadge"), coreCount: $("coreCount"),
  waveform: $("waveform"), waveformShell: $("waveformShell"),
  qualityStrip: $("qualityStrip"), noiseMetric: $("noiseMetric"),
  voiceMetric: $("voiceMetric"), speedMetric: $("speedMetric"),
};

let ffmpeg = null;
let ffmpegReady = null;
let ffLock = Promise.resolve();
let ffStage = false;
let ffProgressStart = 0;
let ffProgressSpan = 0;
let logTail = [];
let detectedVideo = false;
const SOURCE_MOUNT_POINT = "/source";
const CLEAN_MOUNT_POINT = "/clean-sections";
let sourceMounted = false;
let cleanPartsMounted = false;
let sectionSpool = null;

let currentFile = null;
let inputFsName = null;
let dryPcm = null;
let modelPcm = null;
let wetPcm = null;
let cleanupAnalysis = null;
let recommendedStrength = 0.7;
let wetRevision = 0;
let appliedWetRevision = -1;
let appliedStrength = -1;
let lastExportContext = null;
let lastOutputMeta = null;
let lastRunSummary = null;
let waveformCache = {};
let streamedWaveform = null;
let segmentedArtifacts = [];

let originalURL = null;
let processedURL = null;
let processedReady = false;
let originalPlaybackFailed = false;
let previewToken = 0;
let busy = false;
let runSeq = 0;
let denoiseRun = null;
let sourceAVStartOffset = null;

const PLAY_ICON = '<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><path d="M2 1l9 5-9 5z"/></svg>';
const PAUSE_ICON = '<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><rect x="2" y="1" width="3" height="10"/><rect x="7" y="1" width="3" height="10"/></svg>';

function withFF(task) {
  const promise = ffLock.then(task);
  ffLock = promise.catch(() => {});
  return promise;
}

function cancelActiveDenoise() {
  if (!denoiseRun) return;
  cancelEngineRun(denoiseRun.engineId);
  denoiseRun = null;
}

init();

function init() {
  const cores = navigator.hardwareConcurrency || 4;
  els.coreCount.textContent = String(Math.max(1, cores - 1));
  els.gpuBadge.textContent = "WASM SIMD · local CPU";
  updateEngineBadge();
  updateStrengthUI();

  els.pickBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    els.fileInput.click();
  });
  els.dropZone.addEventListener("click", () => els.fileInput.click());
  els.dropZone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      els.fileInput.click();
    }
  });
  els.fileInput.addEventListener("change", () => {
    const file = els.fileInput.files[0];
    els.fileInput.value = ""; // choosing the same file twice must still fire change
    if (file) setFile(file);
  });
  ["dragenter", "dragover"].forEach((name) => {
    els.dropZone.addEventListener(name, (event) => {
      event.preventDefault();
      els.dropZone.classList.add("dragover");
    });
  });
  ["dragleave", "drop"].forEach((name) => {
    els.dropZone.addEventListener(name, (event) => {
      event.preventDefault();
      els.dropZone.classList.remove("dragover");
    });
  });
  els.dropZone.addEventListener("drop", (event) => {
    const file = event.dataTransfer.files[0];
    if (file) setFile(file);
  });
  window.addEventListener("paste", (event) => {
    const file = Array.from(event.clipboardData?.files || [])[0];
    if (file && /^(audio|video)\//.test(file.type)) setFile(file);
  });

  document.querySelectorAll('input[name="engine"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      updateEngineBadge();
      if (currentFile) processCurrent();
    });
  });
  els.smartStereo.addEventListener("change", () => {
    if (currentFile) processCurrent();
  });
  els.adaptiveCleanup.addEventListener("change", async () => {
    if (lastExportContext?.segmented) {
      processCurrent();
      return;
    }
    rebuildWetPcm();
    if (wetPcm && !busy && lastExportContext) {
      await reexportCurrent();
    }
  });
  els.autoStrength.addEventListener("change", async () => {
    if (els.autoStrength.checked && cleanupAnalysis) applyRecommendedStrength();
    updateStrengthUI();
    if ((wetPcm || lastExportContext?.segmented) && !busy && lastExportContext) await reexportCurrent();
  });
  els.strength.addEventListener("input", () => {
    if (els.autoStrength.checked) els.autoStrength.checked = false;
    updateStrengthUI();
  });
  els.strength.addEventListener("change", async () => {
    if ((wetPcm || lastExportContext?.segmented) && !busy && Number(els.strength.value) / 100 !== appliedStrength) {
      await reexportCurrent();
    }
  });

  els.abToggle.addEventListener("change", applyAB);
  els.playBtn.addEventListener("click", togglePlay);
  els.player.addEventListener("click", togglePlay);
  els.player.addEventListener("play", () => {
    els.playBtn.innerHTML = PAUSE_ICON;
    if (processedReady) {
      syncShadow();
      els.shadow.play().catch(() => {});
    }
  });
  els.player.addEventListener("pause", () => {
    els.playBtn.innerHTML = PLAY_ICON;
    els.shadow.pause();
  });
  els.player.addEventListener("seeked", syncShadow);
  els.player.addEventListener("loadedmetadata", updateMediaMetadata);
  els.player.addEventListener("timeupdate", updateTransport);
  els.player.addEventListener("error", () => {
    if (!currentFile || els.player.src !== originalURL) return;
    originalPlaybackFailed = true;
    els.playerHint.textContent = processedReady
      ? "This browser cannot preview the original format, so only the cleaned version is available here."
      : "This browser cannot preview the original format. The cleaned version will appear when processing finishes.";
    els.playerHint.hidden = false;
    if (processedReady) useProcessedOnlyPreview();
  });
  els.seek.addEventListener("input", () => {
    const duration = els.player.duration || 0;
    if (duration) els.player.currentTime = (Number(els.seek.value) / 1000) * duration;
  });
  setInterval(() => {
    if (processedReady && !els.player.paused && Math.abs(els.shadow.currentTime - els.player.currentTime) > 0.06) {
      syncShadow();
    }
  }, 750);

  const redraw = () => renderWaveform();
  if ("ResizeObserver" in window) new ResizeObserver(redraw).observe(els.waveformShell);
  else window.addEventListener("resize", redraw);
  window.addEventListener("beforeunload", revokeURLs);

  // Start downloads after the first paint. One engine worker is warmed; larger
  // clips grow the pool on demand instead of paying the cost up front.
  const warm = () => {
    ensureFFmpeg().catch(() => {});
    getPool(selectedEngineId()).catch(() => {});
  };
  if ("requestIdleCallback" in window) requestIdleCallback(warm, { timeout: 800 });
  else setTimeout(warm, 80);
}

function selectedEngineId() {
  return document.querySelector('input[name="engine"]:checked').value;
}

function cleanupAnalysisOptions(engineId) {
  return engineId === "dfn3"
    ? {
        minimumStrength: 0.84,
        baselineStrength: 0.86,
        maximumStrength: 0.94,
        targetQuietRatio: 0.16,
      }
    : {};
}

function updateEngineBadge() {
  els.engineBadge.textContent = ENGINE_INFO[selectedEngineId()].short;
}

function updateStrengthUI() {
  const value = Number(els.strength.value);
  const automatic = els.autoStrength.checked;
  els.strengthVal.textContent = automatic ? `Auto · ${value}%` : `${value}%`;
  els.autoState.textContent = automatic ? "On" : "Off";
  els.autoDescription.textContent = automatic
    ? (cleanupAnalysis ? "Recommended from this recording's noise and speech." : "Listens for the noise floor and protects speech.")
    : "Manual control is active.";
}

function applyRecommendedStrength() {
  els.strength.value = String(Math.round(recommendedStrength * 100));
  updateStrengthUI();
}

function togglePlay() {
  if (els.player.paused) els.player.play().catch(() => {});
  else els.player.pause();
}

function syncShadow() {
  if (!processedReady) return;
  try {
    if (typeof els.shadow.fastSeek === "function") els.shadow.fastSeek(els.player.currentTime);
    else els.shadow.currentTime = els.player.currentTime;
  } catch {}
}

function applyAB() {
  const denoised = els.abToggle.checked && processedReady;
  els.player.muted = denoised;
  els.shadow.muted = !denoised;
  els.abLabelOrig.classList.toggle("on", !denoised);
  els.abLabelDen.classList.toggle("on", denoised);
}

function updateTransport() {
  const duration = els.player.duration || 0;
  if (duration) els.seek.value = String(Math.round((els.player.currentTime / duration) * 1000));
  els.timeLabel.textContent = `${fmtTime(els.player.currentTime)} / ${fmtTime(duration)}`;
}

function updateMediaMetadata() {
  updateTransport();
  if (!currentFile) return;
  const duration = isFinite(els.player.duration) ? ` · ${fmtTime(els.player.duration)}` : "";
  els.fileMeta.textContent = `${fmtSize(currentFile.size)}${duration} · click to replace`;
}

function setFile(file) {
  if (!file.size) {
    showStandaloneError("That file is empty. Choose a video or audio file with a playable audio track.");
    return;
  }
  if (file.size > MAX_FILE_BYTES) {
    showStandaloneError(`This file is ${fmtSize(file.size)}. Browser-based processing currently supports source files up to 1.5 GB.`);
    return;
  }
  if (mediaExtension(file.name, file.type) === "webm") {
    showStandaloneError(
      "WebM is temporarily unavailable because the browser audio engine can crash while decoding it. " +
      "Convert the file to MP4, MOV or MKV first, then try again. Your file has not been changed or uploaded.",
    );
    return;
  }

  cancelActiveDenoise();
  runSeq++;
  currentFile = file;
  dryPcm = modelPcm = wetPcm = null;
  cleanupAnalysis = null;
  recommendedStrength = 0.7;
  wetRevision = 0;
  appliedWetRevision = -1;
  appliedStrength = -1;
  lastExportContext = null;
  lastOutputMeta = null;
  lastRunSummary = null;
  waveformCache = {};
  streamedWaveform = null;
  processedReady = false;
  originalPlaybackFailed = false;
  previewToken++;
  sourceAVStartOffset = null;
  delete els.videoCard.dataset.durationSource;
  delete els.videoCard.dataset.segmentStorage;

  els.dropZone.classList.add("compact");
  els.dropTitle.hidden = true;
  els.dropHint.hidden = true;
  els.fileName.textContent = file.name;
  els.fileMeta.textContent = `${fmtSize(file.size)} · reading metadata…`;
  els.fileKind.textContent = fileKind(file);
  els.fileInfo.hidden = false;

  els.errorBox.hidden = true;
  els.playerHint.hidden = true;
  els.emptyState.hidden = true;
  els.mediaWorkbench.hidden = false;
  els.videoCard.dataset.state = "processing";
  els.videoCard.classList.toggle("audio-only", isAudioFile(file));
  els.workspaceTitle.textContent = file.name;
  els.downloadBtn.classList.add("disabled");
  els.downloadBtn.setAttribute("aria-disabled", "true");
  els.downloadBtn.removeAttribute("href");
  els.resultTitle.textContent = "Preparing cleaned file";
  els.resultInfo.textContent = "Processing locally";
  els.qualityStrip.hidden = true;
  els.abToggle.checked = true;
  els.abToggle.disabled = true;
  els.waveformShell.dataset.loading = "true";
  clearWaveform();

  revokeURLs();
  originalURL = URL.createObjectURL(file);
  els.player.src = originalURL;
  els.shadow.removeAttribute("src");
  els.shadow.load();
  applyAB();
  processCurrent();
}

function isAudioFile(file) {
  return file.type.startsWith("audio/") || /\.(mp3|wav|m4a|flac|ogg|aac)$/i.test(file.name);
}

function fileKind(file) {
  const extension = file.name.split(".").pop()?.slice(0, 4).toUpperCase();
  return extension || (isAudioFile(file) ? "AUD" : "VID");
}

function revokeURLs() {
  if (originalURL) URL.revokeObjectURL(originalURL);
  if (processedURL) URL.revokeObjectURL(processedURL);
  originalURL = processedURL = null;
}

// ---------- ffmpeg ----------

function ensureFFmpeg() {
  if (ffmpegReady) return ffmpegReady;
  ffmpegReady = (async () => {
    ffmpeg = new FFmpeg();
    ffmpeg.on("log", ({ message }) => {
      logTail.push(message);
      if (logTail.length > 120) logTail.shift();
      if (/Stream #0:\d+.*: Video:/.test(message) && !/attached pic/.test(message)) detectedVideo = true;
    });
    ffmpeg.on("progress", ({ progress }) => {
      if (ffStage && progress >= 0 && progress <= 1) {
        setBar(ffProgressStart + progress * ffProgressSpan);
      }
    });
    const base = new URL(".", document.baseURI).href;
    await ffmpeg.load({
      coreURL: base + "vendor/ffmpeg-core/ffmpeg-core.js",
      wasmURL: base + "vendor/ffmpeg-core/ffmpeg-core.wasm",
    });
  })();
  ffmpegReady.catch(() => { ffmpegReady = null; });
  return ffmpegReady;
}

// ---------- processing pipeline ----------

async function processCurrent() {
  if (!currentFile) return;
  cancelActiveDenoise();
  const file = currentFile;
  const seq = ++runSeq;
  const engineId = selectedEngineId();
  const engine = ENGINE_INFO[engineId];
  const smartStereo = els.smartStereo.checked;
  const started = performance.now();

  setBusy(true);
  els.videoCard.dataset.state = "processing";
  els.errorBox.hidden = true;
  processedReady = false;
  appliedStrength = -1;
  appliedWetRevision = -1;
  els.abToggle.disabled = true;
  applyAB();

  try {
    let sourceDuration = FORCE_DURATION_PROBE ? null : await waitForSourceMetadata(seq);
    if (seq !== runSeq) return;
    if (sourceDuration) els.videoCard.dataset.durationSource = "browser";
    const initialMemoryPlan = sourceDuration ? getWorkingMemoryPlan(file, sourceDuration) : null;
    const allowMemoryStaging = initialMemoryPlan
      ? initialMemoryPlan.safe
      : file.size <= MAX_UNPROBED_FILE_BYTES;

    setStatus("Loading local tools…", true, false, 0.02);
    await Promise.all([
      ensureFFmpeg(),
      getPool(engineId),
    ]);
    if (seq !== runSeq) return;

    const runInputName = await withFF(async () => {
      if (seq !== runSeq) return null;
      await cleanupSegmentedArtifactsLocked();
      return stageSourceFileLocked(file, seq, allowMemoryStaging);
    });
    if (seq !== runSeq || !runInputName) return;

    const probedAVStartOffset = isAudioFile(file) || DISABLE_AV_PROBE
      ? 0
      : await probeAVStartOffset(file, seq);
    if (seq !== runSeq) return;

    let probedHasVideo = false;
    if (!sourceDuration) {
      setStatus("Reading recording duration safely…", true, false, 0.04);
      const metadata = await withFF(() => probeSourceMetadataLocked(runInputName, seq));
      sourceDuration = metadata?.duration || null;
      probedHasVideo = Boolean(metadata?.hasVideo);
      if (seq !== runSeq) return;
      if (sourceDuration) {
        els.videoCard.dataset.durationSource = "ffmpeg";
        els.fileMeta.textContent = `${fmtSize(file.size)} · ${fmtTime(sourceDuration)} · click to replace`;
        console.debug(`[denoise] duration=ffmpeg seconds=${sourceDuration.toFixed(3)}`);
      }
    }

    if (!sourceDuration && file.size > MAX_UNPROBED_FILE_BYTES) {
      const error = new Error(
        "Shaant could not determine this large recording's duration safely. " +
        "Try remuxing it to MP4, MOV, MKV or WebM without re-encoding.",
      );
      error.userFacing = true;
      throw error;
    }

    const memoryPlan = sourceDuration ? getWorkingMemoryPlan(file, sourceDuration) : null;
    const useSegmentedPipeline = FORCE_SEGMENTED || Boolean(memoryPlan && !memoryPlan.safe);

    if (useSegmentedPipeline && sourceDuration) {
      await processSegmentedFile({
        seq, file, runInputName, sourceDuration, engineId, engine, smartStereo, started,
        knownHasVideo: probedHasVideo, knownAVStartOffset: probedAVStartOffset,
      });
      return;
    }

    setStatus("Extracting the audio track…", false, false, 0.08);
    const rawName = `audio-${seq}.f32`;

    const extracted = await withFF(async () => {
      if (seq !== runSeq) return null;
      detectedVideo = false;
      logTail = [];
      ffStage = true;
      ffProgressStart = 0.08;
      ffProgressSpan = 0.12;
      let returnCode;
      try {
        returnCode = await ffmpeg.exec([
          "-i", runInputName, "-vn", "-sn", "-dn", "-map", "0:a:0",
          "-ac", String(CH), "-ar", String(SR),
          "-f", "f32le", "-c:a", "pcm_f32le", rawName,
        ]);
      } finally {
        ffStage = false;
      }
      if (returnCode !== 0) {
        throw new Error("No usable audio track was found in this file.\n\n" + logTail.slice(-6).join("\n"));
      }
      const data = await ffmpeg.readFile(rawName);
      await ffmpeg.deleteFile(rawName);
      const loggedOffset = parseAVStartOffset(logTail);
      const avStartOffset = Math.abs(probedAVStartOffset) >= 0.0005
        ? probedAVStartOffset
        : loggedOffset;
      console.debug(`[denoise] av-offset=${avStartOffset.toFixed(6)}`);
      return {
        data,
        hasVideo: detectedVideo || probedHasVideo,
        avStartOffset,
      };
    });
    if (seq !== runSeq || !extracted) return;

    const raw = extracted.data;
    if (raw.byteOffset % 4 === 0 && raw.byteLength % 4 === 0) {
      dryPcm = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
    } else {
      dryPcm = new Float32Array(raw.byteLength >> 2);
      new Uint8Array(dryPcm.buffer).set(raw);
    }
    els.waveformShell.dataset.loading = "false";
    renderWaveform();

    denoiseRun = { seq, engineId };
    let denoised;
    try {
      denoised = await denoiseParallel(
        engineId,
        dryPcm,
        CH,
        (progress) => {
          if (seq !== runSeq) return;
          const workers = Math.max(1, Math.min(engine.maxWorkers, navigator.hardwareConcurrency - 1 || 3));
          setStatus(`Removing noise with ${engine.short} · up to ${workers} cores`, false, false, 0.2 + progress * 0.62);
        },
        { smartStereo },
      );
    } finally {
      if (denoiseRun?.seq === seq) denoiseRun = null;
    }
    if (seq !== runSeq) return;

    const delay = denoised.aligned ? 0 : measureDelay(dryPcm, denoised.wet, CH);
    const alignedModel = denoised.aligned
      ? denoised.wet
      : compensateDelay(denoised.wet, CH, delay);
    modelPcm = protectSpeechEnvelope(dryPcm, alignedModel, CH);
    rebuildWetPcm();
    cleanupAnalysis = analyseCleanup(dryPcm, modelPcm, CH, cleanupAnalysisOptions(engineId));
    recommendedStrength = cleanupAnalysis.recommendedStrength;
    if (els.autoStrength.checked) applyRecommendedStrength();
    else updateStrengthUI();

    const context = {
      seq,
      file,
      inputName: runInputName,
      hasVideo: extracted.hasVideo,
      engineId,
      engine,
      workers: denoised.workers,
      mode: denoised.mode,
      avStartOffset: extracted.avStartOffset,
    };
    lastExportContext = context;

    setStatus(extracted.hasVideo ? "Putting the cleaned audio back…" : "Encoding cleaned audio…", true, false, 0.84);
    let wantedStrength = Number(els.strength.value) / 100;
    let wantedRevision = wetRevision;
    while (seq === runSeq && (wantedStrength !== appliedStrength || wantedRevision !== appliedWetRevision)) {
      await exportWithStrength(wantedStrength, context);
      wantedStrength = Number(els.strength.value) / 100;
      wantedRevision = wetRevision;
    }
    if (seq !== runSeq) return;

    const elapsedSeconds = (performance.now() - started) / 1000;
    const audioSeconds = dryPcm.length / (SR * CH);
    const realtime = elapsedSeconds > 0 ? audioSeconds / elapsedSeconds : 0;
    const secondsLabel = elapsedSeconds.toFixed(1);
    lastRunSummary = `${engine.short} · ${denoised.mode} · ${denoised.workers} ${denoised.workers === 1 ? "worker" : "workers"} · ${secondsLabel}s`;
    updateResultInfo();
    els.noiseMetric.textContent = cleanupAnalysis.quietFloorReductionDb >= 95
      ? ">95 dB"
      : `${cleanupAnalysis.quietFloorReductionDb.toFixed(1)} dB`;
    els.voiceMetric.textContent = formatVoiceRetention(cleanupAnalysis.voiceRetentionDb);
    els.speedMetric.textContent = realtime >= 1 ? `${realtime.toFixed(1)}× realtime` : `${secondsLabel}s`;
    els.qualityStrip.hidden = false;
    els.videoCard.dataset.state = "ready";
    setStatus("Ready to compare", false, true, 1);
    console.debug(
      `[denoise] engine=${engineId} workers=${denoised.workers} mode=${denoised.mode} ` +
      `delay=${delay} samples auto=${Math.round(recommendedStrength * 100)}% ` +
      `quiet-ratio=${cleanupAnalysis.quietRatio.toFixed(3)} ` +
      `voice-ratio=${cleanupAnalysis.voiceRatio.toFixed(3)} total=${secondsLabel}s`,
    );
  } catch (error) {
    if (seq === runSeq) showError(error);
  } finally {
    if (seq === runSeq) setBusy(false);
  }
}

function waitForSourceMetadata(seq, timeoutMs = 2500) {
  if (els.player.readyState >= HTMLMediaElement.HAVE_METADATA && isFinite(els.player.duration)) {
    return Promise.resolve(els.player.duration);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (duration = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      els.player.removeEventListener("loadedmetadata", onMetadata);
      els.player.removeEventListener("error", onError);
      resolve(seq === runSeq ? duration : null);
    };
    const onMetadata = () => finish(isFinite(els.player.duration) ? els.player.duration : null);
    const onError = () => finish(null);
    const timer = setTimeout(() => finish(null), timeoutMs);
    els.player.addEventListener("loadedmetadata", onMetadata, { once: true });
    els.player.addEventListener("error", onError, { once: true });
  });
}

function getWorkingMemoryPlan(file, duration) {
  const deviceBytes = (navigator.deviceMemory || 4) * 1024 * 1024 * 1024;
  const safeLimit = Math.min(2.5 * 1024 * 1024 * 1024, deviceBytes * 0.35);
  return planWorkingMemory(file.size, duration, {
    sampleRate: SR,
    channels: CH,
    multiplier: PCM_WORKING_SET_MULTIPLIER,
    safeLimitBytes: safeLimit,
  });
}

async function probeSourceMetadataLocked(inputName, seq) {
  try {
    detectedVideo = false;
    logTail = [];
    const returnCode = await ffmpeg.exec([
      "-hide_banner", "-i", inputName,
      "-map", "0:a:0", "-t", "0.001", "-f", "null", "-",
    ]);
    if (returnCode !== 0 || seq !== runSeq) return null;
    const durationLine = logTail.find((line) => line.includes("Duration:"));
    const match = durationLine?.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (!match) return null;
    const duration = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
    return Number.isFinite(duration) && duration > 0
      ? { duration, hasVideo: detectedVideo }
      : null;
  } catch (error) {
    console.warn("[denoise] duration-probe failed", error);
    return null;
  }
}

async function probeAVStartOffset(file, seq) {
  if (sourceAVStartOffset !== null) return sourceAVStartOffset;
  const probe = new FFmpeg();
  const logs = [];
  try {
    probe.on("log", ({ message }) => {
      logs.push(message);
      if (logs.length > 120) logs.shift();
    });
    const base = new URL(".", document.baseURI).href;
    await probe.load({
      coreURL: base + "vendor/ffmpeg-core/ffmpeg-core.js",
      wasmURL: base + "vendor/ffmpeg-core/ffmpeg-core.wasm",
    });
    await probe.createDir(SOURCE_MOUNT_POINT);
    const mounted = await probe.mount(
      FFFSType.WORKERFS,
      { files: [file] },
      SOURCE_MOUNT_POINT,
    );
    if (!mounted) return 0;
    const inputName = `${SOURCE_MOUNT_POINT}/${file.name}`;
    const returnCode = await probe.exec([
      "-copyts", "-i", inputName,
      "-filter_complex", "[0:a:0]ashowinfo[a];[0:v:0]showinfo[v]",
      "-map", "[a]", "-map", "[v]",
      "-frames:a", "1", "-frames:v", "1",
      "-f", "null", "-",
    ]);
    if (returnCode !== 0 || seq !== runSeq) return 0;
    const first = (filterName) => {
      const line = logs.find((entry) =>
        entry.includes(`[Parsed_${filterName}_`) && /\bn:\s*0\b/.test(entry) && entry.includes("pts_time:"));
      const value = Number(line?.match(/pts_time:\s*(-?\d+(?:\.\d+)?)/)?.[1]);
      return Number.isFinite(value) ? value : null;
    };
    const audioStart = first("ashowinfo");
    const videoStart = first("showinfo");
    const offset = audioStart === null || videoStart === null ? 0 : audioStart - videoStart;
    if (seq === runSeq) sourceAVStartOffset = offset;
    return offset;
  } catch (error) {
    console.warn("[denoise] A/V timestamp probe failed; using normalized starts.", error);
    return 0;
  } finally {
    probe.terminate();
  }
}

async function cleanupSegmentedArtifactsLocked() {
  if (cleanPartsMounted) {
    try { await ffmpeg.unmount(CLEAN_MOUNT_POINT); } catch {}
    cleanPartsMounted = false;
  }
  for (const name of segmentedArtifacts) {
    try { await ffmpeg.deleteFile(name); } catch {}
  }
  segmentedArtifacts = [];
  await cleanupSectionSpool();
}

async function cleanupSectionSpool() {
  const spool = sectionSpool;
  sectionSpool = null;
  await removeSectionSpool(spool);
}

async function removeSectionSpool(spool) {
  if (!spool) return;
  try { await spool.parent.removeEntry(spool.name, { recursive: true }); } catch {}
}

async function createSectionSpool(seq) {
  if (!navigator.storage?.getDirectory) return null;
  try {
    const root = await navigator.storage.getDirectory();
    const parent = await root.getDirectoryHandle("shaant-temporary-audio", { create: true });
    // A tab can be closed before asynchronous cleanup runs. Reclaim old runs,
    // but never delete a directory that another active tab may still own.
    for await (const [name] of parent.entries()) {
      const timestamp = Number(name.split("-").at(-1));
      if (name.startsWith("run-") && Number.isFinite(timestamp) &&
          Date.now() - timestamp > 24 * 60 * 60 * 1000) {
        try { await parent.removeEntry(name, { recursive: true }); } catch {}
      }
    }
    const name = `run-${seq}-${Date.now()}`;
    const directory = await parent.getDirectoryHandle(name, { create: true });
    return { parent, directory, name, files: [] };
  } catch (error) {
    console.warn("[denoise] OPFS section spool unavailable; using memory.", error);
    return null;
  }
}

async function spoolCleanPart(spool, name, data) {
  const handle = await spool.directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(data);
  } finally {
    await writable.close();
  }
  const file = await handle.getFile();
  spool.files.push(file);
  return `${CLEAN_MOUNT_POINT}/${name}`;
}

async function cleanupSourceFileLocked() {
  if (sourceMounted) {
    try { await ffmpeg.unmount(SOURCE_MOUNT_POINT); } catch {}
    sourceMounted = false;
  } else if (inputFsName) {
    try { await ffmpeg.deleteFile(inputFsName); } catch {}
  }
  inputFsName = null;
}

async function stageSourceFileLocked(file, seq, allowMemoryFallback = true) {
  await cleanupSourceFileLocked();
  try { await ffmpeg.createDir(SOURCE_MOUNT_POINT); } catch {}

  // WORKERFS exposes the browser File directly to ffmpeg. Unlike writeFile,
  // it does not duplicate the complete compressed video inside the WASM heap;
  // ffmpeg reads only the byte ranges requested by the demuxer.
  try {
    if (FORCE_MEMORY_SOURCE) throw new Error("in-memory source forced for diagnostics");
    const mounted = await ffmpeg.mount(
      FFFSType.WORKERFS,
      { files: [file] },
      SOURCE_MOUNT_POINT,
    );
    if (!mounted) throw new Error("WORKERFS is unavailable");
    sourceMounted = true;
    inputFsName = `${SOURCE_MOUNT_POINT}/${file.name}`;
    console.debug("[denoise] source=direct-file-mount");
    return inputFsName;
  } catch (error) {
    try { await ffmpeg.unmount(SOURCE_MOUNT_POINT); } catch {}
    sourceMounted = false;
    console.warn("[denoise] Direct file mount unavailable.", error);
  }

  if (!allowMemoryFallback) {
    const error = new Error(
      "This browser could not open the recording through the memory-safe file mount. " +
      "Try the latest Chrome, Edge or Firefox instead of loading the whole file into memory.",
    );
    error.userFacing = true;
    throw error;
  }

  const extension = (file.name.split(".").pop() || "dat").toLowerCase();
  console.debug("[denoise] source=in-memory-fallback");
  const safeExtension = /^[a-z0-9]{1,5}$/.test(extension) ? extension : "dat";
  const fallbackName = `input-${seq}.${safeExtension}`;
  const bytes = new Uint8Array(await file.arrayBuffer());
  await ffmpeg.writeFile(fallbackName, bytes);
  inputFsName = fallbackName;
  return inputFsName;
}

async function processSegmentedFile({
  seq, file, runInputName, sourceDuration, engineId, engine, smartStereo, started,
  knownHasVideo = false, knownAVStartOffset = 0,
}) {
  const segments = planMediaSegments(sourceDuration, STREAM_CHUNK_SECONDS);
  const partCount = segments.length;
  const analyses = [];
  const partNames = [];
  let usedWorkers = 1;
  let detectedInputVideo = knownHasVideo;
  let avStartOffset = knownAVStartOffset;
  streamedWaveform = { dry: [], wet: [] };
  dryPcm = modelPcm = wetPcm = null;
  waveformCache = {};

  const spool = await createSectionSpool(seq);
  if (seq !== runSeq) {
    await removeSectionSpool(spool);
    return;
  }
  sectionSpool = spool;
  let segmentStorageMode = spool ? "opfs" : "memfs";
  els.videoCard.dataset.segmentStorage = segmentStorageMode;

  setStatus(`Preparing ${partCount} memory-safe parts…`, true, false, 0.04);

  for (let part = 0; part < partCount; part++) {
    if (seq !== runSeq) return;
    const keepStart = segments[part].start;
    const keepDuration = segments[part].duration;
    const leadSeconds = part === 0 ? 0 : STREAM_PRIME_SECONDS;
    const extractStart = Math.max(0, keepStart - leadSeconds);
    const extractDuration = keepDuration + leadSeconds;
    const rawName = `stream-${seq}-${String(part).padStart(3, "0")}.f32`;

    console.debug(`[denoise] part=${part + 1}/${partCount} stage=decode`);
    setStatus(`Decoding part ${part + 1} of ${partCount}…`, false, false,
      0.07 + (part / partCount) * 0.72);
    const raw = await withFF(async () => {
      if (seq !== runSeq) return null;
      if (part === 0) {
        detectedVideo = false;
        logTail = [];
      }
      ffStage = true;
      ffProgressStart = 0.07 + (part / partCount) * 0.72;
      ffProgressSpan = 0.08 / partCount;
      let returnCode;
      try {
        returnCode = await ffmpeg.exec([
          "-ss", extractStart.toFixed(6), "-i", runInputName,
          "-t", extractDuration.toFixed(6),
          "-vn", "-sn", "-dn", "-map", "0:a:0",
          "-ac", String(CH), "-ar", String(SR),
          "-f", "f32le", "-c:a", "pcm_f32le", rawName,
        ]);
      } finally {
        ffStage = false;
      }
      if (returnCode !== 0) {
        throw new Error(`Could not decode audio part ${part + 1}.\n\n` + logTail.slice(-6).join("\n"));
      }
      const data = await ffmpeg.readFile(rawName);
      await ffmpeg.deleteFile(rawName);
      if (part === 0) {
        detectedInputVideo = detectedInputVideo || detectedVideo;
        const loggedOffset = parseAVStartOffset(logTail);
        if (Math.abs(avStartOffset) < 0.0005) avStartOffset = loggedOffset;
      }
      return data;
    });
    if (!raw || seq !== runSeq) return;
    console.debug(`[denoise] part=${part + 1}/${partCount} stage=model bytes=${raw.byteLength}`);
    if (raw.byteLength < CH * Float32Array.BYTES_PER_ELEMENT) {
      console.debug(`[denoise] part=${part + 1}/${partCount} stage=empty-skip`);
      continue;
    }

    let dryFull;
    if (raw.byteOffset % 4 === 0 && raw.byteLength % 4 === 0) {
      dryFull = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
    } else {
      dryFull = new Float32Array(raw.byteLength >> 2);
      new Uint8Array(dryFull.buffer).set(raw);
    }

    denoiseRun = { seq, engineId };
    let denoised;
    try {
      denoised = await denoiseParallel(
        engineId,
        dryFull,
        CH,
        (progress) => {
          if (seq !== runSeq) return;
          const overall = (part + progress * 0.86) / partCount;
          setStatus(`Cleaning part ${part + 1} of ${partCount} with ${engine.short}…`, false, false,
            0.07 + overall * 0.72);
        },
        { smartStereo },
      );
    } finally {
      if (denoiseRun?.seq === seq) denoiseRun = null;
    }
    if (seq !== runSeq) return;
    usedWorkers = Math.max(usedWorkers, denoised.workers);

    const delay = denoised.aligned ? 0 : measureDelay(dryFull, denoised.wet, CH);
    const alignedModel = denoised.aligned
      ? denoised.wet
      : compensateDelay(denoised.wet, CH, delay);
    const modelFull = protectSpeechEnvelope(dryFull, alignedModel, CH);
    const enhancedFull = els.adaptiveCleanup.checked
      ? adaptiveResidualCleanup(dryFull, modelFull, CH)
      : modelFull;
    const leadFrames = Math.round(leadSeconds * SR);
    const availableFrames = Math.max(0, Math.floor(dryFull.length / CH) - leadFrames);
    const keepFrames = Math.min(Math.round(keepDuration * SR), availableFrames);
    const startSample = leadFrames * CH;
    const endSample = startSample + keepFrames * CH;
    const dryKeep = dryFull.subarray(startSample, endSample);
    const modelKeep = modelFull.subarray(startSample, endSample);
    const enhancedKeep = enhancedFull.subarray(startSample, endSample);

    if (!keepFrames) continue;
    const actualKeepDuration = keepFrames / SR;
    const analysis = analyseCleanup(dryKeep, modelKeep, CH, cleanupAnalysisOptions(engineId));
    analyses.push({ ...analysis, duration: actualKeepDuration });
    const peakCount = Math.max(24, Math.round(actualKeepDuration * 0.7));
    streamedWaveform.dry.push(...waveformPeaks(dryKeep, CH, peakCount));
    streamedWaveform.wet.push(...waveformPeaks(enhancedKeep, CH, peakCount));
    waveformCache = {};
    els.waveformShell.dataset.loading = "false";
    renderWaveform();

    const pcmName = `clean-${seq}-${String(part).padStart(3, "0")}.f32`;
    const flacName = `clean-${seq}-${String(part).padStart(3, "0")}.flac`;
    console.debug(`[denoise] part=${part + 1}/${partCount} stage=pack`);
    setStatus(`Packing part ${part + 1} of ${partCount}…`, true, false,
      0.07 + ((part + 0.9) / partCount) * 0.72);
    const encoded = await withFF(async () => {
      if (seq !== runSeq) return false;
      const bytesView = new Uint8Array(
        enhancedKeep.buffer,
        enhancedKeep.byteOffset,
        enhancedKeep.byteLength,
      );
      await ffmpeg.writeFile(pcmName, bytesView);
      let returnCode;
      try {
        returnCode = await ffmpeg.exec([
          "-f", "f32le", "-ar", String(SR), "-ac", String(CH), "-i", pcmName,
          "-c:a", "flac", "-sample_fmt", "s32", "-y", flacName,
        ]);
      } finally {
        try { await ffmpeg.deleteFile(pcmName); } catch {}
      }
      return returnCode === 0;
    });
    if (!encoded || seq !== runSeq) {
      if (seq === runSeq) throw new Error(`Could not store cleaned audio part ${part + 1}.`);
      return;
    }
    let storedName = flacName;
    if (spool) {
      try {
        const flacData = await withFF(() => ffmpeg.readFile(flacName));
        if (seq !== runSeq) {
          await withFF(async () => { try { await ffmpeg.deleteFile(flacName); } catch {} });
          await removeSectionSpool(spool);
          return;
        }
        storedName = await spoolCleanPart(spool, flacName, flacData);
        if (seq !== runSeq) {
          await withFF(async () => { try { await ffmpeg.deleteFile(flacName); } catch {} });
          await removeSectionSpool(spool);
          return;
        }
        await withFF(async () => {
          try { await ffmpeg.deleteFile(flacName); } catch {}
        });
      } catch (error) {
        if (seq !== runSeq) {
          await withFF(async () => { try { await ffmpeg.deleteFile(flacName); } catch {} });
          await removeSectionSpool(spool);
          return;
        }
        segmentStorageMode = "hybrid";
        els.videoCard.dataset.segmentStorage = segmentStorageMode;
        console.warn(`[denoise] Could not spool part ${part + 1}; keeping it in memory.`, error);
      }
    }
    partNames.push(storedName);
    if (storedName === flacName) segmentedArtifacts.push(flacName);
    console.debug(`[denoise] part=${part + 1}/${partCount} stage=done`);
  }

  if (seq !== runSeq) return;
  if (!partNames.length) throw new Error("The selected recording contains no decodable audio samples.");
  if (spool?.files.length) {
    await withFF(async () => {
      if (seq !== runSeq || sectionSpool !== spool) return;
      try { await ffmpeg.createDir(CLEAN_MOUNT_POINT); } catch {}
      const mounted = await ffmpeg.mount(
        FFFSType.WORKERFS,
        { files: spool.files },
        CLEAN_MOUNT_POINT,
      );
      if (mounted) {
        cleanPartsMounted = true;
        return;
      }

      // Very old WORKERFS builds may reject a second mount. Restore only the
      // already-spooled compressed parts to MEMFS as a compatibility fallback.
      segmentStorageMode = "memfs-fallback";
      els.videoCard.dataset.segmentStorage = segmentStorageMode;
      for (const file of spool.files) {
        await ffmpeg.writeFile(file.name, new Uint8Array(await file.arrayBuffer()));
        segmentedArtifacts.push(file.name);
      }
      for (let index = 0; index < partNames.length; index++) {
        if (partNames[index].startsWith(`${CLEAN_MOUNT_POINT}/`)) {
          partNames[index] = partNames[index].slice(CLEAN_MOUNT_POINT.length + 1);
        }
      }
    });
    if (seq !== runSeq || sectionSpool !== spool) return;
  }
  const listName = `clean-${seq}-parts.txt`;
  const listText = partNames.map((name) => `file '${name}'`).join("\n") + "\n";
  await withFF(async () => {
    if (seq !== runSeq) return;
    await ffmpeg.writeFile(listName, new TextEncoder().encode(listText));
  });
  segmentedArtifacts.push(listName);

  cleanupAnalysis = aggregateCleanupAnalyses(analyses);
  recommendedStrength = cleanupAnalysis.recommendedStrength;
  if (els.autoStrength.checked) applyRecommendedStrength();
  else updateStrengthUI();
  wetRevision++;

  const context = {
    seq,
    file,
    inputName: runInputName,
    hasVideo: detectedInputVideo,
    engineId,
    engine,
    workers: usedWorkers,
    mode: `streamed · ${partCount} parts`,
    segmented: true,
    cleanList: listName,
    avStartOffset,
  };
  lastExportContext = context;
  setStatus(detectedInputVideo ? "Rebuilding the full video…" : "Building the full audio file…",
    true, false, 0.82);
  await exportWithStrength(Number(els.strength.value) / 100, context);
  if (seq !== runSeq) return;

  const elapsedSeconds = (performance.now() - started) / 1000;
  const realtime = sourceDuration / Math.max(0.001, elapsedSeconds);
  const secondsLabel = elapsedSeconds.toFixed(1);
  lastRunSummary = `${engine.short} · streamed in ${partCount} parts · ${usedWorkers} workers · ${secondsLabel}s`;
  updateResultInfo();
  els.noiseMetric.textContent = cleanupAnalysis.quietFloorReductionDb >= 95
    ? ">95 dB"
    : `${cleanupAnalysis.quietFloorReductionDb.toFixed(1)} dB`;
  els.voiceMetric.textContent = formatVoiceRetention(cleanupAnalysis.voiceRetentionDb);
  els.speedMetric.textContent = realtime >= 1 ? `${realtime.toFixed(1)}× realtime` : `${secondsLabel}s`;
  els.qualityStrip.hidden = false;
  els.videoCard.dataset.state = "ready";
  setStatus("Ready to compare", false, true, 1);
  console.debug(
    `[denoise] engine=${engineId} workers=${usedWorkers} mode=streamed parts=${partCount} ` +
    `auto=${Math.round(recommendedStrength * 100)}% ` +
    `quiet-ratio=${cleanupAnalysis.quietRatio.toFixed(3)} ` +
    `voice-ratio=${cleanupAnalysis.voiceRatio.toFixed(3)} total=${secondsLabel}s`,
  );
}

function rebuildWetPcm() {
  if (!modelPcm || !dryPcm) return;
  wetPcm = els.adaptiveCleanup.checked
    ? adaptiveResidualCleanup(dryPcm, modelPcm, CH)
    : modelPcm;
  waveformCache.wet = null;
  wetRevision++;
  renderWaveform();
}

async function reexportCurrent() {
  if (!lastExportContext || lastExportContext.seq !== runSeq) return;
  try {
    setBusy(true);
    setStatus("Updating the cleaned file…", true, false, 0.84);
    let wantedStrength = Number(els.strength.value) / 100;
    let wantedRevision = wetRevision;
    while (lastExportContext.seq === runSeq &&
      (wantedStrength !== appliedStrength || wantedRevision !== appliedWetRevision)) {
      await exportWithStrength(wantedStrength, lastExportContext);
      wantedStrength = Number(els.strength.value) / 100;
      wantedRevision = wetRevision;
    }
    if (lastExportContext.seq === runSeq) setStatus("Ready to compare", false, true, 1);
  } catch (error) {
    if (lastExportContext.seq === runSeq) showError(error);
  } finally {
    if (lastExportContext?.seq === runSeq) setBusy(false);
  }
}

async function exportWithStrength(strength, context) {
  if (context.segmented) return exportSegmentedWithStrength(strength, context);
  if (!wetPcm || !dryPcm || context.seq !== runSeq || context.file !== currentFile) return false;
  const revision = wetRevision;
  let mixed;
  let transferable;
  if (strength >= 1) {
    mixed = wetPcm;
    transferable = new Uint8Array(mixed.buffer, mixed.byteOffset, mixed.byteLength).slice();
  } else {
    mixed = new Float32Array(dryPcm.length);
    for (let i = 0; i < dryPcm.length; i++) mixed[i] = dryPcm[i] + (wetPcm[i] - dryPcm[i]) * strength;
    transferable = new Uint8Array(mixed.buffer);
  }

  const payload = await withFF(async () => {
    if (context.seq !== runSeq) return null;
    await ffmpeg.writeFile("denoised.f32", transferable);
    const timingArgs = Math.abs(context.avStartOffset || 0) >= 0.0005
      ? ["-itsoffset", Number(context.avStartOffset).toFixed(6)]
      : [];
    const rawArgs = [
      ...timingArgs,
      "-f", "f32le", "-ar", String(SR), "-ac", String(CH), "-i", "denoised.f32",
    ];
    const attempts = [];
    if (!context.hasVideo) {
      attempts.push({
        ext: "m4a", mime: "audio/mp4",
        args: ["-map", "1:a:0", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"],
      });
    } else {
      const copyVideo = ["-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy"];
      attempts.push({
        ext: "mp4", mime: "video/mp4",
        args: [...copyVideo, "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"],
      });
      attempts.push({ ext: "mkv", mime: "video/x-matroska", args: [...copyVideo, "-c:a", "aac", "-b:a", "192k"] });
    }

    ffStage = true;
    ffProgressStart = 0.84;
    ffProgressSpan = 0.16;
    let output = null;
    try {
      for (const attempt of attempts) {
        const outputName = `out-${context.seq}.${attempt.ext}`;
        logTail = [];
        const returnCode = await ffmpeg.exec([
          "-i", context.inputName, ...rawArgs, ...attempt.args, "-y", outputName,
        ]);
        if (returnCode === 0) {
          output = { name: outputName, ...attempt };
          break;
        }
        try { await ffmpeg.deleteFile(outputName); } catch {}
      }
    } finally {
      ffStage = false;
      try { await ffmpeg.deleteFile("denoised.f32"); } catch {}
    }
    if (!output) throw new Error("The cleaned file could not be rebuilt.\n\n" + logTail.slice(-6).join("\n"));
    const data = await ffmpeg.readFile(output.name);
    await ffmpeg.deleteFile(output.name);
    return { data, output };
  });

  return installExportPayload(payload, strength, context, revision);
}

async function exportSegmentedWithStrength(strength, context) {
  if (!context.cleanList || context.seq !== runSeq || context.file !== currentFile) return false;
  const revision = wetRevision;
  const dryWeight = Math.max(0, 1 - strength).toFixed(6);
  const wetWeight = Math.min(1, Math.max(0, strength)).toFixed(6);
  const startOffset = Number(context.avStartOffset) || 0;
  const filter =
    `[0:a:0]aresample=${SR},asetpts=PTS-STARTPTS[dry];` +
    `[1:a:0]aresample=${SR},asetpts=PTS-STARTPTS[wet];` +
    `[dry][wet]amix=inputs=2:weights='${dryWeight} ${wetWeight}':` +
    `normalize=0:duration=first[mixed];` +
    `[mixed]asetpts=PTS+${startOffset.toFixed(6)}/TB[outa]`;

  const payload = await withFF(async () => {
    if (context.seq !== runSeq) return null;
    const commonInput = [
      "-i", context.inputName,
      "-f", "concat", "-safe", "0", "-i", context.cleanList,
      "-filter_complex", filter,
    ];
    const attempts = [];
    if (!context.hasVideo) {
      attempts.push({
        ext: "m4a", mime: "audio/mp4",
        args: ["-map", "[outa]", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"],
      });
    } else {
      const copyVideo = ["-map", "0:v:0", "-map", "[outa]", "-c:v", "copy"];
      attempts.push({
        ext: "mp4", mime: "video/mp4",
        args: [...copyVideo, "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"],
      });
      attempts.push({ ext: "mkv", mime: "video/x-matroska", args: [...copyVideo, "-c:a", "aac", "-b:a", "192k"] });
    }

    ffStage = true;
    ffProgressStart = 0.82;
    ffProgressSpan = 0.18;
    let output = null;
    try {
      for (const attempt of attempts) {
        const outputName = `out-${context.seq}-stream.${attempt.ext}`;
        logTail = [];
        const returnCode = await ffmpeg.exec([
          ...commonInput, ...attempt.args, "-y", outputName,
        ]);
        if (returnCode === 0) {
          output = { name: outputName, ...attempt };
          break;
        }
        try { await ffmpeg.deleteFile(outputName); } catch {}
      }
    } finally {
      ffStage = false;
    }
    if (!output) {
      throw new Error("The streamed cleaned file could not be rebuilt.\n\n" + logTail.slice(-8).join("\n"));
    }
    const data = await ffmpeg.readFile(output.name);
    await ffmpeg.deleteFile(output.name);
    return { data, output };
  });
  return installExportPayload(payload, strength, context, revision);
}

async function installExportPayload(payload, strength, context, revision) {
  if (!payload || context.seq !== runSeq || context.file !== currentFile) return false;
  const blob = new Blob([payload.data], { type: payload.output.mime });
  const previousURL = processedURL;
  processedURL = URL.createObjectURL(blob);
  if (previousURL) URL.revokeObjectURL(previousURL);
  appliedStrength = strength;
  appliedWetRevision = revision;

  const base = context.file.name.replace(/\.[^.]+$/, "");
  els.downloadBtn.href = processedURL;
  els.downloadBtn.download = `${base}.shaant.${payload.output.ext}`;
  els.downloadBtn.dataset.strength = String(Math.round(strength * 100));
  els.downloadBtn.classList.remove("disabled");
  els.downloadBtn.setAttribute("aria-disabled", "false");
  els.resultTitle.textContent = "Cleaned file ready";
  lastOutputMeta = `${payload.output.ext.toUpperCase()} · ${fmtSize(blob.size)}`;
  updateResultInfo();

  const token = ++previewToken;
  const wasPlaying = !els.player.paused && !els.player.ended;
  const previewURL = processedURL;
  await new Promise((resolve) => {
    const finish = () => {
      els.shadow.removeEventListener("loadedmetadata", finish);
      els.shadow.removeEventListener("error", finish);
      resolve();
    };
    els.shadow.addEventListener("loadedmetadata", finish, { once: true });
    els.shadow.addEventListener("error", finish, { once: true });
    els.shadow.src = previewURL;
  });
  if (token !== previewToken || previewURL !== processedURL || context.seq !== runSeq) return false;

  processedReady = true;
  els.abToggle.disabled = originalPlaybackFailed;
  syncShadow();
  if (wasPlaying) els.shadow.play().catch(() => {});
  if (originalPlaybackFailed) useProcessedOnlyPreview();
  else applyAB();
  return true;
}

function useProcessedOnlyPreview() {
  if (!processedURL) return;
  const time = els.player.currentTime || 0;
  const wasPlaying = !els.player.paused;
  els.player.src = processedURL;
  els.player.addEventListener("loadedmetadata", () => {
    els.player.currentTime = Math.min(time, els.player.duration || time);
    if (wasPlaying) els.player.play().catch(() => {});
  }, { once: true });
  els.abToggle.disabled = true;
  els.player.muted = false;
  els.shadow.muted = true;
  els.abLabelOrig.classList.remove("on");
  els.abLabelDen.classList.add("on");
}

// ---------- waveform ----------

function clearWaveform() {
  const context = els.waveform.getContext("2d");
  context.clearRect(0, 0, els.waveform.width, els.waveform.height);
}

function renderWaveform() {
  if ((!dryPcm && !streamedWaveform?.dry.length) || !els.waveformShell.clientWidth) return;
  const cssWidth = els.waveformShell.clientWidth;
  const cssHeight = els.waveformShell.clientHeight;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  els.waveform.width = Math.round(cssWidth * ratio);
  els.waveform.height = Math.round(cssHeight * ratio);
  const context = els.waveform.getContext("2d");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, cssWidth, cssHeight);

  const buckets = Math.max(120, Math.floor(cssWidth / 2));
  if (!dryPcm && streamedWaveform?.dry.length) {
    const dryPeaks = fitPeakSeries(streamedWaveform.dry, buckets);
    const wetPeaks = fitPeakSeries(streamedWaveform.wet, buckets);
    let peak = 0;
    for (const value of dryPeaks) peak = Math.max(peak, value);
    const scale = peak > 0 ? (cssHeight * 0.4) / peak : 1;
    drawPeaks(context, dryPeaks, cssWidth, cssHeight, scale, "rgba(111, 125, 111, 0.48)", 1);
    drawPeaks(context, wetPeaks, cssWidth, cssHeight, scale, "rgba(201, 247, 197, 0.88)", 1.3);
    return;
  }
  if (waveformCache.dry !== dryPcm || waveformCache.buckets !== buckets) {
    waveformCache = {
      dry: dryPcm,
      wet: null,
      buckets,
      dryPeaks: waveformPeaks(dryPcm, CH, buckets),
      wetPeaks: null,
    };
  }
  if (wetPcm && waveformCache.wet !== wetPcm) {
    waveformCache.wet = wetPcm;
    waveformCache.wetPeaks = waveformPeaks(wetPcm, CH, buckets);
  }
  const dryPeaks = waveformCache.dryPeaks;
  const wetPeaks = wetPcm ? waveformCache.wetPeaks : null;
  let peak = 0;
  for (const value of dryPeaks) peak = Math.max(peak, value);
  const scale = peak > 0 ? (cssHeight * 0.4) / peak : 1;
  drawPeaks(context, dryPeaks, cssWidth, cssHeight, scale, "rgba(111, 125, 111, 0.48)", 1);
  if (wetPeaks) drawPeaks(context, wetPeaks, cssWidth, cssHeight, scale, "rgba(201, 247, 197, 0.88)", 1.3);
}

function fitPeakSeries(values, buckets) {
  const output = new Float32Array(buckets);
  if (!values.length) return output;
  for (let bucket = 0; bucket < buckets; bucket++) {
    const start = Math.floor(bucket * values.length / buckets);
    const end = Math.max(start + 1, Math.ceil((bucket + 1) * values.length / buckets));
    let peak = 0;
    for (let i = start; i < Math.min(values.length, end); i++) peak = Math.max(peak, values[i]);
    output[bucket] = peak;
  }
  return output;
}

function drawPeaks(context, peaks, width, height, scale, color, lineWidth) {
  const center = height / 2;
  context.beginPath();
  for (let i = 0; i < peaks.length; i++) {
    const x = (i / Math.max(1, peaks.length - 1)) * width;
    const amplitude = Math.max(0.6, peaks[i] * scale);
    context.moveTo(x, center - amplitude);
    context.lineTo(x, center + amplitude);
  }
  context.strokeStyle = color;
  context.lineWidth = lineWidth;
  context.stroke();
}

// ---------- UI helpers ----------

function setBusy(value) {
  busy = value;
  els.barTrack.hidden = !value;
}

function setStatus(text, indeterminate = false, done = false, progress = null) {
  els.statusChip.textContent = text;
  els.statusChip.classList.toggle("done", done);
  els.progressLabel.textContent = text;
  els.bar.classList.toggle("indeterminate", indeterminate);
  if (progress !== null) setBar(progress);
}

function setBar(ratio) {
  const value = Math.min(1, Math.max(0, ratio));
  els.bar.style.width = `${Math.round(value * 100)}%`;
  els.progressValue.textContent = `${Math.round(value * 100)}%`;
}

function showStandaloneError(message) {
  els.errorBox.textContent = message;
  els.errorBox.hidden = false;
  els.errorBox.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function showError(error) {
  if (!error?.userFacing) console.error(error);
  els.videoCard.dataset.state = "error";
  setStatus("Processing failed", false, false);
  showStandaloneError(String(error?.message || error));
}

function updateResultInfo() {
  els.resultInfo.textContent = [lastOutputMeta, lastRunSummary].filter(Boolean).join(" · ") || "Processing locally";
}

function formatVoiceRetention(db) {
  if (db >= -0.15) return "Full level";
  return `${db.toFixed(1)} dB`;
}

function fmtSize(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtTime(seconds) {
  if (!isFinite(seconds)) return "0:00";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60).toString().padStart(2, "0");
  return hours ? `${hours}:${minutes.toString().padStart(2, "0")}:${secs}` : `${minutes}:${secs}`;
}
