// Parallel denoise orchestration. PCM is interleaved Float32 in [-1, 1] at 48 kHz.
//
// The audio is split per channel into ~6 s chunks and fanned out to a pool of
// Web Workers (one wasm engine instance per worker). Each chunk is prefixed
// with 1 s of "priming" audio so the recurrent model's state adapts before the
// kept region starts, and consecutive kept regions are stitched with a 20 ms
// crossfade. Pools are cached, so re-runs skip engine startup.

const CHUNK = 288000;  // 6 s kept region per task
const PRIME = 48000;   // 1 s state warm-up, discarded
const XFADE = 960;     // 20 ms crossfade at chunk seams

export const ENGINE_INFO = {
  rnnoise: { label: "RNNoise · WASM SIMD (CPU)", short: "RNNoise", maxWorkers: 8 },
  dfn3: { label: "DeepFilterNet3 · WASM SIMD (CPU)", short: "DeepFilterNet3", maxWorkers: 6 },
};

const MODEL_URL = new URL("../vendor/deepfilternet/DeepFilterNet3_onnx.tar.gz", import.meta.url).href;

class WorkerPool {
  constructor(engineId, size) {
    this.engineId = engineId;
    this.size = size;
    this.workers = [];
  }

  async init() {
    const spawns = [];
    for (let i = 0; i < this.size; i++) {
      const w = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
      this.workers.push(w);
      spawns.push(new Promise((resolve, reject) => {
        w.onmessage = (e) => {
          if (e.data.type === "ready") resolve();
          else if (e.data.type === "error") reject(new Error(e.data.message));
        };
        w.onerror = (e) => reject(new Error("worker failed to start: " + e.message));
        w.postMessage({ type: "init", engine: this.engineId, modelURL: MODEL_URL });
      }));
    }
    await Promise.all(spawns);
  }

  // tasks: [{ id, data: Float32Array }] — data buffers are transferred.
  // onTaskProgress(id, doneSamples), resolves to Map(id -> Float32Array)
  run(tasks, onTaskProgress) {
    return new Promise((resolve, reject) => {
      const results = new Map();
      const queue = tasks.slice();
      let failed = false;

      const feed = (w) => {
        const t = queue.shift();
        if (!t) return;
        w.__task = t.id;
        w.postMessage({ type: "task", id: t.id, data: t.data }, [t.data.buffer]);
      };

      for (const w of this.workers) {
        w.onerror = (e) => {
          failed = true;
          reject(new Error("worker crashed: " + e.message));
        };
        w.onmessage = (e) => {
          if (failed) return;
          const m = e.data;
          if (m.type === "progress") {
            onTaskProgress?.(m.id, m.done);
          } else if (m.type === "result") {
            results.set(m.id, m.out);
            onTaskProgress?.(m.id, m.out.length);
            if (results.size === tasks.length) resolve(results);
            else feed(w);
          } else if (m.type === "error") {
            failed = true;
            reject(new Error(m.message));
          }
        };
      }
      this.workers.forEach(feed);
    });
  }

  dispose() {
    this.workers.forEach((w) => w.terminate());
    this.workers = [];
  }
}

const pools = {};

export async function getPool(engineId) {
  if (pools[engineId]) return pools[engineId];
  const cores = navigator.hardwareConcurrency || 4;
  const size = Math.max(1, Math.min(ENGINE_INFO[engineId].maxWorkers, cores - 1));
  const pool = new WorkerPool(engineId, size);
  await pool.init();
  pools[engineId] = pool;
  return pool;
}

