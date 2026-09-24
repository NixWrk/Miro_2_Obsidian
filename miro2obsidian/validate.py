"""Validate one or more `.canvas` files against this project's board schema.

    python -m miro2obsidian.validate <file.canvas> [<file.canvas> ...]

Prints every issue found, one per line, then exits non-zero if any file was
invalid (unreadable, not JSON, or failing `miro2obsidian/schemas/v1/board.schema.json`).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Sequence

from .schema import CURRENT_SCHEMA_VERSION, validate_board


def _load(path: Path) -> object:
    with path.open("r", encoding="utf-8-sig") as handle:
        return json.load(handle)


def main(argv: Sequence[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if not args:
        print("Usage: python -m miro2obsidian.validate <file.canvas> [<file.canvas> ...]", file=sys.stderr)
        return 2

    exit_code = 0
    for arg in args:
        path = Path(arg)
        try:
            document = _load(path)
        except (OSError, json.JSONDecodeError) as error:
            print(f"{path}: could not be read as JSON: {error}")
            exit_code = 1
            continue

        issues = validate_board(document, version=CURRENT_SCHEMA_VERSION)
        if not issues:
            print(f"{path}: valid")
            continue

        exit_code = 1
        for issue in issues:
            print(f"{path}: {issue}")

    return exit_code


if __name__ == "__main__":
    sys.exit(main())
