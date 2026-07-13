#!/usr/bin/env bash
# Builds a 10 s test clip: speech (macOS `say`) mixed with white noise, H.264 + AAC.
# Speech starts at 1.5 s, so 0–1.3 s is a noise-only region for measurements.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p tmp
say -o tmp/speech.aiff "This is a test of the browser based noise removal tool. The background hiss should disappear completely when the switch is flipped."
ffmpeg -y \
  -f lavfi -i "testsrc2=duration=10:size=640x360:rate=30" \
  -i tmp/speech.aiff \
  -f lavfi -i "anoisesrc=d=10:c=white:a=0.08" \
  -filter_complex "[1:a]adelay=1500|1500,apad[sp];[sp][2:a]amix=inputs=2:duration=first:normalize=0,atrim=0:10[a]" \
  -map 0:v -map "[a]" -c:v libx264 -pix_fmt yuv420p -c:a aac -b:a 192k \
  tmp/noisy_test.mp4
echo "Wrote test/tmp/noisy_test.mp4"