export async function denoiseParallel(engineId, dry, channels, onProgress) {
  const pool = await getPool(engineId);
  const n = Math.floor(dry.length / channels);

  // deinterleave
  const chans = [];
  for (let c = 0; c < channels; c++) {
    const a = new Float32Array(n);
    for (let i = 0, j = c; i < n; i++, j += channels) a[i] = dry[j];
    chans.push(a);
  }

  // build tasks: each covers [keepStart, keepEnd) plus prime/crossfade lead-in
  const numChunks = Math.max(1, Math.ceil(n / CHUNK));
  const tasks = [];
  const meta = [];
  for (let c = 0; c < channels; c++) {
    for (let k = 0; k < numChunks; k++) {
      const keepStart = k * CHUNK;
      const keepEnd = Math.min(n, (k + 1) * CHUNK);
      let data, keepOffset;
      if (k === 0) {
        // synthetic prime: process the opening second twice, discard the first pass
        const p = Math.min(PRIME, n);
        data = new Float32Array(p + keepEnd);
        data.set(chans[c].subarray(0, p), 0);
        data.set(chans[c].subarray(0, keepEnd), p);
        keepOffset = p;
      } else {
        const procStart = Math.max(0, keepStart - PRIME - XFADE);
        data = chans[c].slice(procStart, keepEnd);
        keepOffset = keepStart - XFADE - procStart;
      }
      const id = tasks.length;
      tasks.push({ id, data });
      meta.push({ id, ch: c, k, keepStart, keepEnd, keepOffset, len: data.length });
    }
  }

  // progress across all tasks
  const totalSamples = meta.reduce((s, m) => s + m.len, 0);
  const taskDone = new Array(tasks.length).fill(0);
  const results = await pool.run(tasks, (id, done) => {
    taskDone[id] = Math.min(done, meta[id].len);
    onProgress?.(taskDone.reduce((a, b) => a + b, 0) / totalSamples);
  });

  // merge in order (crossfade needs the previous chunk's tail in place)
  const wetChans = chans.map(() => new Float32Array(n));
  meta.sort((a, b) => a.ch - b.ch || a.k - b.k);
  for (const m of meta) {
    const out = results.get(m.id);
    const wet = wetChans[m.ch];
    if (m.k === 0) {
      wet.set(out.subarray(m.keepOffset), 0);
    } else {
      const xf = Math.min(XFADE, m.keepStart); // safety, always XFADE in practice
      for (let i = 0; i < xf; i++) {
        const pos = m.keepStart - xf + i;
        const w = i / xf;
        wet[pos] = wet[pos] * (1 - w) + out[m.keepOffset + i] * w;
      }
      wet.set(out.subarray(m.keepOffset + xf), m.keepStart);
    }
  }

  // re-interleave
  const wet = new Float32Array(dry.length);
  for (let c = 0; c < channels; c++) {
    const a = wetChans[c];
    for (let i = 0, j = c; i < n; i++, j += channels) wet[j] = a[i];
  }
  return { wet, workers: pool.size };
}

// ---------- delay compensation ----------

// Denoisers introduce a small algorithmic delay (RNNoise ~20 ms, DFN3 ~30 ms).
// Estimate it by cross-correlating dry vs wet on a strided window, so
// strength-mixing doesn't comb-filter and A/V sync stays exact.
export function measureDelay(dry, wet, channels, maxLag = 4800) {
  const n = Math.min(Math.floor(dry.length / channels), 48000 * 10);
  const stride = 8;
  let bestLag = 0;
  let bestScore = -Infinity;
  let zeroScore = 0;
  for (let lag = 0; lag <= maxLag; lag += 1) {
    let s = 0;
    for (let i = lag; i < n; i += stride) {
      s += dry[(i - lag) * channels] * wet[i * channels];
    }
    if (lag === 0) zeroScore = s;
    if (s > bestScore) {
      bestScore = s;
      bestLag = lag;
    }
  }
  // only trust a clear peak
  if (bestLag > 0 && bestScore < Math.abs(zeroScore) * 1.05) return 0;
  return bestLag;
}

// Shift wet earlier by `delay` samples (per channel), zero-padding the tail.
export function compensateDelay(wet, channels, delay) {
  if (delay <= 0) return wet;
  const out = new Float32Array(wet.length);
  out.set(wet.subarray(delay * channels));
  return out;
}
