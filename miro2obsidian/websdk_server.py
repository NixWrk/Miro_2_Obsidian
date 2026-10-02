"""Static server for the Miro Web SDK app plus a loopback capture handoff API.

The Web SDK app runs inside a Miro board. Instead of making the user download
a JSON file, the app POSTs the validated capture to this process over loopback
(``/api/captures``). Other local processes can register a *pending capture
request* for a board (``/api/requests``) so the app knows it should export that
board as soon as it is opened.

Security model (see ``tools/miro_websdk_exporter/README.md``):

* the server is meant for loopback only and checks the ``Host`` header of every
  API call (DNS-rebinding defense);
* no response ever carries CORS headers, so foreign web origins cannot read the
  per-process token returned by ``GET /api/session``;
* ``Origin`` must be absent or one of the server's own origins; uploads from the
  app panel (same-origin) must carry it;
* uploads need the per-process token (constant-time compare), a JSON content
  type, and are bounded in size; the body is streamed to a temp file and only
  published (atomic rename) after ``validate_websdk_export`` accepts it;
* payload contents are never logged or echoed in error messages.
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import re
import secrets
import socket
import sys
import tempfile
import threading
import time
from datetime import datetime, timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, BinaryIO
from urllib.parse import parse_qs, unquote, urlsplit, urlunsplit

from miro2obsidian.paths import default_capture_dir
from scripts.merge_miro_sources import (
    DEFAULT_MAX_SOURCE_AGE_HOURS,
    source_board_id,
    validate_websdk_export,
)


CURRENT_ENTRYPOINT = "/index.html"
LEGACY_PATHS = {
    "/index-20260611-deep-table.html": "/index.html",
    "/index-20260727-complete-json.html": "/index.html",
    "/panel-20260611-deep-table.html": "/panel.html",
    "/panel-20260727-complete-json.html": "/panel.html",
}

API_APP_NAME = "miro2obsidian-websdk"
API_PROTOCOL = 1
TOKEN_HEADER = "X-Miro2Obsidian-Token"
DEFAULT_PORT = 8766
DEFAULT_MAX_CAPTURE_BYTES = 512 * 1024 * 1024
DEFAULT_PENDING_TTL_SECONDS = 30 * 60.0
MAX_CONTROL_BODY_BYTES = 64 * 1024
_STREAM_CHUNK = 256 * 1024
_DRAIN_LIMIT = 8 * 1024 * 1024
_LOOPBACK_HOSTNAMES = frozenset({"localhost", "127.0.0.1", "[::1]"})
_MAX_ERROR_LENGTH = 300


def resolve_request_path(path: str) -> str:
    """Serve the SDK bootstrap from Miro's selected authorization callback URI."""
    parsed = urlsplit(path)
    query = parse_qs(parsed.query, keep_blank_values=True)
    if parsed.path.rstrip("/") == "/callback" and "code" not in query:
        return urlunsplit(("", "", CURRENT_ENTRYPOINT, parsed.query, ""))
    if parsed.path in LEGACY_PATHS:
        return urlunsplit(("", "", LEGACY_PATHS[parsed.path], parsed.query, ""))
    return path


def normalize_board_id(board_id: Any) -> str:
    """Return the canonical form of a board id (URL-decoded, trimmed)."""
    return unquote(str(board_id or "")).strip()


def board_dirname(board_id: str) -> str:
    """Return a filesystem-safe directory name for a board id.

    Safe ids are kept readable; ids with other characters (``uXjVJSz4qHA=``
    contains ``=``) get unsafe characters replaced plus a short digest of the
    exact id so different ids never collide. The exact id is always stored in the
    capture JSON itself.
    """
    safe = re.sub(r"[^A-Za-z0-9_-]", "_", board_id)[:64] or "board"
    if safe != board_id:
        safe += "-" + hashlib.sha256(board_id.encode("utf-8")).hexdigest()[:8]
    return safe


