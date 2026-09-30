from __future__ import annotations

import http.client
import re
import threading
from http.server import ThreadingHTTPServer
from urllib.parse import urlencode

from miro2obsidian import browser_setup


def test_local_setup_uses_same_origin_and_saves_only_token(monkeypatch) -> None:
    state = browser_setup.SetupState()
    saved: list[str] = []
    saved_event = threading.Event()
    seen: list[tuple[str, str]] = []

    def fake_oauth(config, *, on_authorize_url, **_kwargs):
        seen.append((config.client_id, config.client_secret))
        on_authorize_url("https://miro.com/oauth/authorize?state=test")
        return "test-access-token"

    monkeypatch.setattr(browser_setup, "authorize_and_get_token", fake_oauth)
    def fake_save(token: str) -> None:
        saved.append(token)
        saved_event.set()

    monkeypatch.setattr(browser_setup, "save_access_token", fake_save)
    server = ThreadingHTTPServer(("127.0.0.1", 0), browser_setup.make_handler(
        state, origin="http://127.0.0.1:8767"
    ))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        connection = http.client.HTTPConnection("127.0.0.1", server.server_port)
        connection.request("GET", "/")
        response = connection.getresponse()
        page = response.read().decode()
        assert response.status == 200
        assert response.getheader("Cache-Control") == "no-store"
        csrf = re.search(r'name="csrf" value="([^"]+)"', page).group(1)
        form = urlencode({"csrf": csrf, "client_id": "app-id", "client_secret": "test-secret"})
        headers = {"Content-Type": "application/x-www-form-urlencoded", "Origin": "https://other.example"}
        connection.request("POST", "/connect", body=form, headers=headers)
        denied = connection.getresponse()
        assert denied.status == 403
        denied.read()
        assert not seen

        headers["Origin"] = "null"
        connection.request("POST", "/connect", body=form, headers=headers)
        accepted = connection.getresponse()
        assert accepted.status == 303
        assert accepted.getheader("Location") == "https://miro.com/oauth/authorize?state=test"
        accepted.read()
        assert saved_event.wait(1)
        assert seen == [("app-id", "test-secret")]
        assert saved == ["test-access-token"]
        connection.request("GET", "/continue")
        resume = connection.getresponse()
        assert resume.status == 303
        assert resume.getheader("Location") == "https://miro.com/oauth/authorize?state=test"
        resume.read()
        connection.request("GET", "/status")
        status = connection.getresponse().read().decode()
        assert "Miro is connected" in status
        assert "test-secret" not in status
        assert "test-access-token" not in status
        connection.close()
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
