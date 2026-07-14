#!/usr/bin/env python3
"""Memory-bounded local speech enhancement with MossFormer2-SE on Apple MLX.

The input must be a 48 kHz PCM WAV. Long recordings are processed as independent
cores with context on both sides; only the core is written, so model warm-up and
edge artifacts never create gaps or change the duration.
"""

from __future__ import annotations

import argparse
import math
import time
from pathlib import Path

import numpy as np
import soundfile as sf


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--core-seconds", type=float, default=30.0)
    parser.add_argument("--context-seconds", type=float, default=2.0)
    parser.add_argument("--model", default="starkdmi/MossFormer2-SE-fp16")
    return parser.parse_args()


def validate_args(args: argparse.Namespace) -> None:
    if args.core_seconds <= 0:
        raise ValueError("--core-seconds must be positive")
    if args.context_seconds < 0:
        raise ValueError("--context-seconds cannot be negative")
    if args.input.resolve() == args.output.resolve():
        raise ValueError("input and output paths must differ")


def downmix(block: np.ndarray) -> np.ndarray:
    if block.ndim == 1:
        return block.astype(np.float32, copy=False)
    # Camera stereo is commonly dual-mono. A true average avoids the +3 dB gain
    # of a power-preserving mix and therefore cannot create clipping.
    return np.mean(block, axis=1, dtype=np.float32)


def match_input_length(enhanced: np.ndarray, fallback: np.ndarray) -> np.ndarray:
    """Return model output with the exact input length, preserving any STFT tail."""
    enhanced = np.asarray(enhanced, dtype=np.float32)
    fallback = np.asarray(fallback, dtype=np.float32)
    if len(enhanced) == len(fallback):
        return enhanced
    repaired = fallback.copy()
    shared = min(len(enhanced), len(fallback))
    repaired[:shared] = enhanced[:shared]
    return repaired


def enhance_file(args: argparse.Namespace) -> None:
    from mlx_audio.sts.models.mossformer2_se import MossFormer2SEModel

    validate_args(args)
    args.output.parent.mkdir(parents=True, exist_ok=True)

    with sf.SoundFile(args.input) as source:
        if source.samplerate != 48_000:
            raise ValueError(f"expected 48 kHz input, got {source.samplerate} Hz")
        total_frames = len(source)
        core_frames = max(1, round(args.core_seconds * source.samplerate))
        context_frames = round(args.context_seconds * source.samplerate)
        parts = math.ceil(total_frames / core_frames)

        model = MossFormer2SEModel.from_pretrained(args.model)
        model.warmup(chunked=False)
        started = time.monotonic()

        with sf.SoundFile(
            args.output,
            mode="w",
            samplerate=source.samplerate,
            channels=1,
            subtype="FLOAT",
        ) as destination:
            for part, core_start in enumerate(range(0, total_frames, core_frames), 1):
                core_end = min(total_frames, core_start + core_frames)
                read_start = max(0, core_start - context_frames)
                read_end = min(total_frames, core_end + context_frames)
                source.seek(read_start)
                block = source.read(read_end - read_start, dtype="float32", always_2d=True)
                mono = downmix(block)
                enhanced = np.asarray(model.enhance(mono, chunked=False), dtype=np.float32)
                # A non-centred STFT may return up to one hop fewer samples when
                # the final block is not frame-aligned. Preserve that tiny tail
                # from the input rather than shortening the recording or adding
                # silence. Longer model output is equally bounded to the input.
                enhanced = match_input_length(enhanced, mono)
                keep_start = core_start - read_start
                keep_end = keep_start + (core_end - core_start)
                core = np.nan_to_num(enhanced[keep_start:keep_end], copy=False)
                np.clip(core, -1.0, 1.0, out=core)
                destination.write(core)

                elapsed = time.monotonic() - started
                rate = (core_end / source.samplerate) / max(elapsed, 1e-6)
                print(f"part {part}/{parts}: {core_end / source.samplerate:.1f}s, {rate:.2f}x realtime", flush=True)

    with sf.SoundFile(args.output) as result:
        if len(result) != total_frames:
            raise RuntimeError(f"duration mismatch: wrote {len(result)} of {total_frames} frames")


if __name__ == "__main__":
    enhance_file(parse_args())