class ApiError(Exception):
    """An API failure that maps to an HTTP status and a payload-free message."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


class _PendingRequest:
    __slots__ = ("board_id", "created_at", "expires_at")

    def __init__(self, board_id: str, ttl_seconds: float) -> None:
        self.board_id = board_id
        self.created_at = time.time()
        self.expires_at = time.monotonic() + ttl_seconds


class CaptureHub:
    """Thread-safe state behind the handoff API: token, pending requests, storage."""

    def __init__(
        self,
        capture_dir: Path | None = None,
        *,
        max_body_bytes: int = DEFAULT_MAX_CAPTURE_BYTES,
        pending_ttl_seconds: float = DEFAULT_PENDING_TTL_SECONDS,
        max_age_hours: float = DEFAULT_MAX_SOURCE_AGE_HOURS,
        token: str | None = None,
        port: int = DEFAULT_PORT,
    ) -> None:
        self.capture_dir = Path(capture_dir) if capture_dir else default_capture_dir()
        self.max_body_bytes = int(max_body_bytes)
        self.pending_ttl_seconds = float(pending_ttl_seconds)
        self.max_age_hours = max_age_hours
        self.token = token or secrets.token_urlsafe(32)
        self.port = port
        self.accepting = True
        self._lock = threading.Lock()
        self._pending: dict[str, _PendingRequest] = {}
        self._rejections: dict[str, tuple[float, str]] = {}

    # -- request gating ---------------------------------------------------

    def allowed_origins(self) -> frozenset[str]:
        return frozenset(
            f"http://{host}:{self.port}" for host in ("localhost", "127.0.0.1", "[::1]")
        )

    def origin_allowed(self, origin: str) -> bool:
        return origin.strip().lower() in self.allowed_origins()

    def host_allowed(self, host_header: str | None) -> bool:
        """Accept only loopback ``Host`` values with this server's port."""
        if not host_header:
            return False
        value = host_header.strip().lower()
        if value.startswith("["):
            end = value.find("]")
            if end < 0:
                return False
            hostname, rest = value[: end + 1], value[end + 1 :]
        else:
            hostname, _, port_text = value.partition(":")
            rest = f":{port_text}" if port_text or ":" in value else ""
        if hostname not in _LOOPBACK_HOSTNAMES:
            return False
        if not rest:
            return self.port == 80
        if not rest.startswith(":") or not rest[1:].isdigit():
            return False
        return int(rest[1:]) == self.port

    def token_ok(self, supplied: str | None) -> bool:
        if not supplied:
            return False
        return hmac.compare_digest(
            supplied.encode("utf-8", "replace"), self.token.encode("utf-8")
        )

    # -- pending requests -------------------------------------------------

    def _prune_locked(self) -> None:
        now = time.monotonic()
        for board_id in [b for b, r in self._pending.items() if r.expires_at <= now]:
            del self._pending[board_id]

    def pending_ids(self) -> list[str]:
        with self._lock:
            self._prune_locked()
            return sorted(self._pending)

    def register_request(self, board_id: Any, ttl_seconds: float | None = None) -> str:
        normalized = normalize_board_id(board_id)
        if not normalized or len(normalized) > 256:
            raise ApiError(400, "board_id must be a non-empty string")
        ttl = self.pending_ttl_seconds if ttl_seconds is None else float(ttl_seconds)
        if not 0 < ttl <= 24 * 3600:
            raise ApiError(400, "ttl_seconds must be between 0 and 86400")
        with self._lock:
            self._prune_locked()
            if len(self._pending) >= 64 and normalized not in self._pending:
                raise ApiError(429, "Too many pending capture requests")
            self._pending[normalized] = _PendingRequest(normalized, ttl)
            self._rejections.pop(normalized, None)
        return normalized

    def cancel_request(self, board_id: Any) -> bool:
        normalized = normalize_board_id(board_id)
        with self._lock:
            return self._pending.pop(normalized, None) is not None

    def request_status(self, board_id: Any) -> dict[str, Any]:
        normalized = normalize_board_id(board_id)
        with self._lock:
            self._prune_locked()
            rejection = self._rejections.get(normalized)
            return {
                "board_id": normalized,
                "pending": normalized in self._pending,
                "rejection": (
                    {"error": rejection[1], "at": rejection[0]} if rejection else None
                ),
            }

    def last_rejection(self, board_id: Any) -> tuple[float, str] | None:
        with self._lock:
            return self._rejections.get(normalize_board_id(board_id))

    def session_payload(self) -> dict[str, Any]:
        return {
            "app": API_APP_NAME,
            "protocol": API_PROTOCOL,
            "token": self.token,
            "pending": self.pending_ids(),
            "accepting": self.accepting,
        }

    # -- capture ingestion ------------------------------------------------

    def ingest(self, stream: BinaryIO, length: int) -> dict[str, Any]:
        """Stream ``length`` bytes to disk, validate, publish atomically.

        Raises ``ApiError`` (never including payload content) on any failure.
        """
        if not self.accepting:
            raise ApiError(503, "The capture server is shutting down")
        self.capture_dir.mkdir(parents=True, exist_ok=True)
        handle = tempfile.NamedTemporaryFile(  # noqa: SIM115 - ownership handled below
            dir=self.capture_dir, prefix=".incoming-", suffix=".tmp", delete=False
        )
        temp_path = Path(handle.name)
        published = False
        try:
            with handle:
                remaining = length
                while remaining > 0:
                    chunk = stream.read(min(_STREAM_CHUNK, remaining))
                    if not chunk:
                        raise ApiError(400, "Request body ended before Content-Length bytes")
                    handle.write(chunk)
                    remaining -= len(chunk)
            payload = self._load_json(temp_path)
            board_id = normalize_board_id(source_board_id(payload))
            if not board_id:
                self._note_rejection(None, "The capture does not identify its board")
                raise ApiError(400, "The capture does not identify its board")
            try:
                validate_websdk_export(
                    payload,
                    expected_board_id=board_id,
                    max_age_hours=self.max_age_hours,
                )
            except ValueError as exc:
                message = self._safe_message(exc)
                self._note_rejection(board_id, message)
                raise ApiError(400, message) from None
            except Exception:  # noqa: BLE001 - malformed shape, no payload echo
                message = "The capture failed validation"
                self._note_rejection(board_id, message)
                raise ApiError(400, message) from None
            items = len(payload["items"])
            final = self._publish(temp_path, board_id)
            published = True
            with self._lock:
                self._pending.pop(board_id, None)
                self._rejections.pop(board_id, None)
            return {
                "status": "accepted",
                "board_id": board_id,
                "path": str(final),
                "items": items,
            }
        finally:
            if not published:
                temp_path.unlink(missing_ok=True)

    @staticmethod
    def _load_json(path: Path) -> Any:
        try:
            with path.open("rb") as fh:
                return json.load(fh)
        except (ValueError, UnicodeDecodeError, RecursionError):
            raise ApiError(400, "The request body is not valid JSON") from None

    @staticmethod
    def _safe_message(exc: Exception) -> str:
        text = " ".join(str(exc).split())
        return (text[:_MAX_ERROR_LENGTH] or "The capture failed validation")

    def _note_rejection(self, board_id: str | None, message: str) -> None:
        if not board_id:
            return
        with self._lock:
            if board_id in self._pending:
                self._rejections[board_id] = (time.time(), message)

    def _publish(self, temp_path: Path, board_id: str) -> Path:
        board_dir = self.capture_dir / board_dirname(board_id)
        board_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        final = board_dir / f"websdk-{stamp}.json"
        counter = 0
        while final.exists():
            counter += 1
            final = board_dir / f"websdk-{stamp}-{counter}.json"
        os.replace(temp_path, final)
        return final.resolve()


