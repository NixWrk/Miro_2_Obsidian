import os
import sys
from unittest.mock import patch

import pytest

from miro2obsidian.export_methods import (
    BATCH_HELP, REST_AND_SDK, REST_ONLY, SDK_REQUIRED, websdk_selection_error,
)


def test_combined_export_requires_file_and_complete_assets(tmp_path):
    options = dict(source_mode="Miro URL", workflow_mode="Manual", method=REST_AND_SDK, path="", allow_missing_assets=False)
    assert websdk_selection_error(**options) == SDK_REQUIRED
    options["path"] = str(tmp_path / "absent.json")
    assert "existing" in websdk_selection_error(**options)
    path = tmp_path / "sdk.json"
    path.write_text("{}")  # Payload verification belongs to the canonical merge.
    options["path"] = str(path)
    assert not websdk_selection_error(**options)
    options["allow_missing_assets"] = True
    assert "complete attachments" in websdk_selection_error(**options)
    options["method"] = REST_ONLY
    assert not websdk_selection_error(**options)


def test_batch_cannot_silently_downgrade_to_rest():
    options = dict(source_mode="Miro URL list", workflow_mode="Code automation", method=REST_AND_SDK, path="", allow_missing_assets=False)
    assert websdk_selection_error(**options) == BATCH_HELP
    options["method"] = REST_ONLY
    assert not websdk_selection_error(**options)


@pytest.mark.parametrize("source,workflow", [("Existing JSON", "Manual"), ("Miro URL", "Agent")])
def test_offline_and_agent_validate_sources_in_their_own_pipeline(source, workflow):
    assert not websdk_selection_error(source_mode=source, workflow_mode=workflow, method=REST_AND_SDK, path="", allow_missing_assets=False)


@pytest.mark.parametrize("extra", [[], ["--rest-only", "--websdk-json", "sdk.json"], ["--existing-json", "--rest-only"]])
def test_cli_requires_explicit_source_method_before_auth(tmp_path, extra):
    from scripts import miro_pipeline

    argv = ["miro2obsidian", "--board-id", "synthetic", "--source-json", str(tmp_path / "board.json"), "--format", "raw-json", *extra]
    with patch.object(sys, "argv", argv), patch("scripts.miro_pipeline.resolve_token_from_args") as auth:
        with pytest.raises(SystemExit) as error:
            miro_pipeline.main()
    assert error.value.code == 2
    auth.assert_not_called()


@pytest.mark.skipif(os.name != "nt", reason="Native GUI requires a Windows display")
def test_gui_blocks_missing_sdk_before_auth_and_preserves_explicit_choice(tmp_path, monkeypatch):
    from Miro_2_Obsidian_GUI import MiroPipelineApp

    monkeypatch.setenv("MIRO2OBSIDIAN_UI_SETTINGS", str(tmp_path / "ui.json"))
    app = MiroPipelineApp()
    app.withdraw()
    calls = []
    monkeypatch.setattr(app, "_token", lambda: calls.append("auth"))
    monkeypatch.setattr(app, "run_pipeline", lambda: calls.append("pipeline"))
    try:
        assert app.export_method.get() == REST_AND_SDK
        app.source_mode.set("Miro URL")
        app.guided.source_changed("Miro URL")
        app.board_id.insert(0, "https://miro.com/app/board/synthetic/")
        app.target_dir.insert(0, str(tmp_path / "Exports"))
        app.guided.start()
        assert app.guided.step == 1
        assert "requires" in app.guided.error.cget("text")
        assert app.websdk_help.frame.winfo_manager() == "grid"
        assert not calls
        # Verify the direct entry point too, without bypassing its preflight.
        MiroPipelineApp.run_pipeline(app)
        assert not calls
        sdk = tmp_path / "sdk.json"
        sdk.write_text("{}")
        app.websdk_path.insert(0, str(sdk))
        app.guided.start()
        assert calls == ["pipeline"]
        calls.clear()
        app.export_method.set(REST_ONLY)
        app.guided.context()
        assert not app.websdk_path.winfo_manager()
        assert not app.websdk_help.frame.winfo_manager()
        assert app.websdk_help.coverage.winfo_manager() == "grid"
        for language in ("ru", "en"):
            app.ui.change("language", language)
            assert app.export_method.get() == REST_ONLY
            assert app.websdk_path.get() == str(sdk)
        app.guided.start()
        assert calls == ["pipeline"]
    finally:
        app.destroy()
