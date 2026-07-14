// Parallel denoise orchestration. PCM is interleaved Float32 in [-1, 1] at 48 kHz.
//
// Audio is split into chunks with a state-priming lead-in, processed across a
// lazily-sized worker pool, and stitched with a short crossfade. For ordinary
// centred stereo recordings, Smart Stereo processes the coherent mid channel
// once and applies the learned attenuation to the side channel. That prevents
// left/right model drift and roughly halves neural inference work.

import { reconstructSmartStereo, stereoProfile } from "./audio-utils.mjs";

const CHUNK = 384000; // 8 s kept region per task
const PRIME = 48000;  // 1 s state warm-up, discarded
const XFADE = 960;    // 20 ms crossfade at chunk seams

export function parseAttenuationLimit(value, fallback = 30) {
  if (value === null || value === undefined || String(value).trim() === "") return fallback;
  const limit = Number(value);
  return Number.isFinite(limit) ? Math.min(100, Math.max(12, limit)) : fallback;
}

// DFN's own ceiling is the first line of speech protection. The old 100 dB
// setting allowed effectively unlimited spectral suppression; 30 dB still
// removes strong ambience but bounds the damage from a mistaken speech mask.
const DFN_ATTENUATION_LIMIT_DB = parseAttenuationLimit(
  typeof location === "undefined"
    ? null
    : new URLSearchParams(location.search).get("dfn-limit"),
);

export const ENGINE_INFO = {
  rnnoise: { label: "RNNoise · WASM SIMD", short: "RNNoise", maxWorkers: 8 },
  dfn3: { label: "DeepFilterNet3 · WASM SIMD", short: "DeepFilterNet3", maxWorkers: 6 },
};

const MODEL_URL = new URL("../vendor/deepfilternet/DeepFilterNet3_onnx.tar.gz", import.meta.url).href;
let modelPromise = null;

async function getDeepFilterModel() {
  if (!modelPromise) {
    modelPromise = (async () => {
      const response = await fetch(MODEL_URL);
      if (!response.ok) throw new Error(`DeepFilterNet model download failed (${response.status})`);
      return new Uint8Array(await response.arrayBuffer());
    })();
    modelPromise.catch(() => { modelPromise = null; });
  }
  return modelPromise;
}

class WorkerPool {
  constructor(engineId, maxSize) {
    this.engineId = engineId;
    this.maxSize = maxSize;
    this.workers = [];
    this._growPromise = Promise.resolve();
    this._activeReject = null;
    this._initRejects = new Set();
    this.disposed = false;
  }

  get size() { return this.workers.length; }

  async spawn() {
    if (this.disposed) throw new Error("worker pool was disposed");
    const model = this.engineId === "dfn3" ? await getDeepFilterModel() : null;
    if (this.disposed) throw new Error("worker pool was disposed");
    const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    this.workers.push(worker);
    let rejectInit = null;
    try {
      await new Promise((resolve, reject) => {
        rejectInit = reject;
        this._initRejects.add(reject);
        worker.onmessage = (event) => {
          if (event.data.type === "ready") resolve();
          else if (event.data.type === "error") reject(new Error(event.data.message));
        };
        worker.onerror = (event) => reject(new Error("worker failed to start: " + event.message));
        worker.postMessage({
          type: "init",
          engine: this.engineId,
          model,
          attenuationLimit: this.engineId === "dfn3" ? DFN_ATTENUATION_LIMIT_DB : null,
        });
      });
    } catch (error) {
      worker.terminate();
      this.workers = this.workers.filter((candidate) => candidate !== worker);
      throw error;
    } finally {
      if (rejectInit) this._initRejects.delete(rejectInit);
    }
  }

  async ensureSize(requested) {
    const target = Math.max(1, Math.min(this.maxSize, requested));
    this._growPromise = this._growPromise.then(async () => {
      if (this.disposed) throw new Error("worker pool was disposed");
      if (this.workers.length === 0) await this.spawn();
      const missing = Math.max(0, target - this.workers.length);
      if (missing) await Promise.all(Array.from({ length: missing }, () => this.spawn()));
    });
    return this._growPromise;
  }

