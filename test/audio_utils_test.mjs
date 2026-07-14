import assert from "node:assert/strict";
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
  reconstructSmartStereo,
  stereoProfile,
  waveformPeaks,
} from "../js/audio-utils.mjs";

const SR = 48000;
const CH = 2;

{
  const aggregate = aggregateCleanupAnalyses([
    {
      duration: 1, recommendedStrength: 0.55,
      quietFloorReductionDb: 2, voiceRetentionDb: -8, quietRatio: 0.8, voiceRatio: 0.4,
    },
    {
      duration: 90, recommendedStrength: 0.9,
      quietFloorReductionDb: 24, voiceRetentionDb: -0.5, quietRatio: 0.1, voiceRatio: 0.94,
    },
  ]);
  assert.equal(aggregate.recommendedStrength, 0.9,
    "a one-second tail must not dictate strength for a 90-second section");
}

{
  assert.equal(parseChunkSeconds(null), 90,
    "a missing test override must keep the production section length");
  assert.equal(parseChunkSeconds(""), 90);
  assert.equal(parseChunkSeconds("3"), 3);
  assert.equal(parseChunkSeconds("999"), 300);
  assert.equal(mediaExtension("CAMERA.WEBM"), "webm");
  assert.equal(mediaExtension("recording", "video/webm; codecs=vp9"), "webm");
  assert.equal(mediaExtension("lecture.final.MP4"), "mp4");
  assert.equal(parseAVStartOffset([
    "Duration: 00:00:10.00, start: 0.000000, bitrate: 895 kb/s",
    "Stream #0:0(und): Video: h264, yuv420p, 640x360",
    "Stream #0:1(und): Audio: aac, 22050 Hz, mono, 101 kb/s, start 0.453016 (default)",
  ]), 0.453016);
  assert.equal(parseAVStartOffset([
    "Duration: 00:00:10.00, start: 2.000000, bitrate: 895 kb/s",
    "Stream #0:0: Video: h264, start 2.250000",
    "Stream #0:1: Audio: aac, start 2.000000",
  ]), -0.25);
}

{
  const boundary = planMediaSegments(180.000001, 90);
  assert.equal(boundary.length, 2,
    "sub-frame metadata rounding must not create a nearly empty model job");
  assert(Math.abs(boundary[1].duration - 90.000001) < 1e-7,
    "a microscopic tail should merge into the preceding section");
}

function makeFixture({ damagedVoice = false } = {}) {
  const frames = 100;
  const frameSize = 960;
  const dry = new Float32Array(frames * frameSize * CH);
  const wet = new Float32Array(dry.length);
  for (let frame = 0; frame < frames; frame++) {
    const speech = frame >= 45;
    for (let i = 0; i < frameSize; i++) {
      const index = frame * frameSize + i;
      const noise = 0.05 * Math.sin(index * 0.37) + 0.025 * Math.sin(index * 0.113);
      const voice = speech ? 0.28 * Math.sin(index * 2 * Math.PI * 220 / SR) : 0;
      const cleanVoice = damagedVoice ? voice * 0.35 : voice * 0.94;
      for (let channel = 0; channel < CH; channel++) {
        dry[index * CH + channel] = voice + noise;
        wet[index * CH + channel] = cleanVoice + noise * 0.1;
      }
    }
  }
  return { dry, wet, frameSize };
}

function rms(pcm, start, end) {
  let sum = 0;
  for (let i = start; i < end; i++) sum += pcm[i] * pcm[i];
  return Math.sqrt(sum / Math.max(1, end - start));
}

{
  const plan = planWorkingMemory(350 * 1024 * 1024, 3600, {
    safeLimitBytes: 2 * 1024 * 1024 * 1024,
  });
  assert(!plan.safe, "long compressed media should select bounded-memory processing");
  assert(plan.secondsAtLimit < 3600 && plan.secondsAtLimit >= 60);
}

