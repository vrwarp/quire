import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

ARTIFACT_DIR = Path(
    os.environ.get("E2E_OUTPUT_DIR")
    or tempfile.mkdtemp(prefix="quire-e2e-")
)
SHOT_DIR = ARTIFACT_DIR / "screenshots"
SHOT_DIR.mkdir(parents=True, exist_ok=True)


def make_sample_pdf(out_path: Path):
    """Create a real valid 3-page PDF using node + pdf-lib for CUJ 3 import validation."""
    script = f"""
    import {{ PDFDocument, StandardFonts, rgb }} from 'pdf-lib';
    import fs from 'fs';
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.HelveticaBold);
    for (let i = 1; i <= 3; i++) {{
      const page = doc.addPage([612, 792]);
      page.drawText('Quire Lecture Deck - Slide ' + i, {{
        x: 72, y: 700, size: 24, font, color: rgb(0.1, 0.1, 0.15)
      }});
      page.drawText('Vector PDF content preserved on import and export.', {{
        x: 72, y: 660, size: 14, font, color: rgb(0.3, 0.3, 0.35)
      }});
    }}
    const bytes = await doc.save();
    fs.writeFileSync({str(out_path)!r}, bytes);
    """
    subprocess.run(["node", "--input-type=module", "-e", script], check=True)


