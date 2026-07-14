#!/usr/bin/env python3
"""End-to-end test: drop a noisy video, wait for auto-processing, exercise the
instant A/B toggle and strength slider, download the result, and verify
(a) the noise floor dropped by >20 dB in the speech-free region and (b) the
video stream was copied bit-identically.

Prereqs:
    bash make_test_video.sh                 # build test/tmp/noisy_test.mp4
    python3 ../serve.py 8000 &              # serve the repo root
    pip install playwright && playwright install chromium

Run:
    URL=http://localhost:8000/ [ENGINE=rnnoise|dfn3] [NOISY=path] python3 e2e_test.py
"""
import base64
from array import array
import json
import os
import re
import subprocess
import sys

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
TMP = os.path.join(HERE, "tmp")
URL = os.environ.get("URL", "http://localhost:8000/")
ENGINE = os.environ.get("ENGINE", "rnnoise")
NOISY = os.environ.get("NOISY", os.path.join(TMP, "noisy_test.mp4"))
RESULT_DIR = os.environ.get("RESULT_DIR", TMP)
os.makedirs(RESULT_DIR, exist_ok=True)
RESULT = os.path.join(RESULT_DIR, f"denoised_result_{ENGINE}.mp4")
REAL_WORLD = os.environ.get("REAL_WORLD") == "1"
STREAMING = os.environ.get("STREAMING") == "1"
STREAMING_PART_SECONDS = os.environ.get("STREAMING_PART_SECONDS")
DOWNLOAD_VIA_BROWSER = os.environ.get("DOWNLOAD_VIA_BROWSER") == "1"
LARGE_FILE = os.environ.get("LARGE_FILE") == "1"
INTERRUPT_FILE = os.environ.get("INTERRUPT_FILE")
STRESS_CYCLES = int(os.environ.get("STRESS_CYCLES", "0"))
FORCE_DURATION_PROBE = os.environ.get("FORCE_DURATION_PROBE") == "1"
REQUIRE_OPFS = os.environ.get("REQUIRE_OPFS") == "1"
INVALID_FIRST = os.environ.get("INVALID_FIRST")
MEMORY_SOURCE = os.environ.get("MEMORY_SOURCE") == "1"
DISABLE_AV_PROBE = os.environ.get("DISABLE_AV_PROBE") == "1"
EXPECT_REJECTION = os.environ.get("EXPECT_REJECTION") == "1"
FINAL_STRENGTH = os.environ.get("FINAL_STRENGTH")


def rms_db(path, seconds=None):
    cmd = ["ffmpeg", "-hide_banner", "-i", path]
    if seconds:
        cmd += ["-t", str(seconds)]
    cmd += ["-af", "astats=metadata=1", "-f", "null", "-"]
    out = subprocess.run(cmd, capture_output=True, text=True).stderr
    m = re.search(r"RMS level dB: (-?[\d.]+|-inf)", out)
    return -120.0 if m.group(1) == "-inf" else float(m.group(1))


def video_md5(path):
    out = subprocess.run(
        ["ffmpeg", "-i", path, "-map", "0:v", "-c", "copy", "-f", "md5", "-"],
        capture_output=True, text=True,
    ).stdout
    return out.strip()


def has_video(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=index", "-of", "csv=p=0", path],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    return bool(out)


def av_start_offset(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries",
         "stream=codec_type,start_time", "-of", "json", path],
        capture_output=True, text=True, check=True,
    ).stdout
    starts = {}
    for stream in json.loads(out).get("streams", []):
        value = stream.get("start_time")
        if value not in (None, "N/A") and stream.get("codec_type") not in starts:
            starts[stream["codec_type"]] = float(value)
    if "audio" not in starts or "video" not in starts:
        return None
    return starts["audio"] - starts["video"]


