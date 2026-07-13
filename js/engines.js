// Denoise engines. Each engine exposes:
//   label            — UI string
//   async ensureLoaded(onStatus)
//   async process(dryPcm, channels, onProgress) -> wetPcm (same length/layout)
// PCM is interleaved Float32 in [-1, 1] at 48 kHz.

const PCM_SCALE = 32768;

async function uiYield() {
  return new Promise((r) => setTimeout(r, 0));
}

// ---------- RNNoise (fast, ~100x realtime) ----------

export const rnnoiseEngine = {
  id: "rnnoise",
  label: "RNNoise · WASM SIMD (CPU)",
  _rnnoise: null,

  async ensureLoaded(onStatus) {
    if (this._rnnoise) return;
    onStatus("Loading RNNoise…");
    const { Rnnoise } = await import("../vendor/rnnoise/rnnoise.js");
    this._rnnoise = await Rnnoise.load();
  },

  async process(dry, channels, onProgress) {
    const rn = this._rnnoise;
    const frameSize = rn.frameSize; // 480 samples = 10 ms
    const samplesPerCh = Math.floor(dry.length / channels);
    const wet = new Float32Array(dry.length);
    const frame = new Float32Array(frameSize);
    const totalFrames = Math.ceil(samplesPerCh / frameSize) * channels;
    let done = 0;

    for (let ch = 0; ch < channels; ch++) {
      const state = rn.createDenoiseState();
      try {
        for (let off = 0; off < samplesPerCh; off += frameSize) {
          const len = Math.min(frameSize, samplesPerCh - off);
          for (let i = 0; i < len; i++) frame[i] = dry[(off + i) * channels + ch] * PCM_SCALE;
          if (len < frameSize) frame.fill(0, len);
          state.processFrame(frame); // in-place, expects 16-bit range
          for (let i = 0; i < len; i++) wet[(off + i) * channels + ch] = frame[i] / PCM_SCALE;
          if (++done % 500 === 0) {
            onProgress(done / totalFrames);
            await uiYield();
          }
        }
      } finally {
        state.destroy();
      }
    }
    onProgress(1);
    return wet;
  },
};

// ---------- DeepFilterNet3 (high quality, slower) ----------

export const dfn3Engine = {
  id: "dfn3",
  label: "DeepFilterNet3 · WASM SIMD (CPU)",
  _mod: null,
  _model: null,

  async ensureLoaded(onStatus) {
    if (this._mod) return;
    onStatus("Loading DeepFilterNet3 (~17 MB, cached after first run)…");
    const mod = await import("../vendor/deepfilternet/df.js");
    await mod.default(); // instantiate wasm
    const resp = await fetch(new URL("../vendor/deepfilternet/DeepFilterNet3_onnx.tar.gz", import.meta.url));
    if (!resp.ok) throw new Error("Could not fetch DeepFilterNet3 model");
    this._model = new Uint8Array(await resp.arrayBuffer());
    this._mod = mod;
  },

  async process(dry, channels, onProgress) {
    const { df_create, df_get_frame_length, df_process_frame, df_free } = this._mod;
    const samplesPerCh = Math.floor(dry.length / channels);
    const wet = new Float32Array(dry.length);
    let done = 0;

    for (let ch = 0; ch < channels; ch++) {
      // one state per channel: the model carries temporal context
      const st = df_create(this._model, 100);
      try {
        const hop = df_get_frame_length(st);
        const frame = new Float32Array(hop);
        const totalFrames = Math.ceil(samplesPerCh / hop) * channels;
        for (let off = 0; off < samplesPerCh; off += hop) {
          const len = Math.min(hop, samplesPerCh - off);
          for (let i = 0; i < len; i++) frame[i] = dry[(off + i) * channels + ch];
          if (len < hop) frame.fill(0, len);
          const out = df_process_frame(st, frame);
          for (let i = 0; i < len; i++) wet[(off + i) * channels + ch] = out[i];
          if (++done % 25 === 0) {
            onProgress(done / totalFrames);
            await uiYield();
          }
        }
      } finally {
        if (df_free) df_free(st);
      }
    }
    onProgress(1);
    return wet;
  },
};

export const engines = { rnnoise: rnnoiseEngine, dfn3: dfn3Engine };

// ---------- delay compensation ----------

// Denoisers introduce a small algorithmic delay (RNNoise ~10 ms). Estimate it by
// cross-correlating dry vs wet on a strided window, so strength-mixing doesn't
// comb-filter and A/V sync stays exact.
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
