"""The single place that turns saved Miro credentials into a usable token.

The CLI, GUI, MCP server and agent tools all call :func:`get_access_token`.
It prefers ``MIRO_ACCESS_TOKEN`` (when allowed), then the v2 connection in the
OS vault (refreshing an expiring token and persisting Miro's rotated refresh
token), then the legacy bare token, and otherwise says how to connect.

Nothing here ever returns, logs or serializes a secret except
``get_access_token`` handing back the token itself.
"""

from __future__ import annotations

import logging
import os
import threading
from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from miro2obsidian.credential_store import (
    CredentialStoreUnavailable,
    MiroConnection,
    clear_access_token,
    clear_connection,
    load_connection,
    load_legacy_access_token,
    save_connection,
)
from scripts.miro_oauth_token import (
    DEFAULT_BROWSER,
    DEFAULT_TIMEOUT_SECONDS,
    OAuthTokenExchangeError,
    TokenGrant,
    authorize_and_get_grant,
    fetch_token_info,
    refresh_token_grant,
    revoke_token,
    session_oauth_config,
)

__all__ = [
    "ConnectionStatus",
    "CredentialStoreUnavailable",
    "NotConnected",
    "TokenRefreshFailed",
    "connect_with_credentials",
    "connection_status",
    "disconnect",
    "get_access_token",
    "reconnect_with_saved_app",
]

ENV_TOKEN = "MIRO_ACCESS_TOKEN"
DEFAULT_REFRESH_MARGIN = timedelta(minutes=5)
_LOG = logging.getLogger(__name__)
_REFRESH_LOCK = threading.Lock()

CONNECT_HINT = (
    "Connect once with `miro2obsidian auth login --form` (a local form that saves "
    "the connection in your OS credential store), or with Set up Miro app in the "
    f"GUI. Alternatively set {ENV_TOKEN} for this run."
)


class NotConnected(RuntimeError):
    """No Miro token is available; the message says how to connect."""


class TokenRefreshFailed(RuntimeError):
    """The saved token could not be renewed.

    ``needs_reauthorization`` is True when Miro refused the refresh token (it
    was revoked, rotated elsewhere or the app was removed) or none was saved:
    the person must connect again. It is False for transient failures such as a
    network error, where trying again later is reasonable.
    """

    def __init__(self, message: str, *, needs_reauthorization: bool = True) -> None:
        super().__init__(message)
        self.needs_reauthorization = needs_reauthorization


@dataclass(frozen=True)
class ConnectionStatus:
    connected: bool
    source: str | None = None  # "env" | "vault-v2" | "vault-v1" | None
    team_id: str | None = None
    team_name: str | None = None
    scopes: tuple[str, ...] = ()
    expires_at: datetime | None = None
    refreshable: bool = False
    store_available: bool = True
    problem: str | None = None
    message: str = ""

    def to_dict(self) -> dict[str, Any]:
        """JSON-safe summary. Contains no token, secret or client id."""
        return {
            "connected": self.connected,
            "source": self.source,
            "team_id": self.team_id,
            "team_name": self.team_name,
            "scopes": list(self.scopes),
            "expires_at": self.expires_at.astimezone(timezone.utc).isoformat()
            if self.expires_at
            else None,
            "refreshable": self.refreshable,
            "store_available": self.store_available,
            "problem": self.problem,
            "message": self.message,
        }


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _env_token() -> str | None:
    value = os.environ.get(ENV_TOKEN, "").strip()
    return value or None


def _needs_refresh(connection: MiroConnection, margin: timedelta) -> bool:
    return connection.expires_at is not None and connection.expires_at - margin <= _now()


def _is_expired(connection: MiroConnection) -> bool:
    return connection.expires_at is not None and connection.expires_at <= _now()


def _can_refresh(connection: MiroConnection) -> bool:
    return bool(connection.refresh_token and connection.client_id and connection.client_secret)


def _apply_grant(connection: MiroConnection, grant: TokenGrant) -> MiroConnection:
    scopes = tuple(grant.scope.split()) if grant.scope else connection.scopes
    return replace(
        connection,
        access_token=grant.access_token,
        refresh_token=grant.refresh_token or connection.refresh_token,
        expires_at=grant.expires_at,
        team_id=grant.team_id or connection.team_id,
        scopes=scopes,
        saved_at=_now(),
    )