class NoCacheHandler(SimpleHTTPRequestHandler):
    """Static file handler with no-cache headers and the ``/api/`` handoff."""

    server_version = "miro2obsidian-websdk"

    def _hub(self) -> CaptureHub | None:
        return getattr(self.server, "hub", None)

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        if getattr(self.server, "quiet", False):
            return
        super().log_message(format, *args)

    # -- static ----------------------------------------------------------

    def do_GET(self) -> None:  # noqa: N802
        if self._is_api():
            self._handle_api("GET")
            return
        self.path = resolve_request_path(self.path)
        super().do_GET()

    def do_HEAD(self) -> None:  # noqa: N802
        if self._is_api():
            self._send_json(405, {"status": "rejected", "error": "Method not allowed"})
            return
        self.path = resolve_request_path(self.path)
        super().do_HEAD()

    def do_POST(self) -> None:  # noqa: N802
        if self._is_api():
            self._handle_api("POST")
        else:
            self._send_json(405, {"status": "rejected", "error": "Method not allowed"})

    def do_DELETE(self) -> None:  # noqa: N802
        if self._is_api():
            self._handle_api("DELETE")
        else:
            self._send_json(405, {"status": "rejected", "error": "Method not allowed"})

    def do_OPTIONS(self) -> None:  # noqa: N802
        # No CORS preflight support by design: never send Access-Control-* headers.
        self._send_json(405, {"status": "rejected", "error": "Method not allowed"})

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    # -- API -------------------------------------------------------------

    def _is_api(self) -> bool:
        return urlsplit(self.path).path.startswith("/api/")

    def _send_json(
        self, status: int, body: dict[str, Any], *, close: bool = False
    ) -> None:
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Content-Type-Options", "nosniff")
        if status == 405:
            self.send_header("Allow", "GET, POST, DELETE")
        if close:
            self.send_header("Connection", "close")
            self.close_connection = True
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    _body_read = False

    def _reject(self, error: ApiError) -> None:
        if not self._body_read:
            self._drain_body()
        self._send_json(
            error.status, {"status": "rejected", "error": error.message}, close=True
        )

    def _content_length(self) -> int | None:
        raw = self.headers.get("Content-Length")
        if raw is None or not raw.strip().isdigit():
            return None
        return int(raw)

    def _drain_body(self) -> None:
        """Consume a bounded amount of an unread body so the client sees our reply."""
        length = self._content_length() or 0
        remaining = min(length, _DRAIN_LIMIT)
        try:
            self.connection.settimeout(5)
            while remaining > 0:
                chunk = self.rfile.read(min(_STREAM_CHUNK, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
        except OSError:
            pass

    def _gate(self, hub: CaptureHub, *, token: bool, origin_required: bool) -> None:
        if not hub.host_allowed(self.headers.get("Host")):
            raise ApiError(403, "Host not allowed")
        fetch_site = (self.headers.get("Sec-Fetch-Site") or "").lower()
        if fetch_site in {"cross-site", "same-site"}:
            raise ApiError(403, "Cross-site requests are not allowed")
        origin = self.headers.get("Origin")
        if origin is None:
            if origin_required:
                raise ApiError(403, "Origin header required")
        elif not hub.origin_allowed(origin):
            raise ApiError(403, "Origin not allowed")
        if token and not hub.token_ok(self.headers.get(TOKEN_HEADER)):
            raise ApiError(403, "Missing or invalid token")

    def _require_json(self, limit: int) -> int:
        content_type = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if content_type != "application/json":
            raise ApiError(415, "Content-Type must be application/json")
        if "chunked" in (self.headers.get("Transfer-Encoding") or "").lower():
            raise ApiError(411, "Content-Length is required")
        length = self._content_length()
        if length is None:
            raise ApiError(411, "Content-Length is required")
        if length > limit:
            raise ApiError(413, "Request body is too large")
        return length

    def _read_json_object(self, length: int) -> dict[str, Any]:
        self._body_read = True
        raw = self.rfile.read(length) if length else b""
        try:
            value = json.loads(raw)
        except (ValueError, UnicodeDecodeError):
            raise ApiError(400, "The request body is not valid JSON") from None
        if not isinstance(value, dict):
            raise ApiError(400, "The request body must be a JSON object")
        return value

    def _handle_api(self, method: str) -> None:
        hub = self._hub()
        if hub is None:
            self._reject(ApiError(404, "Not found"))
            return
        path = urlsplit(self.path).path.rstrip("/")
        try:
            if path == "/api/session":
                if method != "GET":
                    raise ApiError(405, "Method not allowed")
                self._gate(hub, token=False, origin_required=False)
                self._send_json(200, hub.session_payload())
            elif path == "/api/captures":
                if method != "POST":
                    raise ApiError(405, "Method not allowed")
                self._gate(hub, token=True, origin_required=True)
                length = self._require_json(hub.max_body_bytes)
                self.connection.settimeout(60)
                self._body_read = True
                self._send_json(200, hub.ingest(self.rfile, length), close=True)
            elif path == "/api/requests":
                if method != "POST":
                    raise ApiError(405, "Method not allowed")
                self._gate(hub, token=True, origin_required=False)
                length = self._require_json(MAX_CONTROL_BODY_BYTES)
                body = self._read_json_object(length)
                ttl = body.get("ttl_seconds")
                if ttl is not None and (isinstance(ttl, bool) or not isinstance(ttl, (int, float))):
                    raise ApiError(400, "ttl_seconds must be a number")
                board_id = hub.register_request(body.get("board_id"), ttl)
                self._send_json(
                    200,
                    {
                        "status": "pending",
                        "board_id": board_id,
                        "capture_dir": str(hub.capture_dir),
                    },
                )
            elif path.startswith("/api/requests/"):
                board_id = unquote(path[len("/api/requests/"):])
                if method not in {"GET", "DELETE"}:
                    raise ApiError(405, "Method not allowed")
                self._gate(hub, token=True, origin_required=False)
                if method == "GET":
                    self._send_json(200, hub.request_status(board_id))
                else:
                    cancelled = hub.cancel_request(board_id)
                    self._send_json(200, {"status": "cancelled" if cancelled else "absent"})
            else:
                raise ApiError(404, "Not found")
        except ApiError as error:
            self._reject(error)
        except (TimeoutError, ConnectionError):
            self.close_connection = True


class LoopbackHTTPServer(ThreadingHTTPServer):
    """IPv4 server that refuses to share its port (SO_REUSEADDR hijacks on Windows)."""

    allow_reuse_address = os.name != "nt"


class IPv6ThreadingHTTPServer(LoopbackHTTPServer):
    address_family = socket.AF_INET6

    def server_bind(self) -> None:
        self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
        super().server_bind()


def server_specs(host: str) -> list[tuple[str, type[ThreadingHTTPServer]]]:
    if host.lower() == "localhost":
        return [
            ("127.0.0.1", LoopbackHTTPServer),
            ("::1", IPv6ThreadingHTTPServer),
        ]
    server_type = IPv6ThreadingHTTPServer if ":" in host else LoopbackHTTPServer
    return [(host, server_type)]


def bind_servers(
    host: str,
    port: int,
    directory: Path,
    hub: CaptureHub | None,
    *,
    quiet: bool = False,
) -> list[ThreadingHTTPServer]:
    """Bind the loopback servers (IPv4 required, IPv6 best effort).

    ``port=0`` picks a free port; the IPv6 server and ``hub.port`` reuse it.
    Raises ``OSError`` when the primary address cannot be bound.
    """
    handler = partial(NoCacheHandler, directory=str(directory))
    specs = server_specs(host)
    primary = specs[0][1]((specs[0][0], port), handler)
    servers: list[ThreadingHTTPServer] = [primary]
    actual_port = primary.server_address[1]
    for extra_host, server_type in specs[1:]:
        try:
            servers.append(server_type((extra_host, actual_port), handler))
        except OSError:
            # IPv6 is optional on some machines; IPv4 localhost remains usable.
            pass
    if hub is not None:
        hub.port = actual_port
    for server in servers:
        server.hub = hub  # type: ignore[attr-defined]
        server.quiet = quiet  # type: ignore[attr-defined]
    return servers


def websdk_directory() -> Path:
    """Find the same static app in a checkout, wheel, or frozen executable."""
    candidates = []
    if getattr(sys, "_MEIPASS", None):
        candidates.append(Path(sys._MEIPASS) / "share" / "miro2obsidian" / "websdk")
    candidates.extend([
        Path(__file__).resolve().parents[1] / "tools" / "miro_websdk_exporter",
        Path(sys.prefix) / "share" / "miro2obsidian" / "websdk",
    ])
    required = ("index.html", "panel.html", "exporter.js", "exporter-core.js", "handoff.js")
    for directory in candidates:
        if all((directory / name).is_file() for name in required):
            return directory
    raise FileNotFoundError("The Web SDK exporter is missing from this installation.")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Serve the Miro Web SDK exporter and its capture handoff API."
    )
    parser.add_argument("--host", default="localhost")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--directory", type=Path)
    parser.add_argument(
        "--capture-dir",
        type=Path,
        help="Where received captures are stored "
        "(default: per-user app data, or $MIRO2OBSIDIAN_CAPTURE_DIR).",
    )
    parser.add_argument(
        "--max-capture-mib",
        type=int,
        default=DEFAULT_MAX_CAPTURE_BYTES // (1024 * 1024),
        help="Largest accepted capture upload in MiB (default: %(default)s).",
    )
    args = parser.parse_args(argv)

    directory = args.directory or websdk_directory()
    hub = CaptureHub(
        args.capture_dir,
        max_body_bytes=max(1, args.max_capture_mib) * 1024 * 1024,
        port=args.port,
    )
    servers = bind_servers(args.host, args.port, directory, hub)
    threads = [
        threading.Thread(target=server.serve_forever, daemon=True)
        for server in servers[1:]
    ]
    for thread in threads:
        thread.start()
    print(
        f"serving_no_cache=http://{args.host}:{hub.port}{CURRENT_ENTRYPOINT}",
        flush=True,
    )
    print(f"capture_dir={hub.capture_dir}", flush=True)
    try:
        servers[0].serve_forever()
    except KeyboardInterrupt:
        return 0
    finally:
        hub.accepting = False
        for server in servers:
            server.shutdown()
            server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
