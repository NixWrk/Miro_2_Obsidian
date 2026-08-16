from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import patch

import pytest


SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

from obsidian_plugin_setup import (  # noqa: E402
    ADVANCED_CANVAS_ID,
    plugin_has_runtime,
    setup_obsidian_plugins,
)


def test_setup_rejects_reparse_obsidian_directory_before_install(tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    settings = vault / ".obsidian"
    settings.mkdir(parents=True)

    with (
        patch(
            "obsidian_plugin_setup.is_link_or_reparse",
            side_effect=lambda path: Path(path) == settings,
        ),
        patch("obsidian_plugin_setup.install_advanced_canvas") as advanced,
        patch("obsidian_plugin_setup.install_zoom_unlock") as zoom,
        pytest.raises(RuntimeError, match="regular .obsidian"),
    ):
        setup_obsidian_plugins(vault)

    advanced.assert_not_called()
    zoom.assert_not_called()


def test_linked_plugin_runtime_is_never_trusted(tmp_path: Path) -> None:
    target = tmp_path / ".obsidian" / "plugins" / ADVANCED_CANVAS_ID
    target.mkdir(parents=True)
    (target / "manifest.json").write_text(
        '{"id":"advanced-canvas","version":"6.0.1"}', encoding="utf-8"
    )
    (target / "main.js").write_text("main", encoding="utf-8")
    (target / "styles.css").write_text("styles", encoding="utf-8")

    with patch(
        "obsidian_plugin_setup.is_link_or_reparse",
        side_effect=lambda path: Path(path) == target,
    ):
        assert not plugin_has_runtime(tmp_path, ADVANCED_CANVAS_ID, "6.0.1")