def _refresh(connection: MiroConnection, *, session: Any | None) -> MiroConnection:
    """Refresh and persist. The rotated refresh token is saved before returning."""
    if not _can_refresh(connection):
        raise TokenRefreshFailed(
            "The saved Miro token has expired and cannot be renewed automatically. "
            "Connect again to get a new one. " + CONNECT_HINT
        )
    try:
        grant = refresh_token_grant(
            (connection.client_id, connection.client_secret),
            connection.refresh_token or "",
            session=session,
        )
    except OAuthTokenExchangeError as exc:
        status = exc.status_code
        permanent = status is None or 400 <= status < 500
        if permanent:
            raise TokenRefreshFailed(
                f"Miro refused to renew the saved token (HTTP {status or 'error'}). "
                "The authorization was probably revoked or the app changed. "
                "Connect again. " + CONNECT_HINT,
                needs_reauthorization=True,
            ) from None
        raise TokenRefreshFailed(
            f"Miro could not renew the saved token right now (HTTP {status}). Try again later.",
            needs_reauthorization=False,
        ) from None
    except Exception as exc:  # noqa: BLE001 - network errors; never echo their text
        raise TokenRefreshFailed(
            f"Could not reach Miro to renew the saved token ({type(exc).__name__}). "
            "Check the network connection and try again.",
            needs_reauthorization=False,
        ) from None
    renewed = _apply_grant(connection, grant)
    try:
        save_connection(renewed)
    except CredentialStoreUnavailable:
        # The old refresh token is already spent; keep working this run.
        _LOG.warning("Miro token was renewed but could not be saved to the credential store.")
    return renewed


def _usable_connection(
    connection: MiroConnection, *, margin: timedelta, session: Any | None
) -> MiroConnection:
    if not _needs_refresh(connection, margin):
        return connection
    if not _can_refresh(connection) and not _is_expired(connection):
        return connection  # nothing to renew with, but still valid
    with _REFRESH_LOCK:
        try:
            current = load_connection() or connection
        except CredentialStoreUnavailable:
            current = connection
        if not _needs_refresh(current, margin):
            return current  # another thread or process already renewed it
        try:
            return _refresh(current, session=session)
        except TokenRefreshFailed:
            # A concurrent process may have rotated the token under us.
            try:
                latest = load_connection()
            except CredentialStoreUnavailable:
                latest = None
            if (
                latest is not None
                and latest.refresh_token != current.refresh_token
                and not _is_expired(latest)
            ):
                return latest
            raise


def get_access_token(
    *,
    allow_env: bool = True,
    refresh_margin: timedelta = DEFAULT_REFRESH_MARGIN,
    session: Any | None = None,
) -> str:
    """Return a Miro access token that is good to use now.

    Order: ``MIRO_ACCESS_TOKEN`` (if ``allow_env``), the v2 vault connection
    (refreshed when it expires within ``refresh_margin``), the legacy v1 vault
    token. Raises :class:`NotConnected`, :class:`TokenRefreshFailed` or
    :class:`CredentialStoreUnavailable`.
    """
    if allow_env:
        token = _env_token()
        if token:
            return token
    connection = load_connection()
    if connection is not None:
        return _usable_connection(connection, margin=refresh_margin, session=session).access_token
    legacy = load_legacy_access_token()
    if legacy:
        return legacy
    raise NotConnected("Miro is not connected. " + CONNECT_HINT)


def _status_from_connection(connection: MiroConnection, *, store_available: bool = True) -> ConnectionStatus:
    problem = None
    connected = True
    if _is_expired(connection) and not _can_refresh(connection):
        problem = "The saved Miro token has expired and cannot be renewed. Connect again."
        connected = False
    return ConnectionStatus(
        connected=connected,
        source="vault-v2",
        team_id=connection.team_id,
        team_name=connection.team_name,
        scopes=connection.scopes,
        expires_at=connection.expires_at,
        refreshable=_can_refresh(connection),
        store_available=store_available,
        problem=problem,
        message=_describe(connected, "vault-v2", connection.team_name, problem),
    )


def _describe(connected: bool, source: str | None, team_name: str | None, problem: str | None) -> str:
    if problem:
        return problem
    if not connected:
        return "Miro is not connected. " + CONNECT_HINT
    where = {
        "env": f"the {ENV_TOKEN} environment variable",
        "vault-v2": "the OS credential store",
        "vault-v1": "the OS credential store (legacy token)",
    }.get(source or "", "an unknown source")
    team = f" to team {team_name}" if team_name else ""
    return f"Miro is connected{team} using {where}."


def _verify(
    status: ConnectionStatus, token: str, *, session: Any | None
) -> ConnectionStatus:
    try:
        info = fetch_token_info(token, session=session)
    except OAuthTokenExchangeError as exc:
        if exc.status_code in (401, 403):
            problem = "Miro rejected the saved token (revoked or expired). Connect again."
            return replace(
                status,
                connected=False,
                problem=problem,
                message=problem,
            )
        problem = f"Miro could not verify the token right now (HTTP {exc.status_code or 'error'})."
        return replace(status, problem=problem, message=problem)
    except Exception as exc:  # noqa: BLE001
        problem = f"Could not reach Miro to verify the token ({type(exc).__name__})."
        return replace(status, problem=problem, message=problem)
    scopes = tuple(info.get("scopes") or ()) or status.scopes
    team_name = info.get("team_name") or status.team_name
    return replace(
        status,
        team_id=info.get("team_id") or status.team_id,
        team_name=team_name,
        scopes=scopes,
        message=_describe(status.connected, status.source, team_name, status.problem),
    )


