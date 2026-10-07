"""Connection steps keep credentials visible and configuration copyable."""

import os
import threading
from http.server import ThreadingHTTPServer
from unittest.mock import Mock

import pytest

from miro2obsidian.app_setup import APP_URL, REDIRECT_URI
from miro2obsidian.browser_setup import SetupState, make_handler


@pytest.mark.skipif(os.name != "nt", reason="Native GUI requires a Windows display")
def test_inline_setup_preserves_fields_and_reports_errors_without_dialogs(tmp_path, monkeypatch):
    import Miro_2_Obsidian_GUI as gui
    from miro2obsidian import desktop_ui as ctk

    monkeypatch.setenv("MIRO2OBSIDIAN_UI_SETTINGS", str(tmp_path / "ui.json"))
    app = gui.MiroPipelineApp()
    app.withdraw()
    try:
        app.open_miro_setup()
        setup = app._setup_view
        setup.show(2)
        app.ui.change("language", "ru")
        setup.advance()
        assert setup.feedback.cget("text") == "Заполните оба поля: Client ID и Client secret."
        assert not any(isinstance(child, ctk.CTkToplevel) for child in app.winfo_children())
        setup.client_id.insert(0, "synthetic-id")
        setup.client_secret.insert(0, "synthetic-secret")
        setup.show(1)
        setup.show(2)
        app.open_miro_setup()
        assert app._setup_view is setup
        assert setup.client_id.get() == "synthetic-id"
        assert setup.client_secret.get() == "synthetic-secret"
        app._clear_saved_token = Mock()
        app.authenticate_and_refresh_boards = Mock()
        setup.advance()
        assert setup.busy
        assert setup.client_id.cget("state") == "disabled"
        app._clear_saved_token.assert_called_once()
        callbacks = app.authenticate_and_refresh_boards.call_args.kwargs
        callbacks["on_error"]("synthetic failure")
        assert not setup.busy
        assert setup.client_id.get() == "synthetic-id"
        assert setup.client_secret.get() == "synthetic-secret"
        assert setup.feedback.cget("text")
        assert not any(isinstance(child, ctk.CTkToplevel) for child in app.winfo_children())
        app.clipboard_clear = Mock()
        app.clipboard_append = Mock()
        setup.copy(APP_URL)
        app.clipboard_append.assert_called_once_with(APP_URL)
        setup.advance()
        app.authenticate_and_refresh_boards.call_args.kwargs["on_complete"]()
        assert app._setup_view is None
        assert app.guided.step == 1
    finally:
        app.destroy()


def test_browser_steps_copy_and_languages_preserve_credentials(tmp_path):
    from playwright.sync_api import sync_playwright

    state = SetupState()
    server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(state, origin="http://127.0.0.1"))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with sync_playwright() as playwright:
            if not os.path.isfile(playwright.chromium.executable_path):
                pytest.skip("Playwright Chromium is not installed")
            browser = playwright.chromium.launch(headless=True)
            context = browser.new_context(viewport={"width": 1200, "height": 900})
            # Capture only public configuration values in a test clipboard.
            context.add_init_script("Object.defineProperty(navigator, 'clipboard', {value: {writeText: async value => { window.testCopiedValue = value; }}});")
            page = context.new_page()
            page.goto(f"http://127.0.0.1:{server.server_port}/")
            assert page.locator('[data-setup-panel="0"]').is_visible()
            assert not page.locator('[data-setup-panel="2"]').is_visible()
            assert "does not renew" in page.locator('[data-setup-panel="0"]').inner_text()
            page.get_by_role("button", name="App created — continue", exact=True).click()
            assert page.locator('[data-setup-panel="1"]').is_visible()
            page.locator('[data-copy-target="setup-app-url"]').click()
            page.wait_for_function("window.testCopiedValue !== undefined")
            assert page.evaluate("window.testCopiedValue") == APP_URL
            page.locator('[data-copy-target="setup-redirect"]').click()
            page.wait_for_function("window.testCopiedValue.includes('8765')")
            assert page.evaluate("window.testCopiedValue") == REDIRECT_URI
            page.screenshot(path=str(tmp_path / "configure.en.png"), full_page=True)
            page.get_by_role("button", name="App configured — continue", exact=True).click()
            page.locator('[name="client_id"]').fill("synthetic-id")
            page.locator('[name="client_secret"]').fill("synthetic-secret")
            page.locator('[data-language="ru"]').click()
            assert page.locator('[name="client_id"]').input_value() == "synthetic-id"
            assert page.locator('[name="client_secret"]').input_value() == "synthetic-secret"
            assert page.locator('[name="client_secret"]').get_attribute("type") == "password"
            assert page.get_by_text("Access token — разрешение на экспорт доски.", exact=False).is_visible()
            page.get_by_role("button", name="2. Настроить приложение", exact=True).click()
            page.set_viewport_size({"width": 360, "height": 800})
            page.screenshot(path=str(tmp_path / "configure.ru.mobile.png"), full_page=True)
            assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
            page.get_by_role("button", name="3. Подключить", exact=True).click()
            assert page.locator('[name="client_id"]').is_visible()
            assert page.locator('[name="client_secret"]').is_visible()
            assert page.locator('[name="client_secret"]').input_value() == "synthetic-secret"
            context.close()
            browser.close()
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
