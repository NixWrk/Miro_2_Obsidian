"""One-shot loopback form for connecting a Miro app without exposing credentials to an agent."""

from __future__ import annotations

import argparse
import html
import ipaddress
import secrets
import threading
import time
import webbrowser
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable
from urllib.parse import parse_qs, urlsplit

from miro2obsidian import miro_auth
from scripts.miro_oauth_token import session_oauth_config


@dataclass
class SetupState:
    csrf: str = field(default_factory=lambda: secrets.token_urlsafe(32))
    status: str = "waiting"
    error: str = ""
    team_name: str = ""
    authorize_url: str | None = None
    lock: threading.Lock = field(default_factory=threading.Lock)
    ready: threading.Event = field(default_factory=threading.Event)


def make_handler(state: SetupState, *, origin: str) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, _format: str, *_args: object) -> None:
            return

        def _send(self, status: int, body: str, *, location: str | None = None) -> None:
            encoded = body.encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(encoded)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header(
                "Content-Security-Policy",
                "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
            )
            if location is not None:
                self.send_header("Location", location)
            self.end_headers()
            self.wfile.write(encoded)

        def do_GET(self) -> None:  # noqa: N802
            path = urlsplit(self.path).path
            if path == "/":
                self._send(200, _form_page(state.csrf))
            elif path == "/continue":
                with state.lock:
                    authorize_url = state.authorize_url
                if authorize_url is None:
                    self._send(409, _status_page("waiting", ""))
                else:
                    self._send(303, "Continue to Miro authorization", location=authorize_url)
            elif path == "/status":
                with state.lock:
                    status, error, team = state.status, state.error, state.team_name
                self._send(200, _status_page(status, error, team))
            else:
                self._send(404, "Not found")

        def do_POST(self) -> None:  # noqa: N802
            if urlsplit(self.path).path != "/connect":
                self._send(404, "Not found")
                return
            request_origin = self.headers.get("Origin")
            # Sandboxed in-app browsers may submit loopback forms with Origin: null.
            # The one-time CSRF token still prevents a different site from posting.
            if request_origin not in {origin, "null", None}:
                self._send(403, f"Origin rejected: {html.escape(request_origin)}")
                return
            if self.headers.get("Content-Type", "").split(";", 1)[0] != "application/x-www-form-urlencoded":
                self._send(415, "Unsupported form encoding")
                return
            try:
                length = int(self.headers.get("Content-Length", ""))
            except ValueError:
                length = 0
            if not 0 < length <= 8192:
                self._send(413, "Form too large or empty")
                return
            try:
                fields = parse_qs(self.rfile.read(length).decode("utf-8"), keep_blank_values=True)
                csrf = fields.get("csrf", [""])[0]
                if not secrets.compare_digest(csrf, state.csrf):
                    raise ValueError("Invalid setup session")
                config = session_oauth_config(
                    fields.get("client_id", [""])[0], fields.get("client_secret", [""])[0]
                )
            except (UnicodeError, ValueError, IndexError):
                self._send(400, "Invalid setup form. Return to the local setup page and retry.")
                return

            with state.lock:
                if state.status != "waiting":
                    self._send(409, "Setup has already started")
                    return
                state.status = "authorizing"

            def work() -> None:
                try:
                    connection = miro_auth.connect_with_credentials(
                        config.client_id,
                        config.client_secret,
                        open_browser=False,
                        on_authorize_url=lambda url: _publish_authorize_url(state, url),
                        report=lambda _message: None,
                    )
                    with state.lock:
                        state.team_name = connection.team_name or ""
                        state.status = "complete"
                except Exception as exc:  # noqa: BLE001 - never expose credentials in an error
                    with state.lock:
                        state.status = "failed"
                        state.error = type(exc).__name__
                finally:
                    state.ready.set()

            threading.Thread(target=work, daemon=True).start()
            if not state.ready.wait(10):
                self._send(202, _status_page("authorizing", ""))
                return
            with state.lock:
                authorize_url, status, error = state.authorize_url, state.status, state.error
            if authorize_url is not None:
                self._send(303, "Continue to Miro authorization", location=authorize_url)
            else:
                self._send(503, _status_page(status, error))

    return Handler


