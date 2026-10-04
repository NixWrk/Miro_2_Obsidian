"""One-shot loopback form for connecting a Miro app without exposing credentials to an agent."""

from __future__ import annotations

import argparse
import html
import ipaddress
import secrets
import threading
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

from miro2obsidian.app_setup import setup_intro_html
from miro2obsidian.ui_theme import html_page, theme_script_source
from miro2obsidian.credential_store import save_access_token
from scripts.miro_oauth_token import authorize_and_get_token, session_oauth_config


@dataclass
class SetupState:
    csrf: str = field(default_factory=lambda: secrets.token_urlsafe(32))
    status: str = "waiting"
    error: str = ""
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
                "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; "
                f"script-src {theme_script_source()}",
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
                    status, error = state.status, state.error
                self._send(200, _status_page(status, error))
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
                    token = authorize_and_get_token(
                        config,
                        open_browser=False,
                        on_authorize_url=lambda url: _publish_authorize_url(state, url),
                        report=lambda _message: None,
                    )
                    save_access_token(token)
                    with state.lock:
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
    return html_page(body)


def _form_page(csrf: str) -> str:
    return _page(
        setup_intro_html() +
        '<details id="connect"><summary>I have configured my Miro app — connect</summary>'
        '<p>Copy the Client ID and Client secret from '
        'your own Miro app. They stay in this local process memory until OAuth finishes. '
        'Only the access token is saved in your operating system credential store.</p>'
        '<form method="post" action="/connect" autocomplete="off">'
        f'<input type="hidden" name="csrf" value="{html.escape(csrf, quote=True)}">'
        '<label>Client ID<input name="client_id" required autocomplete="off"></label>'
        '<label>Client secret<input name="client_secret" type="password" required autocomplete="off"></label>'
        '<button type="submit">Connect to Miro</button></form></details>'
    )


def _status_page(status: str, error: str) -> str:
    message = {
        "waiting": "Ready to connect.",
        "authorizing": "Waiting for Miro authorization. Finish it in this browser, then refresh this page.",
        "complete": "Miro is connected. The access token is in your operating system credential store.",
        "failed": "Connection failed. Check the app credentials, redirect URI, and Miro permissions.",
    }.get(status, "Unknown setup state")
    detail = f"<p>Error category: {html.escape(error)}</p>" if error else ""
    actions = {
        "waiting": "<p><a href='/'>Set up Miro app</a></p>",
        "authorizing": "<p><a href='/continue'>Continue to Miro authorization</a></p>"
                       "<p><a href='/status'>Refresh status</a></p>",
        "failed": "<p>Restart setup from the app.</p>",
        "complete": "<p>Return to the app to choose your board.</p>",
    }.get(status, "<p><a href='/status'>Refresh status</a></p>")
    return _page(
        f'<section class="status-card"><h2>Miro setup</h2><p>{message}</p>{detail}'
        f"{actions}</section>"
    )


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
