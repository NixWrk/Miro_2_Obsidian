from __future__ import annotations

import threading
from urllib.error import HTTPError
from urllib.request import urlopen

import pytest



from scripts import miro_oauth_token as oauth


def test_oauth_callback_rejects_malformed_then_keeps_first_valid_result() -> None:
    result = oauth.CallbackResult()
    event = threading.Event()
    handler = oauth._make_callback_handler(
        callback_path="/callback",
        expected_state="expected-state",
        result=result,
        event=event,
    )
    server = oauth._make_callback_server("127.0.0.1", 0, handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    port = server.server_address[1]
    base = f"http://127.0.0.1:{port}/callback"
    try:
        with pytest.raises(HTTPError) as malformed:
            urlopen(f"{base}?state=expected-state", timeout=2)
        assert malformed.value.code == 400
        assert not event.is_set()

        with urlopen(
            f"{base}?code=first-code&state=expected-state", timeout=2
        ) as response:
            assert response.status == 200
        assert event.wait(1)

        with pytest.raises(HTTPError) as duplicate:
            urlopen(f"{base}?code=second-code&state=expected-state", timeout=2)
        assert duplicate.value.code == 409
        assert result.code == "first-code"
        assert result.error is None
    finally:
        server.shutdown()
        server.server_close()
