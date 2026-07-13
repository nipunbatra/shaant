import { FFmpeg } from "../vendor/ffmpeg/index.js";
import { ENGINE_INFO, getPool, denoiseParallel, cancelEngineRun, measureDelay, compensateDelay } from "./engines.js";

const SR = 48000;  // both engines operate at 48 kHz
const CH = 2;      // process everything as stereo

const $ = (id) => document.getElementById(id);
const els = {
  dropZone: $("dropZone"), fileInput: $("fileInput"), pickBtn: $("pickBtn"),
  fileInfo: $("fileInfo"), dropHint: $("dropHint"), dropTitle: $("dropTitle"),
  videoCard: $("videoCard"), statusChip: $("statusChip"),
  bar: $("bar"), barTrack: $("barTrack"),
  player: $("player"), shadow: $("shadowPlayer"),
  playBtn: $("playBtn"), seek: $("seek"), timeLabel: $("timeLabel"),
  abToggle: $("abToggle"), abLabelOrig: $("abLabelOrig"), abLabelDen: $("abLabelDen"),
  strength: $("strength"), strengthVal: $("strengthVal"),
  downloadBtn: $("downloadBtn"), resultInfo: $("resultInfo"),
  playerHint: $("playerHint"), errorBox: $("errorBox"),
  engineBadge: $("engineBadge"), gpuBadge: $("gpuBadge"),
};

let ffmpeg = null;
let ffmpegReady = null;      // promise, so prefetch and process share one load
let currentFile = null;
let inputFsName = null;
let hasVideo = false;
let dryPcm = null;
let wetPcm = null;
let appliedStrength = -1;
let originalURL = null;
let processedURL = null;
let processedReady = false;
let busy = false;
let runSeq = 0;              // invalidates in-flight runs when a new file/engine lands
let denoiseRun = null;       // { seq, engineId } while a pool run is in flight
let logTail = [];
let ffStage = false;         // route ffmpeg progress events to the bar
let ffLock = Promise.resolve(); // serializes ffmpeg use across overlapping runs

function withFF(fn) {
  const p = ffLock.then(fn);
  ffLock = p.catch(() => {});
  return p;
}

function cancelActiveDenoise() {
  if (denoiseRun) {
    cancelEngineRun(denoiseRun.engineId);
    denoiseRun = null;
  }
}

init();

