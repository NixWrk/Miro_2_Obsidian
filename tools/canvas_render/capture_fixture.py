from __future__ import annotations

import argparse
import json
import shutil
import tempfile
from pathlib import Path
from typing import Any

from PIL import Image, ImageChops
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright


TOOL_DIR = Path(__file__).resolve().parent
REPO_ROOT = TOOL_DIR.parents[1]
FIXTURES_DIR = REPO_ROOT / "tests" / "fixtures"
CONVERTER_DIR = REPO_ROOT / "Json_2_Canvas"
OUT_DIR = TOOL_DIR / ".out"

from Json_2_Canvas.Converter import convert_miro_to_canvas  # noqa: E402


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8-sig") as f:
        return json.load(f)


def fixture_dirs(selected: list[str] | None = None) -> list[Path]:
    if selected:
        dirs = [FIXTURES_DIR / name for name in selected]
    else:
        dirs = sorted(
            p for p in FIXTURES_DIR.iterdir()
            if p.is_dir() and (p / "input.miro.json").exists()
        )

    missing = [p for p in dirs if not (p / "input.miro.json").exists()]
    if missing:
        joined = ", ".join(str(p) for p in missing)
        raise SystemExit(f"Missing fixtures: {joined}")
    return dirs


def convert_fixture(fixture: Path, work_dir: Path) -> Path:
    input_path = work_dir / "input.miro.json"
    shutil.copy2(fixture / "input.miro.json", input_path)

    src_files = fixture / "input.miro_files"
    if src_files.exists():
        shutil.copytree(src_files, work_dir / "input.miro_files")

    vault_root = work_dir / "vault"
    target_dir = vault_root / "MIRO2OBSIDIAN"
    target_dir.mkdir(parents=True)

    manifest = load_json(fixture / "case.json")
    converter_cfg = manifest.get("converter", {})

    canvas_path = convert_miro_to_canvas(
        str(input_path),
        str(target_dir),
        str(vault_root),
        scale=float(converter_cfg.get("scale", 1.0)),
        min_font_px=int(converter_cfg.get("min_font_px", 8)),
        theme=str(converter_cfg.get("theme", "dark")),
        text_style_mode=str(converter_cfg.get("text_style_mode", "miro")),
    )
    return Path(canvas_path)


def capture_canvas(canvas_path: Path, screenshot_path: Path, *, fit_viewport: bool = False) -> None:
    index_url = (TOOL_DIR / "index.html").resolve().as_uri()
    screenshot_path.parent.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(
            viewport={"width": 1400, "height": 900},
            device_scale_factor=1,
        )
        try:
            page.goto(index_url)
            viewport = page.locator("#viewport")
            viewport_size = viewport.evaluate(
                "(element) => ({ width: element.clientWidth, height: element.clientHeight })"
            )
            viewport.evaluate(
                """
                (element, size) => {
                  element.style.width = `${size.width}px`;
                  element.style.height = `${size.height}px`;
                  element.style.overflow = "hidden";
                }
                """,
                viewport_size,
            )
            page.set_input_files("#canvas-file", str(canvas_path))
            page.wait_for_function(
                "document.body.dataset.renderStatus === 'ready'",
                timeout=5000,
            )
            if fit_viewport:
                page.evaluate(
                    """
                    () => {
                      const viewport = document.getElementById("viewport");
                      const stage = document.getElementById("stage");
                      const stageWidth = Math.max(1, Number.parseFloat(stage.style.width) || stage.scrollWidth);
                      const stageHeight = Math.max(1, Number.parseFloat(stage.style.height) || stage.scrollHeight);
                      const scale = Math.min(
                        1,
                        viewport.clientWidth / stageWidth,
                        viewport.clientHeight / stageHeight
                      );
                      stage.style.transformOrigin = "0 0";
                      stage.style.transform = `scale(${scale})`;
                      document.body.dataset.renderScale = String(scale);
                    }
                    """
                )
                viewport.screenshot(path=str(screenshot_path))
            else:
                page.locator("#stage").screenshot(path=str(screenshot_path))
        except PlaywrightTimeoutError as exc:
            state = page.locator("#messages").text_content(timeout=1000)
            raise RuntimeError(f"Renderer did not become ready. Message: {state}") from exc
        finally:
            browser.close()


def image_diff_ratio(expected: Path, actual: Path, pixel_tolerance: int) -> float:
    with Image.open(expected) as exp_img, Image.open(actual) as act_img:
        exp = exp_img.convert("RGBA")
        act = act_img.convert("RGBA")
        if exp.size != act.size:
            return 1.0

        diff = ImageChops.difference(exp, act)
        changed = 0
        total = exp.size[0] * exp.size[1]
        for pixel in diff.get_flattened_data():
            if max(pixel) > pixel_tolerance:
                changed += 1
        return changed / max(total, 1)


def check_fixture(
    fixture: Path,
    *,
    update_baseline: bool,
    max_diff_ratio: float,
    pixel_tolerance: int,
) -> bool:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    actual_path = OUT_DIR / f"{fixture.name}.render.png"
    expected_path = fixture / "expected.render.png"

    with tempfile.TemporaryDirectory(prefix=f"miro2obs_render_{fixture.name}_") as tmp:
        canvas_path = convert_fixture(fixture, Path(tmp))
        capture_canvas(canvas_path, actual_path, fit_viewport=True)

    if update_baseline:
        shutil.copy2(actual_path, expected_path)
        print(f"UPDATED {fixture.name}: {expected_path}")
        return True

    if not expected_path.exists():
        print(f"SKIP {fixture.name}: no visual baseline")
        return True

    ratio = image_diff_ratio(expected_path, actual_path, pixel_tolerance)
    if ratio > max_diff_ratio:
        print(
            f"FAIL {fixture.name}: render diff ratio {ratio:.6f} "
            f"> {max_diff_ratio:.6f}; actual={actual_path}"
        )
        return False

    print(f"OK {fixture.name}: render diff ratio {ratio:.6f}")
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description="Capture and compare diagnostic canvas-render screenshots.")
    parser.add_argument("fixtures", nargs="*", help="Fixture names. Defaults to all fixtures.")
    parser.add_argument("--all", action="store_true", help="Capture all fixtures.")
    parser.add_argument("--update-baseline", action="store_true", help="Overwrite expected.render.png baselines.")
    parser.add_argument("--max-diff-ratio", type=float, default=0.001)
    parser.add_argument("--pixel-tolerance", type=int, default=0)
    args = parser.parse_args()

    selected = None if args.all or not args.fixtures else args.fixtures
    ok = True
    for fixture in fixture_dirs(selected):
        ok = check_fixture(
            fixture,
            update_baseline=args.update_baseline,
            max_diff_ratio=args.max_diff_ratio,
            pixel_tolerance=args.pixel_tolerance,
        ) and ok
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
