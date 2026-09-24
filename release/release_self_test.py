"""A build that cannot find its own parts should say so before anyone runs it.

`--self-test` imports everything the application needs and checks the data
files shipped beside it, then exits: the release workflow runs it on every
operating system, where opening a window is not possible.
"""

from __future__ import annotations

import sys
from pathlib import Path


def _check() -> list[str]:
    problems: list[str] = []
    import customtkinter  # noqa: F401 - the desktop window's toolkit and its themes

    from miro2obsidian import application  # noqa: F401 - the whole pipeline
    from miro2obsidian.schema import validate_board

    if validate_board({"nodes": [], "edges": []}):
        problems.append("the board schema rejects an empty board")
    from scripts import obsidian_plugin_setup

    if not obsidian_plugin_setup.ZOOM_UNLOCK_SOURCE.is_dir():
        problems.append(f"missing bundled plugin: {obsidian_plugin_setup.ZOOM_UNLOCK_SOURCE}")
    themes = Path(customtkinter.__file__).resolve().parent / "assets" / "themes"
    if not themes.is_dir():
        problems.append(f"missing customtkinter themes: {themes}")
    return problems


def run_self_test_if_asked() -> None:
    if "--self-test" not in sys.argv[1:]:
        return
    problems = _check()
    for problem in problems:
        print(f"self-test: {problem}")
    print("self-test: ok" if not problems else "self-test: failed")
    sys.exit(1 if problems else 0)
