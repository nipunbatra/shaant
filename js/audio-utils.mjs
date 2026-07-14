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

export function mediaExtension(fileName, mimeType = "") {
  const name = String(fileName || "").split(/[?#]/, 1)[0];
  const match = name.match(/\.([a-z0-9]{1,8})$/i);
  const extension = match ? match[1].toLowerCase() : "";
  if (!extension && /(?:video|audio)\/webm/i.test(String(mimeType))) return "webm";
  return extension;
}

export function parseAVStartOffset(logLines) {
  const lines = Array.from(logLines || [], String);
  const formatLine = lines.find((line) => line.includes("Duration:") && line.includes("start:"));
  const formatStart = Number(formatLine?.match(/start:\s*(-?\d+(?:\.\d+)?)/)?.[1] || 0);
  const videoLine = lines.find((line) => /Stream #0:\d+.*Video:/.test(line));
  const audioLine = lines.find((line) => /Stream #0:\d+.*Audio:/.test(line));
  if (!videoLine || !audioLine) return 0;
  const start = (line) => {
    const explicit = line.match(/,\s*start\s+(-?\d+(?:\.\d+)?)/)?.[1];
    return explicit === undefined ? formatStart : Number(explicit);
  };
  const offset = start(audioLine) - start(videoLine);
  return Number.isFinite(offset) ? offset : 0;
}

// Kept separate from the browser pipeline so container-duration boundary
// behavior can be exercised deterministically.
export function planMediaSegments(durationSeconds, chunkSeconds) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 ||
      !Number.isFinite(chunkSeconds) || chunkSeconds <= 0) return [];
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
  const positive = (value, fallback) => Number.isFinite(value) && value > 0 ? value : fallback;
  const nonnegative = (value, fallback) => Number.isFinite(value) && value >= 0 ? value : fallback;
  const sampleRate = positive(options.sampleRate, 48000);
  const channels = positive(options.channels, 2);
  const multiplier = nonnegative(options.multiplier, 4.25);
  const safeLimitBytes = nonnegative(options.safeLimitBytes, 1.5 * 1024 * 1024 * 1024);
  const sourceBytes = nonnegative(fileBytes, 0);
  const duration = nonnegative(durationSeconds, 0);
  const bytesPerSecond = sampleRate * channels * Float32Array.BYTES_PER_ELEMENT * multiplier;
  const estimatedBytes = sourceBytes + duration * bytesPerSecond;
  const secondsAtLimit = bytesPerSecond > 0
    ? Math.max(60, (safeLimitBytes - sourceBytes) / bytesPerSecond)
    : 60;
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
        const candidate = pcm[i * channels + c];
        const value = Number.isFinite(candidate) ? candidate : 0;
        sum += value * value;
        count++;
      }
    }
    frames.push(Math.sqrt(sum / Math.max(1, count)));
  }
  return frames;
}

