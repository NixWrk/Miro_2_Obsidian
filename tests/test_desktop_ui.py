import os

import pytest

from miro2obsidian.ui_preferences import load_preferences, save_preferences


def test_preferences_only_store_appearance(tmp_path, monkeypatch):
    path = tmp_path / "ui.json"
    monkeypatch.setenv("MIRO2OBSIDIAN_UI_SETTINGS", str(path))
    save_preferences({"theme": "dark", "language": "ru", "extra": "discard-this"})
    assert load_preferences() == {"theme": "dark", "language": "ru"}
    assert "discard-this" not in path.read_text()
    path.write_text('{"theme": "invalid", "language": "invalid"}')
    assert load_preferences() == {"theme": "light", "language": "en"}


@pytest.mark.skipif(os.name != "nt", reason="Native GUI requires a Windows display")
def test_language_switch_preserves_form_and_canonical_choices(tmp_path, monkeypatch):
    from Miro_2_Obsidian_GUI import MiroPipelineApp

    monkeypatch.setenv("MIRO2OBSIDIAN_UI_SETTINGS", str(tmp_path / "ui.json"))
    app = MiroPipelineApp()
    app.withdraw()
    try:
        app.source_mode.set("Existing JSON")
        app.on_source_mode_changed("Existing JSON")
        app.json_path.insert(0, "synthetic-source.json")
        app.scale.insert(0, "1.25")
        app.theme.set("light")
        app.allow_missing_assets.set(True)
        app.ui.change("language", "ru")
        app.ui.change("theme", "dark")
        app.update_idletasks()
        assert app.run_button.cget("text") == "Экспортировать"
        assert app.run_button.master is app.action_bar
        assert app.source_mode.get() == "Existing JSON"
        assert app.scale_mode.get() == "readable"
        assert app.theme.get() == "light"  # Canvas output theme is independent.
        assert app.json_path.get() == "synthetic-source.json"
        assert app.scale.get() == "1.25"
        assert app.allow_missing_assets.get()
        app.ui.change("language", "en")
        assert app.run_button.cget("text") == "Run pipeline"
        assert app.source_mode.get() == "Existing JSON"
    finally:
        app.destroy()


def test_web_assets_follow_shared_theme(tmp_path):
    from pathlib import Path

    from scripts.build_ui_assets import build

    build(tmp_path)
    source = Path(__file__).resolve().parents[1] / "tools" / "miro_websdk_exporter"
    for name in ("theme.css", "ui.js"):
        assert (tmp_path / name).read_text(encoding="utf-8") == (source / name).read_text(encoding="utf-8")


@pytest.mark.skipif(os.name != "nt", reason="Native GUI requires a Windows display")
def test_guided_workflow_validates_and_hides_irrelevant_controls(tmp_path, monkeypatch):
    from Miro_2_Obsidian_GUI import MiroPipelineApp

    monkeypatch.setenv("MIRO2OBSIDIAN_UI_SETTINGS", str(tmp_path / "ui.json"))
    app = MiroPipelineApp()
    app.withdraw()
    try:
        guide = app.guided
        assert guide.step == 0
        assert not app.agent_settings_button.winfo_manager()
        assert not guide.advanced.winfo_manager()
        guide.advance()
        guide.advance()
        assert guide.step == 1  # A board is required before destination.
        assert guide.error.cget("text")
        source = tmp_path / "board.json"
        source.write_text("{}")
        app.source_mode.set("Existing JSON")
        guide.source_changed("Existing JSON")
        app.json_path.insert(0, str(source))
        assert not guide.sdk_toggle.winfo_manager()
        assert not app.stable_items_checkbox.winfo_manager()
        guide.advance()
        assert guide.step == 2
        guide.start()
        assert guide.step == 2  # A destination is required before execution.
        guide.toggle_advanced()
        assert guide.advanced.winfo_manager() == "grid"
        app.workflow_mode.set("Agent")
        guide.workflow_changed("Agent")
        assert app.source_mode.get() == "Miro account"
        assert "Existing JSON" not in app.source_mode._original_values
        assert app.agent_settings_button.winfo_manager() == "grid"
        assert not guide.sdk_toggle.winfo_manager()
        guide.set_busy(True)
        guide.previous()
        assert guide.step == 2
        guide.set_busy(False)
        guide.previous()
        assert guide.step == 1
        app.ui.change("language", "ru")
        assert guide.next.cget("text") == "Продолжить"
    finally:
        app.destroy()


@pytest.mark.skipif(os.name != "nt", reason="Native GUI requires a Windows display")
def test_source_controls_follow_dependency_order(tmp_path, monkeypatch):
    from Miro_2_Obsidian_GUI import MiroPipelineApp

    monkeypatch.setenv("MIRO2OBSIDIAN_UI_SETTINGS", str(tmp_path / "ui.json"))
    app = MiroPipelineApp()
    app.withdraw()
    try:
        guide = app.guided
        setup = next(child for child in app.account_frame.winfo_children()
                     if getattr(child, "_original_text", "") == "Set up Miro app")
        assert app.source_mode.grid_info()["row"] < app.path_frame.grid_info()["row"]
        assert setup.grid_info()["row"] < guide.refresh_button.grid_info()["row"]
        assert guide.refresh_button.grid_info()["row"] < app.board_menu.grid_info()["row"]
        assert setup.grid_info()["sticky"] == "w"
        assert app.board_menu.cget("state") == "disabled"
        assert not guide.sdk_toggle.winfo_manager()
        guide.connection_changed(True)
        assert guide.refresh_button.cget("state") == "normal"
        assert app.board_menu.cget("state") == "disabled"
        guide.boards_loaded(True)
        assert app.board_menu.cget("state") == "normal"
        guide.connection_changed(False)
        assert guide.refresh_button.cget("state") == "disabled"
        assert app.board_menu.cget("state") == "disabled"
        assert not guide.sdk_toggle.winfo_manager()
        for frame in (app.url_frame, app.url_list_frame):
            first = next(child for child in frame.winfo_children()
                         if getattr(child, "_original_text", "") == "Set up Miro app")
            assert first.grid_info()["row"] == 0
    finally:
        app.destroy()