  // tasks: [{ id, data: Float32Array }] — data buffers are transferred.
  // onTaskProgress(id, doneSamples), resolves to Map(id -> Float32Array).
  run(tasks, onTaskProgress) {
    if (!tasks.length) return Promise.resolve(new Map());
    return new Promise((resolve, reject) => {
      const results = new Map();
      const queue = tasks.slice();
      let failed = false;

      const fail = (error) => {
        if (failed) return;
        failed = true;
        this._activeReject = null;
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      this._activeReject = (error) => fail(error);

      const feed = (worker) => {
        const task = queue.shift();
        if (!task || failed) return;
        worker.__task = task.id;
        worker.postMessage({ type: "task", id: task.id, data: task.data }, [task.data.buffer]);
      };

      for (const worker of this.workers) {
        worker.onerror = (event) => fail(new Error("worker crashed: " + event.message));
        worker.onmessage = (event) => {
          if (failed) return;
          const message = event.data;
          if (message.type === "progress") {
            onTaskProgress?.(message.id, message.done);
          } else if (message.type === "result") {
            results.set(message.id, message.out);
            onTaskProgress?.(message.id, message.out.length);
            if (results.size === tasks.length) {
              this._activeReject = null;
              resolve(results);
            } else {
              feed(worker);
            }
          } else if (message.type === "error") {
            fail(new Error(message.message));
          }
        };
      }
      this.workers.forEach(feed);
    });
  }

  dispose() {
    this.disposed = true;
    this._initRejects.forEach((reject) => reject(new Error("cancelled")));
    this._initRejects.clear();
    this.workers.forEach((worker) => worker.terminate());
    this.workers = [];
    if (this._activeReject) {
      const reject = this._activeReject;
      this._activeReject = null;
      reject(new Error("cancelled"));
    }
  }
}

const pools = {};
const poolPromises = {};

// Abort an in-flight run. Terminating workers is the only reliable way to stop
// a busy synchronous WASM frame loop.
export function cancelEngineRun(engineId) {
  const pool = pools[engineId];
  if (pool) {
    delete pools[engineId];
    pool.dispose();
  }
}

export async function getPool(engineId) {
  if (pools[engineId]) return pools[engineId];
  if (poolPromises[engineId]) return poolPromises[engineId];

  const cores = navigator.hardwareConcurrency || 4;
  const maxSize = Math.max(1, Math.min(ENGINE_INFO[engineId].maxWorkers, cores - 1));
  const pool = new WorkerPool(engineId, maxSize);
  poolPromises[engineId] = (async () => {
    try {
      // Prewarming now starts one worker. More are added only when the clip has
      // enough chunks to use them, which is much faster for short recordings.
      await pool.ensureSize(1);
      pools[engineId] = pool;
      return pool;
    } catch (error) {
      pool.dispose();
      throw error;
    } finally {
      delete poolPromises[engineId];
    }
  })();
  return poolPromises[engineId];
}

export async function denoiseParallel(engineId, dry, channels, onProgress, options = {}) {
  const pool = await getPool(engineId);
  const samples = Math.floor(dry.length / channels);
  const profile = options.smartStereo === false
    ? { useMidSide: false, correlation: 0, balance: 1 }
    : stereoProfile(dry, channels);
  const useMidSide = channels === 2 && profile.useMidSide;

  // Deinterleave, or create a coherent mid channel for ordinary camera audio.
  const sourceChannels = [];
  if (useMidSide) {
    const mid = new Float32Array(samples);
    for (let i = 0, j = 0; i < samples; i++, j += 2) mid[i] = (dry[j] + dry[j + 1]) * 0.5;
    sourceChannels.push(mid);
  } else {
    for (let channel = 0; channel < channels; channel++) {
      const data = new Float32Array(samples);
      for (let i = 0, j = channel; i < samples; i++, j += channels) data[i] = dry[j];
      sourceChannels.push(data);
    }
  }

  // Each task covers a kept interval plus model-state priming/crossfade audio.
  const numChunks = Math.max(1, Math.ceil(samples / CHUNK));
  const tasks = [];
  const meta = [];
  for (let channel = 0; channel < sourceChannels.length; channel++) {
    for (let chunk = 0; chunk < numChunks; chunk++) {
      const keepStart = chunk * CHUNK;
      const keepEnd = Math.min(samples, (chunk + 1) * CHUNK);
      let data;
      let keepOffset;
      if (chunk === 0) {
        const primeLength = Math.min(PRIME, samples);
        data = new Float32Array(primeLength + keepEnd);
        data.set(sourceChannels[channel].subarray(0, primeLength));
        data.set(sourceChannels[channel].subarray(0, keepEnd), primeLength);
        keepOffset = primeLength;
      } else {
        const processStart = Math.max(0, keepStart - PRIME - XFADE);
        data = sourceChannels[channel].slice(processStart, keepEnd);
        keepOffset = keepStart - XFADE - processStart;
      }
      const id = tasks.length;
      tasks.push({ id, data });
      meta.push({ id, channel, chunk, keepStart, keepEnd, keepOffset, length: data.length });
    }
  }

  await pool.ensureSize(Math.min(pool.maxSize, tasks.length));

  const totalSamples = meta.reduce((sum, item) => sum + item.length, 0);
  const taskDone = new Float64Array(tasks.length);
  let completedSamples = 0;
  let results;
  try {
    results = await pool.run(tasks, (id, done) => {
      const next = Math.min(done, meta[id].length);
      completedSamples += next - taskDone[id];
      taskDone[id] = next;
      onProgress?.(completedSamples / totalSamples);
    });
  } catch (error) {
    if (pools[engineId] === pool) delete pools[engineId];
    pool.dispose();
    throw error;
  }

  const wetChannels = sourceChannels.map(() => new Float32Array(samples));
  meta.sort((a, b) => a.channel - b.channel || a.chunk - b.chunk);
  for (const item of meta) {
    const output = results.get(item.id);
    const wet = wetChannels[item.channel];
    if (item.chunk === 0) {
      wet.set(output.subarray(item.keepOffset), 0);
    } else {
      const crossfade = Math.min(XFADE, item.keepStart);
      for (let i = 0; i < crossfade; i++) {
        const position = item.keepStart - crossfade + i;
        const weight = i / crossfade;
        wet[position] = wet[position] * (1 - weight) + output[item.keepOffset + i] * weight;
      }
      wet.set(output.subarray(item.keepOffset + crossfade), item.keepStart);
    }
  }

  if (useMidSide) {
    const delay = measureDelay(sourceChannels[0], wetChannels[0], 1);
    const alignedMid = compensateDelay(wetChannels[0], 1, delay);
    return {
      wet: reconstructSmartStereo(dry, alignedMid),
      workers: pool.size,
      mode: "smart stereo",
      correlation: profile.correlation,
      aligned: true,
    };
  }

  const wet = new Float32Array(dry.length);
  for (let channel = 0; channel < channels; channel++) {
    const data = wetChannels[channel];
    for (let i = 0, j = channel; i < samples; i++, j += channels) wet[j] = data[i];
  }
  return { wet, workers: pool.size, mode: channels > 1 ? "dual channel" : "mono", aligned: false };
}

// Denoisers introduce a small algorithmic delay (RNNoise ~20 ms, DFN3 ~30 ms).
// Cross-correlation estimates it so strength mixing stays phase-aligned.
export function measureDelay(dry, wet, channels, maxLag = 4800) {
  const samples = Math.min(Math.floor(dry.length / channels), 48000 * 10);
  const stride = 8;
  let bestLag = 0;
  let bestScore = -Infinity;
  let zeroScore = 0;
  for (let lag = 0; lag <= maxLag; lag++) {
    let score = 0;
    for (let i = lag; i < samples; i += stride) {
      score += dry[(i - lag) * channels] * wet[i * channels];
    }
    if (lag === 0) zeroScore = score;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  if (bestLag > 0 && bestScore < Math.abs(zeroScore) * 1.05) return 0;
  return bestLag;
}

export function compensateDelay(wet, channels, delay) {
  if (delay <= 0) return wet;
  const out = new Float32Array(wet.length);
  out.set(wet.subarray(delay * channels));
  return out;
}
