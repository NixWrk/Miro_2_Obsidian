"""Programmatic handoff of Miro Web SDK captures to the local program.

The Miro Web SDK app (``tools/miro_websdk_exporter``) POSTs a validated
``maximum_board_v1`` capture to the loopback server started by
``miro2obsidian websdk-serve``. This module is the stable Python API for code
(CLI, GUI, MCP) that wants such a capture without the user handling files:

* :class:`CaptureServer` starts the server in background threads, or attaches
  as a client to an already running ``websdk-serve`` on the same port;
* :func:`capture_board` is the one-call helper: serve, register a pending
  request for the board, open the board in the default browser and wait;
* :func:`latest_capture` / :func:`wait_for_capture` read the capture directory.

Captures are validated with ``scripts.merge_miro_sources.validate_websdk_export``
before they are stored, so any returned path holds a complete, fresh capture of
the requested board. Payload contents are never logged or placed in messages.
"""

from __future__ import annotations

import json
import re
import threading
import time
import webbrowser
from dataclasses import dataclass, field
from datetime import datetime, timezone
from http.server import ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import ProxyHandler, Request, build_opener

from miro2obsidian.paths import default_capture_dir
from miro2obsidian.websdk_server import (
    API_APP_NAME,
    DEFAULT_MAX_CAPTURE_BYTES,
    DEFAULT_PENDING_TTL_SECONDS,
    DEFAULT_PORT,
    TOKEN_HEADER,
    ApiError,
    CaptureHub,
    bind_servers,
    board_dirname,
    normalize_board_id,
    websdk_directory,
)
from scripts.merge_miro_sources import (
    DEFAULT_MAX_SOURCE_AGE_HOURS,
    validate_websdk_export,
)

__all__ = [
    "CaptureError",
    "CaptureRejected",
    "CaptureRequest",
    "CaptureServer",
    "CaptureServerUnavailable",
    "CaptureTimeout",
    "board_url",
    "capture_board",
    "latest_capture",
    "wait_for_capture",
]

StatusCallback = Callable[[str], None]

_STAMP_RE = re.compile(r"^websdk-(\d{8}T\d{12}Z)(?:-\d+)?\.json$")
_HEARTBEAT_SECONDS = 30.0
_POLL_SECONDS = 0.25

OPEN_HINT = (
    "Opened the board in your browser. If the export does not start within ~20 s, "
    "click the Miro2Obsidian app icon in the board's left toolbar "
    "(or 'More apps' -> the app)."
)


class CaptureError(RuntimeError):
    """Base class for Web SDK handoff failures."""


class CaptureTimeout(CaptureError):
    """No valid capture arrived before the deadline."""


class CaptureServerUnavailable(CaptureError):
    """The handoff server cannot be started, reached or is not ours."""


class CaptureRejected(CaptureError):
    """The server refused a request or the exporter's capture failed validation."""


def board_url(board_id: str) -> str:
    """Return the Miro URL that opens ``board_id``."""
    return f"https://miro.com/app/board/{quote(normalize_board_id(board_id), safe='=')}/"


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _emit(callback: StatusCallback | None, message: str) -> None:
    if callback is not None:
        callback(message)


def _board_capture_dir(board_id: str, capture_dir: Path | None) -> Path:
    root = Path(capture_dir) if capture_dir else default_capture_dir()
    return root / board_dirname(normalize_board_id(board_id))


def _capture_files(board_dir: Path) -> list[Path]:
    """Capture files newest first (names embed a sortable UTC timestamp)."""
    try:
        return sorted(
            (p for p in board_dir.glob("websdk-*.json") if p.is_file()),
            key=lambda p: p.name,
            reverse=True,
        )
    except OSError:
        return []


def _capture_time(path: Path) -> float:
    match = _STAMP_RE.match(path.name)
    if match:
        parsed = datetime.strptime(match.group(1), "%Y%m%dT%H%M%S%fZ")
        return parsed.replace(tzinfo=timezone.utc).timestamp()
    try:
        return path.stat().st_mtime
    except OSError:
        return 0.0


def _is_valid_capture(path: Path, board_id: str, max_age_hours: float) -> bool:
    try:
        with path.open("rb") as fh:
            payload = json.load(fh)
        validate_websdk_export(
            payload,
            expected_board_id=normalize_board_id(board_id),
            max_age_hours=max_age_hours,
        )
    except Exception:  # noqa: BLE001 - any failure means "not a usable capture"
        return False
    return True


