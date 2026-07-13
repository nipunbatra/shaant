import { FFmpeg } from "../vendor/ffmpeg/index.js";
import { engines, measureDelay, compensateDelay } from "./engines.js";

const SR = 48000;  // both engines operate at 48 kHz
const CH = 2;      // process everything as stereo

const $ = (id) => document.getElementById(id);
const els = {
  dropZone: $("dropZone"), fileInput: $("fileInput"), pickBtn: $("pickBtn"),
  fileInfo: $("fileInfo"), controlsCard: $("controlsCard"),
  strength: $("strength"), strengthVal: $("strengthVal"), processBtn: $("processBtn"),
  progressCard: $("progressCard"), stageLabel: $("stageLabel"), bar: $("bar"),
  errorBox: $("errorBox"), resultCard: $("resultCard"), player: $("player"),
  abToggle: $("abToggle"), playerHint: $("playerHint"),
  downloadBtn: $("downloadBtn"), resultInfo: $("resultInfo"),
  engineBadge: $("engineBadge"), gpuBadge: $("gpuBadge"),
};

let ffmpeg = null;
let currentFile = null;
let inputFsName = null;      // input file name inside ffmpeg's virtual FS
let hasVideo = false;
let dryPcm = null;           // original audio, interleaved f32
let wetPcm = null;           // denoised audio, interleaved f32 (delay-compensated)
let wetEngineId = null;      // which engine produced wetPcm
let appliedStrength = -1;
let originalURL = null;
let processedURL = null;
let busy = false;
let logTail = [];
let currentStage = "";

init();

function init() {
  els.gpuBadge.textContent = navigator.gpu
    ? "WebGPU: available (denoisers run fine on CPU)"
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

  document.querySelectorAll('input[name="engine"]').forEach((radio) =>
    radio.addEventListener("change", updateEngineBadge));

  els.strength.addEventListener("input", () => {
    els.strengthVal.textContent = `${els.strength.value}%`;
  });
  // Re-export with the new strength without re-running the denoiser
  els.strength.addEventListener("change", async () => {
    const s = Number(els.strength.value) / 100;
    if (wetPcm && !busy && s !== appliedStrength) {
      try {
        busy = true;
        showProgress("Re-exporting with new strength…", true);
        await exportWithStrength(s);
        hideProgress();
      } catch (err) {
        showError(err);
      } finally {
        busy = false;
      }
    }
  });

  els.processBtn.addEventListener("click", () => { if (!busy) process(); });

  els.abToggle.addEventListener("change", () => {
    swapSource(els.abToggle.checked ? processedURL : originalURL);
  });
  els.player.addEventListener("error", () => {
    if (!els.abToggle.checked && processedURL) {
      els.playerHint.textContent =
        "Your browser can't play the original file's format — switching back to the denoised version.";
      els.playerHint.hidden = false;
      els.abToggle.checked = true;
      swapSource(processedURL);
    }
  });
}

function selectedEngine() {
  return engines[document.querySelector('input[name="engine"]:checked').value];
}

function updateEngineBadge() {
  els.engineBadge.textContent = "Engine: " + selectedEngine().label;
}

function setFile(file) {
  if (busy) return;
  currentFile = file;
  dryPcm = wetPcm = null;
  wetEngineId = null;
  appliedStrength = -1;
  els.fileInfo.textContent = `${file.name} · ${fmtSize(file.size)}`;
  els.fileInfo.hidden = false;
  els.controlsCard.hidden = false;
  els.resultCard.hidden = true;
  els.errorBox.hidden = true;
  els.playerHint.hidden = true;
  if (originalURL) URL.revokeObjectURL(originalURL);
  originalURL = URL.createObjectURL(file);
}

// ---------- ffmpeg ----------

async function ensureFFmpeg() {
  if (ffmpeg) return;
  showProgress("Loading FFmpeg (~32 MB, cached by the browser after the first run)…", true);
  ffmpeg = new FFmpeg();
  ffmpeg.on("log", ({ message }) => {
    logTail.push(message);
    if (logTail.length > 60) logTail.shift();
    if (/Stream #0:\d+.*: Video:/.test(message) && !/attached pic/.test(message)) {
      hasVideo = true;
    }
  });
  ffmpeg.on("progress", ({ progress }) => {
    if (currentStage === "ffmpeg" && progress >= 0 && progress <= 1) setBar(progress);
  });
  const base = new URL(".", document.baseURI).href;
  await ffmpeg.load({
    coreURL: base + "vendor/ffmpeg-core/ffmpeg-core.js",
    wasmURL: base + "vendor/ffmpeg-core/ffmpeg-core.wasm",
  });
}

// ---------- pipeline ----------

