"""Loopback handoff API and capture helpers (no Miro, no external network)."""

from __future__ import annotations

import http.client
import json
import os
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

import pytest

# Reuse the canonical valid Web SDK payload builder (tests dir is on sys.path).
from test_merge_miro_sources import websdk_export

from miro2obsidian import websdk_capture
from miro2obsidian.paths import CAPTURE_DIR_ENV, default_capture_dir
from miro2obsidian.websdk_capture import (
    CaptureRejected,
    CaptureServer,
    CaptureServerUnavailable,
    CaptureTimeout,
    capture_board,
    latest_capture,
    wait_for_capture,
)
from miro2obsidian.websdk_server import TOKEN_HEADER, board_dirname


REPO_ROOT = Path(__file__).resolve().parents[1]
EXPORTER_DIR = REPO_ROOT / "tools" / "miro_websdk_exporter"
BOARD_ID = "uXjVJSz4qHA="
ITEM = {"id": "item-1", "type": "shape", "data": {"content": "SECRET-CONTENT-MARKER"}}


def valid_payload(board_id: str = BOARD_ID, **kwargs) -> dict:
    return websdk_export([dict(ITEM)], board_id, **kwargs)


@pytest.fixture
def server(tmp_path):
    with CaptureServer(
        port=0, capture_dir=tmp_path / "caps", directory=EXPORTER_DIR, max_body_bytes=200_000
    ) as running:
        yield running


def call(server, method, path, *, body=None, headers=None, raw=None):
    """Raw HTTP call; ``headers`` override the defaults (None removes one)."""
    port = server.port
    merged = {
        "Host": f"localhost:{port}",
        "Origin": f"http://localhost:{port}",
        "Content-Type": "application/json",
        TOKEN_HEADER: server._hub.token,
    }
    merged.update(headers or {})
    merged = {k: v for k, v in merged.items() if v is not None}
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        conn.request(method, path, body=data, headers=merged)
        response = conn.getresponse()
        text = response.read()
        try:
            parsed = json.loads(text)
        except ValueError:
            parsed = None
        return response.status, parsed, response, text
    finally:
        conn.close()


def post_capture(server, payload=None, **kwargs):
    return call(server, "POST", "/api/captures", body=payload if payload is not None else valid_payload(), **kwargs)


def captures_on_disk(server) -> list[Path]:
    return sorted(server.capture_dir.glob("*/websdk-*.json"))


# --- HTTP API ---------------------------------------------------------------


def test_session_shape_and_no_cors(server):
    status, body, response, _ = call(server, "GET", "/api/session", headers={"Origin": None})
    assert status == 200
    assert body["app"] == "miro2obsidian-websdk"
    assert body["protocol"] == 1
    assert body["accepting"] is True
    assert body["pending"] == []
    assert body["token"] == server._hub.token
    assert not [h for h, _ in response.getheaders() if h.lower().startswith("access-control-")]


def test_session_is_same_origin_only(server):
    status, body, response, text = call(
        server, "GET", "/api/session", headers={"Origin": "https://evil.example"}
    )
    assert status == 403
    assert server._hub.token.encode() not in text
    assert not [h for h, _ in response.getheaders() if h.lower().startswith("access-control-")]
    for origin in (f"http://127.0.0.1:{server.port}", f"http://[::1]:{server.port}"):
        assert call(server, "GET", "/api/session", headers={"Origin": origin})[0] == 200
    # Same host, other port is a different origin.
    assert call(server, "GET", "/api/session", headers={"Origin": "http://localhost:1"})[0] == 403


def test_host_header_must_be_loopback_with_server_port(server):
    for host in ("evil.example", "evil.example:%d" % server.port, "localhost:1", "127.0.0.1.evil.test"):
        status, _, _, text = call(server, "GET", "/api/session", headers={"Host": host, "Origin": None})
        assert status == 403, host
        assert server._hub.token.encode() not in text
    for host in (f"127.0.0.1:{server.port}", f"[::1]:{server.port}", f"LOCALHOST:{server.port}"):
        assert call(server, "GET", "/api/session", headers={"Host": host, "Origin": None})[0] == 200
    assert post_capture(server, headers={"Host": "evil.example"})[0] == 403


def test_options_has_no_cors_allowance(server):
    status, _, response, _ = call(
        server, "OPTIONS", "/api/captures", headers={"Access-Control-Request-Method": "POST"}
    )
    assert status in (403, 405)
    assert not [h for h, _ in response.getheaders() if h.lower().startswith("access-control-")]


