"""Standalone exports stay independent of an Obsidian vault and conversion."""

import json
import os
import sys
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

import pytest

from miro2obsidian import application
from miro2obsidian.agent_runner import build_agent_prompt
from miro2obsidian.desktop_actions import obsidian_uri
from scripts import miro_pipeline


def fake_export(**options):
    source = options["output_path"]
    source.parent.mkdir(parents=True, exist_ok=True)
    sidecar = source.with_name(f"{source.stem}_files")
    sidecar.mkdir()
    (sidecar / "sample.txt").write_text("synthetic attachment", encoding="utf-8")
    payload = {
        "items": [{"id": "example", "type": "text"}],
        "comments": [],
        "completeness": {"complete": True, "assets": {"complete": True}},
    }
    source.write_text(json.dumps(payload), encoding="utf-8")
    return payload, {"asset_stats": {"downloaded": 1}}


def test_raw_export_service_needs_only_source_path(tmp_path):
    source = tmp_path / "Exports" / "board.json"
    with (
        patch("miro2obsidian.application.export_complete_board_source", side_effect=fake_export),
        patch("miro2obsidian.application.convert_miro_to_canvas") as converter,
        patch("miro2obsidian.application.setup_obsidian_plugins") as plugins,
        patch("miro2obsidian.application.share_board_attachments") as sharing,
    ):
        result = application.run_rest_experimental_pipeline(
            board_id="example", token="synthetic-token", source_json=source,
            output_format="raw-json", install_obsidian_plugins=True,
        )
    assert result.output_kind == "raw_json"
    assert result.canvas_path == source
    assert json.loads(source.read_text())["items"][0]["id"] == "example"
    assert (source.with_name("board_files") / "sample.txt").is_file()
    assert not list(tmp_path.rglob(".obsidian"))
    assert not list(tmp_path.rglob("*.canvas"))
    converter.assert_not_called()
    plugins.assert_not_called()
    sharing.assert_not_called()


def test_canvas_service_rejects_missing_destination_before_export(tmp_path):
    with patch("miro2obsidian.application.export_complete_board_source") as export:
        with pytest.raises(ValueError, match="target_dir and vault_root"):
            application.run_rest_experimental_pipeline(
                board_id="example", token="synthetic-token", source_json=tmp_path / "board.json",
                output_format="miro-canvas",
            )
    export.assert_not_called()


def test_raw_export_cli_does_not_read_vault_settings(tmp_path):
    source = tmp_path / "board.json"
    with (
        patch.object(sys, "argv", ["miro2obsidian", "--rest-only", "--board-id", "example", "--source-json", str(source), "--format", "raw-json"]),
        patch("scripts.miro_pipeline.resolve_token_from_args", return_value="synthetic-token"),
        patch("scripts.miro_pipeline.resolve_attachment_dir") as vault_settings,
        patch("miro2obsidian.application.export_complete_board_source", side_effect=fake_export),
    ):
        assert miro_pipeline.main() == 0
    vault_settings.assert_not_called()
    assert source.is_file()


def test_canvas_cli_keeps_destination_required_before_auth(tmp_path):
    with (
        patch.object(sys, "argv", ["miro2obsidian", "--board-id", "example", "--source-json", str(tmp_path / "board.json")]),
        patch("scripts.miro_pipeline.resolve_token_from_args") as auth,
    ):
        with pytest.raises(SystemExit) as error:
            miro_pipeline.main()
    assert error.value.code == 2
    auth.assert_not_called()


def test_agent_raw_export_prompt_uses_export_destination(tmp_path):
    prompt = build_agent_prompt(
        board_url="https://miro.com/app/board/example/", target_dir=tmp_path,
        vault_root=tmp_path, output_format="raw-json",
    )
    assert "Miro Full Exporter" in prompt
    assert "Export folder:" in prompt
    assert "Vault root:" not in prompt
    assert "Canvas folder:" not in prompt
    assert "inside the selected export folder" in prompt


def test_obsidian_uri_round_trips_spaces_unicode_and_reserved_characters(tmp_path):
    path = tmp_path / "Доски & идеи" / "Board #1.canvas"
    query = parse_qs(urlsplit(obsidian_uri(path)).query)
    assert query == {"path": [str(path.resolve())], "paneType": ["tab"]}


@pytest.mark.skipif(os.name != "nt", reason="Native GUI requires a Windows display")
def test_gui_exports_outside_vault_and_offers_offline_conversion(tmp_path, monkeypatch):
    import Miro_2_Obsidian_GUI as gui

    monkeypatch.setenv("MIRO2OBSIDIAN_UI_SETTINGS", str(tmp_path / "ui.json"))
    app = gui.MiroPipelineApp()
    app.withdraw()
    try:
        assert app.title() == "Miro Full Exporter"
        assert app.output_format.get() == "raw-json"
        assert app.export_purpose.get() == "Export data"
        assert not app.install_obsidian_plugins.get()
        app.source_mode.set("Miro URL")
        app.guided.source_changed("Miro URL")
        app.board_id.insert(0, "https://miro.com/app/board/example/")
        app.target_dir.insert(0, str(tmp_path / "Exports"))
        # REST-only export is an explicit alternative to the GUI's combined default.
        from miro2obsidian.export_methods import REST_ONLY

        app.export_method.set(REST_ONLY)
        app.guided.context()
        # Hidden Canvas tuning must not block a data export.
        app.scale.insert(0, "invalid")
        app.min_zoom.delete(0, "end")
        app.min_zoom.insert(0, "invalid")
        with (
            patch.object(app, "_token", return_value="synthetic-token"),
            patch("Miro_2_Obsidian_GUI.resolve_vault_paths") as vault,
            patch("miro2obsidian.application.export_complete_board_source", side_effect=fake_export),
            patch("Miro_2_Obsidian_GUI.threading.Thread", side_effect=lambda *, target, **kwargs: SimpleNamespace(start=target)),
        ):
            app.guided.start()
            app.update()
        vault.assert_not_called()
        assert app.guided.result_frame is not None
        source = next((tmp_path / "Exports").rglob("*.json"))
        app.guided.prepare_canvas(source)
        assert app.json_path.get() == str(source)
        assert app.source_mode.get() == "Existing JSON"
        assert app.output_format.get() == "miro-canvas"
        assert app.export_purpose.get() == "For Obsidian"
        assert app.target_dir.get() == ""
        assert app.guided.step == 2
        app.ui.change("language", "ru")
        assert app.output_format.get() == "miro-canvas"
        assert app.destination_label.cget("text") == "Папка Canvas"
        app.ui.change("language", "en")
        assert app.output_format.get() == "miro-canvas"
    finally:
        app.destroy()