{
  const noBudget = planWorkingMemory(1, 1, { safeLimitBytes: 0 });
  assert(!noBudget.safe, "an explicit zero-byte budget must not fall back to the default");
  const invalidNumbers = planWorkingMemory(Number.NaN, Number.POSITIVE_INFINITY, {
    sampleRate: Number.NaN,
    channels: Number.POSITIVE_INFINITY,
    multiplier: -1,
    safeLimitBytes: Number.NaN,
  });
  assert(Number.isFinite(invalidNumbers.estimatedBytes),
    "invalid metadata must not poison the memory planner with NaN");
  assert(Number.isFinite(invalidNumbers.secondsAtLimit),
    "invalid metadata must still produce a bounded sectional plan");
  assert.deepEqual(planMediaSegments(Number.NaN, 90), []);
  assert.deepEqual(planMediaSegments(Number.POSITIVE_INFINITY, 90), []);
}

{
  const { dry, wet } = makeFixture();
  const result = analyseCleanup(dry, wet, CH);
  assert(result.quietFloorReductionDb > 17, "should measure a meaningfully lower quiet floor");
  assert(result.recommendedStrength >= 0.68 && result.recommendedStrength <= 0.96);
  assert(result.voiceRetentionDb > -2, "healthy speech should be protected");
}

{
  const healthy = analyseCleanup(...Object.values(makeFixture()).slice(0, 2), CH);
  const damagedFixture = makeFixture({ damagedVoice: true });
  const damaged = analyseCleanup(damagedFixture.dry, damagedFixture.wet, CH);
  assert(damaged.recommendedStrength < healthy.recommendedStrength, "speech damage must lower auto strength");
  assert(damaged.recommendedStrength >= 0.55, "recommendation stays inside the documented safe range");
  const modelGuarded = analyseCleanup(damagedFixture.dry, damagedFixture.wet, CH, {
    minimumStrength: 0.82,
    maximumStrength: 0.94,
  });
  assert(modelGuarded.recommendedStrength >= 0.82 && modelGuarded.recommendedStrength <= 0.94,
    "a model with its own attenuation and envelope guards may use a stronger Automatic range");
}

{
  // A direct percentile comparison mistakes removed background energy for
  // damaged speech. Here the voice component is unchanged while the strong,
  // steady background is reduced by 20 dB.
  const frames = 100;
  const frameSize = 960;
  const dry = new Float32Array(frames * frameSize * CH);
  const wet = new Float32Array(dry.length);
  for (let frame = 0; frame < frames; frame++) {
    const speech = frame >= 60;
    for (let sample = 0; sample < frameSize; sample++) {
      const index = frame * frameSize + sample;
      const noise = 0.25 * Math.sin(index * 0.37);
      const cleanNoise = 0.025 * Math.sin(index * 0.37);
      const voice = speech ? 0.14 * Math.sin(index * 0.071) : 0;
      for (let channel = 0; channel < CH; channel++) {
        dry[index * CH + channel] = noise + voice;
        wet[index * CH + channel] = cleanNoise + voice;
      }
    }
  }
  const result = analyseCleanup(dry, wet, CH);
  assert(result.voiceRetentionDb > -1,
    "removing a loud floor must not be reported as chopped speech");
  assert(result.recommendedStrength >= 0.8,
    "preserved speech over a reduced floor should permit strong cleanup");
}

{
  const { dry, wet, frameSize } = makeFixture();
  const cleaned = adaptiveResidualCleanup(dry, wet, CH);
  const quietEnd = 40 * frameSize * CH;
  const speechStart = 55 * frameSize * CH;
  assert(rms(cleaned, 0, quietEnd) < rms(wet, 0, quietEnd), "expander should lower residual quiet noise");
  assert(rms(cleaned, speechStart, cleaned.length) > rms(wet, speechStart, wet.length) * 0.9,
    "expander should retain speech-level frames");
}

{
  const dry = new Float32Array(1920).fill(1.4);
  const wet = new Float32Array(1920).fill(1.4);
  dry[0] = Number.NaN;
  wet[1] = Number.POSITIVE_INFINITY;
  const cleaned = adaptiveResidualCleanup(dry, wet, CH);
  assert(cleaned.every((sample) => Number.isFinite(sample) && Math.abs(sample) <= 1),
    "residual cleanup must preserve the encoder-safe float PCM contract");
}