function init() {
  els.gpuBadge.textContent = navigator.gpu
    ? "WebGPU: available (see README for why compute stays on CPU)"
    : "WebGPU: not available (CPU is enough)";
  updateEngineBadge();

  els.pickBtn.addEventListener("click", (e) => { e.stopPropagation(); els.fileInput.click(); });
  els.dropZone.addEventListener("click", () => els.fileInput.click());
  els.fileInput.addEventListener("change", () => {
    if (els.fileInput.files.length) setFile(els.fileInput.files[0]);
  });
  ["dragenter", "dragover"].forEach((ev) =>
    els.dropZone.addEventListener(ev, (e) => { e.preventDefault(); els.dropZone.classList.add("dragover"); }));
  ["dragleave", "drop"].forEach((ev) =>
    els.dropZone.addEventListener(ev, (e) => { e.preventDefault(); els.dropZone.classList.remove("dragover"); }));
  els.dropZone.addEventListener("drop", (e) => {
    if (e.dataTransfer.files.length) setFile(e.dataTransfer.files[0]);
  });

  // engine switch re-processes the current file — even mid-run (cancels it)
  document.querySelectorAll('input[name="engine"]').forEach((radio) =>
    radio.addEventListener("change", () => {
      updateEngineBadge();
      if (currentFile) processCurrent();
    }));

  els.strength.addEventListener("input", () => {
    els.strengthVal.textContent = `${els.strength.value}%`;
  });
  els.strength.addEventListener("change", async () => {
    const s = Number(els.strength.value) / 100;
    if (wetPcm && !busy && s !== appliedStrength) {
      const seq = runSeq;
      try {
        setBusy(true);
        setStatus("Re-exporting…", true);
        await exportWithStrength(s);
        if (seq === runSeq) setStatus(readyText(), false, true);
      } catch (err) {
        showError(err);
      } finally {
        setBusy(false);
      }
    }
  });

  // A/B switch: instant audio swap between the two synced players
  els.abToggle.addEventListener("change", applyAB);

  // custom transport controls (native controls would fight the mute-swap)
  els.playBtn.addEventListener("click", togglePlay);
  els.player.addEventListener("click", togglePlay);
  els.player.addEventListener("play", () => {
    els.playBtn.textContent = "❚❚";
    if (processedReady) { syncShadow(); els.shadow.play().catch(() => {}); }
  });
  els.player.addEventListener("pause", () => {
    els.playBtn.textContent = "▶";
    els.shadow.pause();
  });
  els.player.addEventListener("seeked", syncShadow);
  els.player.addEventListener("loadedmetadata", () => {
    els.timeLabel.textContent = `${fmtTime(els.player.currentTime)} / ${fmtTime(els.player.duration)}`;
  });
  els.player.addEventListener("timeupdate", () => {
    const d = els.player.duration || 0;
    if (d) els.seek.value = String(Math.round((els.player.currentTime / d) * 1000));
    els.timeLabel.textContent = `${fmtTime(els.player.currentTime)} / ${fmtTime(d)}`;
  });
  els.seek.addEventListener("input", () => {
    const d = els.player.duration || 0;
    if (d) els.player.currentTime = (Number(els.seek.value) / 1000) * d;
  });
  setInterval(() => {
    if (processedReady && !els.player.paused) {
      if (Math.abs(els.shadow.currentTime - els.player.currentTime) > 0.06) syncShadow();
    }
  }, 750);

  els.player.addEventListener("error", () => {
    if (!currentFile) return;
    if (processedURL && els.player.src === originalURL) {
      els.playerHint.textContent =
        "Your browser can't play the original file's format — previewing the processed version only.";
      els.playerHint.hidden = false;
      els.player.src = processedURL;
      els.abToggle.disabled = true;
    }
  });

  // warm everything up while the user is still picking a file
  ensureFFmpeg().catch(() => {});
  getPool(selectedEngineId()).catch(() => {});
}

function selectedEngineId() {
  return document.querySelector('input[name="engine"]:checked').value;
}

function updateEngineBadge() {
  els.engineBadge.textContent = "Engine: " + ENGINE_INFO[selectedEngineId()].label;
}

function togglePlay() {
  if (els.player.paused) els.player.play().catch(() => {});
  else els.player.pause();
}

function syncShadow() {
  if (processedReady) els.shadow.currentTime = els.player.currentTime;
}

function applyAB() {
  const denoised = els.abToggle.checked && processedReady;
  els.player.muted = denoised;
  els.shadow.muted = !denoised;
  els.abLabelOrig.classList.toggle("on", !denoised);
  els.abLabelDen.classList.toggle("on", denoised);
}

function setFile(file) {
  runSeq++;
  currentFile = file;
  dryPcm = wetPcm = null;
  appliedStrength = -1;
  processedReady = false;

  els.dropZone.classList.add("compact");
  els.dropTitle.hidden = true;
  els.dropHint.hidden = true;
  els.fileInfo.textContent = `${file.name} · ${fmtSize(file.size)} — drop another file to replace`;
  els.fileInfo.hidden = false;

  els.errorBox.hidden = true;
  els.playerHint.hidden = true;
  els.videoCard.hidden = false;
  els.videoCard.dataset.state = "processing";
  els.downloadBtn.classList.add("disabled");
  els.resultInfo.textContent = "";
  els.abToggle.checked = true;
  els.abToggle.disabled = true;

  if (originalURL) URL.revokeObjectURL(originalURL);
  originalURL = URL.createObjectURL(file);
  els.player.src = originalURL;
  els.shadow.removeAttribute("src");
  applyAB();

  processCurrent();
}

// ---------- ffmpeg ----------

