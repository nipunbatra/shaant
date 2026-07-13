// Module worker: runs one denoise engine over mono PCM chunks (48 kHz).
// Protocol:
//   -> { type:"init", engine:"rnnoise"|"dfn3", modelURL? }
//   <- { type:"ready" }
//   -> { type:"task", id, data: Float32Array }
//   <- { type:"progress", id, done }   (done = samples processed so far in this task)
//   <- { type:"result", id, out: Float32Array }  (transferred)
//   <- { type:"error", message }

const PCM_SCALE = 32768;

let engineId = null;
let rnModule = null;
let dfMod = null;
let dfState = 0;
let hop = 480;

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === "init") {
      engineId = msg.engine;
      if (engineId === "rnnoise") {
        const { Rnnoise } = await import("../vendor/rnnoise/rnnoise.js");
        rnModule = await Rnnoise.load();
        hop = rnModule.frameSize;
      } else if (engineId === "dfn3") {
        dfMod = await import("../vendor/deepfilternet/df.js");
        await dfMod.default();
        const resp = await fetch(msg.modelURL);
        if (!resp.ok) throw new Error("model fetch failed: " + resp.status);
        const model = new Uint8Array(await resp.arrayBuffer());
        dfState = dfMod.df_create(model, 100);
        hop = dfMod.df_get_frame_length(dfState);
      } else {
        throw new Error("unknown engine " + engineId);
      }
      postMessage({ type: "ready" });
      return;
    }

    if (msg.type === "task") {
      const { id, data } = msg;
      const out = new Float32Array(data.length);
      const frame = new Float32Array(hop);
      // fresh state per task for RNNoise (cheap); DFN3 reuses its state — the
      // priming overlap prepended to every chunk washes out stale context
      const rnState = engineId === "rnnoise" ? rnModule.createDenoiseState() : null;
      try {
        let f = 0;
        for (let off = 0; off < data.length; off += hop) {
          const len = Math.min(hop, data.length - off);
          if (rnState) {
            for (let i = 0; i < len; i++) frame[i] = data[off + i] * PCM_SCALE;
            if (len < hop) frame.fill(0, len);
            rnState.processFrame(frame);
            for (let i = 0; i < len; i++) out[off + i] = frame[i] / PCM_SCALE;
          } else {
            frame.set(data.subarray(off, off + len));
            if (len < hop) frame.fill(0, len);
            const res = dfMod.df_process_frame(dfState, frame);
            out.set(res.subarray(0, len), off);
          }
          if (++f % 50 === 0) postMessage({ type: "progress", id, done: off + len });
        }
      } finally {
        if (rnState) rnState.destroy();
      }
      postMessage({ type: "result", id, out }, [out.buffer]);
    }
  } catch (err) {
    postMessage({ type: "error", message: String(err?.stack || err) });
  }
};