{
  const frameSize = 480;
  const frames = 100;
  const dry = new Float32Array(frameSize * frames * CH);
  const wet = new Float32Array(dry.length);
  for (let frame = 0; frame < frames; frame++) {
    const speech = frame >= 50;
    for (let sample = 0; sample < frameSize; sample++) {
      const index = frame * frameSize + sample;
      const input = speech
        ? 0.42 * Math.sin(index * 0.071)
        : 0.05 * Math.sin(index * 0.37);
      const model = speech ? 0 : input * 0.1;
      for (let channel = 0; channel < CH; channel++) {
        dry[index * CH + channel] = input;
        wet[index * CH + channel] = model;
      }
    }
  }
  const protectedWet = protectSpeechEnvelope(dry, wet, CH);
  const split = frameSize * 50 * CH;
  assert(rms(protectedWet, 0, split) <= rms(wet, 0, split) * 1.1,
    "quiet frames should retain the model's full reduction");
  assert(rms(protectedWet, split, protectedWet.length) >= rms(dry, split, dry.length) * 0.31,
    "a collapsed speech envelope must be restored to the safety floor");
  assert(protectedWet.every((sample) => Number.isFinite(sample) && Math.abs(sample) <= 1),
    "speech protection must preserve the encoder-safe PCM contract");
}

{
  const stereo = new Float32Array(4800 * 2);
  for (let i = 0; i < stereo.length / 2; i++) {
    const value = Math.sin(i * 0.1);
    stereo[i * 2] = value;
    stereo[i * 2 + 1] = value;
  }
  assert(stereoProfile(stereo).useMidSide, "correlated stereo should use the faster coherent path");
  for (let i = 0; i < stereo.length / 2; i++) stereo[i * 2 + 1] *= -1;
  assert(!stereoProfile(stereo).useMidSide, "anti-correlated stereo must keep independent channels");
}

{
  const oneSided = new Float32Array(4800 * 2);
  for (let i = 0; i < oneSided.length / 2; i++) oneSided[i * 2] = Math.sin(i * 0.1);
  assert(!stereoProfile(oneSided).useMidSide,
    "a silent channel must not be folded into the coherent stereo path");
}

{
  const changingStereo = new Float32Array(4000 * 2);
  for (let i = 0; i < changingStereo.length / 2; i++) {
    const value = Math.sin(i * 0.1);
    changingStereo[i * 2] = value;
    changingStereo[i * 2 + 1] = i < 2000 ? value : -value;
  }
  assert(!stereoProfile(changingStereo, 2, 2000).useMidSide,
    "stereo profiling must sample the whole timeline, not just a correlated intro");
}

{
  const dry = new Float32Array(1000 * 2);
  const mid = new Float32Array(1000);
  for (let i = 0; i < mid.length; i++) {
    mid[i] = Math.sin(i * 0.05) * 0.2;
    dry[i * 2] = mid[i];
    dry[i * 2 + 1] = mid[i];
  }
  const reconstructed = reconstructSmartStereo(dry, mid);
  for (let i = 0; i < mid.length; i++) {
    assert(Math.abs(reconstructed[i * 2] - mid[i]) < 1e-6);
    assert(Math.abs(reconstructed[i * 2 + 1] - mid[i]) < 1e-6);
  }
  assert.equal(waveformPeaks(reconstructed, CH, 80).length, 80);
}

{
  // A clean-mid model can occasionally overshoot while the original side
  // channel is still strong. Reconstruction must always produce valid float PCM.
  const dry = new Float32Array(960 * 2);
  const cleanMid = new Float32Array(960);
  for (let i = 0; i < cleanMid.length; i++) {
    dry[i * 2] = 1;
    dry[i * 2 + 1] = -1;
    cleanMid[i] = 0.85;
  }
  const reconstructed = reconstructSmartStereo(dry, cleanMid);
  assert(reconstructed.every((sample) => Number.isFinite(sample) && Math.abs(sample) <= 1),
    "smart-stereo reconstruction must stay inside [-1, 1]");
}

console.log("audio-utils: all tests passed");