def _publish_authorize_url(state: SetupState, url: str) -> None:
    with state.lock:
        state.authorize_url = url
    state.ready.set()


def _page(body: str) -> str:
    return (
        '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        '<title>Connect Miro locally</title><style>'
        'body{font:16px system-ui;max-width:34rem;margin:3rem auto;padding:0 1rem}'
        'label{display:block;margin:1rem 0}input{display:block;width:100%;box-sizing:border-box;padding:.6rem}'
        'button{padding:.7rem 1rem}</style></head><body>' + body + '</body></html>'
    )


def _form_page(csrf: str) -> str:
    return _page(
        '<h1>Connect your Miro app</h1><p>Copy the Client ID and Client secret from '
        'your own Miro app. After you authorize in Miro, the connection (access and refresh '
        'tokens plus your Client ID and Client secret, so tokens can renew without you) is '
        'saved only in your operating system credential store, never in a file.</p>'
        '<form method="post" action="/connect" autocomplete="off">'
        f'<input type="hidden" name="csrf" value="{html.escape(csrf, quote=True)}">'
        '<label>Client ID<input name="client_id" required autocomplete="off"></label>'
        '<label>Client secret<input name="client_secret" type="password" required autocomplete="off"></label>'
        '<button type="submit">Connect to Miro</button></form>'
    )


def _status_page(status: str, error: str, team_name: str = "") -> str:
    team = f" to team {html.escape(team_name)}" if team_name else ""
    message = {
        "waiting": "Ready to connect.",
        "authorizing": "Waiting for Miro authorization. Finish it in this browser, then refresh this page.",
        "complete": f"Miro is connected{team}. The connection is saved in your operating system credential store.",
        "failed": "Connection failed. Check the app credentials, redirect URI, and Miro permissions.",
    }.get(status, "Unknown setup state")
    detail = f"<p>Error category: {html.escape(error)}</p>" if error else ""
    return _page(
        f"<h1>Miro setup</h1><p>{message}</p>{detail}"
        "<p><a href='/continue'>Continue to Miro authorization</a></p>"
        "<p><a href='/status'>Refresh status</a></p>"
    )


def run_form(
    *,
    host: str = "127.0.0.1",
    port: int = 0,
    open_browser: bool = True,
    timeout_seconds: float = 600,
    report: Callable[[str], None] = lambda _message: None,
) -> SetupState:
    """Serve the setup form until the connection completes, fails or times out.

    The form is the same one ``setup-serve`` runs; this variant stops by itself
    so a command can open it, wait and report. ``report`` receives the form URL
    (never a credential). Returns the final :class:`SetupState`
    (``status`` is ``complete``, ``failed`` or, on timeout, ``waiting`` /
    ``authorizing``).
    """
    if not ipaddress.ip_address(host).is_loopback:
        raise ValueError("The setup form must listen on a loopback address.")
    state = SetupState()
    server = ThreadingHTTPServer((host, port), BaseHTTPRequestHandler)
    origin = f"http://{host}:{server.server_address[1]}"
    # The handler needs the final origin, which port 0 only reveals after binding.
    server.RequestHandlerClass = make_handler(state, origin=origin)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    url = f"{origin}/"
    report(url)
    if open_browser:
        try:
            webbrowser.open(url)
        except Exception:  # noqa: BLE001 - the URL was reported; the person can open it
            pass
    deadline = time.monotonic() + timeout_seconds
    try:
        while time.monotonic() < deadline:
            with state.lock:
                if state.status in {"complete", "failed"}:
                    break
            time.sleep(0.25)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
    return state


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Connect a Miro app through a local browser form.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8767)
    args = parser.parse_args(argv)
    if not ipaddress.ip_address(args.host).is_loopback:
        parser.error("The setup form must listen on a loopback address.")
    origin = f"http://{args.host}:{args.port}"
    server = ThreadingHTTPServer((args.host, args.port), make_handler(SetupState(), origin=origin))
    print(f"local_miro_setup={origin}/", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        return 0
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
