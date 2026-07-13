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
RESULT = os.path.join(TMP, f"denoised_result_{ENGINE}.mp4")


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


def wait_ready(page, timeout=600000):
    page.wait_for_function(
        "() => document.getElementById('videoCard').dataset.state === 'ready'"
        " || !document.getElementById('errorBox').hidden",
        timeout=timeout,
    )
    if page.evaluate("() => !document.getElementById('errorBox').hidden"):
        print("ERROR BOX:", page.locator("#errorBox").inner_text())
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

    page.goto(URL)
    page.wait_for_selector("#dropZone", timeout=10000)
    print("PAGE LOADED, badges:", page.locator(".badges").inner_text().replace("\n", " | "))

    # dropping a file auto-starts processing with the Fast engine
    page.set_input_files("#fileInput", NOISY)
    page.wait_for_selector("#videoCard:not([hidden])", timeout=5000)
    wait_ready(page)
    print("FAST DONE:", page.locator("#resultInfo").inner_text())

    if ENGINE == "dfn3":
        # switching engine re-processes automatically
        page.check('input[name="engine"][value="dfn3"]', force=True)
        page.wait_for_function(
            "() => document.getElementById('videoCard').dataset.state === 'processing'",
            timeout=10000,
        )
        wait_ready(page)
        info = page.locator("#resultInfo").inner_text()
        assert "DeepFilterNet3" in info, f"expected DFN3 result, got: {info}"
        print("HQ DONE:", info)

    print("DOWNLOAD NAME:", page.locator("#downloadBtn").get_attribute("download"))

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

    # restore 100% and grab the final blob
    page.locator("#strength").evaluate(
        "el => { el.value = 100; el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); }"
    )
    page.wait_for_timeout(500)
    page.wait_for_function(
        "() => !document.getElementById('barTrack').offsetParent || document.getElementById('barTrack').hidden",
        timeout=120000,
    )

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
assert noise_before - noise_after > 20, "expected >20 dB noise reduction"
assert total_before - total_after < 10, "speech should be preserved"
assert video_md5(NOISY) == video_md5(RESULT), "video stream must be copied bit-identically"
print("VIDEO STREAM BIT-IDENTICAL")
print("ALL CHECKS PASSED")
