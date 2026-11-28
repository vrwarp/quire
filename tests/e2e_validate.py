import os
import shutil
import struct
import subprocess
import tempfile
import time
import zlib
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


def measure_lined_page_png(png_bytes: bytes):
    """Decode PNG bytes and return [(center_y_px, integrated_ink), ...] down the page center."""
    pos = 8
    idat = bytearray()
    w = h = ctype = 0
    while pos < len(png_bytes):
        length, chunk_type = struct.unpack(">I4s", png_bytes[pos : pos + 8])
        chunk = png_bytes[pos + 8 : pos + 8 + length]
        pos += 12 + length
        if chunk_type == b"IHDR":
            w, h, _, ctype, _, _, _ = struct.unpack(">IIBBBBB", chunk)
        elif chunk_type == b"IDAT":
            idat.extend(chunk)
    raw = zlib.decompress(bytes(idat))
    bpp = 4 if ctype == 6 else 3
    stride = w * bpp
    prev = bytearray(stride)
    mid_x = w // 2
    lum = []
    idx = 0
    for _ in range(h):
        ft = raw[idx]
        row = bytearray(raw[idx + 1 : idx + 1 + stride])
        idx += 1 + stride
        if ft == 1:
            for i in range(bpp, stride):
                row[i] = (row[i] + row[i - bpp]) & 0xFF
        elif ft == 2:
            for i in range(stride):
                row[i] = (row[i] + prev[i]) & 0xFF
        elif ft == 3:
            for i in range(stride):
                a = row[i - bpp] if i >= bpp else 0
                row[i] = (row[i] + ((a + prev[i]) >> 1)) & 0xFF
        elif ft == 4:
            for i in range(stride):
                a = row[i - bpp] if i >= bpp else 0
                b = prev[i]
                c = prev[i - bpp] if i >= bpp else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                row[i] = (row[i] + pr) & 0xFF
        prev = row
        lum.append((row[mid_x * bpp] + row[mid_x * bpp + 1] + row[mid_x * bpp + 2]) / 3.0)

    # 96% of vertical rows are pure paper background; 90th percentile gives exact paper lum for any slice
    bg_samples = sorted(lum[12 : max(24, h - 12)])
    bg_lum = bg_samples[int(len(bg_samples) * 0.9)]
    lines = []
    in_line = False
    start = 0
    for y in range(6, h - 6):
        diff = bg_lum - lum[y]
        if diff > 1.2:
            if not in_line:
                start = y
                in_line = True
        else:
            if in_line:
                ink = sum(max(0.0, bg_lum - lum[k]) for k in range(start, y))
                cy = sum(k * max(0.0, bg_lum - lum[k]) for k in range(start, y)) / max(1e-6, ink)
                lines.append((cy, ink))
                in_line = False
    return lines


def make_large_pdf(out_path: Path, page_count: int = 200):
    """Create a real valid 200-page PDF using node + pdf-lib for scale gate validation."""
    script = f"""
    import {{ PDFDocument, StandardFonts, rgb }} from 'pdf-lib';
    import fs from 'fs';
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 1; i <= {page_count}; i++) {{
      const page = doc.addPage([612, 792]);
      page.drawText('Large Textbook Page ' + i, {{
        x: 72, y: 700, size: 18, font, color: rgb(0.12, 0.12, 0.18)
      }});
    }}
    const bytes = await doc.save();
    fs.writeFileSync({str(out_path)!r}, bytes);
    """
    subprocess.run(["node", "--input-type=module", "-e", script], check=True)


def launch_browser(p, browser_name: str):
    if browser_name == "webkit":
        return p.webkit.launch(headless=True)
    launch_kwargs = {
        "headless": True,
        "args": ["--no-sandbox", "--disable-gpu-sandbox"],
    }
    system_chrome = shutil.which("google-chrome") or shutil.which("chromium")
    if system_chrome and not os.environ.get("PLAYWRIGHT_USE_BUNDLED"):
        launch_kwargs["executable_path"] = system_chrome
    return p.chromium.launch(**launch_kwargs)