def test_static_files_keep_no_cache_headers(server):
    status, _, response, text = call(server, "GET", "/index.html", headers={"Origin": None})
    assert status == 200 and b"Exporter version" in text
    assert "no-store" in response.getheader("Cache-Control")


def test_valid_capture_is_stored_atomically_and_resolves_pending(server):
    request = server.request_capture(BOARD_ID)
    assert server.pending_requests() == [BOARD_ID]
    status, body, _, _ = post_capture(server)
    assert status == 200
    assert body["status"] == "accepted" and body["board_id"] == BOARD_ID and body["items"] == 1
    path = Path(body["path"])
    assert path.parent.name == board_dirname(BOARD_ID)
    assert path.name.startswith("websdk-") and path.suffix == ".json"
    assert json.loads(path.read_text())["board"]["id"] == BOARD_ID
    assert server.pending_requests() == []
    assert not list(server.capture_dir.glob(".incoming-*"))
    assert request.wait(timeout_seconds=2) == path


def test_board_dirname_is_filesystem_safe_and_collision_free():
    assert board_dirname("board-1") == "board-1"
    a, b = board_dirname("a="), board_dirname("a_")
    assert a != b
    for name in (a, board_dirname("../../etc/passwd"), board_dirname("x/y\\z:?")):
        assert not set(name) & set("/\\:?=.")


def test_token_is_required_and_checked(server):
    assert post_capture(server, headers={TOKEN_HEADER: None})[0] == 403
    assert post_capture(server, headers={TOKEN_HEADER: "wrong"})[0] == 403
    assert captures_on_disk(server) == []


def test_foreign_or_missing_origin_is_rejected_for_captures(server):
    assert post_capture(server, headers={"Origin": "https://miro.com"})[0] == 403
    assert post_capture(server, headers={"Origin": "null"})[0] == 403
    assert post_capture(server, headers={"Origin": None})[0] == 403
    assert captures_on_disk(server) == []


def test_non_json_content_type_is_415(server):
    assert post_capture(server, headers={"Content-Type": "text/plain"})[0] == 415
    assert post_capture(server, headers={"Content-Type": None})[0] == 415
    status, _, _, _ = post_capture(server, headers={"Content-Type": "application/json; charset=utf-8"})
    assert status == 200


def test_oversized_body_is_413_and_not_stored(server):
    big = valid_payload()
    big["padding"] = "x" * 300_000
    status, body, _, _ = post_capture(server, big)
    assert status == 413 and body["status"] == "rejected"
    assert captures_on_disk(server) == []
    assert not list(server.capture_dir.glob(".incoming-*"))


def test_missing_content_length_is_411(server):
    conn = http.client.HTTPConnection("127.0.0.1", server.port, timeout=5)
    try:
        conn.putrequest("POST", "/api/captures", skip_host=True)
        for key, value in {
            "Host": f"localhost:{server.port}",
            "Origin": f"http://localhost:{server.port}",
            "Content-Type": "application/json",
            TOKEN_HEADER: server._hub.token,
        }.items():
            conn.putheader(key, value)
        conn.endheaders()
        assert conn.getresponse().status == 411
    finally:
        conn.close()


def test_invalid_json_and_invalid_captures_are_400_without_payload_echo(server):
    status, body, _, text = call(server, "POST", "/api/captures", raw=b"{not json SECRET-CONTENT-MARKER")
    assert status == 400 and b"SECRET-CONTENT-MARKER" not in text

    stale = valid_payload(exported_at=datetime.now(timezone.utc) - timedelta(days=3))
    status, body, _, text = post_capture(server, stale)
    assert status == 400 and body["status"] == "rejected"
    assert "SECRET-CONTENT-MARKER" not in json.dumps(body)

    incomplete = valid_payload()
    incomplete["completeness"]["complete"] = False
    status, body, _, _ = post_capture(server, incomplete)
    assert status == 400 and "SECRET-CONTENT-MARKER" not in json.dumps(body)

    wrong_scope = valid_payload()
    wrong_scope["export_scope"] = "selection"
    assert post_capture(server, wrong_scope)[0] == 400
    assert post_capture(server, [1, 2, 3])[0] == 400
    no_board = valid_payload()
    no_board["board"] = {}
    assert post_capture(server, no_board)[0] == 400
    assert captures_on_disk(server) == []
    assert not list(server.capture_dir.glob(".incoming-*"))


