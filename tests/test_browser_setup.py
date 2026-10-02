from __future__ import annotations

import http.client
import re
import threading
from http.server import ThreadingHTTPServer
from urllib.parse import urlencode

from miro2obsidian import browser_setup, credential_store, miro_auth
from scripts import miro_oauth_token as oauth


def test_local_setup_uses_same_origin_and_saves_full_connection(monkeypatch) -> None:
    state = browser_setup.SetupState()
    saved: list[credential_store.MiroConnection] = []
    saved_event = threading.Event()
    seen: list[tuple[str, str]] = []

    def fake_oauth(config, *, on_authorize_url, **_kwargs):
        seen.append((config.client_id, config.client_secret))
        on_authorize_url("https://miro.com/oauth/authorize?state=test")
        return oauth.TokenGrant(
            access_token="test-access-token",
            refresh_token="test-refresh-token",
            scope="boards:read",
        )

    def fake_save(connection) -> None:
        saved.append(connection)
        saved_event.set()

    monkeypatch.setattr(miro_auth, "authorize_and_get_grant", fake_oauth)
    monkeypatch.setattr(
        miro_auth,
        "fetch_token_info",
        lambda token, **_kw: {"team_id": "t-1", "team_name": "<b>Design</b>", "scopes": ["boards:read"]},
    )
    monkeypatch.setattr(miro_auth, "save_connection", fake_save)
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
        assert len(saved) == 1
        assert saved[0].access_token == "test-access-token"
        assert saved[0].refresh_token == "test-refresh-token"
        assert (saved[0].client_id, saved[0].client_secret) == ("app-id", "test-secret")
        assert saved[0].team_name == "<b>Design</b>"
        connection.request("GET", "/continue")
        resume = connection.getresponse()
        assert resume.status == 303
        assert resume.getheader("Location") == "https://miro.com/oauth/authorize?state=test"
        resume.read()
        connection.request("GET", "/status")
        status = connection.getresponse().read().decode()
        assert "Miro is connected" in status
        assert "&lt;b&gt;Design&lt;/b&gt;" in status
        assert "<b>Design</b>" not in status
        assert "test-refresh-token" not in status
        assert "test-secret" not in status
        assert "test-access-token" not in status
        connection.close()
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def test_run_form_serves_then_stops_itself_on_timeout(monkeypatch) -> None:
    reported: list[str] = []
    served: list[int] = []

    def report(url: str) -> None:
        reported.append(url)
        host, port = re.match(r"http://([^:/]+):(\d+)/", url).groups()
        connection = http.client.HTTPConnection(host, int(port), timeout=5)
        connection.request("GET", "/")
        response = connection.getresponse()
        served.append(response.status)
        assert "Client secret" in response.read().decode("utf-8")
        connection.close()

    state = browser_setup.run_form(open_browser=False, timeout_seconds=0.5, report=report)
    assert served == [200]
    assert state.status == "waiting"
    assert reported and reported[0].startswith("http://127.0.0.1:")
    # the server is gone once run_form returns
    host, port = re.match(r"http://([^:/]+):(\d+)/", reported[0]).groups()
    try:
        http.client.HTTPConnection(host, int(port), timeout=1).request("GET", "/")
    except OSError:
        pass
    else:  # pragma: no cover
        raise AssertionError("the setup form kept listening")


def test_run_form_rejects_non_loopback_hosts() -> None:
    import pytest

    with pytest.raises(ValueError, match="loopback"):
        browser_setup.run_form(host="0.0.0.0", open_browser=False, timeout_seconds=0.1)
