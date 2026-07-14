// Lightweight, deterministic post-processing and analysis helpers.
// These stay model-agnostic so they can be unit-tested outside the browser.

const EPS = 1e-9;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function parseChunkSeconds(value, defaultSeconds = 90) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return defaultSeconds;
  }
  const seconds = Number(value);
  return Number.isFinite(seconds) ? clamp(seconds, 3, 300) : defaultSeconds;
}

// Kept separate from the browser pipeline so container-duration boundary
// behavior can be exercised deterministically.
export function planMediaSegments(durationSeconds, chunkSeconds) {
  const duration = Math.max(0, durationSeconds);
  const chunk = Math.max(0.001, chunkSeconds);
  const count = Math.ceil(duration / chunk);
  const segments = Array.from({ length: count }, (_, index) => ({
    start: index * chunk,
    duration: Math.min(chunk, duration - index * chunk),
  }));
  const minimumUsefulTail = Math.min(1, chunk * 0.02);
  if (segments.length > 1 && segments.at(-1).duration < minimumUsefulTail) {
    const tail = segments.pop();
    segments.at(-1).duration += tail.duration;
  }
  return segments;
}

export function planWorkingMemory(fileBytes, durationSeconds, options = {}) {
  const sampleRate = options.sampleRate || 48000;
  const channels = options.channels || 2;
  const multiplier = options.multiplier || 4.25;
  const safeLimitBytes = options.safeLimitBytes || 1.5 * 1024 * 1024 * 1024;
  const bytesPerSecond = sampleRate * channels * Float32Array.BYTES_PER_ELEMENT * multiplier;
  const estimatedBytes = Math.max(0, fileBytes) + Math.max(0, durationSeconds) * bytesPerSecond;
  const secondsAtLimit = Math.max(60, (safeLimitBytes - Math.max(0, fileBytes)) / bytesPerSecond);
  return { estimatedBytes, secondsAtLimit, safe: estimatedBytes <= safeLimitBytes };
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.round((sorted.length - 1) * clamp(fraction, 0, 1));
  return sorted[index];
}

function frameLevels(pcm, channels, frameSize = 960) {
  const frames = [];
  const samples = Math.floor(pcm.length / channels);
  for (let start = 0; start < samples; start += frameSize) {
    const end = Math.min(samples, start + frameSize);
    let sum = 0;
    let count = 0;
    for (let i = start; i < end; i++) {
      for (let c = 0; c < channels; c++) {
        const value = pcm[i * channels + c];
        sum += value * value;
        count++;
      }
    }
    frames.push(Math.sqrt(sum / Math.max(1, count)));
  }
  return frames;
}

export function analyseCleanup(dry, wet, channels) {
  if (!dry?.length || dry.length !== wet?.length || channels < 1) {
    return {
      quietFloorReductionDb: 0,
      voiceRetentionDb: 0,
      recommendedStrength: 0.7,
      quietRatio: 1,
      voiceRatio: 1,
    };
  }

  const dryFrames = frameLevels(dry, channels);
  const wetFrames = frameLevels(wet, channels);
  const dryQuiet = percentile(dryFrames, 0.2);
  const wetQuiet = percentile(wetFrames, 0.2);
  const dryVoice = percentile(dryFrames, 0.88);
  const wetVoice = percentile(wetFrames, 0.88);
  const quietRatio = clamp(wetQuiet / Math.max(EPS, dryQuiet), 0, 2);
  const voiceRatio = clamp(wetVoice / Math.max(EPS, dryVoice), 0, 2);

  // Estimate a safe wet/dry amount. Aim for roughly -14 dB residual ambience,
  // while keeping representative speech frames above -1.7 dB of their input.
  // Because the streams are phase-aligned, a linear mixture is predictable.
  const targetQuietRatio = 0.2;
  const minimumVoiceRatio = 0.82;
  const neededForNoise = quietRatio < 0.995
    ? (1 - targetQuietRatio) / (1 - quietRatio)
    : 0.96;
  const allowedForVoice = voiceRatio < minimumVoiceRatio
    ? (1 - minimumVoiceRatio) / Math.max(EPS, 1 - voiceRatio)
    : 0.96;
  const recommendedStrength = clamp(
    Math.min(Math.max(neededForNoise, 0.68), allowedForVoice, 0.96),
    0.55,
    0.96,
  );

  const quietFloorReductionDb = clamp(
    20 * Math.log10(Math.max(EPS, dryQuiet) / Math.max(EPS, wetQuiet)),
    0,
    96,
  );
  const voiceRetentionDb = clamp(
    20 * Math.log10(Math.max(EPS, wetVoice) / Math.max(EPS, dryVoice)),
    -60,
    12,
  );

  return {
    quietFloorReductionDb,
    voiceRetentionDb,
    recommendedStrength,
    quietRatio,
    voiceRatio,
  };
}

function smoothstep(edge0, edge1, value) {
  const x = clamp((value - edge0) / Math.max(EPS, edge1 - edge0), 0, 1);
  return x * x * (3 - 2 * x);
}

