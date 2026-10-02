from __future__ import annotations

import argparse
import ipaddress
import json
import math
import os
import secrets
import socket
import subprocess
import threading
import webbrowser
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable
from urllib.parse import parse_qs, urlencode, urlparse


DEFAULT_AUTHORIZE_URL = "https://miro.com/oauth/authorize"
DEFAULT_TOKEN_URL = "https://api.miro.com/v1/oauth/token"
TOKEN_INFO_URL = "https://api.miro.com/v1/oauth-token"
# UNVERIFIED against a live app: Miro documents token revocation under
# /v2/oauth/revoke, but the exact body shape has not been exercised here.
REVOKE_URL = "https://api.miro.com/v2/oauth/revoke"
DEFAULT_REDIRECT_URI = "http://localhost:8765/callback"
ALTERNATE_LOOPBACK_REDIRECT_URI = "http://127.0.0.1:8765/callback"
DEFAULT_SCOPES = "boards:read team:read"
DEFAULT_TIMEOUT_SECONDS = 300
DEFAULT_BROWSER = "system"
LOCAL_CONFIG_ENV = "MIRO_OAUTH_CONFIG"
LOCAL_CONFIG_NAME = ".miro_oauth.local.json"


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
    """A Miro OAuth request failed; the message never contains secrets."""

    def __init__(self, message: str, *, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code


@dataclass(frozen=True)
class TokenGrant:
    """What Miro returned for an authorization or a refresh.

    ``expires_at`` is UTC and is ``None`` for tokens that do not expire (the
    app was created without "Expire user authorization token").
    """

    access_token: str = field(repr=False)
    refresh_token: str | None = field(default=None, repr=False)
    expires_at: datetime | None = None
    scope: str | None = None
    team_id: str | None = None
    user_id: str | None = None


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _clean_id(value: Any) -> str | None:
    if value is None or isinstance(value, bool):
        return None
    text = str(value).strip()
    return text or None


def grant_from_payload(
    payload: Any, *, fallback_refresh_token: str | None = None, now: datetime | None = None
) -> TokenGrant:
    """Build a TokenGrant from a Miro token-endpoint JSON object."""
    if not isinstance(payload, dict):
        raise RuntimeError("OAuth token response was not a JSON object")
    token = payload.get("access_token")
    if not token:
        raise RuntimeError("OAuth token response did not include access_token")
    expires_at: datetime | None = None
    expires_in = payload.get("expires_in")
    if expires_in not in (None, "") and not isinstance(expires_in, bool):
        try:
            seconds = float(expires_in)
        except (TypeError, ValueError):
            seconds = None
        if seconds is not None and math.isfinite(seconds) and seconds > 0:
            expires_at = (now or _utcnow()) + timedelta(seconds=seconds)
    refresh = payload.get("refresh_token") or fallback_refresh_token
    return TokenGrant(
        access_token=str(token),
        refresh_token=str(refresh) if refresh else None,
        expires_at=expires_at,
        scope=_clean_id(payload.get("scope")),
        team_id=_clean_id(payload.get("team_id")),
        user_id=_clean_id(payload.get("user_id")),
    )


def session_oauth_config(client_id: str, client_secret: str) -> OAuthConfig:
    client_id = client_id.strip()
    client_secret = client_secret.strip()
    if not client_id or not client_secret:
        raise ValueError("Enter both the Miro Client ID and Client secret.")
    return OAuthConfig(client_id=client_id, client_secret=client_secret)


def load_local_oauth_config() -> dict[str, str]:
    candidates: list[Path] = []
    if os.environ.get(LOCAL_CONFIG_ENV):
        candidates.append(Path(str(os.environ[LOCAL_CONFIG_ENV])).expanduser())
    candidates.extend(
        [
            Path.cwd() / LOCAL_CONFIG_NAME,
            Path(__file__).resolve().parents[1] / LOCAL_CONFIG_NAME,
        ]
    )

    for path in candidates:
        if not path.is_file():
            continue
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
        if not isinstance(payload, dict):
            raise ValueError(f"OAuth config must be a JSON object: {path}")
        return {
            str(key): str(value) for key, value in payload.items() if value is not None
        }
    return {}


def config_from_env(
    *,
    client_id_env: str = "MIRO_CLIENT_ID",
    client_secret_env: str = "MIRO_CLIENT_SECRET",
    redirect_uri: str | None = None,
    scopes: str | None = None,
    authorize_url: str | None = None,
    token_url: str | None = None,
) -> OAuthConfig:
    local_config = load_local_oauth_config()
    client_id = os.environ.get(client_id_env) or local_config.get("client_id")
    client_secret = os.environ.get(client_secret_env) or local_config.get(
        "client_secret"
    )
    missing = [
        name
        for name, value in (
            (client_id_env, client_id),
            (client_secret_env, client_secret),
        )
        if not value
    ]
    if missing:
        raise ValueError(
            f"Missing OAuth environment variable(s): {', '.join(missing)}. "
            f"Set them or create ignored {LOCAL_CONFIG_NAME}."
        )
    return OAuthConfig(
        client_id=str(client_id),
        client_secret=str(client_secret),
        redirect_uri=redirect_uri
        or os.environ.get("MIRO_REDIRECT_URI")
        or local_config.get("redirect_uri")
        or DEFAULT_REDIRECT_URI,
        scopes=scopes
        or os.environ.get("MIRO_SCOPES")
        or local_config.get("scopes")
        or DEFAULT_SCOPES,
        authorize_url=authorize_url
        or os.environ.get("MIRO_AUTHORIZE_URL")
        or local_config.get("authorize_url")
        or DEFAULT_AUTHORIZE_URL,
        token_url=token_url
        or os.environ.get("MIRO_TOKEN_URL")
        or local_config.get("token_url")
        or DEFAULT_TOKEN_URL,
    )


def build_authorize_url(config: OAuthConfig, *, state: str) -> str:
    query: dict[str, str] = {
        "response_type": "code",
        "client_id": config.client_id,
        "redirect_uri": config.redirect_uri,
        "scope": config.scopes,
    }
    query["state"] = state
    return f"{config.authorize_url}?{urlencode(query)}"


def format_callback_timeout_message(config: OAuthConfig, authorize_url: str) -> str:
    lines = [
        f"Timed out waiting for Miro OAuth callback at {config.redirect_uri}.",
        "The authorization page did not redirect back to the local callback server.",
        "Check that the Miro app has this exact Redirect URI for OAuth2.0:",
        config.redirect_uri,
        "Then open or retry this authorization URL in the same browser session:",
        authorize_url,
        "Redirect URI matching is exact; localhost and 127.0.0.1 are different values.",
        "Useful loopback values to register:",
        DEFAULT_REDIRECT_URI,
        ALTERNATE_LOOPBACK_REDIRECT_URI,
    ]
    hint = callback_recovery_hint(config)
    if hint:
        lines.extend(["", hint])
    return "\n".join(lines)


def callback_recovery_hint(config: OAuthConfig) -> str | None:
    redirect = urlparse(config.redirect_uri)
    if redirect.scheme != "http" or (redirect.hostname or "").lower() != "localhost":
        return None

    port = redirect.port or 80
    alternate = redirect._replace(netloc=f"127.0.0.1:{port}").geturl()
    return "\n".join(
        [
            'If the browser shows {"error":"Not found."} at localhost, another local service is handling localhost.',
            f"Keep the full callback URL, replace only http://localhost:{port} with http://127.0.0.1:{port}, and press Enter.",
            f"This works when the helper is listening at {alternate}.",
        ]
    )


def format_callback_bind_error(
    config: OAuthConfig, port: int, bind_failures: list[tuple[str, str]]
) -> str:
    lines = [
        f"Could not start local OAuth callback server on port {port}.",
        "Another local service already owns the callback address, so Miro's browser redirect cannot reach this helper.",
    ]
    if bind_failures:
        lines.append("Bind failures:")
        lines.extend(f"- {host}:{port}: {error}" for host, error in bind_failures)
    lines.extend(
        [
            "This cannot be fixed automatically for an existing Miro app because OAuth redirect_uri values are exact.",
            f"The current app flow is using: {config.redirect_uri}",
            "Free the port, use a Miro app that also registers another loopback redirect URI, or copy the callback URL and exchange it manually.",
        ]
    )
    return "\n".join(lines)


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


def _redact(text: str, *sensitive_values: str | None) -> str:
    for sensitive in sensitive_values:
        if sensitive:
            text = text.replace(sensitive, "[redacted]")
    return text


def _safe_response_payload(response: Any, *, config: OAuthConfig, code: str) -> str:
    try:
        payload = response.json()
    except ValueError:
        payload = getattr(response, "text", "")
    return _redact(str(payload), config.client_secret, code)


def format_token_exchange_error(
    response: Any, *, config: OAuthConfig, code: str
) -> str:
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
        '<!doctype html><html><head><meta charset="utf-8">'
        f"<title>{title}</title></head><body><p>{body}</p>"
        "<script>window.close();</script></body></html>"
    ).encode("utf-8")


