from __future__ import annotations

import argparse
import os
import threading
import webbrowser
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlencode, urlparse


DEFAULT_AUTHORIZE_URL = "https://miro.com/oauth/authorize"
DEFAULT_TOKEN_URL = "https://api.miro.com/v1/oauth/token"
DEFAULT_REDIRECT_URI = "http://localhost:8000/callback"
DEFAULT_SCOPES = "boards:read boards:write team:read"
DEFAULT_TIMEOUT_SECONDS = 300


@dataclass(frozen=True)
class OAuthConfig:
    client_id: str
    client_secret: str
    redirect_uri: str = DEFAULT_REDIRECT_URI
    scopes: str = DEFAULT_SCOPES
    authorize_url: str = DEFAULT_AUTHORIZE_URL
    token_url: str = DEFAULT_TOKEN_URL


@dataclass
class CallbackResult:
    code: str | None = None
    error: str | None = None
    state: str | None = None


def config_from_env(
    *,
    client_id_env: str = "MIRO_CLIENT_ID",
    client_secret_env: str = "MIRO_CLIENT_SECRET",
    redirect_uri: str | None = None,
    scopes: str | None = None,
) -> OAuthConfig:
    client_id = os.environ.get(client_id_env)
    client_secret = os.environ.get(client_secret_env)
    missing = [name for name, value in ((client_id_env, client_id), (client_secret_env, client_secret)) if not value]
    if missing:
        raise ValueError(f"Missing OAuth environment variable(s): {', '.join(missing)}")
    return OAuthConfig(
        client_id=str(client_id),
        client_secret=str(client_secret),
        redirect_uri=redirect_uri or DEFAULT_REDIRECT_URI,
        scopes=scopes or DEFAULT_SCOPES,
    )


def build_authorize_url(config: OAuthConfig, *, state: str | None = None) -> str:
    query: dict[str, str] = {
        "response_type": "code",
        "client_id": config.client_id,
        "redirect_uri": config.redirect_uri,
        "scope": config.scopes,
    }
    if state:
        query["state"] = state
    return f"{config.authorize_url}?{urlencode(query)}"


def parse_callback_path(path: str) -> CallbackResult:
    parsed = urlparse(path)
    params = parse_qs(parsed.query)
    return CallbackResult(
        code=(params.get("code") or [None])[0],
        error=(params.get("error") or [None])[0],
        state=(params.get("state") or [None])[0],
    )


def _callback_page(result: CallbackResult) -> bytes:
    if result.error:
        title = "Miro authorization failed"
        body = "Authorization failed. You can close this window and retry from the terminal."
    else:
        title = "Miro authorization complete"
        body = "Authorization complete. You can close this window."
    return (
        "<!doctype html><html><head><meta charset=\"utf-8\">"
        f"<title>{title}</title></head><body><p>{body}</p>"
        "<script>window.close();</script></body></html>"
    ).encode("utf-8")


def _make_callback_handler(
    *,
    callback_path: str,
    result: CallbackResult,
    event: threading.Event,
) -> type[BaseHTTPRequestHandler]:
    class OAuthCallbackHandler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
            parsed = urlparse(self.path)
            if parsed.path != callback_path:
                self.send_response(404)
                self.end_headers()
                self.wfile.write(b"Not found")
                return

            callback_result = parse_callback_path(self.path)
            result.code = callback_result.code
            result.error = callback_result.error
            result.state = callback_result.state
            event.set()

            page = _callback_page(result)
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(page)))
            self.end_headers()
            self.wfile.write(page)

        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - BaseHTTPRequestHandler API
            return

    return OAuthCallbackHandler


def exchange_access_token(config: OAuthConfig, code: str, *, session: Any | None = None) -> str:
    if session is None:
        import requests

        session = requests

    response = session.post(
        config.token_url,
        data={
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": config.redirect_uri,
            "client_id": config.client_id,
            "client_secret": config.client_secret,
        },
        timeout=30,
    )
    response.raise_for_status()
    payload = response.json()
    token = payload.get("access_token")
    if not token:
        raise RuntimeError("OAuth token response did not include access_token")
    return str(token)


def authorize_and_get_token(
    config: OAuthConfig,
    *,
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
    open_browser: bool = True,
    session: Any | None = None,
) -> str:
    redirect = urlparse(config.redirect_uri)
    if redirect.scheme != "http" or not redirect.hostname:
        raise ValueError("Only local http redirect URIs are supported by this helper.")
    if not redirect.path:
        raise ValueError("Redirect URI must include a callback path.")

    result = CallbackResult()
    event = threading.Event()
    handler = _make_callback_handler(callback_path=redirect.path, result=result, event=event)
    port = redirect.port or 80

    with ThreadingHTTPServer((redirect.hostname, port), handler) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        authorize_url = build_authorize_url(config)
        if open_browser:
            webbrowser.open(authorize_url)
        else:
            print(f"authorization_url={authorize_url}")

        if not event.wait(timeout_seconds):
            server.shutdown()
            raise TimeoutError("Timed out waiting for Miro OAuth callback")

        server.shutdown()

    if result.error:
        raise RuntimeError(f"Miro OAuth callback returned error: {result.error}")
    if not result.code:
        raise RuntimeError("Miro OAuth callback did not include a code")
    return exchange_access_token(config, result.code, session=session)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run a local Miro OAuth flow and obtain an access token.")
    parser.add_argument("--client-id-env", default="MIRO_CLIENT_ID")
    parser.add_argument("--client-secret-env", default="MIRO_CLIENT_SECRET")
    parser.add_argument("--redirect-uri", default=DEFAULT_REDIRECT_URI)
    parser.add_argument("--scopes", default=DEFAULT_SCOPES)
    parser.add_argument("--timeout-seconds", type=int, default=DEFAULT_TIMEOUT_SECONDS)
    parser.add_argument("--no-open-browser", action="store_true")
    parser.add_argument("--print-token", action="store_true", help="Print the token to stdout. Avoid in shared logs.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    config = config_from_env(
        client_id_env=args.client_id_env,
        client_secret_env=args.client_secret_env,
        redirect_uri=args.redirect_uri,
        scopes=args.scopes,
    )
    token = authorize_and_get_token(
        config,
        timeout_seconds=args.timeout_seconds,
        open_browser=not args.no_open_browser,
    )
    if args.print_token:
        print(token)
    else:
        print("access_token=obtained")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
