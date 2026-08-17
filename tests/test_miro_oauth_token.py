from __future__ import annotations

import os
import threading
import unittest
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import urlopen
from unittest.mock import patch



from scripts import miro_oauth_token as oauth
from scripts.miro_oauth_token import (  # noqa: E402
    ALTERNATE_LOOPBACK_REDIRECT_URI,
    DEFAULT_REDIRECT_URI,
    DEFAULT_SCOPES,
    LOCAL_CONFIG_ENV,
    OAuthConfig,
    OAuthTokenExchangeError,
    build_authorize_url,
    callback_bind_hosts,
    callback_recovery_hint,
    config_from_env,
    exchange_access_token,
    exchange_manual_authorization,
    extract_authorization_code,
    format_callback_bind_error,
    format_callback_timeout_message,
    format_token_exchange_error,
    open_authorize_url,
    parse_callback_path,
    resolve_browser_executable,
)


class FakeResponse:
    def __init__(
        self, payload: dict[str, str], *, ok: bool = True, status_code: int = 200
    ) -> None:
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

    def post(self, url: str, *, data: dict[str, str], timeout: int) -> FakeResponse:
        self.calls.append({"url": url, "data": data, "timeout": timeout})
        return self.response


class MiroOAuthTokenTests(unittest.TestCase):
    def test_default_browser_is_system_browser(self) -> None:
        self.assertEqual(oauth.DEFAULT_BROWSER, "system")
    def test_default_scopes_are_read_only(self) -> None:
        self.assertEqual(DEFAULT_SCOPES, "boards:read team:read")

    def test_build_authorize_url_encodes_required_fields(self) -> None:
        config = OAuthConfig(
            client_id="client-1",
            client_secret="secret-1",
            redirect_uri="http://localhost:8765/callback",
            scopes="boards:read boards:write",
            authorize_url="https://miro.com/oauth/authorize",
        )

        url = build_authorize_url(config, state="state-1")

        self.assertIn("response_type=code", url)
        self.assertIn("client_id=client-1", url)
        self.assertIn("redirect_uri=http%3A%2F%2Flocalhost%3A8765%2Fcallback", url)
        self.assertIn("scope=boards%3Aread+boards%3Awrite", url)
        self.assertIn("state=state-1", url)

    def test_callback_bind_hosts_handles_localhost_ipv4_and_ipv6(self) -> None:
        self.assertEqual(callback_bind_hosts("localhost"), ("127.0.0.1", "::1"))
        self.assertEqual(callback_bind_hosts("127.0.0.1"), ("127.0.0.1",))

    def test_callback_bind_hosts_rejects_non_loopback_hosts(self) -> None:
        for hostname in ("0.0.0.0", "192.0.2.1", "example.invalid"):
            with self.subTest(hostname=hostname):
                with self.assertRaisesRegex(ValueError, "loopback"):
                    callback_bind_hosts(hostname)

    def test_timeout_message_contains_retry_diagnostics_without_secret(self) -> None:
        config = OAuthConfig(
            client_id="client-1",
            client_secret="secret-1",
            redirect_uri=DEFAULT_REDIRECT_URI,
        )

        message = format_callback_timeout_message(
            config, "https://miro.com/oauth/authorize?client_id=client-1"
        )

        self.assertIn("http://localhost:8765/callback", message)
        self.assertIn("http://127.0.0.1:8765/callback", message)
        self.assertIn("authorization URL", message)
        self.assertIn("Redirect URI matching is exact", message)
        self.assertIn('{"error":"Not found."}', message)
        self.assertNotIn("secret-1", message)

    def test_callback_recovery_hint_only_for_localhost_redirect(self) -> None:
        hint = callback_recovery_hint(
            OAuthConfig(client_id="client-1", client_secret="secret-1")
        )

        self.assertIsNotNone(hint)
        self.assertIn("127.0.0.1:8765", hint or "")
        self.assertIn("another local service", hint or "")
        self.assertIsNone(
            callback_recovery_hint(
                OAuthConfig(
                    client_id="client-1",
                    client_secret="secret-1",
                    redirect_uri="http://127.0.0.1:8765/callback",
                )
            )
        )

    def test_callback_bind_error_explains_why_it_is_not_automatic(self) -> None:
        message = format_callback_bind_error(
            OAuthConfig(client_id="client-1", client_secret="secret-1"),
            8765,
            [("127.0.0.1", "address already in use")],
        )

        self.assertIn("already owns the callback address", message)
        self.assertIn("cannot be fixed automatically", message)
        self.assertIn("redirect_uri values are exact", message)
        self.assertIn("127.0.0.1:8765", message)
        self.assertNotIn("secret-1", message)

    def test_config_from_env_requires_client_credentials(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            with patch("scripts.miro_oauth_token.load_local_oauth_config", return_value={}):
                with self.assertRaisesRegex(
                    ValueError, "MIRO_CLIENT_ID, MIRO_CLIENT_SECRET"
                ):
                    config_from_env()

    def test_config_from_env_reads_credentials_without_printing_them(self) -> None:
        with patch.dict(
            os.environ, {"MIRO_CLIENT_ID": "client-1", "MIRO_CLIENT_SECRET": "secret-1"}
        ):
            with patch("scripts.miro_oauth_token.load_local_oauth_config", return_value={}):
                config = config_from_env(
                    authorize_url="https://example.invalid/authorize"
                )

        self.assertEqual(config.client_id, "client-1")
        self.assertEqual(config.client_secret, "secret-1")
        self.assertEqual(config.redirect_uri, "http://localhost:8765/callback")
        self.assertEqual(config.authorize_url, "https://example.invalid/authorize")
        self.assertEqual(
            ALTERNATE_LOOPBACK_REDIRECT_URI, "http://127.0.0.1:8765/callback"
        )

    def test_config_from_env_reads_optional_oauth_settings_from_env(self) -> None:
        env = {
            "MIRO_CLIENT_ID": "client-1",
            "MIRO_CLIENT_SECRET": "secret-1",
            "MIRO_REDIRECT_URI": "http://127.0.0.1:8765/callback",
            "MIRO_SCOPES": "boards:read",
            "MIRO_TOKEN_URL": "https://example.invalid/token",
        }
        with patch.dict(os.environ, env, clear=True):
            with patch("scripts.miro_oauth_token.load_local_oauth_config", return_value={}):
                config = config_from_env()

        self.assertEqual(config.redirect_uri, "http://127.0.0.1:8765/callback")
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
                        '  "redirect_uri": "http://127.0.0.1:8765/callback",',
                        '  "scopes": "boards:read"',
                        "}",
                    ]
                ),
                encoding="utf-8",
            )
            with patch.dict(
                os.environ, {LOCAL_CONFIG_ENV: str(config_path)}, clear=True
            ):
                config = config_from_env()

        self.assertEqual(config.client_id, "local-client")
        self.assertEqual(config.client_secret, "local-secret")
        self.assertEqual(config.redirect_uri, "http://127.0.0.1:8765/callback")
        self.assertEqual(config.scopes, "boards:read")

    def test_resolves_yandex_browser_from_local_app_data(self) -> None:
        expected = str(
            Path(
                "C:/Users/me/AppData/Local/Yandex/YandexBrowser/Application/browser.exe"
            )
        )
        with patch.dict(
            os.environ,
            {"LOCALAPPDATA": str(Path("C:/Users/me/AppData/Local"))},
            clear=True,
        ):
            with patch(
                "scripts.miro_oauth_token.os.path.isfile",
                side_effect=lambda path: path == expected,
            ):
                self.assertEqual(resolve_browser_executable("yandex"), expected)

    def test_open_authorize_url_uses_resolved_browser(self) -> None:
        browser = str(Path("C:/Yandex/browser.exe"))
        with patch("scripts.miro_oauth_token.resolve_browser_executable", return_value=browser):
            with patch("scripts.miro_oauth_token.subprocess.Popen") as popen:
                with patch("scripts.miro_oauth_token.webbrowser.open") as system_browser:
                    self.assertTrue(
                        open_authorize_url(
                            "https://example.invalid/oauth", browser="yandex"
                        )
                    )

        popen.assert_called_once()
        self.assertEqual(
            popen.call_args.args[0], [browser, "https://example.invalid/oauth"]
        )
        system_browser.assert_not_called()

    def test_open_authorize_url_falls_back_to_system_browser(self) -> None:
        with patch("scripts.miro_oauth_token.resolve_browser_executable", return_value=None):
            with patch("scripts.miro_oauth_token.subprocess.Popen") as popen:
                with patch(
                    "scripts.miro_oauth_token.webbrowser.open", return_value=True
                ) as system_browser:
                    self.assertTrue(
                        open_authorize_url(
                            "https://example.invalid/oauth", browser="yandex"
                        )
                    )

        popen.assert_not_called()
        system_browser.assert_called_once_with("https://example.invalid/oauth")

    def test_parse_callback_path_extracts_code_error_and_state(self) -> None:
        result = parse_callback_path("/callback?code=code-1&state=state-1")

        self.assertEqual(result.code, "code-1")
        self.assertIsNone(result.error)
        self.assertEqual(result.state, "state-1")

    def test_callback_rejects_wrong_state_without_finishing_flow(self) -> None:
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
        try:
            with self.assertRaises(HTTPError) as error:
                urlopen(
                    f"http://127.0.0.1:{port}/callback?code=bad&state=wrong", timeout=2
                )
            self.assertEqual(error.exception.code, 400)
            self.assertFalse(event.is_set())
            self.assertIsNone(result.code)

            with urlopen(
                f"http://127.0.0.1:{port}/callback?code=good&state=expected-state",
                timeout=2,
            ) as response:
                self.assertEqual(response.status, 200)
            self.assertTrue(event.wait(1))
            self.assertEqual(result.code, "good")
        finally:
            server.shutdown()
            server.server_close()

    def test_authorize_generates_state_and_uses_it_for_url_and_callback(self) -> None:
        class FakeServer:
            def serve_forever(self) -> None:
                return None

            def shutdown(self) -> None:
                return None

            def server_close(self) -> None:
                return None

        def make_handler(**kwargs):
            kwargs["result"].code = "code-1"
            kwargs["event"].set()
            return object

        config = OAuthConfig(client_id="client-1", client_secret="secret-1")
        with patch(
            "scripts.miro_oauth_token.secrets.token_urlsafe", return_value="generated-state"
        ) as token_urlsafe:
            with patch(
                "scripts.miro_oauth_token._make_callback_handler", side_effect=make_handler
            ) as make_callback:
                with patch(
                    "scripts.miro_oauth_token.callback_bind_hosts", return_value=("127.0.0.1",)
                ):
                    with patch(
                        "scripts.miro_oauth_token._make_callback_server",
                        return_value=FakeServer(),
                    ):
                        with patch(
                            "scripts.miro_oauth_token.open_authorize_url", return_value=True
                        ) as open_url:
                            with patch(
                                "scripts.miro_oauth_token.exchange_access_token",
                                return_value="token-1",
                            ):
                                token = oauth.authorize_and_get_token(
                                    config, timeout_seconds=1
                                )

        self.assertEqual(token, "token-1")
        token_urlsafe.assert_called_once_with(32)
        self.assertEqual(
            make_callback.call_args.kwargs["expected_state"], "generated-state"
        )
        self.assertIn("state=generated-state", open_url.call_args.args[0])

    def test_authorize_rejects_unsafe_redirect_before_side_effects(self) -> None:
        for redirect_uri in (
            "https://localhost:8765/callback",
            "http://0.0.0.0:8765/callback",
            "http://example.invalid:8765/callback",
        ):
            config = OAuthConfig(
                client_id="client-1",
                client_secret="secret-1",
                redirect_uri=redirect_uri,
            )
            with self.subTest(redirect_uri=redirect_uri):
                with patch("scripts.miro_oauth_token._make_callback_handler") as make_handler:
                    with patch("scripts.miro_oauth_token._make_callback_server") as make_server:
                        with patch("scripts.miro_oauth_token.open_authorize_url") as open_url:
                            with self.assertRaisesRegex(ValueError, "loopback"):
                                oauth.authorize_and_get_token(config)
                make_handler.assert_not_called()
                make_server.assert_not_called()
                open_url.assert_not_called()

    def test_authorize_rejects_invalid_timeout_before_side_effects(self) -> None:
        config = OAuthConfig(client_id="client-1", client_secret="secret-1")
        for timeout in (0, -1, float("nan"), float("inf"), True):
            with self.subTest(timeout=timeout):
                with patch("scripts.miro_oauth_token._make_callback_handler") as make_handler:
                    with patch("scripts.miro_oauth_token._make_callback_server") as make_server:
                        with self.assertRaisesRegex(ValueError, "positive finite"):
                            oauth.authorize_and_get_token(
                                config, timeout_seconds=timeout
                            )
                make_handler.assert_not_called()
                make_server.assert_not_called()

    def test_extract_authorization_code_accepts_raw_code_or_callback_url(self) -> None:
        self.assertEqual(extract_authorization_code("code-1"), "code-1")
        self.assertEqual(
            extract_authorization_code(
                "http://localhost:8765/callback?code=code-2&state=state-1"
            ),
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
                callback_url="http://localhost:8765/callback?code=code-2",
            )

    def test_exchange_manual_authorization_exchanges_callback_url(self) -> None:
        config = OAuthConfig(client_id="client-1", client_secret="secret-1")
        session = FakeSession()

        token = exchange_manual_authorization(
            config,
            callback_url="http://localhost:8765/callback?code=code-1",
            session=session,
        )

        self.assertEqual(token, "token-1")
        self.assertEqual(session.calls[0]["data"]["code"], "code-1")

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
        session = FakeSession(
            FakeResponse({"error": "invalid_client"}, ok=False, status_code=401)
        )

        with self.assertRaisesRegex(OAuthTokenExchangeError, "invalid_client"):
            exchange_access_token(config, "code-1", session=session)

    def test_exchange_access_token_posts_oauth_form_body(self) -> None:
        config = OAuthConfig(
            client_id="client-1",
            client_secret="secret-1",
            redirect_uri="http://localhost:8765/callback",
        )
        session = FakeSession()

        token = exchange_access_token(config, "code-1", session=session)

        self.assertEqual(token, "token-1")
        self.assertEqual(session.calls[0]["url"], "https://api.miro.com/v1/oauth/token")
        self.assertEqual(
            session.calls[0]["data"],
            {
                "grant_type": "authorization_code",
                "code": "code-1",
                "redirect_uri": "http://localhost:8765/callback",
                "client_id": "client-1",
                "client_secret": "secret-1",
            },
        )


if __name__ == "__main__":
    unittest.main()