def test_rejected_capture_surfaces_to_waiter(server):
    request = server.request_capture(BOARD_ID)
    stale = valid_payload(exported_at=datetime.now(timezone.utc) - timedelta(days=3))
    assert post_capture(server, stale)[0] == 400
    assert server.pending_requests() == [BOARD_ID]  # still waiting for a good capture
    with pytest.raises(CaptureRejected) as info:
        request.wait(timeout_seconds=2)
    assert "SECRET-CONTENT-MARKER" not in str(info.value)


def test_requests_endpoint_needs_token_and_loopback(server):
    assert call(server, "POST", "/api/requests", body={"board_id": "b1"}, headers={TOKEN_HEADER: "no"})[0] == 403
    assert call(server, "POST", "/api/requests", body={"board_id": "b1"}, headers={"Origin": "https://evil.example"})[0] == 403
    assert call(server, "POST", "/api/requests", body={"board_id": ""})[0] == 400
    # Other local processes send no Origin header.
    status, body, _, _ = call(server, "POST", "/api/requests", body={"board_id": "b1%3D"}, headers={"Origin": None})
    assert status == 200 and body["status"] == "pending" and body["board_id"] == "b1="
    assert server.pending_requests() == ["b1="]
    status, body, _, _ = call(server, "GET", "/api/requests/b1%3D", headers={"Origin": None})
    assert body["pending"] is True
    assert call(server, "DELETE", "/api/requests/b1%3D", headers={"Origin": None})[0] == 200
    assert server.pending_requests() == []


def test_pending_requests_expire(server):
    server._hub.register_request("short", ttl_seconds=0.05)
    time.sleep(0.15)
    assert server.pending_requests() == []


# --- CaptureServer / helpers ---------------------------------------------------


def test_attach_to_running_server_as_client(tmp_path):
    with CaptureServer(port=0, capture_dir=tmp_path / "caps", directory=EXPORTER_DIR) as owner:
        assert owner.mode == "owner"
        with CaptureServer(port=owner.port) as client:
            assert client.mode == "client"
            request = client.request_capture(BOARD_ID)
            assert owner.pending_requests() == [BOARD_ID]
            assert client.capture_dir == owner.capture_dir
            status, body, _, _ = post_capture(owner)
            assert status == 200
            assert request.wait(timeout_seconds=3) == Path(body["path"])
            assert client.pending_requests() == []


def test_client_sees_rejection(tmp_path):
    with CaptureServer(port=0, capture_dir=tmp_path / "caps", directory=EXPORTER_DIR) as owner:
        with CaptureServer(port=owner.port) as client:
            request = client.request_capture(BOARD_ID)
            stale = valid_payload(exported_at=datetime.now(timezone.utc) - timedelta(days=3))
            assert post_capture(owner, stale)[0] == 400
            with pytest.raises(CaptureRejected):
                request.wait(timeout_seconds=3)


def test_port_taken_by_something_else_is_a_clear_error():
    import socket

    blocker = socket.socket()
    blocker.bind(("127.0.0.1", 0))
    blocker.listen(1)
    try:
        port = blocker.getsockname()[1]
        with pytest.raises(CaptureServerUnavailable, match="already in use"):
            CaptureServer(port=port, directory=EXPORTER_DIR, http_timeout=0.5).start()
    finally:
        blocker.close()


def test_wait_for_capture_times_out(tmp_path):
    started = time.monotonic()
    with pytest.raises(CaptureTimeout):
        wait_for_capture(BOARD_ID, timeout_seconds=0.3, capture_dir=tmp_path)
    assert time.monotonic() - started < 3


def test_wait_ignores_captures_older_than_since(server):
    assert post_capture(server)[0] == 200
    with pytest.raises(CaptureTimeout):
        server.wait_for_capture(
            BOARD_ID, timeout_seconds=0.3, since=datetime.now(timezone.utc) + timedelta(seconds=1)
        )


def test_latest_capture_returns_newest_fresh_valid_capture(server, tmp_path):
    root = server.capture_dir
    assert latest_capture(BOARD_ID, capture_dir=root) is None
    first = Path(post_capture(server)[1]["path"])
    newest = Path(post_capture(server)[1]["path"])
    assert latest_capture(BOARD_ID, capture_dir=root) == newest
    assert first != newest

    # A newer file that is stale or broken is skipped.
    board_dir = newest.parent
    stale = valid_payload(exported_at=datetime.now(timezone.utc) - timedelta(days=3))
    (board_dir / "websdk-99990101T000000000000Z.json").write_text(json.dumps(stale))
    (board_dir / "websdk-99990102T000000000000Z.json").write_text("not json")
    assert latest_capture(BOARD_ID, capture_dir=root) == newest
    # Freshness window is honoured.
    assert latest_capture(BOARD_ID, capture_dir=root, max_age_hours=1e-9) is None
    # Other boards are separate.
    assert latest_capture("another-board", capture_dir=root) is None
    # A capture of another board stored under this board's directory is not accepted.
    other = valid_payload("another-board")
    (board_dir / "websdk-99990103T000000000000Z.json").write_text(json.dumps(other))
    assert latest_capture(BOARD_ID, capture_dir=root) == newest