@pytest.mark.skipif(os.name != "nt", reason="Native GUI requires a Windows display")
def test_context_for_all_workflows_and_sources(tmp_path, monkeypatch):
    from Miro_2_Obsidian_GUI import MiroPipelineApp

    monkeypatch.setenv("MIRO2OBSIDIAN_UI_SETTINGS", str(tmp_path / "ui.json"))
    app = MiroPipelineApp()
    app.withdraw()
    try:
        guide = app.guided
        guide.boards_loaded(True)
        for workflow in ("Manual", "Code automation", "Agent"):
            app.workflow_mode.set(workflow)
            guide.workflow_changed(workflow)
            for source in app.source_mode._original_values:
                app.source_mode.set(source)
                guide.source_changed(source)
                assert bool(app.agent_settings_button.winfo_manager()) == (workflow == "Agent")
                assert bool(app.stable_items_checkbox.winfo_manager()) == (source != "Existing JSON")
                assert bool(guide.sdk_toggle.winfo_manager()) == (
                    workflow != "Agent" and source in {"Miro account", "Miro URL"})
                visible = [frame for frame in (app.account_frame, app.url_frame,
                           app.url_list_frame, app.json_frame) if frame.winfo_manager()]
                assert len(visible) == 1
        for output in app.output_format._original_values:
            app.output_format.set(output)
            guide.format_changed(output)
            assert bool(app.install_obsidian_plugins_checkbox.winfo_manager()) == (output == "advanced-canvas")
        guide.show(2)
        guide.set_busy(True)
        guide.start()
        guide.advance()
        guide.previous()
        assert guide.step == 2
        assert app.workflow_mode.cget("state") == "disabled"
        assert app.source_mode.cget("state") == "disabled"
        guide.set_busy(False)
        assert app.workflow_mode.cget("state") == "normal"
    finally:
        app.destroy()


@pytest.mark.skipif(os.name != "nt", reason="Native GUI requires a Windows display")
def test_sdk_file_picker_only_follows_file_choice(tmp_path, monkeypatch):
    from Miro_2_Obsidian_GUI import MiroPipelineApp

    monkeypatch.setenv("MIRO2OBSIDIAN_UI_SETTINGS", str(tmp_path / "ui.json"))
    app = MiroPipelineApp()
    app.withdraw()
    try:
        if "websdk_choice" not in app.__dict__:
            pytest.skip("SDK choice is provided by the automation branch")
        for choice in app.websdk_choice._original_values:
            app.websdk_choice.set(choice)
            app.on_websdk_choice_changed(choice)
            assert bool(app.websdk_path.winfo_manager()) == (choice == "From file…")
            assert bool(app.websdk_browse.winfo_manager()) == (choice == "From file…")
    finally:
        app.destroy()


@pytest.mark.skipif(os.name != "nt", reason="Native GUI requires a Windows display")
def test_setup_browser_action_precedes_credentials(tmp_path, monkeypatch):
    import Miro_2_Obsidian_GUI as gui
    from miro2obsidian import desktop_ui as ctk

    monkeypatch.setenv("MIRO2OBSIDIAN_UI_SETTINGS", str(tmp_path / "ui.json"))
    app = gui.MiroPipelineApp()
    app.withdraw()
    try:
        if hasattr(gui, "SetupWizard"):
            dialog = gui.SetupWizard(app, settings_file=tmp_path / "wizard.json")
            assert dialog.open_button.grid_info().get("row", 3) < dialog.copy_frame.grid_info()["row"]
            assert dialog.copy_frame.grid_info()["row"] < dialog.form_frame.grid_info().get("row", 5)
            assert not dialog.form_frame.winfo_manager() or dialog.step.get("form")
        else:
            app.open_miro_setup()
            dialog = next(child for child in app.winfo_children() if isinstance(child, ctk.CTkToplevel))
            children = dialog.winfo_children()
            browser = next(child for child in children if getattr(child, "_original_text", "") == "Open Your apps")
            ready = next(child for child in children if getattr(child, "_original_text", "") == "I have configured my Miro app — connect")
            entries = [child for child in children if isinstance(child, ctk.CTkEntry)]
            assert all(not child.winfo_manager() for child in entries)
            assert browser.grid_info()["row"] < ready.grid_info()["row"]
            ready.invoke()
            assert all(child.winfo_manager() == "grid" for child in entries)
            assert all(browser.grid_info()["row"] < child.grid_info()["row"] for child in entries)
        dialog.destroy()
    finally:
        app.destroy()
