from __future__ import annotations

import json
from dataclasses import replace
from datetime import datetime, timedelta, timezone

import pytest

from miro2obsidian import credential_store, miro_auth
from miro2obsidian.credential_store import MiroConnection
from miro2obsidian.miro_auth import (
    NotConnected,
    TokenRefreshFailed,
    connect_with_credentials,
    connection_status,
    disconnect,
    get_access_token,
)
from scripts import miro_oauth_token as oauth


class MemoryBackend:
    def __init__(self) -> None:
        self.data: dict[str, str] = {}

    def read(self, target):
        return self.data.get(target)

    def write(self, target, value):
        self.data[target] = value

    def delete(self, target):
        self.data.pop(target, None)


class FakeResponse:
    def __init__(self, payload, *, ok=True, status_code=200):
        self.payload, self.ok, self.status_code = payload, ok, status_code

    def json(self):
        return self.payload


class FakeSession:
    """Routes by URL; records every call."""

    def __init__(self, routes):
        self.routes = routes
        self.calls: list[tuple[str, str, dict]] = []

    def _go(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        result = self.routes[url]
        if isinstance(result, Exception):
            raise result
        return result

    def post(self, url, **kwargs):
        return self._go("POST", url, **kwargs)

    def get(self, url, **kwargs):
        return self._go("GET", url, **kwargs)


@pytest.fixture()
def vault(monkeypatch):
    backend = MemoryBackend()
    monkeypatch.setattr(credential_store, "_backend", lambda: backend)
    monkeypatch.delenv("MIRO_ACCESS_TOKEN", raising=False)
    return backend


def connection(**overrides) -> MiroConnection:
    values = dict(
        client_id="client-1",
        client_secret="SECRET-VALUE",
        access_token="ACCESS-OLD",
        refresh_token="REFRESH-OLD",
        expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
        team_id="t-1",
        team_name="Design",
        scopes=("boards:read",),
    )
    values.update(overrides)
    return MiroConnection(**values)


def refresh_ok():
    return FakeResponse(
        {"access_token": "ACCESS-NEW", "refresh_token": "REFRESH-NEW", "expires_in": 3600}
    )


def test_refreshes_near_expiry_and_persists_rotated_refresh_token(vault) -> None:
    credential_store.save_connection(
        connection(expires_at=datetime.now(timezone.utc) + timedelta(minutes=1))
    )
    session = FakeSession({oauth.DEFAULT_TOKEN_URL: refresh_ok()})
    assert get_access_token(session=session) == "ACCESS-NEW"
    sent = session.calls[0][2]["data"]
    assert sent["grant_type"] == "refresh_token" and sent["refresh_token"] == "REFRESH-OLD"
    saved = credential_store.load_connection()
    assert saved.access_token == "ACCESS-NEW"
    assert saved.refresh_token == "REFRESH-NEW"
    assert saved.client_secret == "SECRET-VALUE"
    assert saved.team_name == "Design"
    assert saved.expires_at > datetime.now(timezone.utc) + timedelta(minutes=50)
    # Second call is served from the vault without another refresh.
    assert get_access_token(session=session) == "ACCESS-NEW"
    assert len(session.calls) == 1


def test_no_refresh_for_non_expiring_or_fresh_tokens(vault) -> None:
    session = FakeSession({})
    credential_store.save_connection(connection(expires_at=None, refresh_token=None))
    assert get_access_token(session=session) == "ACCESS-OLD"
    credential_store.save_connection(connection())
    assert get_access_token(session=session) == "ACCESS-OLD"
    assert session.calls == []


def test_near_expiry_without_refresh_token_still_returns_valid_token(vault) -> None:
    credential_store.save_connection(
        connection(refresh_token=None, expires_at=datetime.now(timezone.utc) + timedelta(minutes=1))
    )
    assert get_access_token(session=FakeSession({})) == "ACCESS-OLD"


def test_expired_without_refresh_token_needs_reauthorization(vault) -> None:
    credential_store.save_connection(
        connection(refresh_token=None, expires_at=datetime.now(timezone.utc) - timedelta(minutes=1))
    )
    with pytest.raises(TokenRefreshFailed) as caught:
        get_access_token(session=FakeSession({}))
    assert caught.value.needs_reauthorization


def test_refresh_failure_raises_without_leaking_secrets(vault) -> None:
    credential_store.save_connection(
        connection(expires_at=datetime.now(timezone.utc) - timedelta(minutes=1))
    )
    session = FakeSession(
        {
            oauth.DEFAULT_TOKEN_URL: FakeResponse(
                {"error": "invalid_grant", "echo": "SECRET-VALUE REFRESH-OLD"},
                ok=False,
                status_code=400,
            )
        }
    )
    with pytest.raises(TokenRefreshFailed) as caught:
        get_access_token(session=session)
    message = str(caught.value)
    assert caught.value.needs_reauthorization
    for secret in ("SECRET-VALUE", "REFRESH-OLD", "ACCESS-OLD"):
        assert secret not in message
    # The old record is kept so a person can still inspect and reconnect.
    assert credential_store.load_connection().refresh_token == "REFRESH-OLD"


def test_network_failure_is_transient_and_does_not_leak(vault) -> None:
    credential_store.save_connection(
        connection(expires_at=datetime.now(timezone.utc) - timedelta(minutes=1))
    )
    session = FakeSession({oauth.DEFAULT_TOKEN_URL: ConnectionError("dns for SECRET-VALUE")})
    with pytest.raises(TokenRefreshFailed) as caught:
        get_access_token(session=session)
    assert not caught.value.needs_reauthorization
    assert "SECRET-VALUE" not in str(caught.value)


def test_refresh_survives_vault_write_failure(vault, monkeypatch) -> None:
    credential_store.save_connection(
        connection(expires_at=datetime.now(timezone.utc) - timedelta(minutes=1))
    )

    def boom(_connection):
        raise credential_store.CredentialStoreUnavailable("locked")

    monkeypatch.setattr(miro_auth, "save_connection", boom)
    assert get_access_token(session=FakeSession({oauth.DEFAULT_TOKEN_URL: refresh_ok()})) == "ACCESS-NEW"


def test_failed_refresh_adopts_token_rotated_by_another_process(vault, monkeypatch) -> None:
    stale = connection(expires_at=datetime.now(timezone.utc) - timedelta(minutes=1))
    credential_store.save_connection(stale)
    winner = replace(
        stale,
        access_token="ACCESS-WINNER",
        refresh_token="REFRESH-WINNER",
        expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
    )
    real_refresh = miro_auth.refresh_token_grant

    def lose_race(*args, **kwargs):
        credential_store.save_connection(winner)
        return real_refresh(*args, **kwargs)

    monkeypatch.setattr(miro_auth, "refresh_token_grant", lose_race)
    session = FakeSession(
        {oauth.DEFAULT_TOKEN_URL: FakeResponse({"error": "invalid_grant"}, ok=False, status_code=400)}
    )
    assert get_access_token(session=session) == "ACCESS-WINNER"


def test_legacy_v1_token_is_used_when_no_connection(vault) -> None:
    vault.data[credential_store.TARGET_NAME] = "LEGACY"
    assert get_access_token() == "LEGACY"
    status = connection_status()
    assert status.connected and status.source == "vault-v1"


def test_not_connected_gives_next_step(vault) -> None:
    with pytest.raises(NotConnected, match="auth login --form"):
        get_access_token()
    status = connection_status()
    assert not status.connected and status.source is None


def test_env_precedence_and_allow_env_false(vault, monkeypatch) -> None:
    credential_store.save_connection(connection())
    monkeypatch.setenv("MIRO_ACCESS_TOKEN", "FROM-ENV")
    assert get_access_token() == "FROM-ENV"
    assert get_access_token(allow_env=False) == "ACCESS-OLD"
    assert connection_status().source == "env"
    assert connection_status(allow_env=False).source == "vault-v2"


def test_store_unavailable_is_reported(monkeypatch) -> None:
    monkeypatch.delenv("MIRO_ACCESS_TOKEN", raising=False)

    class Broken:
        def read(self, target):
            raise credential_store.CredentialStoreUnavailable("no keyring")

    monkeypatch.setattr(credential_store, "_backend", lambda: Broken())
    with pytest.raises(credential_store.CredentialStoreUnavailable):
        get_access_token()
    status = connection_status()
    assert not status.connected and not status.store_available


def test_status_to_dict_has_no_secrets(vault) -> None:
    credential_store.save_connection(connection())
    for verify in (False, True):
        session = FakeSession(
            {
                oauth.TOKEN_INFO_URL: FakeResponse(
                    {"team": {"id": "t-1", "name": "Design"}, "scopes": ["boards:read"]}
                )
            }
        )
        dumped = json.dumps(connection_status(verify_online=verify, session=session).to_dict())
        for secret in ("SECRET-VALUE", "ACCESS-OLD", "REFRESH-OLD", "client-1"):
            assert secret not in dumped
        assert "Design" in dumped


def test_verify_online_refreshes_then_reports_team(vault) -> None:
    credential_store.save_connection(
        connection(expires_at=datetime.now(timezone.utc) - timedelta(minutes=1), team_name=None)
    )
    session = FakeSession(
        {
            oauth.DEFAULT_TOKEN_URL: refresh_ok(),
            oauth.TOKEN_INFO_URL: FakeResponse(
                {"team": {"id": "t-9", "name": "Ops"}, "scopes": ["boards:read", "team:read"]}
            ),
        }
    )
    status = connection_status(verify_online=True, session=session)
    assert status.connected and status.team_name == "Ops" and status.refreshable
    assert status.scopes == ("boards:read", "team:read")
    assert session.calls[1][2]["headers"]["Authorization"] == "Bearer ACCESS-NEW"


def test_verify_online_reports_revoked_token_as_problem(vault) -> None:
    credential_store.save_connection(connection())
    session = FakeSession(
        {oauth.TOKEN_INFO_URL: FakeResponse({"message": "ACCESS-OLD"}, ok=False, status_code=401)}
    )
    status = connection_status(verify_online=True, session=session)
    assert not status.connected
    assert "rejected" in (status.problem or "")
    assert "ACCESS-OLD" not in json.dumps(status.to_dict())


def test_verify_online_network_error_keeps_connected(vault) -> None:
    credential_store.save_connection(connection())
    session = FakeSession({oauth.TOKEN_INFO_URL: ConnectionError("offline")})
    status = connection_status(verify_online=True, session=session)
    assert status.connected and "Could not reach Miro" in (status.problem or "")


def test_connect_with_credentials_saves_full_connection(vault, monkeypatch) -> None:
    seen = {}

    def fake_authorize(config, **kwargs):
        seen["client"] = (config.client_id, config.client_secret)
        kwargs["on_authorize_url"]("https://miro.com/oauth/authorize?state=s")
        return oauth.TokenGrant(
            access_token="ACCESS-1",
            refresh_token="REFRESH-1",
            expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
            scope="boards:read team:read",
            team_id="t-1",
        )

    monkeypatch.setattr(miro_auth, "authorize_and_get_grant", fake_authorize)
    urls: list[str] = []
    session = FakeSession(
        {
            oauth.TOKEN_INFO_URL: FakeResponse(
                {"team": {"id": "t-1", "name": "Design"}, "scopes": ["boards:read", "team:read"]}
            )
        }
    )
    status = connect_with_credentials(
        " client-1 ", " SECRET-VALUE ", open_browser=False, on_authorize_url=urls.append, session=session
    )
    assert seen["client"] == ("client-1", "SECRET-VALUE")
    assert urls == ["https://miro.com/oauth/authorize?state=s"]
    saved = credential_store.load_connection()
    assert (saved.access_token, saved.refresh_token, saved.client_secret) == (
        "ACCESS-1",
        "REFRESH-1",
        "SECRET-VALUE",
    )
    assert saved.team_name == "Design" and saved.scopes == ("boards:read", "team:read")
    assert status.connected and status.team_name == "Design" and status.refreshable
    assert "SECRET-VALUE" not in json.dumps(status.to_dict())


def test_connect_tolerates_token_info_failure(vault, monkeypatch) -> None:
    monkeypatch.setattr(
        miro_auth,
        "authorize_and_get_grant",
        lambda config, **kw: oauth.TokenGrant(access_token="A", scope="boards:read", team_id="9"),
    )
    session = FakeSession({oauth.TOKEN_INFO_URL: ConnectionError("down")})
    status = connect_with_credentials("c", "s", open_browser=False, session=session)
    assert status.connected and status.team_id == "9" and status.scopes == ("boards:read",)


def test_disconnect_revokes_then_clears_and_tolerates_revoke_failure(vault) -> None:
    credential_store.save_connection(connection())
    vault.data[credential_store.TARGET_NAME] = "LEGACY"
    ok = FakeSession({oauth.REVOKE_URL: FakeResponse({})})
    assert disconnect(session=ok) is True
    assert ok.calls[0][2]["data"]["client_secret"] == "SECRET-VALUE"
    assert vault.data == {}

    credential_store.save_connection(connection())
    failing = FakeSession({oauth.REVOKE_URL: FakeResponse({}, ok=False, status_code=404)})
    assert disconnect(session=failing) is False
    assert vault.data == {}

    credential_store.save_connection(connection())
    offline = FakeSession({})
    assert disconnect(revoke=False, session=offline) is False
    assert offline.calls == [] and vault.data == {}
