from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[1]
PLUGIN_DIR = REPO_ROOT / "tools" / "obsidian_plugins" / "canvas-zoom-unlock"


def test_canvas_zoom_unlock_manifest_matches_folder() -> None:
    manifest = json.loads((PLUGIN_DIR / "manifest.json").read_text(encoding="utf-8-sig"))

    assert manifest["id"] == "canvas-zoom-unlock"
    assert manifest["name"] == "Canvas Zoom Unlock"
    assert (PLUGIN_DIR / "main.js").exists()
    assert (PLUGIN_DIR / "styles.css").exists()


def test_canvas_zoom_unlock_main_js_syntax() -> None:
    node = shutil.which("node")
    if not node:
        pytest.skip("node is required for JavaScript syntax checks")

    result = subprocess.run(
        [node, "--check", str(PLUGIN_DIR / "main.js")],
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
