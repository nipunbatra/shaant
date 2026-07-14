import assert from "node:assert/strict";
import { compensateDelay, measureDelay, parseAttenuationLimit } from "../js/engines.js";

assert.equal(parseAttenuationLimit(null), 30,
  "production DFN3 must have a speech-safe attenuation ceiling");
assert.equal(parseAttenuationLimit("40"), 40);
assert.equal(parseAttenuationLimit("5"), 12,
  "diagnostic overrides must not turn the denoiser into a near-bypass");
assert.equal(parseAttenuationLimit("500"), 100,
  "diagnostic overrides must stay inside the model API's supported range");
assert.equal(parseAttenuationLimit("not-a-number"), 30);

const CH = 2;
const frames = 16000;
const delay = 960;
const dry = new Float32Array(frames * CH);
const wet = new Float32Array(dry.length);

for (let frame = 0; frame < frames; frame++) {
  const sample = Math.sin(frame * 0.071) * 0.4 + Math.sin(frame * 0.013) * 0.15;
  dry[frame * CH] = sample;
  dry[frame * CH + 1] = sample * 0.8;
  if (frame + delay < frames) {
    wet[(frame + delay) * CH] = sample;
    wet[(frame + delay) * CH + 1] = sample * 0.8;
  }
}

assert.equal(measureDelay(dry, wet, CH, 1400), delay,
  "cross-correlation should recover a known algorithmic delay");

const aligned = compensateDelay(wet, CH, delay);
let squaredError = 0;
let samples = 0;
for (let frame = 0; frame < frames - delay; frame++) {
  for (let channel = 0; channel < CH; channel++) {
    const error = aligned[frame * CH + channel] - dry[frame * CH + channel];
    squaredError += error * error;
    samples++;
  }
}
assert(Math.sqrt(squaredError / samples) < 1e-6,
  "delay compensation should restore sample alignment");
assert.equal(measureDelay(dry, dry, CH), 0, "aligned audio must not acquire a false delay");
assert.strictEqual(compensateDelay(dry, CH, 0), dry,
  "zero-delay compensation should avoid a full PCM copy");

console.log("engines: all tests passed");