def _make_callback_handler(
    *,
    callback_path: str,
    expected_state: str,
    result: CallbackResult,
    event: threading.Event,
) -> type[BaseHTTPRequestHandler]:
    result_lock = threading.Lock()

    class OAuthCallbackHandler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
            parsed = urlparse(self.path)
            if parsed.path != callback_path:
                self.send_response(404)
                self.end_headers()
                self.wfile.write(b"Not found")
                return

            callback_result = parse_callback_path(self.path)
            if not callback_result.state or not secrets.compare_digest(
                callback_result.state, expected_state
            ):
                page = b"Invalid OAuth state. You can close this window and retry."
                self.send_response(400)
                self.send_header("Content-Type", "text/plain; charset=utf-8")
                self.send_header("Content-Length", str(len(page)))
                self.end_headers()
                self.wfile.write(page)
                return
            if bool(callback_result.code) == bool(callback_result.error):
                page = b"OAuth callback must contain exactly one of code or error."
                self.send_response(400)
                self.send_header("Content-Type", "text/plain; charset=utf-8")
                self.send_header("Content-Length", str(len(page)))
                self.end_headers()
                self.wfile.write(page)
                return

            with result_lock:
                if event.is_set():
                    page = b"OAuth callback was already processed."
                    self.send_response(409)
                    self.send_header("Content-Type", "text/plain; charset=utf-8")
                    self.send_header("Content-Length", str(len(page)))
                    self.end_headers()
                    self.wfile.write(page)
                    return
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
    try:
        address = ipaddress.ip_address(normalized)
    except ValueError as exc:
        raise ValueError("OAuth callback host must be a loopback address.") from exc
    if not address.is_loopback:
        raise ValueError("OAuth callback host must be a loopback address.")
    return (str(address),)


