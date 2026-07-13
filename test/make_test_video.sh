#!/usr/bin/env bash
# Builds a DURATION-second test clip (default 10): speech (macOS `say`, looped)
# mixed with white noise, H.264 + AAC. Speech starts at 1.5 s, so 0–1.3 s is a
# noise-only region for measurements.
#   DURATION=60 OUT=tmp/noisy_60s.mp4 bash make_test_video.sh
set -euo pipefail
cd "$(dirname "$0")"
DUR="${DURATION:-10}"
OUT="${OUT:-tmp/noisy_test.mp4}"
mkdir -p tmp
say -o tmp/speech.aiff "This is a test of the browser based noise removal tool. The background hiss should disappear completely when the switch is flipped."
ffmpeg -y \
  -f lavfi -i "testsrc2=duration=${DUR}:size=640x360:rate=30" \
  -stream_loop -1 -i tmp/speech.aiff \
  -f lavfi -i "anoisesrc=d=${DUR}:c=white:a=0.08" \
  -filter_complex "[1:a]adelay=1500|1500,apad[sp];[sp][2:a]amix=inputs=2:duration=shortest:normalize=0,atrim=0:${DUR}[a]" \
  -map 0:v -map "[a]" -c:v libx264 -pix_fmt yuv420p -c:a aac -b:a 192k \
  "$OUT"
echo "Wrote test/$OUT"