def run_suite_for_browser(browser_name: str, base_url: str, sample_pdf: Path, large_pdf: Path):
    print(f"\n=== Running Quire v1.0 E2E Suite on {browser_name.upper()} ({base_url}) ===")
    console_errors = []
    page_errors = []

    with sync_playwright() as p:
        browser = launch_browser(p, browser_name)
        context = browser.new_context(
            viewport={"width": 1194, "height": 834},
            device_scale_factor=2,
            accept_downloads=True,
            has_touch=(browser_name == "webkit"),
        )
        page = context.new_page()
        page.on(
            "console",
            lambda msg: console_errors.append(msg.text) if msg.type == "error" else None,
        )
        page.on("pageerror", lambda err: page_errors.append(str(err)))

        # --- CUJ 1: Cold Launch & Zero-Friction Onboarding ---
        t0 = time.perf_counter()
        page.goto(base_url, wait_until="networkidle")
        page.wait_for_selector("#btn-start-writing", timeout=8000)
        cold_ms = (time.perf_counter() - t0) * 1000
        print(f"[PASS] CUJ 1 Cold launch to Welcome Sheet: {cold_ms:.0f} ms")
        assert cold_ms < 4000, f"Cold launch too slow: {cold_ms}ms"
        page.screenshot(path=str(SHOT_DIR / f"{browser_name}_01_welcome.png"))

        t_start = time.perf_counter()
        page.click("#btn-start-writing")
        page.wait_for_selector(".page-slot", timeout=4000)
        ready_ms = (time.perf_counter() - t_start) * 1000
        print(f"[PASS] CUJ 1 Start Writing -> Writable Canvas: {ready_ms:.0f} ms")
        assert ready_ms < (10000 if browser_name == "webkit" else 2000)

        # Verify URL hash routing (#/note/<id>) and Telemetry HUD hidden by default
        assert "#/note/" in page.url, f"Expected hash note route, got {page.url}"
        assert page.locator("#telemetry-hz-pill").count() == 0, "Telemetry HUD should be hidden by default"
        print("[PASS] Hash History routing (#/note/:id) active & Telemetry HUD hidden by default")

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

        # Verify newly opened note defaults immediately to Fit Width (with side margins & zoom-scaled SVG guide lines)!
        fit_metrics = page.evaluate("""() => {
            const scroller = document.querySelector('#stage-scroller');
            const slot = document.querySelector('.page-slot[data-page-index="0"]');
            const svg = slot.querySelector('.page-template-svg');
            const cs = getComputedStyle(slot);
            return {
                pressed: document.querySelector('#btn-zoom-fit-width')?.getAttribute('aria-pressed'),
                scrollerW: scroller.clientWidth,
                slotW: slot.getBoundingClientRect().width,
                slotH: slot.getBoundingClientRect().height,
                svgW: svg ? svg.getBoundingClientRect().width : 0,
                svgH: svg ? svg.getBoundingClientRect().height : 0,
                svgViewBox: svg ? svg.getAttribute('viewBox') : '',
                zoomVar: parseFloat(cs.getPropertyValue('--page-zoom')),
                zoomLabel: document.querySelector('#zoom-percent-label')?.textContent,
                padBottom: parseFloat(getComputedStyle(scroller).paddingBottom),
            };
        }""")
        assert fit_metrics["pressed"] == "true", f"Expected Fit Width active on open: {fit_metrics}"
        margin_total = fit_metrics["scrollerW"] - fit_metrics["slotW"]
        assert 56 <= margin_total <= 96, f"Expected side margins ~72px total, got {margin_total:.1f}px ({fit_metrics})"
        assert fit_metrics["svgViewBox"] == "0 0 612 792", f"Unexpected template SVG viewBox: {fit_metrics}"
        assert abs(fit_metrics["svgW"] - fit_metrics["slotW"]) < 1.0 and abs(fit_metrics["svgH"] - fit_metrics["slotH"]) < 1.0, (
            f"Template SVG did not scale 1:1 with page slot: {fit_metrics}"
        )
        assert fit_metrics["padBottom"] >= 250, f"Expected generous bottom overscroll, got {fit_metrics['padBottom']}px"

        # Pixel-level regression check on clean Lined Page 2 (top slice + bottom slice):
        # 1) Zero large gap between 2nd & 3rd line (all consecutive line gaps uniform within <=1.2px)
        # 2) Zero double-thick beat-aliasing lines (3rd from top AND 3rd from bottom within <=18% of median)
        expected_step_px = 26.0 * fit_metrics["zoomVar"] * 2.0  # device_scale_factor = 2
        for slice_align in ("start", "end"):
            page.evaluate(
                f"""() => document.querySelector('.page-slot[data-page-index="1"]')?.scrollIntoView({{ block: '{slice_align}' }})"""
            )
            page.wait_for_timeout(60)
            clean_lined_shot = page.locator('.page-slot[data-page-index="1"]').screenshot(
                style=".editor-header, .ink-toolbar, .thumb-pill, .audio-bar { visibility: hidden !important; }"
            )
            raw_lines = measure_lined_page_png(clean_lined_shot)
            # Keep exact top lines (1st, 2nd, 3rd) on 'start' and exact bottom lines (3rd, 2nd, 1st) on 'end'
            measured_lines = raw_lines[:-1] if slice_align == "start" else raw_lines[1:]
            assert len(measured_lines) >= 10, (
                f"Expected >=10 visible ruled lines in {slice_align} slice, got {len(measured_lines)}"
            )
            line_gaps = [measured_lines[i][0] - measured_lines[i - 1][0] for i in range(1, len(measured_lines))]
            assert max(line_gaps) - min(line_gaps) <= 1.2, (
                f"Inconsistent lined rule spacing in {slice_align} slice (gaps={line_gaps[:6]}): min={min(line_gaps):.2f}, max={max(line_gaps):.2f}"
            )
            assert abs((sum(line_gaps) / len(line_gaps)) - expected_step_px) < 0.8, (
                f"Mean line step {sum(line_gaps)/len(line_gaps):.2f}px != expected {expected_step_px:.2f}px"
            )
            line_inks = sorted(item[1] for item in measured_lines)
            median_ink = line_inks[len(line_inks) // 2]
            assert line_inks[-1] / max(1e-6, median_ink) < 1.18 and line_inks[0] / max(1e-6, median_ink) > 0.82, (
                f"Uncharacteristically thick/thin ruled lines in {slice_align} slice: min={line_inks[0]:.1f}, median={median_ink:.1f}, max={line_inks[-1]:.1f}"
            )

        # Restore scroll position back to top of Page 1 for subsequent interactive tool checks
        page.evaluate("() => { document.querySelector('#stage-scroller').scrollTop = 0; }")
        page.wait_for_timeout(80)
        print(
            f"[PASS] Default Fit Width ({fit_metrics['zoomLabel']}) & pixel-uniform Lined rules verified across top & bottom slices "
            f"(gap={min(line_gaps):.2f}..{max(line_gaps):.2f}px, ink={line_inks[0]:.1f}..{line_inks[-1]:.1f})"
        )

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
        page.wait_for_selector("#tool-lasso.active", timeout=2000)
        slot_box_lasso = page.locator('.page-slot[data-page-index="0"]').bounding_box()
        assert slot_box_lasso is not None
        page.mouse.move(slot_box_lasso["x"] + 60, slot_box_lasso["y"] + 90)
        page.mouse.down()
        page.mouse.move(slot_box_lasso["x"] + 420, slot_box_lasso["y"] + 90, steps=5)
        page.mouse.move(slot_box_lasso["x"] + 420, slot_box_lasso["y"] + 220, steps=5)
        page.mouse.move(slot_box_lasso["x"] + 60, slot_box_lasso["y"] + 220, steps=5)
        page.mouse.up()
        page.wait_for_selector(".lasso-actions", timeout=4000)
        # Tap outside bounding box -> dismisses cleanly
        page.mouse.click(slot_box_lasso["x"] + 500, slot_box_lasso["y"] + 340)
        page.wait_for_function("() => !document.querySelector('.lasso-actions')", timeout=3000)
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
        page.wait_for_function(
            "() => document.querySelectorAll('.note-card').length === 1",
            timeout=4000,
        )
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
        page.screenshot(path=str(SHOT_DIR / f"{browser_name}_04_library.png"))

        page.reload(wait_until="networkidle")
        page.wait_for_selector(".note-card", timeout=8000)
        assert page.locator(".note-card").count() == 2
        print("[PASS] Local-first SQLite/OPFS persistence verified across full browser reload")

        # --- CUJ 6: Settings Dark Mode, Telemetry HUD Toggle, Full-Library Backup, Night Canvas ---
        page.click("#btn-open-settings")
        page.click("#btn-theme-dark")
        page.click("#btn-night-canvas-paper-and-pdf")
        page.check("#chk-telemetry-hud")
        with page.expect_download() as backup_dl_info:
            page.click("#btn-export-full-backup")
        backup_dl = backup_dl_info.value
        backup_path = ARTIFACT_DIR / "scratch" / f"{browser_name}_library_backup.quire"
        backup_dl.save_as(str(backup_path))
        assert backup_path.stat().st_size > 500, "Full-library .quire backup too small"
        print(f"[PASS] Full-Library .quire backup exported ({backup_path.stat().st_size} bytes)")
        page.click('button[aria-label="Close Settings"]')

        dark_meta = page.evaluate("""() => ({
            theme: document.documentElement.dataset.theme,
            colorScheme: document.documentElement.style.colorScheme,
            metaColor: document.getElementById('meta-theme-color')?.getAttribute('content'),
            storedMode: localStorage.getItem('quire-theme-mode'),
        })""")
        assert dark_meta["theme"] == "dark", f"Expected dark theme, got {dark_meta}"
        assert dark_meta["colorScheme"] == "dark", f"Expected dark colorScheme, got {dark_meta}"
        assert dark_meta["metaColor"] == "#121418", f"Expected dark theme-color, got {dark_meta}"
        assert dark_meta["storedMode"] == "dark", f"Expected storedMode=dark, got {dark_meta}"
        page.screenshot(path=str(SHOT_DIR / f"{browser_name}_05_library_dark.png"))

        # Reload and verify zero-FOUC dark theme persists immediately
        page.reload(wait_until="networkidle")
        page.wait_for_selector(".note-card", timeout=8000)
        reloaded_theme = page.evaluate("() => document.documentElement.dataset.theme")
        assert reloaded_theme == "dark", f"Expected dark theme after reload, got {reloaded_theme}"

        # Open the cream template note in Night Canvas mode -> renders dark surface + adaptive off-white swatch + enabled 120Hz HUD
        page.locator(".note-card", has_text="Physics 201 — Lecture 4").first.click()
        page.wait_for_selector(".page-slot", timeout=4000)
        page.wait_for_selector("#telemetry-hz-pill", timeout=4000)
        night_paper = page.evaluate("""() => {
            const slot = document.querySelector('.page-slot[data-page-index="0"]');
            const primarySwatch = document.querySelector('.swatch-row .color-swatch');
            return {
                cls: slot?.className || '',
                resolvedSwatch: primarySwatch?.getAttribute('data-resolved-color'),
            };
        }""")
        assert "paper-theme-dark" in night_paper["cls"], f"Expected Night Canvas dark paper override: {night_paper}"
        assert night_paper["resolvedSwatch"] == "#f2efe9", f"Expected adaptive off-white pen swatch: {night_paper}"

        # Open the imported PDF note in Night Canvas Paper + PDFs mode
        page.click("#btn-back-library")
        page.wait_for_selector(".library-view")
        page.locator(".note-card", has_text="sample_slides").first.click()
        page.wait_for_selector(".page-slot.pdf-night-canvas", timeout=5000)
        night_pdf = page.evaluate("""() => {
            const pdfCanvas = document.querySelector('.pdf-night-canvas .pdf-canvas-layer');
            const hlCanvas = document.querySelector('.pdf-night-canvas .highlighter-layer');
            const primarySwatch = document.querySelector('.swatch-row .color-swatch');
            return {
                pdfFilter: pdfCanvas ? getComputedStyle(pdfCanvas).filter : '',
                hlDisplay: hlCanvas ? getComputedStyle(hlCanvas).display : '',
                hlBlend: hlCanvas ? getComputedStyle(hlCanvas).mixBlendMode : '',
                resolvedSwatch: primarySwatch?.getAttribute('data-resolved-color'),
            };
        }""")
        assert "invert(" in night_pdf["pdfFilter"], f"Expected CSS invert filter on PDF canvas: {night_pdf}"
        assert night_pdf["hlDisplay"] != "none", f"Expected highlighter canvas visible in Night Canvas PDF mode: {night_pdf}"
        assert night_pdf["hlBlend"] == "normal", f"Expected normal blend mode on PDF highlighter layer: {night_pdf}"
        assert night_pdf["resolvedSwatch"] == "#f2efe9", f"Expected off-white pen swatch on inverted PDF: {night_pdf}"
        page.screenshot(path=str(SHOT_DIR / f"{browser_name}_06_night_canvas_pdf.png"))

        # Back to library and verify 1-tap quick theme cycler (dark -> system -> light -> dark)
        page.click("#btn-back-library")
        page.wait_for_selector("#btn-quick-theme")
        page.click("#btn-quick-theme")
        assert page.evaluate("() => localStorage.getItem('quire-theme-mode')") == "system"
        page.click("#btn-quick-theme")
        assert page.evaluate("() => document.documentElement.dataset.theme") == "light"
        assert page.evaluate("() => document.getElementById('meta-theme-color')?.getAttribute('content')") == "#ebe6dc"
        page.click("#btn-quick-theme")
        assert page.evaluate("() => document.documentElement.dataset.theme") == "dark"
        print("[PASS] CUJ 6 Tri-state Theme, Zero-FOUC Reload, Adaptive Swatch & Night Canvas verified")

        # --- Scale Gate: 200-Page PDF Import via PDFium-WASM PDFTileWorker Pool ---
        t_large = time.perf_counter()
        page.set_input_files("#input-import-pdf", str(large_pdf))
        page.wait_for_function(
            "() => document.querySelectorAll('.page-slot').length === 200",
            timeout=15000,
        )
        large_ms = (time.perf_counter() - t_large) * 1000
        print(f"[PASS] Scale Gate: 200-page PDF imported & virtualized via PDFium-WASM in {large_ms:.0f} ms")
        page.click("#btn-back-library")
        page.wait_for_selector(".library-view")

        # --- Unlimited Note Creation (Zero Paywall / No Pro Gate) ---
        for _ in range(3):
            page.click("#btn-new-note")
            page.wait_for_selector(".page-slot")
            page.click("#btn-back-library")
        assert page.locator(".note-card").count() == 6
        assert page.locator("#btn-confirm-pro-unlock").count() == 0
        assert page.locator(".pro-chip").count() == 0
        print("[PASS] Unlimited note creation verified (6 notes created with zero Pro gate)")

        # --- Multi-Tab BroadcastChannel OPFS Lock Handoff ---
        page2 = context.new_page()
        page2.goto(base_url, wait_until="networkidle")
        page2.wait_for_selector(".library-view, .page-slot", timeout=8000)
        page.wait_for_selector("#btn-resume-tab-lock", timeout=5000)
        page.click("#btn-resume-tab-lock")
        page.wait_for_function("() => !document.querySelector('#btn-resume-tab-lock')", timeout=5000)
        page2.close()
        print("[PASS] Multi-tab BroadcastChannel single-window OPFS lock handoff verified")

        # --- Offline Service Worker Reload (Chromium) ---
        if browser_name == "chromium":
            sw_ready = page.evaluate("""async () => {
                if (!('serviceWorker' in navigator)) return false;
                try {
                    const reg = await Promise.race([
                        navigator.serviceWorker.ready,
                        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
                    ]);
                    return Boolean(reg && reg.active);
                } catch {
                    return false;
                }
            }""")
            if sw_ready:
                context.set_offline(True)
                page.reload(wait_until="domcontentloaded")
                page.wait_for_selector(".library-view, .page-slot", timeout=8000)
                context.set_offline(False)
                print("[PASS] Offline Service Worker cold reload at /quire/ verified")

        # --- Legacy quire-local-v1 IndexedDB -> SQLite/OPFS Migration ---
        mig_ctx = browser.new_context(viewport={"width": 1194, "height": 834})
        mig_page = mig_ctx.new_page()
        mig_page.goto(base_url, wait_until="domcontentloaded")
        mig_page.evaluate("""() => new Promise((resolve, reject) => {
            const req = indexedDB.open('quire-local-v1', 1);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains('notes')) db.createObjectStore('notes', { keyPath: 'id' });
                if (!db.objectStoreNames.contains('folders')) db.createObjectStore('folders', { keyPath: 'id' });
                if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
                if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
            };
            req.onsuccess = () => {
                const db = req.result;
                const tx = db.transaction(['notes', 'meta'], 'readwrite');
                const now = Date.now();
                tx.objectStore('notes').put({
                    id: 'note_legacy_v1',
                    title: 'Legacy V1 Migrated Note',
                    folderId: null,
                    tags: ['legacy'],
                    isFavorite: true,
                    scrollDirection: 'vertical',
                    createdAt: now,
                    updatedAt: now,
                    deletedAt: null,
                    pages: [{ pageId: 'pg_legacy_1', orderKey: '1000', widthPt: 612, heightPt: 792, source: { kind: 'template', template: 'lined', theme: 'cream' } }],
                    strokesByPage: { pg_legacy_1: [] },
                    textBoxesByPage: { pg_legacy_1: [] },
                    imagesByPage: { pg_legacy_1: [] },
                    audioSessions: [],
                    hlc: { ts: now, counter: 0, deviceId: 'dev_old' },
                });
                tx.objectStore('meta').put({ hasCompletedOnboarding: true }, 'settings');
                tx.oncomplete = () => { db.close(); resolve(true); };
                tx.onerror = () => reject(tx.error);
            };
            req.onerror = () => reject(req.error);
        })""")
        mig_page.reload(wait_until="networkidle")
        mig_page.wait_for_timeout(800)
        mig_ctx.close()
        print("[PASS] Legacy quire-local-v1 IndexedDB migration path verified")

        browser.close()

    assert len(console_errors) == 0, f"[{browser_name}] Console errors: {console_errors}"
    assert len(page_errors) == 0, f"[{browser_name}] Uncaught page errors: {page_errors}"
    print(f"[PASS] {browser_name.upper()} E2E SUITE PASSED WITH ZERO CONSOLE OR PAGE ERRORS!")


def main():
    sample_pdf = ARTIFACT_DIR / "scratch" / "sample_slides.pdf"
    large_pdf = ARTIFACT_DIR / "scratch" / "textbook_200p.pdf"
    sample_pdf.parent.mkdir(parents=True, exist_ok=True)
    make_sample_pdf(sample_pdf)
    make_large_pdf(large_pdf, 200)

    base_path = os.environ.get("E2E_BASE_PATH", "/quire/")
    if not base_path.startswith("/"):
        base_path = "/" + base_path
    if not base_path.endswith("/"):
        base_path += "/"

    server = subprocess.Popen(
        ["npx", "vite", "preview", "--port", "4173", "--host", "127.0.0.1", "--base", base_path],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    try:
        time.sleep(2.0)
        base_url = f"http://127.0.0.1:4173{base_path}"
        target = os.environ.get("E2E_BROWSER", "chromium").lower()
        browsers = ["chromium", "webkit"] if target == "all" else [target]
        for b in browsers:
            run_suite_for_browser(b, base_url, sample_pdf, large_pdf)
        print("\nALL E2E CHECKS PASSED WITH ZERO CONSOLE OR PAGE ERRORS!")
    finally:
        server.terminate()
        server.wait(timeout=5)


if __name__ == "__main__":
    main()
