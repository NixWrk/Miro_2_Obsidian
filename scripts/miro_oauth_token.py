from __future__ import annotations

import argparse
import os
import socket
import subprocess
import threading
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlencode, urlparse


DEFAULT_AUTHORIZE_URL = "https://miro.com/oauth/authorize"
DEFAULT_TOKEN_URL = "https://api.miro.com/v1/oauth/token"
DEFAULT_REDIRECT_URI = "http://127.0.0.1:8000/callback"
DEFAULT_SCOPES = "boards:read boards:write team:read"
DEFAULT_TIMEOUT_SECONDS = 300
DEFAULT_BROWSER = "yandex"


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


class OAuthTokenExchangeError(RuntimeError):
    pass


def config_from_env(
    *,
    client_id_env: str = "MIRO_CLIENT_ID",
    client_secret_env: str = "MIRO_CLIENT_SECRET",
    redirect_uri: str | None = None,
    scopes: str | None = None,
    authorize_url: str | None = None,
    token_url: str | None = None,
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
        authorize_url=authorize_url or DEFAULT_AUTHORIZE_URL,
        token_url=token_url or DEFAULT_TOKEN_URL,
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


def format_callback_timeout_message(config: OAuthConfig, authorize_url: str) -> str:
    return "\n".join(
        [
            f"Timed out waiting for Miro OAuth callback at {config.redirect_uri}.",
            "The authorization page did not redirect back to the local callback server.",
            "Check that the Miro app has this exact Redirect URI for OAuth2.0:",
            config.redirect_uri,
            "Then open or retry this authorization URL in the same browser session:",
            authorize_url,
            "If this app still has only the old localhost redirect registered, add this exact URI too:",
            DEFAULT_REDIRECT_URI,
        ]
    )


def parse_callback_path(path: str) -> CallbackResult:
    parsed = urlparse(path)
    params = parse_qs(parsed.query)
    return CallbackResult(
        code=(params.get("code") or [None])[0],
        error=(params.get("error") or [None])[0],
        state=(params.get("state") or [None])[0],
    )


def extract_authorization_code(value: str) -> str:
    candidate = value.strip()
    if not candidate:
        raise ValueError("Authorization code or callback URL is empty")

    if "?" in candidate or candidate.startswith(("http://", "https://")):
        result = parse_callback_path(candidate)
        if result.error:
            raise RuntimeError(f"Miro OAuth callback returned error: {result.error}")
        if not result.code:
            raise ValueError("Callback URL did not include a code query parameter")
        return result.code

    return candidate


def _safe_response_payload(response: Any, *, config: OAuthConfig, code: str) -> str:
    try:
        payload = response.json()
    except ValueError:
        payload = getattr(response, "text", "")

    text = str(payload)
    for sensitive in (config.client_secret, code):
        if sensitive:
            text = text.replace(sensitive, "[redacted]")
    return text


def format_token_exchange_error(response: Any, *, config: OAuthConfig, code: str) -> str:
    status_code = getattr(response, "status_code", "unknown")
    payload = _safe_response_payload(response, config=config, code=code)
    hints = [
        "Miro OAuth token exchange failed.",
        f"HTTP status: {status_code}",
        f"Response: {payload}",
        "Most common causes:",
        "- invalid_client: check MIRO_CLIENT_ID/MIRO_CLIENT_SECRET and rotate the secret if it was exposed.",
        "- invalid_grant: request a fresh authorization code; codes are short-lived and single-use.",
        "- redirect_uri mismatch: exchange must use the same redirect_uri that was used for authorization.",
    ]
    return "\n".join(hints)


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


def callback_bind_hosts(redirect_hostname: str) -> tuple[str, ...]:
    normalized = redirect_hostname.strip("[]").lower()
    if normalized == "localhost":
        return ("127.0.0.1", "::1")
    return (redirect_hostname,)


class IPv6ThreadingHTTPServer(ThreadingHTTPServer):
    address_family = socket.AF_INET6


def _make_callback_server(host: str, port: int, handler: type[BaseHTTPRequestHandler]) -> ThreadingHTTPServer:
    server_type: type[ThreadingHTTPServer] = IPv6ThreadingHTTPServer if ":" in host else ThreadingHTTPServer
    return server_type((host, port), handler)


def yandex_browser_candidates() -> tuple[str, ...]:
    local_app_data = os.environ.get("LOCALAPPDATA", "")
    program_files = os.environ.get("ProgramFiles", "")
    program_files_x86 = os.environ.get("ProgramFiles(x86)", "")
    return tuple(
        path
        for path in (
            os.environ.get("YANDEX_BROWSER_PATH", ""),
            os.path.join(local_app_data, "Yandex", "YandexBrowser", "Application", "browser.exe"),
            os.path.join(program_files, "Yandex", "YandexBrowser", "Application", "browser.exe"),
            os.path.join(program_files_x86, "Yandex", "YandexBrowser", "Application", "browser.exe"),
        )
        if path
    )


def resolve_browser_executable(browser: str) -> str | None:
    normalized = browser.strip().lower()
    if normalized in {"", "manual", "none"}:
        return None
    if normalized in {"yandex", "yandex-browser", "yandexbrowser"}:
        for candidate in yandex_browser_candidates():
            if os.path.isfile(candidate):
                return candidate
        return None
    if os.path.isfile(browser):
        return browser
    return None


def open_authorize_url(authorize_url: str, *, browser: str = DEFAULT_BROWSER) -> bool:
    executable = resolve_browser_executable(browser)
    if not executable:
        print(f"browser_open_skipped={browser}: executable not found")
        return False
    subprocess.Popen([executable, authorize_url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print(f"browser_opened={browser}")
    return True


def exchange_access_token(config: OAuthConfig, code: str, *, session: Any | None = None) -> str:
    if session is None:
        import requests

        session = requests

    response = session.post(
        config.token_url,
        params={
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": config.redirect_uri,
            "client_id": config.client_id,
            "client_secret": config.client_secret,
        },
        timeout=30,
    )
    if not getattr(response, "ok", False):
        raise OAuthTokenExchangeError(format_token_exchange_error(response, config=config, code=code))
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
    browser: str = DEFAULT_BROWSER,
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

    servers: list[tuple[str, ThreadingHTTPServer]] = []
    bind_failures: list[tuple[str, str]] = []
    for bind_host in callback_bind_hosts(redirect.hostname):
        try:
            servers.append((bind_host, _make_callback_server(bind_host, port, handler)))
        except OSError as exc:
            bind_failures.append((bind_host, str(exc)))
            continue
    if not servers:
        raise OSError(f"Could not start local OAuth callback server on port {port}")

    try:
        for _, server in servers:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()

        bind_hosts = ", ".join(host for host, _ in servers)
        print(f"listening_on={bind_hosts}:{port}")
        for host, error in bind_failures:
            print(f"callback_bind_skipped={host}:{port} ({error})")

        authorize_url = build_authorize_url(config)
        print(f"authorization_url={authorize_url}")
        print(f"waiting_for_callback={config.redirect_uri}")
        if open_browser:
            open_authorize_url(authorize_url, browser=browser)

        if not event.wait(timeout_seconds):
            raise TimeoutError(format_callback_timeout_message(config, authorize_url))
    finally:
        for _, server in servers:
            server.shutdown()
            server.server_close()

    if result.error:
        raise RuntimeError(f"Miro OAuth callback returned error: {result.error}")
    if not result.code:
        raise RuntimeError("Miro OAuth callback did not include a code")
    return exchange_access_token(config, result.code, session=session)


def exchange_manual_authorization(
    config: OAuthConfig,
    *,
    code: str | None = None,
    callback_url: str | None = None,
    session: Any | None = None,
) -> str:
    if bool(code) == bool(callback_url):
        raise ValueError("Pass exactly one of code or callback_url")
    authorization_code = extract_authorization_code(code or callback_url or "")
    return exchange_access_token(config, authorization_code, session=session)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run a local Miro OAuth flow and obtain an access token.")
    parser.add_argument("--client-id-env", default="MIRO_CLIENT_ID")
    parser.add_argument("--client-secret-env", default="MIRO_CLIENT_SECRET")
    parser.add_argument("--redirect-uri", default=DEFAULT_REDIRECT_URI)
    parser.add_argument("--scopes", default=DEFAULT_SCOPES)
    parser.add_argument("--authorize-url", default=DEFAULT_AUTHORIZE_URL)
    parser.add_argument("--token-url", default=DEFAULT_TOKEN_URL)
    parser.add_argument("--timeout-seconds", type=int, default=DEFAULT_TIMEOUT_SECONDS)
    parser.add_argument("--browser", default=DEFAULT_BROWSER, help="Browser to open for OAuth. Default: yandex.")
    parser.add_argument("--no-open-browser", action="store_true")
    parser.add_argument("--code", help="Exchange an already obtained authorization code.")
    parser.add_argument("--callback-url", help="Exchange a copied localhost callback URL containing ?code=...")
    parser.add_argument("--print-token", action="store_true", help="Print the token to stdout. Avoid in shared logs.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    config = config_from_env(
        client_id_env=args.client_id_env,
        client_secret_env=args.client_secret_env,
        redirect_uri=args.redirect_uri,
        scopes=args.scopes,
        authorize_url=args.authorize_url,
        token_url=args.token_url,
    )
    if args.code or args.callback_url:
        token = exchange_manual_authorization(config, code=args.code, callback_url=args.callback_url)
    else:
        token = authorize_and_get_token(
            config,
            timeout_seconds=args.timeout_seconds,
            open_browser=not args.no_open_browser,
            browser=args.browser,
        )
    if args.print_token:
        print(token)
    else:
        print("access_token=obtained")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
