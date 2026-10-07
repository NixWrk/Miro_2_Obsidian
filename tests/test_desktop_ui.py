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
@pytest.mark.parametrize("state", ["normal", "disabled"])
def test_language_switch_works_without_customtkinter_textbox_state_cget(tmp_path, monkeypatch, state):
    from Miro_2_Obsidian_GUI import MiroPipelineApp
    from miro2obsidian import desktop_ui as ctk

    monkeypatch.setenv("MIRO2OBSIDIAN_UI_SETTINGS", str(tmp_path / "ui.json"))
    original_cget = ctk.native.CTkTextbox.cget

    def legacy_cget(self, attribute):
        if attribute == "state":
            raise ValueError("'state' is not a supported argument")
        return original_cget(self, attribute)

    monkeypatch.setattr(ctk.native.CTkTextbox, "cget", legacy_cget)
    app = MiroPipelineApp()
    app.withdraw()
    try:
        app.log.insert("end", "Export complete\n")
        app.log.configure(state=state)
        app.open_miro_setup()
        setup = app._setup_view
        setup.show(2)
        setup.client_id.insert(0, "synthetic-id")
        setup.client_secret.insert(0, "synthetic-secret")
        for language, expected in (("ru", "Экспорт завершён"), ("en", "Export complete")):
            app.ui.change("language", language)
            assert expected in app.log.get("1.0", "end")
            assert app.log._textbox.cget("state") == state
            assert setup.client_id.get() == "synthetic-id"
            assert setup.client_secret.get() == "synthetic-secret"
    finally:
        app.destroy()


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
                    workflow != "Agent" and source in {"Miro account", "Miro URL", "Miro URL list"})
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
def test_websdk_instructions_are_inline_copyable_and_translated(tmp_path, monkeypatch):
    from Miro_2_Obsidian_GUI import MiroPipelineApp
    from miro2obsidian import desktop_ui as ctk
    from miro2obsidian.app_setup import APP_URL
    from miro2obsidian.desktop_websdk_help import SOURCE_COMMAND, WEBSDK_COMMAND

    monkeypatch.setenv("MIRO2OBSIDIAN_UI_SETTINGS", str(tmp_path / "ui.json"))
    app = MiroPipelineApp()
    app.withdraw()
    copied = []
    monkeypatch.setattr(app, "clipboard_clear", lambda: None)
    monkeypatch.setattr(app, "clipboard_append", copied.append)
    try:
        app.source_mode.set("Miro URL")
        app.guided.source_changed("Miro URL")
        app.guided.show(1)
        app.websdk_path.insert(0, "synthetic-board.json")
        help_view = app.websdk_help
        assert help_view.frame.master is app.guided.sdk
        assert app.guided.sdk.winfo_manager() == "grid"
        assert not any(isinstance(child, ctk.CTkToplevel) for child in app.winfo_children())
        for entry, button, value in (
            (help_view.command, help_view.command_copy, WEBSDK_COMMAND),
            (help_view.source_command, help_view.source_copy, SOURCE_COMMAND),
            (help_view.app_url, help_view.url_copy, APP_URL),
        ):
            assert entry.get() == value
            assert entry.cget("state") == "readonly"
            button.invoke()
            assert copied[-1] == value
        for language, heading in (("ru", "Как скачать файл доски"), ("en", "How to download the board file")):
            app.ui.change("language", language)
            assert help_view.notes[0].cget("text") == heading
            assert "Export board" in help_view.notes[6].cget("text")
            assert app.websdk_path.get() == "synthetic-board.json"
        app.guided.toggle_sdk()
        assert not app.guided.sdk.winfo_manager()
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
        app.open_miro_setup()
        setup = app._setup_view
        assert not any(isinstance(child, ctk.CTkToplevel) for child in app.winfo_children())
        assert setup.step == 0
        assert setup.panels[0].winfo_manager() == "grid"
        assert not setup.panels[2].winfo_manager()
        setup.show(2)
        app.update_idletasks()
        assert setup.client_id.winfo_manager() == "grid"
        assert setup.client_secret.winfo_manager() == "grid"
        assert setup.client_id.grid_info()["row"] != setup.client_secret.grid_info()["row"]
        assert setup.client_secret.cget("show") == "*"
        setup.close()
    finally:
        app.destroy()