export function analyseCleanup(dry, wet, channels, options = {}) {
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
  // Compare the signal *above* each recording's own quiet floor. A direct
  // wet/dry loud-frame ratio counts successfully removed background energy as
  // missing speech and makes Automatic needlessly timid on noisy recordings.
  const dryVoiceAboveFloor = Math.sqrt(Math.max(EPS, dryVoice ** 2 - dryQuiet ** 2));
  const wetVoiceAboveFloor = Math.sqrt(Math.max(EPS, wetVoice ** 2 - wetQuiet ** 2));
  const voiceRatio = clamp(wetVoiceAboveFloor / dryVoiceAboveFloor, 0, 2);

  // Estimate a safe wet/dry amount. Aim for roughly -14 dB residual ambience,
  // while keeping representative speech frames above -1.7 dB of their input.
  // Because the streams are phase-aligned, a linear mixture is predictable.
  const finiteOption = (value, fallback) => Number.isFinite(value) ? value : fallback;
  const minimumStrength = clamp(finiteOption(options.minimumStrength, 0.55), 0, 1);
  const maximumStrength = clamp(
    finiteOption(options.maximumStrength, 0.96),
    minimumStrength,
    1,
  );
  const baselineStrength = clamp(
    finiteOption(options.baselineStrength, 0.68),
    minimumStrength,
    maximumStrength,
  );
  const targetQuietRatio = clamp(finiteOption(options.targetQuietRatio, 0.2), 0.02, 1);
  const minimumVoiceRatio = clamp(finiteOption(options.minimumVoiceRatio, 0.82), 0.1, 1);
  const neededForNoise = quietRatio < 0.995
    ? (1 - targetQuietRatio) / (1 - quietRatio)
    : maximumStrength;
  const allowedForVoice = voiceRatio < minimumVoiceRatio
    ? (1 - minimumVoiceRatio) / Math.max(EPS, 1 - voiceRatio)
    : maximumStrength;
  const recommendedStrength = clamp(
    Math.min(Math.max(neededForNoise, baselineStrength), allowedForVoice, maximumStrength),
    minimumStrength,
    maximumStrength,
  );

  const quietFloorReductionDb = clamp(
    20 * Math.log10(Math.max(EPS, dryQuiet) / Math.max(EPS, wetQuiet)),
    0,
    96,
  );
  const voiceRetentionDb = clamp(
    20 * Math.log10(Math.max(EPS, voiceRatio)),
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

export function aggregateCleanupAnalyses(analyses) {
  if (!analyses.length) return analyseCleanup(null, null, 2);
  const byRecommendation = analyses.slice().sort(
    (a, b) => a.recommendedStrength - b.recommendedStrength,
  );
  const totalDuration = analyses.reduce(
    (sum, item) => sum + Math.max(0, Number(item.duration) || 0),
    0,
  );
  const targetDuration = totalDuration * 0.25;
  let cumulativeDuration = 0;
  let recommendedStrength = byRecommendation.at(-1).recommendedStrength;
  for (const item of byRecommendation) {
    cumulativeDuration += Math.max(0, Number(item.duration) || 0);
    if (cumulativeDuration >= targetDuration) {
      recommendedStrength = item.recommendedStrength;
      break;
    }
  }
  const weighted = (key) => {
    return analyses.reduce((sum, item) => sum + item[key] * item.duration, 0) /
      Math.max(0.001, totalDuration);
  };
  return {
    recommendedStrength,
    quietFloorReductionDb: weighted("quietFloorReductionDb"),
    voiceRetentionDb: weighted("voiceRetentionDb"),
    quietRatio: weighted("quietRatio"),
    voiceRatio: weighted("voiceRatio"),
  };
}

function smoothstep(edge0, edge1, value) {
  const x = clamp((value - edge0) / Math.max(EPS, edge1 - edge0), 0, 1);
  return x * x * (3 - 2 * x);
}

// Restore only the minimum aligned dry signal needed when a denoiser
// suspiciously collapses a loud, speech-like frame. Quiet frames remain fully
// wet, so this guard prevents chopped syllables without globally undoing the
// model's noise reduction.
export function protectSpeechEnvelope(dry, wet, channels, minimumRatio = 0.35) {
  if (!dry?.length || dry.length !== wet?.length || channels < 1) return wet;
  const frameSize = 480;
  const dryFrames = frameLevels(dry, channels, frameSize);
  const wetFrames = frameLevels(wet, channels, frameSize);
  const floor = Math.max(EPS, percentile(dryFrames, 0.2));
  const speech = Math.max(floor, percentile(dryFrames, 0.88));
  const range = Math.max(EPS, speech - floor);
  const low = Math.max(floor * 2, floor + range * 0.12);
  const high = Math.max(low + EPS, floor + range * 0.65);
  const desired = new Float32Array(dryFrames.length);

  for (let frame = 0; frame < dryFrames.length; frame++) {
    const speechLikelihood = smoothstep(low, high, dryFrames[frame]);
    const modelRatio = clamp(wetFrames[frame] / Math.max(EPS, dryFrames[frame]), 0, 1);
    const safeRatio = clamp(minimumRatio, 0, 0.8) * speechLikelihood;
    // Normal spectral cleanup often lowers a speech frame moderately. Restore
    // only a probable mask failure, not every healthy attenuation decision.
    const collapseThreshold = safeRatio * 0.58;
    desired[frame] = modelRatio < collapseThreshold
      ? clamp((safeRatio - modelRatio) / Math.max(EPS, 1 - modelRatio), 0, 1)
      : 0;
  }

  // One-frame lookahead protects consonant onsets. Restoration opens quickly
  // and releases slowly enough to avoid flutter between adjacent phonemes.
  const smoothed = new Float32Array(desired.length);
  let restoration = 0;
  for (let frame = 0; frame < desired.length; frame++) {
    const target = Math.max(desired[frame], (desired[frame + 1] || 0) * 0.85);
    restoration += (target - restoration) * (target > restoration ? 0.86 : 0.14);
    smoothed[frame] = restoration;
  }

  const out = new Float32Array(wet.length);
  const samples = Math.floor(wet.length / channels);
  let previous = smoothed[0] || 0;
  for (let frame = 0, start = 0; start < samples; frame++, start += frameSize) {
    const end = Math.min(samples, start + frameSize);
    const next = smoothed[Math.min(frame, smoothed.length - 1)] || 0;
    const length = Math.max(1, end - start);
    for (let sample = start; sample < end; sample++) {
      const ratio = (sample - start) / length;
      const restore = previous + (next - previous) * ratio;
      for (let channel = 0; channel < channels; channel++) {
        const index = sample * channels + channel;
        const drySample = Number.isFinite(dry[index]) ? dry[index] : 0;
        const wetSample = Number.isFinite(wet[index]) ? wet[index] : 0;
        out[index] = clamp(wetSample + (drySample - wetSample) * restore, -1, 1);
      }
    }
    previous = next;
  }
  return out;
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
        const candidate = wet[i * channels + c];
        const sample = Number.isFinite(candidate) ? candidate : 0;
        out[i * channels + c] = clamp(
          sample * (Number.isFinite(frameGain) ? frameGain : 1),
          -1,
          1,
        );
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
