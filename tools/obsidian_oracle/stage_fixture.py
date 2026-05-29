from __future__ import annotations

import argparse
import json
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any


TOOL_DIR = Path(__file__).resolve().parent
REPO_ROOT = TOOL_DIR.parents[1]
CONFIG_PATH = TOOL_DIR / "oracle_config.json"
FIXTURES_DIR = REPO_ROOT / "tests" / "fixtures"
CONVERTER_DIR = REPO_ROOT / "Json_2_Canvas"

sys.path.insert(0, str(CONVERTER_DIR))

from Converter import convert_miro_to_canvas  # noqa: E402


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8-sig") as f:
        return json.load(f)


def load_config() -> dict[str, Any]:
    return load_json(CONFIG_PATH)


def fixture_dir(name: str) -> Path:
    path = FIXTURES_DIR / name
    if not (path / "input.miro.json").exists():
        raise SystemExit(f"Fixture does not exist or has no input.miro.json: {path}")
    return path


def stage_fixture(name: str) -> Path:
    config = load_config()
    fixture = fixture_dir(name)
    manifest = load_json(fixture / "case.json")
    converter_cfg = manifest.get("converter", {})

    vault_root = Path(config["vault_path"])
    target_dir = vault_root / config["work_folder"] / config.get("oracle_subfolder", "_oracle") / name
    target_dir.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix=f"miro2obs_oracle_{name}_") as tmp:
        work_dir = Path(tmp)
        input_path = work_dir / "input.miro.json"
        shutil.copy2(fixture / "input.miro.json", input_path)

        src_files = fixture / "input.miro_files"
        if src_files.exists():
            shutil.copytree(src_files, work_dir / "input.miro_files")

        canvas_path = convert_miro_to_canvas(
            str(input_path),
            str(target_dir),
            str(vault_root),
            scale=float(converter_cfg.get("scale", 1.0)),
            min_font_px=int(converter_cfg.get("min_font_px", 8)),
            theme=str(converter_cfg.get("theme", "dark")),
        )

    return Path(canvas_path)


def main() -> int:
    parser = argparse.ArgumentParser(description="Stage a fixture canvas into the Obsidian oracle vault.")
    parser.add_argument("fixture", help="Fixture directory name under tests/fixtures")
    args = parser.parse_args()

    canvas_path = stage_fixture(args.fixture)
    print(canvas_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