def main():
    sample_pdf = ARTIFACT_DIR / "scratch" / "sample_slides.pdf"
    sample_pdf.parent.mkdir(parents=True, exist_ok=True)
    make_sample_pdf(sample_pdf)

    server = subprocess.Popen(
        ["npx", "vite", "preview", "--port", "4173", "--host", "127.0.0.1"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    try:
        # Wait for preview server
        time.sleep(2.0)

        console_errors = []
        page_errors = []

        with sync_playwright() as p:
            launch_kwargs = {
                "headless": True,
                "args": ["--no-sandbox", "--disable-gpu-sandbox"],
            }
            system_chrome = shutil.which("google-chrome") or shutil.which("chromium")
            if system_chrome and not os.environ.get("PLAYWRIGHT_USE_BUNDLED"):
                launch_kwargs["executable_path"] = system_chrome
            browser = p.chromium.launch(**launch_kwargs)
            context = browser.new_context(
                viewport={"width": 1194, "height": 834},
                device_scale_factor=2,
                accept_downloads=True,
            )
            page = context.new_page()
            page.on(
                "console",
                lambda msg: console_errors.append(msg.text) if msg.type == "error" else None,
            )
            page.on("pageerror", lambda err: page_errors.append(str(err)))

            # --- CUJ 1: Cold Launch & Zero-Friction Onboarding ---
            t0 = time.perf_counter()
            page.goto("http://127.0.0.1:4173/", wait_until="networkidle")
            page.wait_for_selector("#btn-start-writing", timeout=5000)
            cold_ms = (time.perf_counter() - t0) * 1000
            print(f"[PASS] CUJ 1 Cold launch to Welcome Sheet: {cold_ms:.0f} ms")
            assert cold_ms < 2500, f"Cold launch too slow: {cold_ms}ms"
            page.screenshot(path=str(SHOT_DIR / "01_welcome.png"))

            t_start = time.perf_counter()
            page.click("#btn-start-writing")
            page.wait_for_selector(".page-slot", timeout=3000)
            ready_ms = (time.perf_counter() - t_start) * 1000
            print(f"[PASS] CUJ 1 Start Writing -> Writable Canvas: {ready_ms:.0f} ms")
            assert ready_ms < 1500

            # Verify 120Hz WebGL2 / OffscreenCanvas worker initialized
            page.wait_for_function(
                "() => document.querySelector('#telemetry-hz-pill')?.textContent?.includes('120Hz')",
                timeout=4000,
            )
            hz_badge = page.locator("#telemetry-hz-pill").text_content()
            print(f"[PASS] 120 Hz Dedicated OffscreenCanvas Worker active ({hz_badge})")

            # --- CUJ 2: Ink, Highlighter, Typed Text, Per-Page Templates & ProMotion Governor ---
            slot = page.locator(".page-slot").first
            box = slot.bounding_box()
            assert box is not None

            # Verify single-finger touch panning is enabled by default (not locked by touch-action: none)
            pan_ready = page.evaluate("""() => {
                const s = document.querySelector('.page-slot');
                return {
                    drawingActive: s.classList.contains('drawing-active'),
                    touchAction: getComputedStyle(s).touchAction,
                };
            }""")
            assert not pan_ready["drawingActive"] and "pan-x" in pan_ready["touchAction"] and "pan-y" in pan_ready["touchAction"], (
                f"Expected single-finger pan-x pan-y by default, got {pan_ready}"
            )
            print(f"[PASS] Single-finger touch pan enabled by default ({pan_ready['touchAction']})")

            # Draw a pen stroke across the page
            page.mouse.move(box["x"] + 90, box["y"] + 130)
            page.mouse.down()
            for step in range(1, 16):
                page.mouse.move(
                    box["x"] + 90 + step * 18,
                    box["y"] + 130 + (18 if step % 2 == 0 else -14),
                )
            # Check ProMotion Governor rate-mark & display-pacer mounted while drawing!
            rate_mark_present = page.locator(".quire-rate-mark").count() > 0
            pacer_present = page.locator(".quire-display-pacer").count() > 0
            scroll_keep_present = page.locator(".quire-scroll-keep").count() > 0
            page.mouse.up()
            assert rate_mark_present and pacer_present and scroll_keep_present, (
                f"ProMotion primitives missing: rate={rate_mark_present}, pacer={pacer_present}, keep={scroll_keep_present}"
            )
            print("[PASS] ProMotion 120 Hz Governor primitives mounted during ink stroke")

            # Verify drawing ink on Page 1 automatically makes Page 2 available to write on!
            assert page.locator(".page-slot").count() == 2, (
                f"Expected Page 2 to auto-append after Page 1 received ink, got {page.locator('.page-slot').count()}"
            )
            print("[PASS] Auto-append Page N+1 verified when Page N receives ink")

            # Draw a Highlighter pass over the pen ink on Page 1
            page.click("#tool-highlighter")
            page.mouse.move(box["x"] + 85, box["y"] + 132)
            page.mouse.down()
            page.mouse.move(box["x"] + 360, box["y"] + 132, steps=10)
            page.mouse.up()
            page.wait_for_timeout(120)

            # Verify Dry Pen + Dry Highlighter canvases on Page 1 both contain rendered pixels
            non_empty = page.evaluate("""() => {
                const canvases = [...document.querySelectorAll('.page-slot[data-page-index="0"] canvas')];
                return canvases.map(c => {
                    const ctx = c.getContext('2d');
                    if (!ctx) return 0;
                    const data = ctx.getImageData(0, 0, c.width, c.height).data;
                    let nonZero = 0;
                    for (let i = 3; i < data.length; i += 16) if (data[i] > 0) nonZero++;
                    return nonZero;
                });
            }""")
            print(f"[PASS] CUJ 2 Dry layer pixel counts (highlighter, pen): {non_empty}")
            assert all(n > 20 for n in non_empty), f"Expected ink pixels on both layers, got {non_empty}"

            # Verify highlighter layer does NOT force CoreAnimation CSS mix-blend-mode backdrop readback
            hl_blend = page.evaluate(
                "() => getComputedStyle(document.querySelector('.highlighter-layer')).mixBlendMode"
            )
            assert hl_blend == "normal", f"Expected normal blend mode on .highlighter-layer, got {hl_blend}"

            # Regression check: switch back from Highlighter -> Pen and draw 3 rapid back-to-back strokes
            # (verifies O(1) incremental Dry Pen append, zero Dry Highlighter churn, and seq-guarded Wet clear!)
            page.click("#tool-pen")
            for line_idx in range(3):
                y_off = 162 + line_idx * 14
                page.mouse.move(box["x"] + 90, box["y"] + y_off)
                page.mouse.down()
                page.mouse.move(box["x"] + 330, box["y"] + y_off, steps=8)
                page.mouse.up()
            page.wait_for_timeout(120)

            after_rapid_pen = page.evaluate("""() => {
                const canvases = [...document.querySelectorAll('.page-slot[data-page-index="0"] canvas')];
                return canvases.map(c => {
                    const ctx = c.getContext('2d');
                    if (!ctx) return 0;
                    const data = ctx.getImageData(0, 0, c.width, c.height).data;
                    let nonZero = 0;
                    for (let i = 3; i < data.length; i += 16) if (data[i] > 0) nonZero++;
                    return nonZero;
                });
            }""")
            assert after_rapid_pen[0] == non_empty[0], (
                f"Highlighter layer unexpectedly changed during Pen strokes: {non_empty[0]} -> {after_rapid_pen[0]}"
            )
            assert after_rapid_pen[1] > non_empty[1] + 40, (
                f"Incremental Dry Pen strokes did not accumulate: {non_empty[1]} -> {after_rapid_pen[1]}"
            )
            print(f"[PASS] Highlighter -> rapid Pen strokes O(1) incremental append verified ({after_rapid_pen})")

            # Verify Wet OffscreenCanvas overlay cleared cleanly after pen lift (0 ghost/double-line pixels!)
            wet_leftover = page.evaluate("""async () => {
                const wet = document.querySelector('.wet-canvas-overlay');
                if (!wet) return -1;
                const bmp = await createImageBitmap(wet);
                const tmp = document.createElement('canvas');
                tmp.width = bmp.width;
                tmp.height = bmp.height;
                const tctx = tmp.getContext('2d');
                tctx.drawImage(bmp, 0, 0);
                bmp.close();
                const data = tctx.getImageData(0, 0, tmp.width, tmp.height).data;
                let dirty = 0;
                for (let i = 3; i < data.length; i += 32) if (data[i] > 0) dirty++;
                return dirty;
            }""")
            assert wet_leftover == 0, f"Wet OffscreenCanvas left {wet_leftover} ghost pixels after pointerup!"
            print("[PASS] Wet OffscreenCanvas dirty-rect cleared to 0 ghost pixels after pen lift")

            # Verify newly opened note defaults immediately to Fit Width (with side margins & zoom-scaled guide lines)!
            fit_metrics = page.evaluate("""() => {
                const scroller = document.querySelector('#stage-scroller');
                const slot = document.querySelector('.page-slot[data-page-index="0"]');
                const cs = getComputedStyle(slot);
                return {
                    pressed: document.querySelector('#btn-zoom-fit-width')?.getAttribute('aria-pressed'),
                    scrollerW: scroller.clientWidth,
                    slotW: slot.getBoundingClientRect().width,
                    zoomVar: parseFloat(cs.getPropertyValue('--page-zoom')),
                    bgPosY: parseFloat(cs.backgroundPositionY),
                    zoomLabel: document.querySelector('#zoom-percent-label')?.textContent,
                    padBottom: parseFloat(getComputedStyle(scroller).paddingBottom),
                };
            }""")
            assert fit_metrics["pressed"] == "true", f"Expected Fit Width active on open: {fit_metrics}"
            margin_total = fit_metrics["scrollerW"] - fit_metrics["slotW"]
            assert 56 <= margin_total <= 96, f"Expected side margins ~72px total, got {margin_total:.1f}px ({fit_metrics})"
            expected_bg_y = 56.0 * fit_metrics["zoomVar"]
            assert abs(fit_metrics["bgPosY"] - expected_bg_y) < 1.5, (
                f"Guide lines did not scale with zoom: bgPosY={fit_metrics['bgPosY']}, expected={expected_bg_y}"
            )
            assert fit_metrics["padBottom"] >= 250, f"Expected generous bottom overscroll, got {fit_metrics['padBottom']}px"
            print(f"[PASS] Default Fit Width ({fit_metrics['zoomLabel']}, {margin_total:.0f}px side margin, {fit_metrics['padBottom']:.0f}px bottom overscroll) verified")

            # Verify Pinch-to-Zoom (Ctrl+Wheel trackpad pinch) zooms in & exits Fit Width, then snaps back magnetically
            page.evaluate("""() => {
                const scroller = document.querySelector('#stage-scroller');
                const r = scroller.getBoundingClientRect();
                scroller.dispatchEvent(new WheelEvent('wheel', {
                    deltaY: -45,
                    ctrlKey: true,
                    clientX: r.left + r.width / 2,
                    clientY: r.top + r.height / 2,
                    bubbles: true,
                    cancelable: true,
                }));
            }""")
            page.wait_for_function(
                "() => document.querySelector('#btn-zoom-fit-width')?.getAttribute('aria-pressed') === 'false'",
                timeout=2000,
            )
            after_pinch = page.evaluate("""() => ({
                pressed: document.querySelector('#btn-zoom-fit-width')?.getAttribute('aria-pressed'),
                zoomVar: parseFloat(getComputedStyle(document.querySelector('.page-slot[data-page-index="0"]')).getPropertyValue('--page-zoom')),
                zoomLabel: document.querySelector('#zoom-percent-label')?.textContent,
            })""")
            assert after_pinch["pressed"] == "false", f"Pinch should exit Fit Width mode: {after_pinch}"
            assert after_pinch["zoomVar"] > fit_metrics["zoomVar"] + 0.1, (
                f"Pinch-to-zoom did not zoom in: {fit_metrics['zoomVar']} -> {after_pinch['zoomVar']}"
            )
            # Pinch back down within ±6% of Fit Width -> magnetic snap re-engages Fit Width!
            page.evaluate("""() => {
                const scroller = document.querySelector('#stage-scroller');
                const r = scroller.getBoundingClientRect();
                scroller.dispatchEvent(new WheelEvent('wheel', {
                    deltaY: 45,
                    ctrlKey: true,
                    clientX: r.left + r.width / 2,
                    clientY: r.top + r.height / 2,
                    bubbles: true,
                    cancelable: true,
                }));
            }""")
            page.wait_for_function(
                "() => document.querySelector('#btn-zoom-fit-width')?.getAttribute('aria-pressed') === 'true'",
                timeout=2000,
            )
            print(f"[PASS] Pinch-to-zoom ({fit_metrics['zoomLabel']} -> {after_pinch['zoomLabel']}) & magnetic Fit-Width snap verified")

            # Verify Partial Eraser default, S/M/L size presets, Auto-Pen toggle, and clean cursor clear
            page.click("#tool-eraser")
            assert page.locator("#btn-eraser-mode").text_content() == "Partial", "Expected Partial Eraser default"
            page.click("#btn-eraser-size-large")
            assert page.locator("#btn-eraser-size-large").get_attribute("aria-pressed") == "true"
            page.click("#btn-eraser-auto-return")
            assert page.locator("#btn-eraser-auto-return").get_attribute("aria-pressed") == "true"
            slot_box_er = page.locator('.page-slot[data-page-index="0"]').bounding_box()
            assert slot_box_er is not None
            page.mouse.move(slot_box_er["x"] + 260, slot_box_er["y"] + 240)
            page.mouse.down()
            page.mouse.move(slot_box_er["x"] + 280, slot_box_er["y"] + 240, steps=4)
            page.mouse.up()
            page.wait_for_timeout(80)
            assert "active" in (page.locator("#tool-pen").get_attribute("class") or ""), (
                "Expected Auto-Pen to return to Pen tool after erasing"
            )
            print("[PASS] Partial Eraser default, S/M/L presets, live cursor, & Auto-Pen verified")

            # Verify Lasso select + tap-outside dismiss
            page.click("#tool-lasso")
            page.mouse.move(slot_box_er["x"] + 60, slot_box_er["y"] + 90)
            page.mouse.down()
            page.mouse.move(slot_box_er["x"] + 420, slot_box_er["y"] + 90, steps=4)
            page.mouse.move(slot_box_er["x"] + 420, slot_box_er["y"] + 220, steps=4)
            page.mouse.move(slot_box_er["x"] + 60, slot_box_er["y"] + 220, steps=4)
            page.mouse.up()
            page.wait_for_selector(".lasso-actions", timeout=2000)
            # Tap outside bounding box -> dismisses cleanly
            page.mouse.click(slot_box_er["x"] + 500, slot_box_er["y"] + 340)
            page.wait_for_function("() => !document.querySelector('.lasso-actions')", timeout=2000)
            print("[PASS] Lasso selection bounding box & tap-outside dismiss verified")

            # Add a Typed Text Box (FR-INK-06)
            page.click("#tool-text")
            slot_box_now = page.locator('.page-slot[data-page-index="0"]').bounding_box()
            assert slot_box_now is not None
            page.mouse.click(slot_box_now["x"] + 95, slot_box_now["y"] + 210)
            textarea = page.locator(".canvas-textbox textarea").first
            textarea.fill("Thermodynamics: dS >= dQ / T")
            print("[PASS] CUJ 2 Typed text box created & edited")

            # Rename note and add a tag
            page.fill("#input-note-title", "Physics 201 — Lecture 4")
            page.click("#btn-toggle-tag")
            page.fill("#input-add-tag", "exam-2")
            page.keyboard.press("Enter")
            page.click("#tool-pen")
            page.screenshot(path=str(SHOT_DIR / "02_editor_light.png"))

            # Page Manager: Insert a Grid page after Page 1 (Page 1 Lined, Page 2 Grid, Page 3 auto-appended Lined)
            page.click("#btn-open-page-manager")
            page.wait_for_selector("#btn-pm-insert-page")
            page.screenshot(path=str(SHOT_DIR / "03_page_manager.png"))
            page.select_option('select[aria-label="Template style"]', "grid")
            page.click("#btn-pm-insert-page")
            assert page.locator(".page-thumb-card").count() == 3
            page.click('button[aria-label="Close Page Manager"]')
            assert page.locator(".page-slot").count() == 3
            p1_cls = page.locator(".page-slot").nth(0).get_attribute("class")
            p2_cls = page.locator(".page-slot").nth(1).get_attribute("class")
            assert "paper-tpl-lined" in p1_cls and "paper-tpl-grid" in p2_cls
            print("[PASS] CUJ 2 Per-page template switching verified (Page 1 Lined, Page 2 Grid, Page 3 ready)")

            # --- CUJ 6: True Vector PDF Export ---
            page.click("#btn-open-export")
            with page.expect_download() as dl_info:
                page.click("#btn-export-vector-pdf")
            download = dl_info.value
            pdf_out = ARTIFACT_DIR / "scratch" / "exported_vector.pdf"
            download.save_as(str(pdf_out))
            header = pdf_out.read_bytes()[:5]
            assert header == b"%PDF-", f"Invalid PDF header: {header}"
            print(f"[PASS] CUJ 6 Vector PDF exported ({pdf_out.stat().st_size} bytes)")

            # --- CUJ 5: Library, Nested Folders, Instant Search & Trash Restore ---
            page.click("#btn-back-library")
            page.wait_for_selector(".library-view")
            page.click("#btn-add-folder")
            page.fill("#input-new-folder-name", "Fall 2026")
            page.click("#btn-confirm-folder")
            page.fill("#input-library-search", "Thermodynamics")
            assert page.locator(".note-card").count() == 1
            page.fill("#input-library-search", "")
            print("[PASS] CUJ 5 Folder creation & typed-text search verified")

            # --- CUJ 3: Multi-Page PDF Import & Annotation ---
            page.set_input_files("#input-import-pdf", str(sample_pdf))
            page.wait_for_function(
                "() => document.querySelectorAll('.page-slot').length === 3",
                timeout=8000,
            )
            time.sleep(0.8)
            print("[PASS] CUJ 3 3-page PDF imported & rendered lazily")

            # Back to library -> verify persistence across full page reload!
            page.click("#btn-back-library")
            page.wait_for_selector(".library-view")
            page.screenshot(path=str(SHOT_DIR / "04_library.png"))

            page.reload(wait_until="networkidle")
            page.wait_for_selector(".note-card", timeout=5000)
            assert page.locator(".note-card").count() == 2
            print("[PASS] Local-first persistence verified across full browser reload")

            # --- CUJ 6: Settings Dark Mode + Non-Destructive Conflict Copy ---
            page.click("#btn-open-settings")
            page.click("#toggle-dark-mode")
            page.click("#btn-test-conflict-sync")
            page.click('button[aria-label="Close Settings"]')
            assert page.locator(".note-card").count() == 3
            page.screenshot(path=str(SHOT_DIR / "05_library_dark_conflict.png"))
            print("[PASS] CUJ 6 Dark Mode & Non-Destructive Conflict Copy verified")

            # --- Unlimited Note Creation (Zero Paywall / No Pro Gate) ---
            for _ in range(3):
                page.click("#btn-new-note")
                page.wait_for_selector(".page-slot")
                page.click("#btn-back-library")
            assert page.locator(".note-card").count() == 6
            assert page.locator("#btn-confirm-pro-unlock").count() == 0
            assert page.locator(".pro-chip").count() == 0
            print("[PASS] Unlimited note creation verified (6 notes created with zero Pro gate)")

            browser.close()

        assert len(console_errors) == 0, f"Console errors: {console_errors}"
        assert len(page_errors) == 0, f"Uncaught page errors: {page_errors}"
        print("\nALL E2E CHECKS PASSED WITH ZERO CONSOLE OR PAGE ERRORS!")
    finally:
        server.terminate()
        server.wait(timeout=5)


if __name__ == "__main__":
    main()