def latest_capture(
    board_id: str,
    *,
    max_age_hours: float = DEFAULT_MAX_SOURCE_AGE_HOURS,
    capture_dir: Path | None = None,
) -> Path | None:
    """Return the newest stored capture of ``board_id`` that is still valid.

    "Valid" means it passes ``validate_websdk_export`` for this board,
    including freshness (``exported_at`` within ``max_age_hours``). Returns
    ``None`` when there is none. ``capture_dir`` defaults to the per-user
    capture directory (``MIRO2OBSIDIAN_CAPTURE_DIR`` overrides it).
    """
    for path in _capture_files(_board_capture_dir(board_id, capture_dir)):
        if _is_valid_capture(path, board_id, max_age_hours):
            return path
    return None


def wait_for_capture(
    board_id: str,
    *,
    timeout_seconds: float,
    since: datetime | None = None,
    capture_dir: Path | None = None,
    max_age_hours: float = DEFAULT_MAX_SOURCE_AGE_HOURS,
    on_status: StatusCallback | None = None,
    rejection_check: Callable[[], str | None] | None = None,
) -> Path:
    """Wait for a valid capture of ``board_id`` stored at or after ``since``.

    ``since`` is a timezone-aware datetime (default: now). Polls the capture
    directory; returns the validated capture path. Raises
    :class:`CaptureTimeout` after ``timeout_seconds`` and
    :class:`CaptureRejected` if ``rejection_check`` reports that the exporter
    delivered a capture that failed validation.
    """
    started = since or _utc_now()
    if started.tzinfo is None:
        raise ValueError("since must be timezone-aware")
    since_ts = started.timestamp()
    board_dir = _board_capture_dir(board_id, capture_dir)
    deadline = time.monotonic() + timeout_seconds
    begun = time.monotonic()
    next_heartbeat = begun + _HEARTBEAT_SECONDS
    seen: set[str] = set()
    while True:
        for path in _capture_files(board_dir):
            if _capture_time(path) < since_ts:
                break
            if path.name in seen:
                continue
            seen.add(path.name)
            if _is_valid_capture(path, board_id, max_age_hours):
                return path
        if rejection_check is not None:
            problem = rejection_check()
            if problem:
                raise CaptureRejected(problem)
        now = time.monotonic()
        if now >= deadline:
            raise CaptureTimeout(
                f"No capture of the board arrived within {timeout_seconds:g} s."
            )
        if now >= next_heartbeat:
            _emit(
                on_status,
                f"Still waiting for the Miro app to send the capture ({int(now - begun)} s elapsed)...",
            )
            next_heartbeat = now + _HEARTBEAT_SECONDS
        time.sleep(min(_POLL_SECONDS, max(0.0, deadline - now)))


@dataclass
class CaptureRequest:
    """An open request for a capture of one board."""

    board_id: str
    created_at: datetime = field(default_factory=_utc_now)
    _server: CaptureServer | None = field(default=None, repr=False, compare=False)

    def wait(
        self,
        *,
        timeout_seconds: float,
        on_status: StatusCallback | None = None,
    ) -> Path:
        """Wait for the capture this request asked for (see ``wait_for_capture``)."""
        if self._server is None:
            raise CaptureServerUnavailable("The capture server is closed.")
        return self._server.wait_for_capture(
            self.board_id,
            timeout_seconds=timeout_seconds,
            since=self.created_at,
            on_status=on_status,
        )

    def cancel(self) -> None:
        """Withdraw the request (idempotent)."""
        if self._server is not None:
            self._server.cancel_request(self.board_id)


