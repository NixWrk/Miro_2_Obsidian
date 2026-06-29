from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = REPO_ROOT / "scripts"

sys.path.insert(0, str(SCRIPTS_DIR))

from miro_oauth_token import (  # noqa: E402
    ALTERNATE_LOOPBACK_REDIRECT_URI,
    DEFAULT_REDIRECT_URI,
    LOCAL_CONFIG_ENV,
    OAuthConfig,
    OAuthTokenExchangeError,
    build_authorize_url,
    callback_bind_hosts,
    config_from_env,
    exchange_access_token,
    exchange_manual_authorization,
    extract_authorization_code,
    format_callback_timeout_message,
    format_token_exchange_error,
    open_authorize_url,
    parse_callback_path,
    resolve_browser_executable,
)


class FakeResponse:
    def __init__(self, payload: dict[str, str], *, ok: bool = True, status_code: int = 200) -> None:
        self.payload = payload
        self.ok = ok
        self.status_code = status_code

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, str]:
        return self.payload


class FakeSession:
    def __init__(self, response: FakeResponse | None = None) -> None:
        self.calls: list[dict[str, object]] = []
        self.response = response or FakeResponse({"access_token": "token-1"})

    def post(self, url: str, *, params: dict[str, str], timeout: int) -> FakeResponse:
        self.calls.append({"url": url, "params": params, "timeout": timeout})
        return self.response