// A conservative downward expander for residual noise. It only closes when
// both signals agree that a frame is quiet and the model has already removed
// most of its energy. That protects breaths and low-level speech much better
// than a conventional hard noise gate.
export function adaptiveResidualCleanup(dry, wet, channels, amount = 0.72) {
  if (!dry?.length || dry.length !== wet?.length || channels < 1 || amount <= 0) {
    return wet;
  }

  const frameSize = 480; // 10 ms at 48 kHz
  const dryFrames = frameLevels(dry, channels, frameSize);
  const wetFrames = frameLevels(wet, channels, frameSize);
  const wetFloor = Math.max(EPS, percentile(wetFrames, 0.24));
  const targets = new Float32Array(wetFrames.length);

  for (let i = 0; i < wetFrames.length; i++) {
    const modelRatio = clamp(wetFrames[i] / Math.max(EPS, dryFrames[i]), 0, 1);
    const modelConfidence = 1 - modelRatio;
    const levelAboveFloor = wetFrames[i] / wetFloor;
    const quietness = 1 - smoothstep(1.35, 5.5, levelAboveFloor);
    const reduction = amount * quietness * modelConfidence * 0.78;
    targets[i] = clamp(1 - reduction, 0.2, 1);
  }

  // Open quickly for speech, close gently after it, then interpolate inside
  // each frame to avoid zipper noise.
  const smoothed = new Float32Array(targets.length);
  let gain = 1;
  for (let i = 0; i < targets.length; i++) {
    const coefficient = targets[i] > gain ? 0.72 : 0.16;
    gain += (targets[i] - gain) * coefficient;
    smoothed[i] = gain;
  }

  const out = new Float32Array(wet.length);
  const samples = Math.floor(wet.length / channels);
  let previous = 1;
  for (let frame = 0, start = 0; start < samples; frame++, start += frameSize) {
    const end = Math.min(samples, start + frameSize);
    const next = smoothed[Math.min(frame, smoothed.length - 1)] ?? 1;
    const length = Math.max(1, end - start);
    for (let i = start; i < end; i++) {
      const mix = (i - start) / length;
      const frameGain = previous + (next - previous) * mix;
      for (let c = 0; c < channels; c++) {
        out[i * channels + c] = wet[i * channels + c] * frameGain;
      }
    }
    previous = next;
  }
  return out;
}

export function stereoProfile(pcm, channels = 2, maxSamples = 48000 * 30) {
  if (channels !== 2 || pcm.length < 4) {
    return { useMidSide: false, correlation: 0, balance: 1 };
  }
  const samples = Math.floor(pcm.length / 2);
  const inspectionCount = Math.max(1, Math.min(samples, maxSamples, 120000));
  let left2 = 0;
  let right2 = 0;
  let cross = 0;
  for (let inspected = 0; inspected < inspectionCount; inspected++) {
    // A bounded stratified sample sees late channel changes without turning
    // profile cost into a function of recording duration.
    const i = Math.min(samples - 1, Math.floor((inspected + 0.5) * samples / inspectionCount));
    const left = pcm[i * 2];
    const right = pcm[i * 2 + 1];
    left2 += left * left;
    right2 += right * right;
    cross += left * right;
  }
  const correlation = cross / Math.max(EPS, Math.sqrt(left2 * right2));
  const balance = Math.sqrt(Math.min(left2, right2) / Math.max(EPS, Math.max(left2, right2)));
  return {
    useMidSide: correlation >= 0.35 && balance >= 0.35,
    correlation,
    balance,
  };
}

export function reconstructSmartStereo(dry, cleanMid) {
  const samples = Math.min(Math.floor(dry.length / 2), cleanMid.length);
  const out = new Float32Array(samples * 2);
  const frameSize = 480;
  let sideGain = 1;

  for (let start = 0; start < samples; start += frameSize) {
    const end = Math.min(samples, start + frameSize);
    let dryEnergy = 0;
    let wetEnergy = 0;
    for (let i = start; i < end; i++) {
      const mid = (dry[i * 2] + dry[i * 2 + 1]) * 0.5;
      dryEnergy += mid * mid;
      wetEnergy += cleanMid[i] * cleanMid[i];
    }
    const modelGain = clamp(Math.sqrt(wetEnergy / Math.max(EPS, dryEnergy)), 0, 1);
    const targetSideGain = 0.08 + 0.92 * Math.sqrt(modelGain);
    const nextSideGain = sideGain + (targetSideGain - sideGain) * (targetSideGain > sideGain ? 0.72 : 0.2);
    const length = Math.max(1, end - start);
    for (let i = start; i < end; i++) {
      const position = (i - start) / length;
      const gain = sideGain + (nextSideGain - sideGain) * position;
      const side = (dry[i * 2] - dry[i * 2 + 1]) * 0.5 * gain;
      // Keep the float PCM contract here instead of relying on an encoder's
      // implementation-specific clipping after mid/side reconstruction.
      out[i * 2] = clamp(cleanMid[i] + side, -1, 1);
      out[i * 2 + 1] = clamp(cleanMid[i] - side, -1, 1);
    }
    sideGain = nextSideGain;
  }
  return out;
}

export function waveformPeaks(pcm, channels, buckets) {
  const peaks = new Float32Array(Math.max(1, buckets));
  if (!pcm?.length || channels < 1) return peaks;
  const samples = Math.floor(pcm.length / channels);
  const step = Math.max(1, Math.ceil(samples / peaks.length));
  for (let bucket = 0; bucket < peaks.length; bucket++) {
    const start = bucket * step;
    const end = Math.min(samples, start + step);
    let peak = 0;
    for (let i = start; i < end; i++) {
      let sample = 0;
      for (let c = 0; c < channels; c++) sample += Math.abs(pcm[i * channels + c]);
      peak = Math.max(peak, sample / channels);
    }
    peaks[bucket] = peak;
  }
  return peaks;
}