class CaptureServer:
    """Run (or attach to) the Web SDK handoff server on ``localhost:<port>``.

    Use as a context manager. If the port is free the server starts in
    background threads (``mode == "owner"``). If it is held by another
    ``miro2obsidian websdk-serve`` (``GET /api/session`` answers with
    ``app == "miro2obsidian-websdk"``) this object talks to it over HTTP
    (``mode == "client"``). Any other occupant raises
    :class:`CaptureServerUnavailable`.
    """

    def __init__(
        self,
        *,
        host: str = "localhost",
        port: int = DEFAULT_PORT,
        capture_dir: Path | None = None,
        directory: Path | None = None,
        max_body_bytes: int = DEFAULT_MAX_CAPTURE_BYTES,
        pending_ttl_seconds: float = DEFAULT_PENDING_TTL_SECONDS,
        quiet: bool = True,
        http_timeout: float = 3.0,
    ) -> None:
        self.host = host
        self.port = port
        self.mode: str | None = None
        self._capture_dir = Path(capture_dir) if capture_dir else None
        self._directory = directory
        self._max_body_bytes = max_body_bytes
        self._pending_ttl_seconds = pending_ttl_seconds
        self._quiet = quiet
        self._http_timeout = http_timeout
        self._hub: CaptureHub | None = None
        self._servers: list[ThreadingHTTPServer] = []
        self._threads: list[threading.Thread] = []
        self._token = ""
        self._opener = build_opener(ProxyHandler({}))  # never route loopback via a proxy
        self._last_poll = 0.0

    # -- lifecycle ---------------------------------------------------------

    def __enter__(self) -> CaptureServer:
        self.start()
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()

    @property
    def base_url(self) -> str:
        """Origin of the server, e.g. ``http://localhost:8766``."""
        return f"http://{self.host}:{self.port}"

    @property
    def app_url(self) -> str:
        """The App URL to register in Miro."""
        return f"{self.base_url}/index.html"

    @property
    def capture_dir(self) -> Path:
        """Directory where accepted captures are stored."""
        if self._hub is not None:
            return self._hub.capture_dir
        return self._capture_dir or default_capture_dir()

    def start(self) -> CaptureServer:
        """Start the server or attach to a running one (idempotent)."""
        if self.mode is not None:
            return self
        try:
            directory = self._directory or websdk_directory()
        except FileNotFoundError as exc:
            raise CaptureServerUnavailable(str(exc)) from exc
        hub = CaptureHub(
            self._capture_dir,
            max_body_bytes=self._max_body_bytes,
            pending_ttl_seconds=self._pending_ttl_seconds,
            port=self.port,
        )
        try:
            servers = bind_servers(self.host, self.port, directory, hub, quiet=self._quiet)
        except OSError as exc:
            self._attach(exc)
            return self
        self._hub = hub
        self._servers = servers
        self.port = hub.port
        self._threads = [
            threading.Thread(target=s.serve_forever, daemon=True) for s in servers
        ]
        for thread in self._threads:
            thread.start()
        self.mode = "owner"
        return self

    def _attach(self, bind_error: OSError) -> None:
        try:
            _, session = self._http("GET", "/api/session", token=False)
        except CaptureError:
            session = None
        if not isinstance(session, dict) or session.get("app") != API_APP_NAME:
            raise CaptureServerUnavailable(
                f"Port {self.port} is already in use by another program (or an older "
                "websdk-serve without the capture API). Stop it or choose another "
                "--port."
            ) from bind_error
        if session.get("accepting") is False:
            raise CaptureServerUnavailable("The running Web SDK server is not accepting captures.")
        self._token = str(session.get("token") or "")
        self.mode = "client"

    def close(self) -> None:
        """Stop the server (owner mode) and forget the attachment."""
        if self._hub is not None:
            self._hub.accepting = False
        for server in self._servers:
            server.shutdown()
            server.server_close()
        for thread in self._threads:
            thread.join(timeout=2)
        self._servers, self._threads = [], []
        self._hub = None
        self.mode = None

    # -- HTTP client (client mode) -------------------------------------------

    def _http(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
        *,
        token: bool = True,
    ) -> tuple[int, Any]:
        data = json.dumps(body).encode("utf-8") if body is not None else None
        headers = {}
        if data is not None:
            headers["Content-Type"] = "application/json"
        if token:
            headers[TOKEN_HEADER] = self._token
        request = Request(
            f"http://127.0.0.1:{self.port}{path}", data=data, headers=headers, method=method
        )
        # The server requires a loopback Host with this port; urllib sends exactly that.
        try:
            with self._opener.open(request, timeout=self._http_timeout) as response:
                return response.status, json.loads(response.read() or b"null")
        except HTTPError as exc:
            try:
                return exc.code, json.loads(exc.read() or b"null")
            except ValueError:
                return exc.code, None
        except (URLError, OSError, ValueError) as exc:
            raise CaptureServerUnavailable(
                f"Cannot reach the Web SDK server on port {self.port}."
            ) from exc

    # -- requests ------------------------------------------------------------

    def request_capture(self, board_id: str) -> CaptureRequest:
        """Register a pending request so the Miro app exports ``board_id`` when opened."""
        self._require_started()
        board_id = normalize_board_id(board_id)
        created = _utc_now()
        if self._hub is not None:
            try:
                self._hub.register_request(board_id)
            except ApiError as exc:
                raise CaptureRejected(exc.message) from None
        else:
            status, body = self._http(
                "POST", "/api/requests", {"board_id": board_id}
            )
            if status != 200 or not isinstance(body, dict):
                message = body.get("error") if isinstance(body, dict) else None
                raise CaptureRejected(message or f"The server refused the request ({status}).")
            reported = body.get("capture_dir")
            if reported:
                self._capture_dir = Path(reported)
        return CaptureRequest(board_id, created, self)

    def cancel_request(self, board_id: str) -> None:
        """Withdraw a pending request (idempotent, ignores a vanished server)."""
        board_id = normalize_board_id(board_id)
        if self._hub is not None:
            self._hub.cancel_request(board_id)
        elif self.mode == "client":
            try:
                self._http("DELETE", f"/api/requests/{quote(board_id, safe='')}")
            except CaptureError:
                pass

    def pending_requests(self) -> list[str]:
        """Board ids that currently have an open capture request."""
        self._require_started()
        if self._hub is not None:
            return self._hub.pending_ids()
        _, session = self._http("GET", "/api/session", token=False)
        return list(session.get("pending", [])) if isinstance(session, dict) else []

    def wait_for_capture(
        self,
        board_id: str,
        *,
        timeout_seconds: float,
        since: datetime | None = None,
        on_status: StatusCallback | None = None,
    ) -> Path:
        """Wait for a validated capture of ``board_id`` newer than ``since``.

        Raises :class:`CaptureTimeout` or :class:`CaptureRejected`.
        """
        self._require_started()
        started = since or _utc_now()
        return wait_for_capture(
            board_id,
            timeout_seconds=timeout_seconds,
            since=started,
            capture_dir=self.capture_dir,
            on_status=on_status,
            rejection_check=lambda: self._rejection(board_id, started),
        )

    def latest_capture(
        self, board_id: str, *, max_age_hours: float = DEFAULT_MAX_SOURCE_AGE_HOURS
    ) -> Path | None:
        """``latest_capture`` against this server's capture directory."""
        return latest_capture(board_id, max_age_hours=max_age_hours, capture_dir=self.capture_dir)

    def _rejection(self, board_id: str, since: datetime) -> str | None:
        since_ts = since.timestamp()
        if self._hub is not None:
            found = self._hub.last_rejection(board_id)
            if found and found[0] >= since_ts:
                return f"The exporter sent a capture that failed validation: {found[1]}"
            return None
        now = time.monotonic()
        if now - self._last_poll < 1.0:
            return None
        self._last_poll = now
        try:
            status, body = self._http(
                "GET", f"/api/requests/{quote(normalize_board_id(board_id), safe='')}"
            )
        except CaptureServerUnavailable:
            return None
        rejection = body.get("rejection") if status == 200 and isinstance(body, dict) else None
        if isinstance(rejection, dict) and float(rejection.get("at") or 0) >= since_ts:
            return f"The exporter sent a capture that failed validation: {rejection.get('error')}"
        return None

    def _require_started(self) -> None:
        if self.mode is None:
            raise CaptureServerUnavailable("The capture server is not started.")


