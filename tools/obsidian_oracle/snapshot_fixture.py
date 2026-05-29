from __future__ import annotations

import argparse
import shutil
import time
from pathlib import Path

from PIL import Image, ImageChops, ImageGrab

from common import REPO_ROOT
from stage_fixture import stage_fixture


FIXTURES_DIR = REPO_ROOT / "tests" / "fixtures"
OUT_DIR = Path(__file__).resolve().parent / ".out"


def fixture_dir(name: str) -> Path:
    path = FIXTURES_DIR / name
    if not (path / "input.miro.json").exists():
        raise SystemExit(f"Fixture does not exist or has no input.miro.json: {path}")
    return path


def image_diff_ratio(expected: Path, actual: Path, pixel_tolerance: int) -> float:
    with Image.open(expected) as exp_img, Image.open(actual) as act_img:
        exp = exp_img.convert("RGBA")
        act = act_img.convert("RGBA")
        if exp.size != act.size:
            return 1.0

        diff = ImageChops.difference(exp, act)
        changed = 0
        total = exp.size[0] * exp.size[1]
        for pixel in diff.getdata():
            if max(pixel) > pixel_tolerance:
                changed += 1
        return changed / max(total, 1)


def capture_screen(path: Path, wait_seconds: float) -> None:
    if wait_seconds > 0:
        print(f"Waiting {wait_seconds:.1f}s before screen capture...")
        time.sleep(wait_seconds)

    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        image = ImageGrab.grab(all_screens=True)
    except OSError as exc:
        raise SystemExit(
            "Screen capture failed. Run this command from an interactive desktop session "
            "or pass --actual with an existing Obsidian screenshot."
        ) from exc
    image.save(path)


def compare_or_update(
    fixture: Path,
    actual_path: Path,
    *,
    update_baseline: bool,
    max_diff_ratio: float,
    pixel_tolerance: int,
) -> bool:
    expected_path = fixture / "expected.obsidian.png"

    if update_baseline:
        shutil.copy2(actual_path, expected_path)
        print(f"UPDATED {fixture.name}: {expected_path}")
        return True

    if not expected_path.exists():
        print(f"MISSING {fixture.name}: {expected_path} (run with --update-baseline)")
        return False

    ratio = image_diff_ratio(expected_path, actual_path, pixel_tolerance)
    if ratio > max_diff_ratio:
        print(
            f"FAIL {fixture.name}: Obsidian diff ratio {ratio:.6f} "
            f"> {max_diff_ratio:.6f}; actual={actual_path}"
        )
        return False

    print(f"OK {fixture.name}: Obsidian diff ratio {ratio:.6f}")
    return True


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Stage a fixture and compare/update its expected.obsidian.png oracle screenshot."
    )
    parser.add_argument("fixture", help="Fixture directory name under tests/fixtures")
    parser.add_argument("--actual", type=Path, help="Path to an existing Obsidian screenshot")
    parser.add_argument(
        "--capture-screen",
        action="store_true",
        help="Capture the current desktop screen after staging. Use from an interactive session.",
    )
    parser.add_argument("--wait-seconds", type=float, default=5.0)
    parser.add_argument("--update-baseline", action="store_true")
    parser.add_argument("--max-diff-ratio", type=float, default=0.001)
    parser.add_argument("--pixel-tolerance", type=int, default=0)
    args = parser.parse_args()

    fixture = fixture_dir(args.fixture)
    canvas_path = stage_fixture(args.fixture)
    print(f"STAGED {canvas_path}")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    actual_path = args.actual
    if args.capture_screen:
        actual_path = OUT_DIR / f"{fixture.name}.obsidian.png"
        print("Open the staged canvas in Obsidian before capture:")
        print(canvas_path)
        capture_screen(actual_path, args.wait_seconds)
        print(f"CAPTURED {actual_path}")

    if not actual_path:
        print("No screenshot provided. Use --actual <png> or --capture-screen.")
        print(f"Open in Obsidian: {canvas_path}")
        return 0

    ok = compare_or_update(
        fixture,
        actual_path,
        update_baseline=args.update_baseline,
        max_diff_ratio=args.max_diff_ratio,
        pixel_tolerance=args.pixel_tolerance,
    )
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())