def test_capture_board_with_fake_browser(tmp_path):
    messages: list[str] = []
    opened: list[str] = []
    result: dict = {}

    def fake_browser(url: str) -> bool:
        opened.append(url)

        def simulate_miro_app() -> None:
            # The app polls /api/session, sees the pending board and POSTs the capture.
            for _ in range(100):
                try:
                    conn = http.client.HTTPConnection("127.0.0.1", port_holder["port"], timeout=2)
                    conn.request("GET", "/api/session", headers={"Host": f"localhost:{port_holder['port']}"})
                    session = json.loads(conn.getresponse().read())
                    conn.close()
                except OSError:
                    time.sleep(0.05)
                    continue
                if BOARD_ID in session["pending"]:
                    conn = http.client.HTTPConnection("127.0.0.1", port_holder["port"], timeout=5)
                    conn.request(
                        "POST",
                        "/api/captures",
                        body=json.dumps(valid_payload()),
                        headers={
                            "Host": f"localhost:{port_holder['port']}",
                            "Origin": f"http://localhost:{port_holder['port']}",
                            "Content-Type": "application/json",
                            TOKEN_HEADER: session["token"],
                        },
                    )
                    result["response"] = json.loads(conn.getresponse().read())
                    conn.close()
                    return
                time.sleep(0.05)

        threading.Thread(target=simulate_miro_app, daemon=True).start()
        return True

    # Learn the dynamic port from the first status line.
    port_holder: dict = {}

    def on_status(message: str) -> None:
        messages.append(message)
        if "listening on http://localhost:" in message:
            port_holder["port"] = int(message.split("http://localhost:")[1].split(" ")[0].split(")")[0])

    path = capture_board(
        BOARD_ID,
        timeout_seconds=15,
        port=0,
        capture_dir=tmp_path / "caps",
        on_status=on_status,
        opener=fake_browser,
    )
    assert opened == ["https://miro.com/app/board/uXjVJSz4qHA=/"]
    assert Path(result["response"]["path"]) == path
    assert json.loads(path.read_text())["board"]["id"] == BOARD_ID
    assert any("click the Miro2Obsidian app icon" in m for m in messages)
    assert not any("SECRET-CONTENT-MARKER" in m for m in messages)


def test_capture_board_without_opening_and_timeout(tmp_path):
    messages: list[str] = []
    opener_calls: list[str] = []
    with pytest.raises(CaptureTimeout):
        capture_board(
            BOARD_ID,
            timeout_seconds=0.3,
            open_board=False,
            port=0,
            capture_dir=tmp_path / "caps",
            on_status=messages.append,
            opener=opener_calls.append,
        )
    assert opener_calls == []
    assert any("Open the board in Miro" in m for m in messages)


def test_capture_board_reports_failed_browser_launch(tmp_path):
    messages: list[str] = []
    with pytest.raises(CaptureTimeout):
        capture_board(
            BOARD_ID,
            timeout_seconds=0.2,
            port=0,
            capture_dir=tmp_path / "caps",
            on_status=messages.append,
            opener=lambda url: False,
        )
    assert any("Could not open a browser" in m for m in messages)


def test_capture_board_uses_webbrowser_by_default(tmp_path):
    with patch.object(websdk_capture.webbrowser, "open", return_value=True) as opener:
        with pytest.raises(CaptureTimeout):
            capture_board(BOARD_ID, timeout_seconds=0.2, port=0, capture_dir=tmp_path / "caps")
    opener.assert_called_once_with("https://miro.com/app/board/uXjVJSz4qHA=/")


# --- paths --------------------------------------------------------------------


def test_capture_dir_env_override(tmp_path):
    with patch.dict(os.environ, {CAPTURE_DIR_ENV: str(tmp_path / "x")}):
        assert default_capture_dir() == (tmp_path / "x").resolve()
    with patch.dict(os.environ, {CAPTURE_DIR_ENV: ""}):
        assert default_capture_dir().name == "websdk-captures"
        assert default_capture_dir().parent.name == "miro2obsidian"
