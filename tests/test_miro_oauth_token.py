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
    OAuthConfig,
    build_authorize_url,
    callback_bind_hosts,
    config_from_env,
    exchange_access_token,
    exchange_manual_authorization,
    extract_authorization_code,
    format_callback_timeout_message,
    parse_callback_path,
)


class FakeResponse:
    def __init__(self, payload: dict[str, str]) -> None:
        self.payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, str]:
        return self.payload


class FakeSession:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    def post(self, url: str, *, data: dict[str, str], timeout: int) -> FakeResponse:
        self.calls.append({"url": url, "data": data, "timeout": timeout})
        return FakeResponse({"access_token": "token-1"})


class MiroOAuthTokenTests(unittest.TestCase):
    def test_build_authorize_url_encodes_required_fields(self) -> None:
        config = OAuthConfig(
            client_id="client-1",
            client_secret="secret-1",
            redirect_uri="http://localhost:8000/callback",
            scopes="boards:read boards:write",
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
            redirect_uri="http://localhost:8000/callback",
        )

        message = format_callback_timeout_message(config, "https://miro.com/oauth/authorize?client_id=client-1")

        self.assertIn("http://localhost:8000/callback", message)
        self.assertIn("authorization URL", message)
        self.assertIn("--oauth-redirect-uri http://127.0.0.1:8000/callback", message)
        self.assertNotIn("secret-1", message)

    def test_config_from_env_requires_client_credentials(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(ValueError, "MIRO_CLIENT_ID, MIRO_CLIENT_SECRET"):
                config_from_env()

    def test_config_from_env_reads_credentials_without_printing_them(self) -> None:
        with patch.dict(os.environ, {"MIRO_CLIENT_ID": "client-1", "MIRO_CLIENT_SECRET": "secret-1"}):
            config = config_from_env()

        self.assertEqual(config.client_id, "client-1")
        self.assertEqual(config.client_secret, "secret-1")

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
        self.assertEqual(session.calls[0]["data"]["code"], "code-1")

    def test_exchange_access_token_posts_oauth_payload(self) -> None:
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
            session.calls[0]["data"],
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