def capture_board(
    board_id: str,
    *,
    timeout_seconds: float = 300,
    open_board: bool = True,
    port: int = DEFAULT_PORT,
    on_status: StatusCallback | None = None,
    opener: Callable[[str], Any] | None = None,
    capture_dir: Path | None = None,
) -> Path:
    """Capture ``board_id`` through the Miro Web SDK app and return the stored path.

    Starts (or attaches to) the handoff server, registers a pending request,
    opens ``https://miro.com/app/board/<id>/`` with ``opener`` (default
    ``webbrowser.open``; pass ``open_board=False`` to skip) and waits up to
    ``timeout_seconds``. Human-readable progress goes to ``on_status``; payload
    contents never do. Raises :class:`CaptureTimeout`,
    :class:`CaptureServerUnavailable` or :class:`CaptureRejected`.
    """
    board_id = normalize_board_id(board_id)
    if not board_id:
        raise ValueError("board_id is required")
    with CaptureServer(port=port, capture_dir=capture_dir) as server:
        if server.mode == "owner":
            _emit(on_status, f"Capture server listening on {server.base_url} (App URL {server.app_url}).")
        else:
            _emit(on_status, f"Using the running Web SDK server on {server.base_url}.")
        request = server.request_capture(board_id)
        try:
            url = board_url(board_id)
            if open_board:
                try:
                    opened = (opener or webbrowser.open)(url)
                except Exception:  # noqa: BLE001 - a missing browser must not abort the wait
                    opened = False
                if opened is False:
                    _emit(on_status, f"Could not open a browser. Open this board yourself: {url}")
                else:
                    _emit(on_status, OPEN_HINT)
            else:
                _emit(on_status, f"Open the board in Miro to start the export: {url}")
            path = request.wait(timeout_seconds=timeout_seconds, on_status=on_status)
        finally:
            request.cancel()
        _emit(on_status, f"Capture received and validated: {path}")
        return path