def sectional_seam_ratios(path, part_seconds):
    duration = media_duration(path)
    if duration > 120:
        return []
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-vn", "-ac", "2", "-ar", "48000",
         "-f", "f32le", "-c:a", "pcm_f32le", "-"],
        capture_output=True, check=True,
    ).stdout
    pcm = array("f")
    pcm.frombytes(raw)
    ratios = []
    boundary = float(part_seconds)
    while boundary < duration - 0.1:
        frame = round(boundary * 48000)
        seam = max(abs(pcm[frame * 2 + channel] - pcm[(frame - 1) * 2 + channel])
                   for channel in range(2))
        neighborhood = []
        for nearby in range(max(1, frame - 480), min(len(pcm) // 2, frame + 481)):
            if nearby == frame:
                continue
            neighborhood.extend(
                abs(pcm[nearby * 2 + channel] - pcm[(nearby - 1) * 2 + channel])
                for channel in range(2)
            )
        neighborhood.sort()
        local_p95 = neighborhood[int((len(neighborhood) - 1) * 0.95)]
        ratios.append(seam / max(1e-5, local_p95))
        boundary += float(part_seconds)
    return ratios


def media_duration(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", path],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    return float(out)


def wait_ready(page, timeout=600000):
    page.wait_for_function(
        "() => document.getElementById('videoCard').dataset.state === 'ready'"
        " || !document.getElementById('errorBox').hidden",
        timeout=timeout,
    )
    if page.evaluate("() => !document.getElementById('errorBox').hidden"):
        print("ERROR BOX:", page.locator("#errorBox").inner_text())
        print("LAST STATUS:", page.locator("#progressLabel").inner_text())
        if console_errors:
            print("CONSOLE ERRORS:", console_errors[-5:])
        sys.exit(1)


console_errors = []

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page()
    page.on("console", lambda m: (
        console_errors.append(m.text) if m.type == "error"
        else print("PAGE:", m.text) if "[denoise]" in m.text else None
    ))
    page.on("pageerror", lambda e: console_errors.append(str(e)))

    target_url = URL
    if STREAMING:
        target_url += ("&" if "?" in target_url else "?") + "streaming=1"
    if STREAMING_PART_SECONDS:
        target_url += ("&" if "?" in target_url else "?") + \
            f"stream-chunk={STREAMING_PART_SECONDS}"
    if FORCE_DURATION_PROBE:
        target_url += ("&" if "?" in target_url else "?") + "probe-duration=1"
    if MEMORY_SOURCE:
        target_url += ("&" if "?" in target_url else "?") + "memory-source=1"
    if DISABLE_AV_PROBE:
        target_url += ("&" if "?" in target_url else "?") + "no-av-probe=1"
    page.goto(target_url)
    page.wait_for_selector("#dropZone", timeout=10000)
    print("PAGE LOADED, badges:", page.locator(".badges").inner_text().replace("\n", " | "))

    # defaults: High quality (dfn3) at 70% — check they're preselected
    assert page.evaluate("() => document.querySelector('input[name=engine]:checked').value") == "dfn3"
    assert page.evaluate("() => document.getElementById('strength').value") == "70"
    assert page.is_checked("#autoStrength")
    assert page.is_checked("#adaptiveCleanup")
    assert page.is_checked("#smartStereo")
    print("DEFAULTS OK (dfn3, automatic strength, residual cleanup, smart stereo)")

    # Engine controls live in progressive-disclosure advanced settings.
    page.locator(".advanced-settings").evaluate("el => el.open = true")

    if ENGINE == "rnnoise":
        # engine is choosable BEFORE dropping a file now
        page.check('input[name="engine"][value="rnnoise"]', force=True)

    if EXPECT_REJECTION:
        page.set_input_files("#fileInput", NOISY)
        page.wait_for_function(
            "() => !document.getElementById('errorBox').hidden",
            timeout=10000,
        )
        error_text = page.locator("#errorBox").inner_text().lower()
        assert "webm" in error_text, f"format rejection did not identify WebM: {error_text}"
        assert "mp4" in error_text and "mkv" in error_text, (
            f"format rejection did not offer useful alternatives: {error_text}"
        )
        assert "not been changed or uploaded" in error_text, (
            f"format rejection did not preserve the privacy guarantee: {error_text}"
        )
        assert not page.locator("#downloadBtn").get_attribute("href")
        assert not console_errors, f"rejected format caused console errors: {console_errors}"
        print("UNSAFE FORMAT REJECTED CLEANLY; APP REMAINS RESPONSIVE")
        browser.close()
        sys.exit(0)

    if INVALID_FIRST:
        page.set_input_files("#fileInput", INVALID_FIRST)
        page.wait_for_function(
            "() => document.getElementById('videoCard').dataset.state === 'error'",
            timeout=120000,
        )
        error_text = page.locator("#errorBox").inner_text().lower()
        assert "audio" in error_text, f"invalid media error was not actionable: {error_text}"
        assert not page.locator("#downloadBtn").get_attribute("href")
        console_errors.clear()  # the expected processing error is already asserted above
        print("NO-AUDIO FAILURE REPORTED; TESTING RECOVERY")

    # Optional adversarial setup: start another file, churn engine workers,
    # then replace the source while work is still in flight.
    if INTERRUPT_FILE:
        page.set_input_files("#fileInput", INTERRUPT_FILE)
        page.wait_for_function(
            "() => document.getElementById('videoCard').dataset.state === 'processing'",
            timeout=10000,
        )
        for value in ("rnnoise", "dfn3", "rnnoise"):
            page.check(f'input[name="engine"][value="{value}"]', force=True)
            page.wait_for_timeout(25)
        page.check(f'input[name="engine"][value="{ENGINE}"]', force=True)
        print("IN-FLIGHT ENGINE/FILE INTERRUPTION ISSUED")

    # dropping a file auto-starts processing with the selected engine
    page.set_input_files("#fileInput", NOISY)
    page.wait_for_selector("#videoCard:not([hidden])", timeout=5000)

    if ENGINE == "dfn3" and not LARGE_FILE:
        # switching engine MID-processing must cancel and restart cleanly
        page.wait_for_function(
            "() => document.getElementById('videoCard').dataset.state === 'processing'",
            timeout=10000,
        )
        page.check('input[name="engine"][value="rnnoise"]', force=True)
        wait_ready(page)
        info = page.locator("#resultInfo").inner_text()
        assert "RNNoise" in info, f"expected RNNoise after mid-run switch, got: {info}"
        print("MID-RUN SWITCH OK:", info)
        page.check('input[name="engine"][value="dfn3"]', force=True)
        wait_ready(page)
        info = page.locator("#resultInfo").inner_text()
        assert "DeepFilterNet3" in info, f"expected DFN3 result, got: {info}"
        print("HQ DONE:", info)
    elif ENGINE == "dfn3":
        wait_ready(page)
        info = page.locator("#resultInfo").inner_text()
        assert "DeepFilterNet3" in info, f"expected DFN3 result, got: {info}"
        print("HQ DONE:", info)
    else:
        wait_ready(page)
        info = page.locator("#resultInfo").inner_text()
        assert "RNNoise" in info, f"expected RNNoise result, got: {info}"
        print("FAST DONE:", info)

    if FORCE_DURATION_PROBE:
        assert page.locator("#videoCard").get_attribute("data-duration-source") == "ffmpeg", (
            "forced metadata fallback did not use the bounded ffmpeg probe"
        )
        print("FFMPEG DURATION FALLBACK OK")

    if REQUIRE_OPFS:
        assert page.locator("#videoCard").get_attribute("data-segment-storage") == "opfs", (
            "sectional clean audio was not spooled outside ffmpeg MEMFS"
        )
        print("OPFS SECTION SPOOL OK")

    # Sequential cycles catch stale mounts, retained sectional artifacts and
    # object-URL races that a single successful processing pass cannot expose.
    for cycle in range(STRESS_CYCLES):
        page.set_input_files("#fileInput", NOISY)
        page.wait_for_function(
            "() => document.getElementById('videoCard').dataset.state === 'processing'",
            timeout=10000,
        )
        wait_ready(page)
        info = page.locator("#resultInfo").inner_text()
        expected = "DeepFilterNet3" if ENGINE == "dfn3" else "RNNoise"
        assert expected in info, f"stress cycle {cycle + 1} used stale engine/source: {info}"
        print(f"REPEAT CYCLE {cycle + 1}/{STRESS_CYCLES} OK:", info)

    # Automatic strength should make a content-based recommendation after the
    # model pass; the user does not need to guess a percentage.
    auto_value = int(page.locator("#strength").input_value())
    assert 55 <= auto_value <= 96, f"automatic strength out of safe range: {auto_value}"
    assert page.locator("#strengthVal").inner_text().startswith("Auto ·")
    assert not page.is_hidden("#qualityStrip")
    print("AUTO STRENGTH OK:", auto_value)

    if not LARGE_FILE:
        # Turning automatic off via a manual edit and back on should restore the
        # same content-based recommendation without another neural-model pass.
        auto_href = page.locator("#downloadBtn").get_attribute("href")
        page.locator("#strength").evaluate(
            "el => { el.value = 42; el.dispatchEvent(new Event('input')); "
            "el.dispatchEvent(new Event('change')); }"
        )
        page.wait_for_function(
            f"() => document.getElementById('downloadBtn').href !== '{auto_href}'"
            " && document.getElementById('barTrack').hidden",
            timeout=120000,
        )
        assert not page.is_checked("#autoStrength")
        manual_href = page.locator("#downloadBtn").get_attribute("href")
        page.check("#autoStrength", force=True)
        page.wait_for_function(
            f"() => document.getElementById('downloadBtn').href !== '{manual_href}'"
            " && document.getElementById('barTrack').hidden",
            timeout=120000,
        )
        assert int(page.locator("#strength").input_value()) == auto_value
        print("AUTO RESTORE OK")

        # Residual cleanup is a post-model operation: toggling it should create a
        # new export and preserve the ready state without rerunning denoising.
        cleanup_href = page.locator("#downloadBtn").get_attribute("href")
        page.uncheck("#adaptiveCleanup")
        page.wait_for_function(
            f"() => document.getElementById('downloadBtn').href !== '{cleanup_href}'"
            " && document.getElementById('videoCard').dataset.state === 'ready'"
            " && document.getElementById('barTrack').hidden",
            timeout=120000,
        )
        page.check("#adaptiveCleanup")
        page.wait_for_function(
            "() => document.getElementById('barTrack').hidden",
            timeout=120000,
        )
        print("RESIDUAL CLEANUP RE-EXPORT OK")

        # Two rapid manual changes should converge on the final requested value,
        # even if the first remux has already acquired the ffmpeg lock.
        rapid_href = page.locator("#downloadBtn").get_attribute("href")
        page.locator("#strength").evaluate(
            "el => {"
            " el.value = 35; el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change'));"
            " el.value = 65; el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change'));"
            "}"
        )
        page.wait_for_function(
            f"() => document.getElementById('downloadBtn').href !== '{rapid_href}'"
            " && document.getElementById('barTrack').hidden"
            " && document.getElementById('downloadBtn').dataset.strength === '65'",
            timeout=120000,
        )
        print("RAPID STRENGTH CONVERGENCE OK")

    download_name = page.locator("#downloadBtn").get_attribute("download")
    print("DOWNLOAD NAME:", download_name)
    # instant A/B toggle: audio swaps via muted flags on two synced players
    assert page.evaluate("() => document.getElementById('player').muted") is True
    assert page.evaluate("() => document.getElementById('shadowPlayer').muted") is False
    page.click(".switch .slider")
    assert page.evaluate("() => document.getElementById('player').muted") is False
    assert page.evaluate("() => document.getElementById('shadowPlayer').muted") is True
    page.click(".switch .slider")
    assert page.evaluate("() => document.getElementById('player').muted") is True
    print("A/B TOGGLE OK (instant mute swap)")

    # toggle while playing must not error
    page.click("#playBtn")
    page.wait_for_timeout(700)
    page.click(".switch .slider")
    page.wait_for_timeout(400)
    page.click(".switch .slider")
    page.wait_for_timeout(400)
    assert page.evaluate("() => !document.getElementById('player').paused"), "should still be playing"
    page.click("#playBtn")
    print("LIVE TOGGLE WHILE PLAYING OK")

    if not LARGE_FILE:
        href_before = page.evaluate("() => document.getElementById('downloadBtn').href")

        # strength slider re-export path (50%) — must not error (regression: detached buffers)
        page.locator("#strength").evaluate(
            "el => { el.value = 50; el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); }"
        )
        page.wait_for_function(
            f"() => document.getElementById('downloadBtn').href !== '{href_before}'"
            " || !document.getElementById('errorBox').hidden",
            timeout=120000,
        )
        assert page.evaluate("() => document.getElementById('errorBox').hidden"), (
            "strength re-export failed: " + page.locator("#errorBox").inner_text()
        )
        print("STRENGTH RE-EXPORT OK")

        # Synthetic fixture uses 100% for the known floor assertion. Real-world
        # fixtures return to the model's safe automatic recommendation.
        final_strength = int(FINAL_STRENGTH) if FINAL_STRENGTH is not None else (
            auto_value if REAL_WORLD else 100
        )
        page.locator("#strength").evaluate(
            f"el => {{ el.value = {final_strength}; el.dispatchEvent(new Event('input')); "
            "el.dispatchEvent(new Event('change')); }"
        )
        page.wait_for_timeout(500)
        page.wait_for_function(
            "() => !document.getElementById('barTrack').offsetParent || document.getElementById('barTrack').hidden",
            timeout=120000,
        )
    elif FINAL_STRENGTH is not None:
        final_strength = int(FINAL_STRENGTH)
        assert 0 <= final_strength <= 100, "FINAL_STRENGTH must be between 0 and 100"
        prior_href = page.locator("#downloadBtn").get_attribute("href")
        page.locator("#strength").evaluate(
            f"el => {{ el.value = {final_strength}; el.dispatchEvent(new Event('input')); "
            "el.dispatchEvent(new Event('change')); }"
        )
        page.wait_for_function(
            f"() => document.getElementById('downloadBtn').href !== '{prior_href}'"
            " && document.getElementById('barTrack').hidden"
            f" && document.getElementById('downloadBtn').dataset.strength === '{final_strength}'",
            timeout=120000,
        )
        print("FINAL STRENGTH OVERRIDE OK:", final_strength)

    result_extension = os.path.splitext(download_name)[1]
    if result_extension:
        RESULT = os.path.join(RESULT_DIR, f"denoised_result_{ENGINE}{result_extension}")

    if DOWNLOAD_VIA_BROWSER:
        with page.expect_download(timeout=120000) as download_info:
            page.click("#downloadBtn")
        download_info.value.save_as(RESULT)
    else:
        b64 = page.evaluate(
            """async () => {
                const href = document.getElementById('downloadBtn').href;
                const buf = await (await fetch(href)).arrayBuffer();
                let s = '';
                const u8 = new Uint8Array(buf);
                for (let i = 0; i < u8.length; i += 0x8000)
                    s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
                return btoa(s);
            }"""
        )
        with open(RESULT, "wb") as f:
            f.write(base64.b64decode(b64))
    print("SAVED:", RESULT)

    assert not console_errors, f"console errors: {console_errors[-10:]}"
    browser.close()

# ---- offline verification with host ffmpeg ----
noise_before = rms_db(NOISY, 1.3)
noise_after = rms_db(RESULT, 1.3)
total_before = rms_db(NOISY)
total_after = rms_db(RESULT)
print(f"noise floor: {noise_before:.1f} dB -> {noise_after:.1f} dB "
      f"(reduction {noise_before - noise_after:.1f} dB)")
print(f"full-file RMS: {total_before:.1f} dB -> {total_after:.1f} dB")
if not REAL_WORLD:
    assert noise_before - noise_after > 20, "expected >20 dB noise reduction"
    assert total_before - total_after < 10, "speech should be preserved"
duration_delta = abs(media_duration(NOISY) - media_duration(RESULT))
assert duration_delta < 0.15, f"A/V duration changed by {duration_delta:.3f}s"
print(f"A/V DURATION OK (delta {duration_delta:.3f}s)")
if has_video(NOISY):
    assert video_md5(NOISY) == video_md5(RESULT), "video stream must be copied bit-identically"
    print("VIDEO STREAM BIT-IDENTICAL")
    offset_before = av_start_offset(NOISY)
    offset_after = av_start_offset(RESULT)
    if offset_before is not None and offset_after is not None:
        offset_delta = abs(offset_before - offset_after)
        assert offset_delta < 0.05, f"relative A/V start changed by {offset_delta:.3f}s"
        print(f"A/V START OFFSET OK (delta {offset_delta:.3f}s)")
else:
    assert not has_video(RESULT), "audio-only input unexpectedly gained a video stream"
    print("AUDIO-ONLY CONTAINER PRESERVED")
if STREAMING_PART_SECONDS:
    seam_ratios = sectional_seam_ratios(RESULT, STREAMING_PART_SECONDS)
    assert all(ratio < 12 for ratio in seam_ratios), f"section boundary click ratios: {seam_ratios}"
    if seam_ratios:
        print(f"SECTION SEAMS OK (worst local ratio {max(seam_ratios):.2f}x)")
print("ALL CHECKS PASSED")
