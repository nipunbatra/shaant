#!/usr/bin/env python3
"""Fast regression tests for the optional native enhancement helpers."""

from __future__ import annotations

import argparse
import tempfile
import unittest
from pathlib import Path

import numpy as np
import soundfile as sf

from scripts.blend_vad_protected import blend_weights, process, speech_mask, validate_mix
from scripts.run_mossformer_mlx import downmix, match_input_length


class MossFormerWrapperTests(unittest.TestCase):
    def test_downmix_is_clipping_safe_average(self) -> None:
        stereo = np.array([[1.0, -1.0], [0.5, 0.5]], dtype=np.float32)
        np.testing.assert_allclose(downmix(stereo), [0.0, 0.5])

    def test_short_stft_tail_uses_input_fallback(self) -> None:
        fallback = np.arange(8, dtype=np.float32)
        enhanced = np.full(5, -1.0, dtype=np.float32)
        repaired = match_input_length(enhanced, fallback)
        np.testing.assert_allclose(repaired, [-1, -1, -1, -1, -1, 5, 6, 7])

    def test_long_model_output_is_bounded_to_input(self) -> None:
        repaired = match_input_length(np.arange(10, dtype=np.float32), np.zeros(4, dtype=np.float32))
        np.testing.assert_allclose(repaired, [0, 1, 2, 3])


class ProtectedBlendTests(unittest.TestCase):
    def test_invalid_mix_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            validate_mix(0.8, 0.4)
        with self.assertRaises(ValueError):
            validate_mix(-0.1, 0.4)

    def test_short_clip_keeps_one_vad_frame(self) -> None:
        samples = np.zeros(1_440, dtype=np.float32)  # one 30 ms frame at 48 kHz
        mask = speech_mask(samples, 48_000, 30, 1, 300)
        self.assertEqual(mask.shape, (1,))

    def test_silence_uses_quiet_strength_and_exact_length(self) -> None:
        samples = np.zeros(48_000, dtype=np.float32)
        weights = blend_weights(samples, 48_000, 0.4, 0.75, 30, 1, 300)
        self.assertEqual(len(weights), len(samples))
        np.testing.assert_allclose(weights, 0.75)

    def test_streaming_process_preserves_frames_and_finite_range(self) -> None:
        sample_rate = 48_000
        frames = sample_rate * 2 + 137
        time = np.arange(frames, dtype=np.float32) / sample_rate
        base = (0.15 * np.sin(2 * np.pi * 220 * time)).astype(np.float32)
        strong = (base * 0.5).astype(np.float32)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            base_path, strong_path, output_path = root / "base.wav", root / "strong.wav", root / "out.wav"
            sf.write(base_path, base, sample_rate, subtype="FLOAT")
            sf.write(strong_path, strong, sample_rate, subtype="FLOAT")
            args = argparse.Namespace(
                base=base_path,
                strong=strong_path,
                output=output_path,
                speech_wet=0.4,
                quiet_wet=0.75,
                vad_mode=1,
                frame_ms=30,
                pad_ms=300.0,
                core_seconds=0.7,
                context_seconds=0.4,
            )
            process(args)
            output, rate = sf.read(output_path, dtype="float32")
            self.assertEqual(rate, sample_rate)
            self.assertEqual(len(output), frames)
            self.assertTrue(np.isfinite(output).all())
            self.assertLessEqual(float(np.max(np.abs(output))), 1.0)


if __name__ == "__main__":
    unittest.main()
