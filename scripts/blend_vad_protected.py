#!/usr/bin/env python3
"""Blend a stronger enhancement into a speech-safe base using WebRTC VAD.

Speech regions use a conservative wet amount. Non-speech regions use a stronger
amount, with look-around padding and smoothed transitions so consonant edges are
never exposed to an abrupt gain change. Processing is bounded by the core size.
"""

from __future__ import annotations

import argparse
import math
from pathlib import Path

import numpy as np
import soundfile as sf
import webrtcvad


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("base", type=Path)
    parser.add_argument("strong", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--speech-wet", type=float, default=0.40)
    parser.add_argument("--quiet-wet", type=float, default=0.75)
    parser.add_argument("--vad-mode", type=int, choices=range(4), default=1)
    parser.add_argument("--frame-ms", type=int, choices=(10, 20, 30), default=30)
    parser.add_argument("--pad-ms", type=float, default=300.0)
    parser.add_argument("--core-seconds", type=float, default=60.0)
    parser.add_argument("--context-seconds", type=float, default=1.0)
    return parser.parse_args()


def validate_mix(speech_wet: float, quiet_wet: float) -> None:
    if not 0.0 <= speech_wet <= 1.0 or not 0.0 <= quiet_wet <= 1.0:
        raise ValueError("wet amounts must be between zero and one")
    if quiet_wet < speech_wet:
        raise ValueError("quiet wet amount must be at least the speech wet amount")


def speech_mask(samples: np.ndarray, sample_rate: int, frame_ms: int, mode: int, pad_ms: float) -> np.ndarray:
    frame = sample_rate * frame_ms // 1000
    total_frames = math.ceil(len(samples) / frame)
    padded = np.zeros(total_frames * frame, dtype=np.float32)
    padded[: len(samples)] = samples
    pcm = np.rint(np.clip(padded, -1.0, 1.0) * 32767.0).astype("<i2", copy=False)
    vad = webrtcvad.Vad(mode)
    detected = np.fromiter(
        (vad.is_speech(pcm[i * frame : (i + 1) * frame].tobytes(), sample_rate) for i in range(total_frames)),
        dtype=bool,
        count=total_frames,
    )

    radius = max(0, math.ceil(pad_ms / frame_ms))
    if radius and detected.size:
        kernel = np.ones(radius * 2 + 1, dtype=np.int16)
        padded_detection = np.pad(detected.astype(np.int16), (radius, radius))
        detected = np.convolve(padded_detection, kernel, mode="valid") > 0
    return detected


def blend_weights(
    samples: np.ndarray,
    sample_rate: int,
    speech_wet: float,
    quiet_wet: float,
    frame_ms: int,
    mode: int,
    pad_ms: float,
) -> np.ndarray:
    validate_mix(speech_wet, quiet_wet)
    mask = speech_mask(samples, sample_rate, frame_ms, mode, pad_ms)
    targets = np.where(mask, speech_wet, quiet_wet).astype(np.float32)

    # Drop to the speech-safe value rapidly; return to stronger cleanup slowly.
    smoothed = np.empty_like(targets)
    current = float(targets[0]) if targets.size else speech_wet
    for i, target in enumerate(targets):
        time_ms = 45.0 if target < current else 180.0
        alpha = 1.0 - math.exp(-frame_ms / time_ms)
        current += alpha * (float(target) - current)
        smoothed[i] = current

    frame = sample_rate * frame_ms // 1000
    return np.repeat(smoothed, frame)[: len(samples)]


def process(args: argparse.Namespace) -> None:
    validate_mix(args.speech_wet, args.quiet_wet)
    args.output.parent.mkdir(parents=True, exist_ok=True)

    with sf.SoundFile(args.base) as base, sf.SoundFile(args.strong) as strong:
        if base.samplerate != strong.samplerate or len(base) != len(strong):
            raise ValueError("base and strong inputs must have identical rates and lengths")
        if base.channels != 1 or strong.channels != 1:
            raise ValueError("base and strong inputs must be mono")
        sample_rate = base.samplerate
        if sample_rate not in (8_000, 16_000, 32_000, 48_000):
            raise ValueError("WebRTC VAD requires 8, 16, 32 or 48 kHz audio")

        total = len(base)
        core_frames = max(1, round(args.core_seconds * sample_rate))
        context_frames = max(round(args.context_seconds * sample_rate), round(args.pad_ms * sample_rate / 1000))

        with sf.SoundFile(args.output, "w", sample_rate, 1, subtype="FLOAT") as output:
            for core_start in range(0, total, core_frames):
                core_end = min(total, core_start + core_frames)
                read_start = max(0, core_start - context_frames)
                read_end = min(total, core_end + context_frames)
                base.seek(read_start)
                strong.seek(read_start)
                dry = base.read(read_end - read_start, dtype="float32")
                wet = strong.read(read_end - read_start, dtype="float32")
                weights = blend_weights(
                    dry,
                    sample_rate,
                    args.speech_wet,
                    args.quiet_wet,
                    args.frame_ms,
                    args.vad_mode,
                    args.pad_ms,
                )
                mixed = dry + weights * (wet - dry)
                keep_start = core_start - read_start
                keep_end = keep_start + core_end - core_start
                core = np.nan_to_num(mixed[keep_start:keep_end], copy=False)
                np.clip(core, -1.0, 1.0, out=core)
                output.write(core)

    with sf.SoundFile(args.output) as result:
        if len(result) != total:
            raise RuntimeError(f"duration mismatch: wrote {len(result)} of {total} frames")


if __name__ == "__main__":
    process(parse_args())