class MiroOAuthTokenTests(unittest.TestCase):
    def test_build_authorize_url_encodes_required_fields(self) -> None:
        config = OAuthConfig(
            client_id="client-1",
            client_secret="secret-1",
            redirect_uri="http://localhost:8000/callback",
            scopes="boards:read boards:write",
            authorize_url="https://miro.com/oauth/authorize",
        )

        url = build_authorize_url(config, state="state-1")

        self.assertIn("response_type=code", url)
        self.assertIn("client_id=client-1", url)
        self.assertIn("redirect_uri=http%3A%2F%2Flocalhost%3A8000%2Fcallback", url)
        self.assertIn("scope=boards%3Aread+boards%3Awrite", url)
        self.assertIn("state=state-1", url)

    def test_callback_bind_hosts_handles_localhost_ipv4_and_ipv6(self) -> None:
        self.assertEqual(callback_bind_hosts("localhost"), ("127.0.0.1", "::1"))
        self.assertEqual(callback_bind_hosts("127.0.0.1"), ("127.0.0.1",))

    def test_timeout_message_contains_retry_diagnostics_without_secret(self) -> None:
        config = OAuthConfig(
            client_id="client-1",
            client_secret="secret-1",
            redirect_uri=DEFAULT_REDIRECT_URI,
        )

        message = format_callback_timeout_message(config, "https://miro.com/oauth/authorize?client_id=client-1")

        self.assertIn("http://localhost:8000/callback", message)
        self.assertIn("http://127.0.0.1:8000/callback", message)
        self.assertIn("authorization URL", message)
        self.assertIn("Redirect URI matching is exact", message)
        self.assertNotIn("secret-1", message)

    def test_config_from_env_requires_client_credentials(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            with patch("miro_oauth_token.load_local_oauth_config", return_value={}):
                with self.assertRaisesRegex(ValueError, "MIRO_CLIENT_ID, MIRO_CLIENT_SECRET"):
                    config_from_env()

    def test_config_from_env_reads_credentials_without_printing_them(self) -> None:
        with patch.dict(os.environ, {"MIRO_CLIENT_ID": "client-1", "MIRO_CLIENT_SECRET": "secret-1"}):
            with patch("miro_oauth_token.load_local_oauth_config", return_value={}):
                config = config_from_env(authorize_url="https://example.invalid/authorize")

        self.assertEqual(config.client_id, "client-1")
        self.assertEqual(config.client_secret, "secret-1")
        self.assertEqual(config.redirect_uri, "http://localhost:8000/callback")
        self.assertEqual(config.authorize_url, "https://example.invalid/authorize")
        self.assertEqual(ALTERNATE_LOOPBACK_REDIRECT_URI, "http://127.0.0.1:8000/callback")

    def test_config_from_env_reads_optional_oauth_settings_from_env(self) -> None:
        env = {
            "MIRO_CLIENT_ID": "client-1",
            "MIRO_CLIENT_SECRET": "secret-1",
            "MIRO_REDIRECT_URI": "http://127.0.0.1:8000/callback",
            "MIRO_SCOPES": "boards:read",
            "MIRO_TOKEN_URL": "https://example.invalid/token",
        }
        with patch.dict(os.environ, env, clear=True):
            with patch("miro_oauth_token.load_local_oauth_config", return_value={}):
                config = config_from_env()

        self.assertEqual(config.redirect_uri, "http://127.0.0.1:8000/callback")
        self.assertEqual(config.scopes, "boards:read")
        self.assertEqual(config.token_url, "https://example.invalid/token")

    def test_config_from_env_reads_ignored_local_oauth_config(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            config_path = Path(tmp) / ".miro_oauth.local.json"
            config_path.write_text(
                "\n".join(
                    [
                        "{",
                        '  "client_id": "local-client",',
                        '  "client_secret": "local-secret",',
                        '  "redirect_uri": "http://127.0.0.1:8000/callback",',
                        '  "scopes": "boards:read"',
                        "}",
                    ]
                ),
                encoding="utf-8",
            )
            with patch.dict(os.environ, {LOCAL_CONFIG_ENV: str(config_path)}, clear=True):
                config = config_from_env()

        self.assertEqual(config.client_id, "local-client")
        self.assertEqual(config.client_secret, "local-secret")
        self.assertEqual(config.redirect_uri, "http://127.0.0.1:8000/callback")
        self.assertEqual(config.scopes, "boards:read")

    def test_resolves_yandex_browser_from_local_app_data(self) -> None:
        expected = str(Path("C:/Users/me/AppData/Local/Yandex/YandexBrowser/Application/browser.exe"))
        with patch.dict(os.environ, {"LOCALAPPDATA": str(Path("C:/Users/me/AppData/Local"))}, clear=True):
            with patch("miro_oauth_token.os.path.isfile", side_effect=lambda path: path == expected):
                self.assertEqual(resolve_browser_executable("yandex"), expected)

    def test_open_authorize_url_uses_resolved_browser_without_system_fallback(self) -> None:
        browser = str(Path("C:/Yandex/browser.exe"))
        with patch("miro_oauth_token.resolve_browser_executable", return_value=browser):
            with patch("miro_oauth_token.subprocess.Popen") as popen:
                self.assertTrue(open_authorize_url("https://example.invalid/oauth", browser="yandex"))

        popen.assert_called_once()
        self.assertEqual(popen.call_args.args[0], [browser, "https://example.invalid/oauth"])

    def test_open_authorize_url_skips_when_yandex_is_missing(self) -> None:
        with patch("miro_oauth_token.resolve_browser_executable", return_value=None):
            with patch("miro_oauth_token.subprocess.Popen") as popen:
                self.assertFalse(open_authorize_url("https://example.invalid/oauth", browser="yandex"))

        popen.assert_not_called()

    def test_parse_callback_path_extracts_code_error_and_state(self) -> None:
        result = parse_callback_path("/callback?code=code-1&state=state-1")

        self.assertEqual(result.code, "code-1")
        self.assertIsNone(result.error)
        self.assertEqual(result.state, "state-1")

    def test_extract_authorization_code_accepts_raw_code_or_callback_url(self) -> None:
        self.assertEqual(extract_authorization_code("code-1"), "code-1")
        self.assertEqual(
            extract_authorization_code("http://localhost:8000/callback?code=code-2&state=state-1"),
            "code-2",
        )

    def test_exchange_manual_authorization_requires_one_source(self) -> None:
        config = OAuthConfig(client_id="client-1", client_secret="secret-1")

        with self.assertRaisesRegex(ValueError, "exactly one"):
            exchange_manual_authorization(config)
        with self.assertRaisesRegex(ValueError, "exactly one"):
            exchange_manual_authorization(
                config,
                code="code-1",
                callback_url="http://localhost:8000/callback?code=code-2",
            )

    def test_exchange_manual_authorization_exchanges_callback_url(self) -> None:
        config = OAuthConfig(client_id="client-1", client_secret="secret-1")
        session = FakeSession()

        token = exchange_manual_authorization(
            config,
            callback_url="http://localhost:8000/callback?code=code-1",
            session=session,
        )

        self.assertEqual(token, "token-1")
        self.assertEqual(session.calls[0]["params"]["code"], "code-1")

    def test_token_exchange_error_sanitizes_secret_and_code(self) -> None:
        config = OAuthConfig(client_id="client-1", client_secret="secret-1")
        response = FakeResponse(
            {"error": "invalid_grant", "error_description": "code-1 secret-1"},
            ok=False,
            status_code=401,
        )

        message = format_token_exchange_error(response, config=config, code="code-1")

        self.assertIn("HTTP status: 401", message)
        self.assertIn("invalid_grant", message)
        self.assertIn("[redacted]", message)
        self.assertNotIn("secret-1", message)
        self.assertNotIn("code-1", message)

    def test_exchange_access_token_reports_sanitized_oauth_error(self) -> None:
        config = OAuthConfig(client_id="client-1", client_secret="secret-1")
        session = FakeSession(FakeResponse({"error": "invalid_client"}, ok=False, status_code=401))

        with self.assertRaisesRegex(OAuthTokenExchangeError, "invalid_client"):
            exchange_access_token(config, "code-1", session=session)

    def test_exchange_access_token_posts_oauth_query_params(self) -> None:
        config = OAuthConfig(
            client_id="client-1",
            client_secret="secret-1",
            redirect_uri="http://localhost:8000/callback",
        )
        session = FakeSession()

        token = exchange_access_token(config, "code-1", session=session)

        self.assertEqual(token, "token-1")
        self.assertEqual(session.calls[0]["url"], "https://api.miro.com/v1/oauth/token")
        self.assertEqual(
            session.calls[0]["params"],
            {
                "grant_type": "authorization_code",
                "code": "code-1",
                "redirect_uri": "http://localhost:8000/callback",
                "client_id": "client-1",
                "client_secret": "secret-1",
            },
        )


if __name__ == "__main__":
    unittest.main()
