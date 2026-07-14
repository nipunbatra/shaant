#!/usr/bin/env python3
"""Transcribe several audio files with one cached MLX Whisper model."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("audio", nargs="+", type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--model", default="mlx-community/whisper-large-v3-turbo")
    parser.add_argument("--language", default="en")
    return parser.parse_args()


def main() -> None:
    from mlx_whisper import transcribe

    args = parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    for audio in args.audio:
        result = transcribe(
            str(audio),
            path_or_hf_repo=args.model,
            language=args.language,
            condition_on_previous_text=False,
            verbose=False,
        )
        output = args.output_dir / f"{audio.stem}.json"
        with output.open("w", encoding="utf-8") as handle:
            json.dump(result, handle, ensure_ascii=False)
        print(output, flush=True)


if __name__ == "__main__":
    main()