def connection_status(
    *,
    verify_online: bool = False,
    allow_env: bool = True,
    session: Any | None = None,
) -> ConnectionStatus:
    """Describe the current connection without exposing any secret.

    With ``verify_online`` the token is refreshed if needed and checked against
    Miro; a revoked or invalid token is reported in ``problem``.
    """
    store_available = True
    connection: MiroConnection | None = None
    legacy: str | None = None
    try:
        connection = load_connection()
        if connection is None:
            legacy = load_legacy_access_token()
    except CredentialStoreUnavailable:
        store_available = False

    env_token = _env_token() if allow_env else None
    if env_token:
        status = ConnectionStatus(
            connected=True,
            source="env",
            store_available=store_available,
            message=_describe(True, "env", None, None),
        )
        return _verify(status, env_token, session=session) if verify_online else status

    if connection is not None:
        status = _status_from_connection(connection, store_available=store_available)
        if not verify_online or not status.connected:
            return status
        try:
            token = get_access_token(allow_env=False, session=session)
        except TokenRefreshFailed as exc:
            return replace(status, connected=not exc.needs_reauthorization, problem=str(exc), message=str(exc))
        except (NotConnected, CredentialStoreUnavailable) as exc:
            return replace(status, connected=False, problem=str(exc), message=str(exc))
        refreshed = load_connection() or connection
        status = _status_from_connection(refreshed, store_available=store_available)
        return _verify(status, token, session=session)

    if legacy:
        status = ConnectionStatus(
            connected=True,
            source="vault-v1",
            store_available=store_available,
            message=_describe(True, "vault-v1", None, None),
        )
        return _verify(status, legacy, session=session) if verify_online else status

    problem = None if store_available else "No usable OS credential store is available."
    return ConnectionStatus(
        connected=False,
        store_available=store_available,
        problem=problem,
        message=problem or _describe(False, None, None, None),
    )


def _noop(_message: str) -> None:
    return None


def connect_with_credentials(
    client_id: str,
    client_secret: str,
    *,
    open_browser: bool = True,
    on_authorize_url: Callable[[str], None] | None = None,
    report: Callable[[str], None] = _noop,
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
    browser: str = DEFAULT_BROWSER,
    session: Any | None = None,
) -> ConnectionStatus:
    """Run Miro OAuth for the user's own app and save the full v2 connection.

    The Client secret is saved with the tokens so later refreshes need no
    person (see ``credential_store`` for the trade-off). Team details come
    from Miro's token-info endpoint; failing to fetch them is not fatal.
    Raises :class:`CredentialStoreUnavailable` when nothing can be saved.
    """
    config = session_oauth_config(client_id, client_secret)
    grant = authorize_and_get_grant(
        config,
        timeout_seconds=timeout_seconds,
        open_browser=open_browser,
        browser=browser,
        session=session,
        on_authorize_url=on_authorize_url,
        report=report,
    )
    try:
        info = fetch_token_info(grant.access_token, session=session)
    except Exception:  # noqa: BLE001 - team details are a convenience
        info = {}
    scopes = tuple(info.get("scopes") or ()) or tuple((grant.scope or "").split())
    connection = MiroConnection(
        client_id=config.client_id,
        client_secret=config.client_secret,
        access_token=grant.access_token,
        refresh_token=grant.refresh_token,
        expires_at=grant.expires_at,
        team_id=info.get("team_id") or grant.team_id,
        team_name=info.get("team_name"),
        scopes=scopes,
        saved_at=_now(),
    )
    save_connection(connection)
    return _status_from_connection(connection)


def reconnect_with_saved_app(
    *,
    open_browser: bool = True,
    on_authorize_url: Callable[[str], None] | None = None,
    report: Callable[[str], None] = _noop,
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
    browser: str = DEFAULT_BROWSER,
    session: Any | None = None,
) -> ConnectionStatus:
    """Run Miro OAuth again with the Client ID/secret saved in the connection.

    Used to switch the Miro team without typing the credentials again: Miro asks
    which team to install for on every authorization. The credentials never
    leave this module. Raises :class:`NotConnected` when no connection with app
    credentials is saved (the person must set the app up first).
    """
    connection = load_connection()
    if connection is None or not (connection.client_id and connection.client_secret):
        raise NotConnected("No Miro app is saved yet. Set up the Miro app first.")
    return connect_with_credentials(
        connection.client_id,
        connection.client_secret,
        open_browser=open_browser,
        on_authorize_url=on_authorize_url,
        report=report,
        timeout_seconds=timeout_seconds,
        browser=browser,
        session=session,
    )


def disconnect(*, revoke: bool = True, session: Any | None = None) -> bool:
    """Forget the saved connection; first try to revoke it at Miro.

    Revocation is best effort (the endpoint shape is unverified, and the
    network may be down): a failure never stops the local records from being
    removed. Returns True when Miro confirmed the revocation.
    """
    revoked = False
    if revoke:
        try:
            connection = load_connection()
        except CredentialStoreUnavailable:
            connection = None
        if connection is not None and connection.client_secret:
            try:
                revoke_token(
                    (connection.client_id, connection.client_secret),
                    connection.access_token,
                    session=session,
                )
                revoked = True
            except Exception as exc:  # noqa: BLE001 - non-fatal by design
                _LOG.warning("Miro token revocation failed (%s); forgetting it locally.", type(exc).__name__)
    clear_connection()
    clear_access_token()
    return revoked
