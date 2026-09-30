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
    from miro2obsidian.websdk_server import websdk_directory
    from playwright._impl._driver import compute_driver_executable

    if validate_board({"nodes": [], "edges": []}):
        problems.append("the board schema rejects an empty board")
    from scripts import obsidian_plugin_setup

    if not obsidian_plugin_setup.ZOOM_UNLOCK_SOURCE.is_dir():
        problems.append(f"missing bundled plugin: {obsidian_plugin_setup.ZOOM_UNLOCK_SOURCE}")
    try:
        websdk_directory()
    except FileNotFoundError as exc:
        problems.append(str(exc))
    themes = Path(customtkinter.__file__).resolve().parent / "assets" / "themes"
    if not themes.is_dir():
        problems.append(f"missing customtkinter themes: {themes}")
    node, cli = compute_driver_executable()
    if not Path(node).is_file() or not Path(cli).is_file():
        problems.append("missing bundled Playwright browser driver")
    return problems


def run_self_test_if_asked() -> None:
    if "--browser-self-test" in sys.argv[1:]:
        from tempfile import TemporaryDirectory

        from miro2obsidian.browser_bridge import start_browser_bridge

        try:
            with TemporaryDirectory(prefix="miro2obsidian-browser-self-test-") as directory:
                with start_browser_bridge(
                    "data:text/html,<title>browser-self-test</title>",
                    profile_dir=Path(directory),
                    headless=True,
                    install_missing=False,
                ):
                    pass
        except Exception as exc:  # noqa: BLE001
            print(f"browser-self-test: {exc}")
            sys.exit(1)
        print("browser-self-test: ok")
        sys.exit(0)
    if "--self-test" not in sys.argv[1:]:
        return
    problems = _check()
    for problem in problems:
        print(f"self-test: {problem}")
    print("self-test: ok" if not problems else "self-test: failed")
    sys.exit(1 if problems else 0)
