from __future__ import annotations

import subprocess
import sys
from pathlib import Path


def main() -> int:
    repo_root = Path(__file__).resolve().parents[1]
    unit_cmd = [
        sys.executable,
        "-m",
        "unittest",
        "discover",
        "-s",
        str(repo_root / "tests"),
        "-v",
    ]
    unit_rc = subprocess.call(unit_cmd, cwd=repo_root)
    if unit_rc != 0:
        return unit_rc

    smoke_cmd = [
        sys.executable,
        str(repo_root / "tools" / "canvas_render" / "smoke_test.py"),
    ]
    smoke_rc = subprocess.call(smoke_cmd, cwd=repo_root)
    if smoke_rc != 0:
        return smoke_rc

    render_cmd = [
        sys.executable,
        str(repo_root / "tools" / "canvas_render" / "capture_fixture.py"),
        "--all",
    ]
    return subprocess.call(render_cmd, cwd=repo_root)


if __name__ == "__main__":
    raise SystemExit(main())
