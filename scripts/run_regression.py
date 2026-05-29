from __future__ import annotations

import subprocess
import sys
import argparse
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description="Run converter regression checks.")
    parser.add_argument(
        "--skip-render",
        action="store_true",
        help="Skip diagnostic web-render smoke and screenshot baseline checks.",
    )
    args = parser.parse_args()

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
    if args.skip_render:
        return 0

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