function ensureFFmpeg() {
  if (ffmpegReady) return ffmpegReady;
  ffmpegReady = (async () => {
    ffmpeg = new FFmpeg();
    ffmpeg.on("log", ({ message }) => {
      logTail.push(message);
      if (logTail.length > 60) logTail.shift();
      if (/Stream #0:\d+.*: Video:/.test(message) && !/attached pic/.test(message)) {
        hasVideo = true;
      }
    });
    ffmpeg.on("progress", ({ progress }) => {
      if (ffStage && progress >= 0 && progress <= 1) setBar(progress);
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

// ---------- pipeline ----------

async function processCurrent() {
  if (!currentFile) return;
  cancelActiveDenoise();
  const seq = ++runSeq;
  const engineId = selectedEngineId();
  const info = ENGINE_INFO[engineId];
  setBusy(true);
  els.videoCard.dataset.state = "processing";
  els.errorBox.hidden = true;
  processedReady = false;
  appliedStrength = -1; // engine re-runs must re-export even at the same strength
  els.abToggle.disabled = true;
  applyAB();
  const t0 = performance.now();
  try {
    // load engines, ffmpeg and the file bytes concurrently
    setStatus("Warming up…", true);
    const [, , bytes] = await Promise.all([
      ensureFFmpeg(),
      getPool(engineId),
      currentFile.arrayBuffer(),
    ]);
    if (seq !== runSeq) return;

    setStatus("Extracting audio…");
    const raw = await withFF(async () => {
      if (seq !== runSeq) return null;
      const ext = (currentFile.name.split(".").pop() || "").toLowerCase();
      if (inputFsName) { try { await ffmpeg.deleteFile(inputFsName); } catch {} }
      inputFsName = "in." + (/^[a-z0-9]{1,5}$/.test(ext) ? ext : "dat");
      await ffmpeg.writeFile(inputFsName, new Uint8Array(bytes));
      hasVideo = false;
      logTail = [];
      ffStage = true;
      const ret = await ffmpeg.exec([
        "-i", inputFsName, "-vn", "-sn", "-dn", "-map", "0:a:0",
        "-ac", String(CH), "-ar", String(SR),
        "-f", "f32le", "-c:a", "pcm_f32le", "audio.f32",
      ]);
      ffStage = false;
      if (ret !== 0) {
        throw new Error("Could not extract audio — does the file have an audio track?\n\n" + logTail.slice(-6).join("\n"));
      }
      const data = await ffmpeg.readFile("audio.f32");
      await ffmpeg.deleteFile("audio.f32");
      return data;
    });
    if (seq !== runSeq || !raw) return;
    dryPcm = new Float32Array(raw.byteLength >> 2);
    new Uint8Array(dryPcm.buffer).set(raw);

    denoiseRun = { seq, engineId };
    let denoised;
    try {
      denoised = await denoiseParallel(engineId, dryPcm, CH, (r) => {
        if (seq === runSeq) {
          setStatus(`Removing noise (${info.short}) · ${workersLabel(engineId)}… ${Math.round(r * 100)}%`);
          setBar(r);
        }
      });
    } finally {
      if (denoiseRun?.seq === seq) denoiseRun = null;
    }
    const { wet, workers } = denoised;
    if (seq !== runSeq) return;

    const delay = measureDelay(dryPcm, wet, CH);
    console.debug(`[denoise] engine=${engineId} workers=${workers} measured delay=${delay} samples`);
    wetPcm = compensateDelay(wet, CH, delay);

    setStatus(hasVideo ? "Rebuilding video…" : "Rebuilding audio…", true);
    // strength can be adjusted while processing runs — catch up if it moved mid-export
    let want = Number(els.strength.value) / 100;
    while (seq === runSeq && want !== appliedStrength) {
      await exportWithStrength(want);
      want = Number(els.strength.value) / 100;
    }
    if (seq !== runSeq) return;

    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    els.resultInfo.textContent += ` · ${info.short} · ${secs}s`;
    console.debug(`[denoise] engine=${engineId} total=${secs}s`);
    els.videoCard.dataset.state = "ready";
    setStatus(readyText(), false, true);
  } catch (err) {
    if (seq === runSeq) showError(err);
  } finally {
    if (seq === runSeq) setBusy(false);
  }
}

function workersLabel(engineId) {
  const cores = navigator.hardwareConcurrency || 4;
  const n = Math.max(1, Math.min(ENGINE_INFO[engineId].maxWorkers, cores - 1));
  return `${n} cores`;
}

function readyText() {
  return "Ready — flick the switch while playing";
}

async function exportWithStrength(strength) {
  let mixed;
  if (strength >= 1) {
    mixed = wetPcm;
  } else {
    mixed = new Float32Array(dryPcm.length);
    for (let i = 0; i < dryPcm.length; i++) {
      mixed[i] = dryPcm[i] + (wetPcm[i] - dryPcm[i]) * strength;
    }
  }
  const { data, output } = await withFF(async () => {
    // writeFile transfers the buffer to the ffmpeg worker (detaching it), so hand it a copy —
    // wetPcm/dryPcm must survive for later strength re-exports
    await ffmpeg.writeFile("denoised.f32", new Uint8Array(mixed.buffer, mixed.byteOffset, mixed.byteLength).slice());

    const inputExt = inputFsName.split(".").pop();
    const rawArgs = ["-f", "f32le", "-ar", String(SR), "-ac", String(CH), "-i", "denoised.f32"];
    const attempts = [];
    if (!hasVideo) {
      attempts.push({ ext: "m4a", mime: "audio/mp4",
        args: ["-map", "1:a:0", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"] });
    } else {
      const videoCopy = ["-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy"];
      if (inputExt === "webm") {
        attempts.push({ ext: "webm", mime: "video/webm", args: [...videoCopy, "-c:a", "libopus", "-b:a", "128k"] });
      }
      attempts.push({ ext: "mp4", mime: "video/mp4",
        args: [...videoCopy, "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"] });
      attempts.push({ ext: "mkv", mime: "video/x-matroska", args: [...videoCopy, "-c:a", "aac", "-b:a", "192k"] });
    }

    let out = null;
    for (const att of attempts) {
      const outName = "out." + att.ext;
      logTail = [];
      const ret = await ffmpeg.exec(["-i", inputFsName, ...rawArgs, ...att.args, "-y", outName]);
      if (ret === 0) {
        out = { name: outName, ...att };
        break;
      }
      try { await ffmpeg.deleteFile(outName); } catch {}
    }
    await ffmpeg.deleteFile("denoised.f32");
    if (!out) {
      throw new Error("Could not rebuild the file.\n\n" + logTail.slice(-6).join("\n"));
    }
    const d = await ffmpeg.readFile(out.name);
    await ffmpeg.deleteFile(out.name);
    return { data: d, output: out };
  });
  const blob = new Blob([data], { type: output.mime });
  if (processedURL) URL.revokeObjectURL(processedURL);
  processedURL = URL.createObjectURL(blob);
  appliedStrength = strength;

  const base = currentFile.name.replace(/\.[^.]+$/, "");
  els.downloadBtn.href = processedURL;
  els.downloadBtn.download = `${base}.denoised.${output.ext}`;
  els.downloadBtn.classList.remove("disabled");
  els.resultInfo.textContent = `${output.ext.toUpperCase()} · ${fmtSize(blob.size)}`;

  // hook the processed file into the hidden synced player → instant A/B
  const wasPlaying = !els.player.paused && !els.player.ended;
  els.shadow.src = processedURL;
  els.shadow.addEventListener("loadedmetadata", () => {
    processedReady = true;
    els.abToggle.disabled = false;
    syncShadow();
    if (wasPlaying) els.shadow.play().catch(() => {});
    applyAB();
  }, { once: true });
}

// ---------- UI helpers ----------

function setBusy(b) {
  busy = b;
  els.barTrack.hidden = !b;
}

function setStatus(text, indeterminate = false, done = false) {
  els.statusChip.textContent = text;
  els.statusChip.classList.toggle("done", done);
  els.bar.classList.toggle("indeterminate", indeterminate);
  if (indeterminate) setBar(0.3);
}

function setBar(ratio) {
  els.bar.style.width = `${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%`;
}

function showError(err) {
  console.error(err);
  els.videoCard.dataset.state = "error";
  setStatus("Failed", false);
  els.errorBox.textContent = String(err?.message || err);
  els.errorBox.hidden = false;
}

function fmtSize(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtTime(s) {
  if (!isFinite(s)) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60).toString().padStart(2, "0");
  return `${m}:${sec}`;
}
