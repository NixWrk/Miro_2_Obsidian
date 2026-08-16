from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[1]


def test_websdk_export_marks_non_json_values_incomplete() -> None:
    node = shutil.which("node")
    if not node:
        pytest.skip("node is required for the Web SDK serialization smoke test")
    subprocess.run(
        [
            node,
            str(REPO_ROOT / "tests" / "websdk_serialization_smoke.js"),
            str(REPO_ROOT / "tools" / "miro_websdk_exporter" / "exporter.js"),
        ],
        cwd=REPO_ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