class IPv6ThreadingHTTPServer(ThreadingHTTPServer):
    address_family = socket.AF_INET6


def _make_callback_server(
    host: str, port: int, handler: type[BaseHTTPRequestHandler]
) -> ThreadingHTTPServer:
    server_type: type[ThreadingHTTPServer] = (
        IPv6ThreadingHTTPServer if ":" in host else ThreadingHTTPServer
    )
    return server_type((host, port), handler)


def yandex_browser_candidates() -> tuple[str, ...]:
    local_app_data = os.environ.get("LOCALAPPDATA", "")
    program_files = os.environ.get("ProgramFiles", "")
    program_files_x86 = os.environ.get("ProgramFiles(x86)", "")
    return tuple(
        path
        for path in (
            os.environ.get("YANDEX_BROWSER_PATH", ""),
            os.path.join(
                local_app_data, "Yandex", "YandexBrowser", "Application", "browser.exe"
            ),
            os.path.join(
                program_files, "Yandex", "YandexBrowser", "Application", "browser.exe"
            ),
            os.path.join(
                program_files_x86,
                "Yandex",
                "YandexBrowser",
                "Application",
                "browser.exe",
            ),
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
    if browser.strip().lower() in {"", "manual", "none"}:
        print(f"browser_open_skipped={browser}: manual mode")
        return False
    executable = resolve_browser_executable(browser)
    if executable:
        subprocess.Popen(
            [executable, authorize_url],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        print(f"browser_opened={browser}")
        return True
    opened = bool(webbrowser.open(authorize_url))
    print("browser_opened=system" if opened else "browser_open_failed=system")
    return opened


def _http(session: Any | None) -> Any:
    if session is not None:
        return session
    import requests

    return requests


def exchange_token_grant(
    config: OAuthConfig, code: str, *, session: Any | None = None
) -> TokenGrant:
    """Exchange an authorization code for a full grant (refresh token, expiry, team)."""
    session = _http(session)
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
    if not getattr(response, "ok", False):
        raise OAuthTokenExchangeError(
            format_token_exchange_error(response, config=config, code=code),
            status_code=getattr(response, "status_code", None),
        )
    return grant_from_payload(response.json())


def exchange_access_token(
    config: OAuthConfig, code: str, *, session: Any | None = None
) -> str:
    """Compatibility wrapper: exchange a code and return only the access token."""
    return exchange_token_grant(config, code, session=session).access_token


def refresh_token_grant(
    config: OAuthConfig | tuple[str, str],
    refresh_token: str,
    *,
    session: Any | None = None,
) -> TokenGrant:
    """Trade a refresh token for a new access token.

    ``config`` is an OAuthConfig or a ``(client_id, client_secret)`` pair.
    Miro rotates refresh tokens: the returned grant carries the new one, and
    the old one stops working, so callers must persist the result at once.
    """
    if isinstance(config, tuple):
        config = OAuthConfig(client_id=config[0], client_secret=config[1])
    if not refresh_token:
        raise ValueError("A refresh token is required.")
    session = _http(session)
    response = session.post(
        config.token_url,
        data={
            "grant_type": "refresh_token",
            "client_id": config.client_id,
            "client_secret": config.client_secret,
            "refresh_token": refresh_token,
        },
        timeout=30,
    )
    if not getattr(response, "ok", False):
        status = getattr(response, "status_code", "unknown")
        detail = _redact(
            _response_text(response), config.client_secret, refresh_token
        )
        raise OAuthTokenExchangeError(
            f"Miro token refresh failed.\nHTTP status: {status}\nResponse: {detail}",
            status_code=status if isinstance(status, int) else None,
        )
    return grant_from_payload(
        response.json(), fallback_refresh_token=refresh_token
    )


def _response_text(response: Any) -> str:
    try:
        return str(response.json())
    except ValueError:
        return str(getattr(response, "text", ""))


def fetch_token_info(access_token: str, *, session: Any | None = None) -> dict[str, Any]:
    """Ask Miro what an access token is for (team, user, scopes).

    Returns a sanitized dict: ``team_id``, ``team_name``, ``user_id``,
    ``user_name``, ``scopes`` (list) and ``type``. The token is never echoed.
    """
    session = _http(session)
    response = session.get(
        TOKEN_INFO_URL,
        headers={"Authorization": f"Bearer {access_token}", "Accept": "application/json"},
        timeout=30,
    )
    if not getattr(response, "ok", False):
        status = getattr(response, "status_code", "unknown")
        raise OAuthTokenExchangeError(
            "Miro did not accept the access token.\nHTTP status: "
            f"{status}\nResponse: {_redact(_response_text(response), access_token)}",
            status_code=status if isinstance(status, int) else None,
        )
    payload = response.json()
    if not isinstance(payload, dict):
        raise RuntimeError("Miro token info response was not a JSON object")
    team = payload.get("team") if isinstance(payload.get("team"), dict) else {}
    user = payload.get("user") if isinstance(payload.get("user"), dict) else {}
    raw_scopes = payload.get("scopes")
    if isinstance(raw_scopes, str):
        raw_scopes = raw_scopes.split()
    scopes = [str(item) for item in raw_scopes] if isinstance(raw_scopes, list) else []
    return {
        "team_id": _clean_id(team.get("id")),
        "team_name": _clean_id(team.get("name")),
        "user_id": _clean_id(user.get("id")),
        "user_name": _clean_id(user.get("name")),
        "scopes": scopes,
        "type": _clean_id(payload.get("type")),
    }


def revoke_token(
    config: OAuthConfig | tuple[str, str],
    access_token: str,
    *,
    session: Any | None = None,
) -> None:
    """Ask Miro to revoke an access token (and with it the grant).

    MUST BE VERIFIED LIVE: this posts a form body ``{client_id, client_secret,
    access_token, token}`` to ``REVOKE_URL`` (``/v2/oauth/revoke``); the exact
    parameter names Miro accepts have not been confirmed against a real app
    (both ``access_token`` and the RFC 7009 name ``token`` are sent). Callers
    must treat failure as non-fatal and still forget the token locally.
    """
    if isinstance(config, tuple):
        config = OAuthConfig(client_id=config[0], client_secret=config[1])
    session = _http(session)
    response = session.post(
        REVOKE_URL,
        data={
            "client_id": config.client_id,
            "client_secret": config.client_secret,
            "access_token": access_token,
            "token": access_token,
        },
        timeout=30,
    )
    if not getattr(response, "ok", False):
        status = getattr(response, "status_code", "unknown")
        raise OAuthTokenExchangeError(
            "Miro token revocation failed.\nHTTP status: "
            f"{status}\nResponse: "
            f"{_redact(_response_text(response), config.client_secret, access_token)}",
            status_code=status if isinstance(status, int) else None,
        )


def authorize_and_get_token(
    config: OAuthConfig,
    *,
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
    open_browser: bool = True,
    browser: str = DEFAULT_BROWSER,
    session: Any | None = None,
    on_authorize_url: Callable[[str], None] | None = None,
    report: Callable[[str], None] = print,
) -> str:
    """Compatibility wrapper around authorize_and_get_grant returning the token."""
    return authorize_and_get_grant(
        config,
        timeout_seconds=timeout_seconds,
        open_browser=open_browser,
        browser=browser,
        session=session,
        on_authorize_url=on_authorize_url,
        report=report,
    ).access_token


def authorize_and_get_grant(
    config: OAuthConfig,
    *,
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
    open_browser: bool = True,
    browser: str = DEFAULT_BROWSER,
    session: Any | None = None,
    on_authorize_url: Callable[[str], None] | None = None,
    report: Callable[[str], None] = print,
) -> TokenGrant:
    redirect = urlparse(config.redirect_uri)
    if redirect.scheme != "http" or not redirect.hostname:
        raise ValueError(
            "Only loopback http redirect URIs are supported by this helper."
        )
    if not redirect.path:
        raise ValueError("Redirect URI must include a callback path.")
    bind_hosts = callback_bind_hosts(redirect.hostname)
    if (
        isinstance(timeout_seconds, bool)
        or not isinstance(timeout_seconds, (int, float))
        or not math.isfinite(timeout_seconds)
        or timeout_seconds <= 0
    ):
        raise ValueError("OAuth callback timeout must be a positive finite number.")

    result = CallbackResult()
    event = threading.Event()
    state = secrets.token_urlsafe(32)
    handler = _make_callback_handler(
        callback_path=redirect.path,
        expected_state=state,
        result=result,
        event=event,
    )
    port = redirect.port or 80

    servers: list[tuple[str, ThreadingHTTPServer]] = []
    bind_failures: list[tuple[str, str]] = []
    for bind_host in bind_hosts:
        try:
            servers.append((bind_host, _make_callback_server(bind_host, port, handler)))
        except OSError as exc:
            bind_failures.append((bind_host, str(exc)))
            continue
    if not servers:
        raise OSError(format_callback_bind_error(config, port, bind_failures))

    try:
        for _, server in servers:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()

        bind_hosts = ", ".join(host for host, _ in servers)
        report(f"listening_on={bind_hosts}:{port}")
        for host, error in bind_failures:
            report(f"callback_bind_skipped={host}:{port} ({error})")

        authorize_url = build_authorize_url(config, state=state)
        report(f"authorization_url={authorize_url}")
        report(f"waiting_for_callback={config.redirect_uri}")
        hint = callback_recovery_hint(config)
        if hint:
            report(hint)
        if on_authorize_url is not None:
            on_authorize_url(authorize_url)
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
    return exchange_token_grant(config, result.code, session=session)


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
    parser = argparse.ArgumentParser(
        description="Run a local Miro OAuth flow and obtain an access token."
    )
    parser.add_argument("--client-id-env", default="MIRO_CLIENT_ID")
    parser.add_argument("--client-secret-env", default="MIRO_CLIENT_SECRET")
    parser.add_argument("--redirect-uri", default=DEFAULT_REDIRECT_URI)
    parser.add_argument("--scopes", default=DEFAULT_SCOPES)
    parser.add_argument("--authorize-url", default=DEFAULT_AUTHORIZE_URL)
    parser.add_argument("--token-url", default=DEFAULT_TOKEN_URL)
    parser.add_argument("--timeout-seconds", type=int, default=DEFAULT_TIMEOUT_SECONDS)
    parser.add_argument(
        "--browser",
        default=DEFAULT_BROWSER,
        help="Browser to open for OAuth. Default: system.",
    )
    parser.add_argument("--no-open-browser", action="store_true")
    parser.add_argument(
        "--code", help="Exchange an already obtained authorization code."
    )
    parser.add_argument(
        "--callback-url",
        help="Exchange a copied localhost callback URL containing ?code=...",
    )
    parser.add_argument(
        "--print-token",
        action="store_true",
        help="Print the token to stdout. Avoid in shared logs.",
    )
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
        token = exchange_manual_authorization(
            config, code=args.code, callback_url=args.callback_url
        )
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