async function process() {
  if (!currentFile) return;
  busy = true;
  els.processBtn.disabled = true;
  els.errorBox.hidden = true;
  els.resultCard.hidden = true;
  const engine = selectedEngine();
  const t0 = performance.now();
  try {
    await ensureFFmpeg();
    await engine.ensureLoaded((msg) => showProgress(msg, true));

    // 1. Put the input file into ffmpeg's virtual FS
    showProgress("Reading file…", true);
    if (inputFsName) { try { await ffmpeg.deleteFile(inputFsName); } catch {} }
    const ext = (currentFile.name.split(".").pop() || "").toLowerCase();
    inputFsName = "in." + (/^[a-z0-9]{1,5}$/.test(ext) ? ext : "dat");
    await ffmpeg.writeFile(inputFsName, new Uint8Array(await currentFile.arrayBuffer()));

    // 2. Extract audio as raw float32 stereo @ 48 kHz
    showProgress("Extracting audio…", false, "ffmpeg");
    hasVideo = false;
    logTail = [];
    const ret = await ffmpeg.exec([
      "-i", inputFsName, "-vn", "-sn", "-dn", "-map", "0:a:0",
      "-ac", String(CH), "-ar", String(SR),
      "-f", "f32le", "-c:a", "pcm_f32le", "audio.f32",
    ]);
    if (ret !== 0) {
      throw new Error("Could not extract audio — does the file have an audio track?\n\n" + logTail.slice(-6).join("\n"));
    }
    const raw = await ffmpeg.readFile("audio.f32");
    await ffmpeg.deleteFile("audio.f32");
    dryPcm = new Float32Array(raw.byteLength >> 2);
    new Uint8Array(dryPcm.buffer).set(raw);

    // 3. Denoise
    showProgress(engine.id === "dfn3" ? "Removing noise (high quality — takes a while)…" : "Removing noise…", false);
    let wet = await engine.process(dryPcm, CH, setBar);

    // 4. Compensate the engine's algorithmic delay so A/V sync stays exact
    //    and strength-mixing doesn't comb-filter
    const delay = measureDelay(dryPcm, wet, CH);
    console.debug(`[denoise] engine=${engine.id} measured delay=${delay} samples`);
    wetPcm = compensateDelay(wet, CH, delay);
    wetEngineId = engine.id;

    // 5. Mix to requested strength, re-encode audio, copy video stream
    showProgress(hasVideo ? "Rebuilding video…" : "Rebuilding audio…", false, "ffmpeg");
    await exportWithStrength(Number(els.strength.value) / 100);

    hideProgress();
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    els.resultInfo.textContent += ` · ${engine.id === "dfn3" ? "DeepFilterNet3" : "RNNoise"} · processed in ${secs}s`;
  } catch (err) {
    showError(err);
  } finally {
    busy = false;
    els.processBtn.disabled = false;
  }
}

async function exportWithStrength(strength) {
  // strength 1 → fully denoised, 0 → original
  let mixed;
  if (strength >= 1) {
    mixed = wetPcm;
  } else {
    mixed = new Float32Array(dryPcm.length);
    for (let i = 0; i < dryPcm.length; i++) {
      mixed[i] = dryPcm[i] + (wetPcm[i] - dryPcm[i]) * strength;
    }
  }
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

  let output = null;
  for (const att of attempts) {
    const outName = "out." + att.ext;
    logTail = [];
    const ret = await ffmpeg.exec(["-i", inputFsName, ...rawArgs, ...att.args, "-y", outName]);
    if (ret === 0) {
      output = { name: outName, ...att };
      break;
    }
    try { await ffmpeg.deleteFile(outName); } catch {}
  }
  await ffmpeg.deleteFile("denoised.f32");
  if (!output) {
    throw new Error("Could not rebuild the file.\n\n" + logTail.slice(-6).join("\n"));
  }

  const data = await ffmpeg.readFile(output.name);
  await ffmpeg.deleteFile(output.name);
  const blob = new Blob([data], { type: output.mime });
  if (processedURL) URL.revokeObjectURL(processedURL);
  processedURL = URL.createObjectURL(blob);
  appliedStrength = strength;

  const base = currentFile.name.replace(/\.[^.]+$/, "");
  els.downloadBtn.href = processedURL;
  els.downloadBtn.download = `${base}.denoised.${output.ext}`;
  els.resultInfo.textContent = `${output.ext.toUpperCase()} · ${fmtSize(blob.size)}`;
  els.resultCard.hidden = false;
  els.abToggle.checked = true;
  swapSource(processedURL);
}

// ---------- UI helpers ----------

function swapSource(url) {
  if (!url) return;
  const v = els.player;
  const t = v.currentTime;
  const wasPlaying = !v.paused && !v.ended;
  v.src = url;
  v.addEventListener("loadedmetadata", () => {
    if (isFinite(t) && t > 0) v.currentTime = Math.min(t, v.duration || t);
    if (wasPlaying) v.play().catch(() => {});
  }, { once: true });
}

function showProgress(label, indeterminate, stageKind = "") {
  currentStage = stageKind;
  els.stageLabel.textContent = label;
  els.progressCard.hidden = false;
  els.bar.classList.toggle("indeterminate", !!indeterminate);
  if (!indeterminate) setBar(0);
}

function hideProgress() {
  els.progressCard.hidden = true;
  currentStage = "";
}

function setBar(ratio) {
  els.bar.style.width = `${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%`;
}

function showError(err) {
  console.error(err);
  hideProgress();
  els.errorBox.textContent = String(err?.message || err);
  els.errorBox.hidden = false;
}

function fmtSize(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
