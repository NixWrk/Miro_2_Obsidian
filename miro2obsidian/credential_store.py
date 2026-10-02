"""Keep Miro credentials in the operating-system vault.

Two kinds of record live here:

* the legacy v1 record: one bare access token (``TARGET_NAME``);
* the v2 "connection" record (``CONNECTION_TARGET_NAME``): a JSON document with
  the access token, refresh token, expiry, team and scopes, plus the Client ID
  and Client secret of the user's own Miro app.

Trade-off, stated plainly: the v2 record deliberately stores the Client secret.
Refreshing an expiring token and re-authorizing unattended both need it, and it
is the only way a scheduled run can recover without a person. The secret sits in
the same per-OS-user vault as the tokens (Windows Credential Manager, macOS
Keychain, or a Linux Secret Service keyring) and is never written to project
files or logs. Anyone who can read this vault as the same OS user can use the
app; rotate the secret in Miro if the machine is shared or compromised.

Windows Credential Manager rejects blobs over 2560 bytes. A record that does not
fit is split over numbered ``.../part/N`` targets and a small manifest (with a
SHA-256 of the payload) is written last, so a crash never leaves a record that
loads half-old, half-new.
"""

from __future__ import annotations

import ctypes
import hashlib
import json
import os
from ctypes import wintypes
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from typing import Any, Protocol


TARGET_NAME = "miro2obsidian/oauth_access_token/v1"
CONNECTION_TARGET_NAME = "miro2obsidian/connection/v2"
ACCOUNT_NAME = "miro2obsidian"
CONNECTION_VERSION = 2
MAX_BLOB_BYTES = 2560  # CRED_MAX_CREDENTIAL_BLOB_SIZE
_CHUNK_BYTES = 2048
_MAX_RECORD_BYTES = 64 * 1024
_MAX_PROBE_PARTS = 8
_CRED_TYPE_GENERIC = 1
_CRED_PERSIST_LOCAL_MACHINE = 2
_ERROR_NOT_FOUND = 1168


class CredentialStoreUnavailable(RuntimeError):
    """No usable system vault is available for unattended token reuse."""


@dataclass(frozen=True)
class MiroConnection:
    """Everything needed to use, refresh and re-authorize a Miro connection."""

    client_id: str
    client_secret: str = field(repr=False)
    access_token: str = field(repr=False)
    refresh_token: str | None = field(default=None, repr=False)
    expires_at: datetime | None = None
    team_id: str | None = None
    team_name: str | None = None
    scopes: tuple[str, ...] = ()
    saved_at: datetime | None = None

    def to_record(self) -> dict[str, Any]:
        return {
            "version": CONNECTION_VERSION,
            "client_id": self.client_id,
            "client_secret": self.client_secret,
            "access_token": self.access_token,
            "refresh_token": self.refresh_token,
            "expires_at": _iso(self.expires_at),
            "team_id": self.team_id,
            "team_name": self.team_name,
            "scopes": list(self.scopes),
            "saved_at": _iso(self.saved_at),
        }

    @classmethod
    def from_record(cls, record: Any) -> "MiroConnection | None":
        if not isinstance(record, dict) or record.get("version") != CONNECTION_VERSION:
            return None
        access_token = record.get("access_token")
        client_id = record.get("client_id")
        if not access_token or not isinstance(access_token, str):
            return None
        if not isinstance(client_id, str):
            return None
        scopes = record.get("scopes")
        return cls(
            client_id=client_id,
            client_secret=str(record.get("client_secret") or ""),
            access_token=access_token,
            refresh_token=_opt_str(record.get("refresh_token")),
            expires_at=_parse_iso(record.get("expires_at")),
            team_id=_opt_str(record.get("team_id")),
            team_name=_opt_str(record.get("team_name")),
            scopes=tuple(str(item) for item in scopes) if isinstance(scopes, list) else (),
            saved_at=_parse_iso(record.get("saved_at")),
        )


def _opt_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value)
    return text or None


def _iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat()


def _parse_iso(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _is_windows() -> bool:
    return os.name == "nt"


def _keyring():
    try:
        import keyring
    except ImportError as exc:
        raise CredentialStoreUnavailable(
            "Install the keyring package or set MIRO_ACCESS_TOKEN in the environment."
        ) from exc
    try:
        backend = keyring.get_keyring()
        if backend.priority <= 0:
            raise CredentialStoreUnavailable(
                "No usable OS keyring is available; set MIRO_ACCESS_TOKEN in the environment."
            )
    except keyring.errors.KeyringError as exc:
        raise CredentialStoreUnavailable("The OS keyring is unavailable.") from exc
    return keyring


class _Credential(ctypes.Structure):
    _fields_ = [
        ("Flags", wintypes.DWORD),
        ("Type", wintypes.DWORD),
        ("TargetName", wintypes.LPWSTR),
        ("Comment", wintypes.LPWSTR),
        ("LastWritten", wintypes.FILETIME),
        ("CredentialBlobSize", wintypes.DWORD),
        ("CredentialBlob", ctypes.POINTER(ctypes.c_ubyte)),
        ("Persist", wintypes.DWORD),
        ("AttributeCount", wintypes.DWORD),
        ("Attributes", ctypes.c_void_p),
        ("TargetAlias", wintypes.LPWSTR),
        ("UserName", wintypes.LPWSTR),
    ]


def _advapi32():
    if os.name != "nt":
        raise RuntimeError("Automatic token storage currently requires Windows Credential Manager.")
    library = ctypes.WinDLL("Advapi32.dll", use_last_error=True)
    library.CredWriteW.argtypes = [ctypes.POINTER(_Credential), wintypes.DWORD]
    library.CredWriteW.restype = wintypes.BOOL
    library.CredReadW.argtypes = [
        wintypes.LPCWSTR,
        wintypes.DWORD,
        wintypes.DWORD,
        ctypes.POINTER(ctypes.POINTER(_Credential)),
    ]
    library.CredReadW.restype = wintypes.BOOL
    library.CredDeleteW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD]
    library.CredDeleteW.restype = wintypes.BOOL
    library.CredFree.argtypes = [ctypes.c_void_p]
    library.CredFree.restype = None
    return library


class _Backend(Protocol):
    """Raw string storage keyed by target name. Tests inject fakes here."""

    def read(self, target: str) -> str | None: ...

    def write(self, target: str, value: str) -> None: ...

    def delete(self, target: str) -> None: ...


class _KeyringBackend:
    def read(self, target: str) -> str | None:
        keyring = _keyring()
        try:
            return keyring.get_password(target, ACCOUNT_NAME)
        except keyring.errors.KeyringError as exc:
            raise CredentialStoreUnavailable("The OS keyring could not read the Miro credentials.") from exc

    def write(self, target: str, value: str) -> None:
        keyring = _keyring()
        try:
            keyring.set_password(target, ACCOUNT_NAME, value)
        except keyring.errors.KeyringError as exc:
            raise CredentialStoreUnavailable("The OS keyring could not save the Miro credentials.") from exc

    def delete(self, target: str) -> None:
        keyring = _keyring()
        try:
            keyring.delete_password(target, ACCOUNT_NAME)
        except keyring.errors.PasswordDeleteError:
            return
        except keyring.errors.KeyringError as exc:
            raise CredentialStoreUnavailable("The OS keyring could not remove the Miro credentials.") from exc


class _WindowsBackend:
    def read(self, target: str) -> str | None:
        credential = ctypes.POINTER(_Credential)()
        library = _advapi32()
        if not library.CredReadW(target, _CRED_TYPE_GENERIC, 0, ctypes.byref(credential)):
            error = ctypes.get_last_error()
            if error == _ERROR_NOT_FOUND:
                return None
            raise CredentialStoreUnavailable("Windows Credential Manager could not read the Miro credentials.")
        try:
            raw = ctypes.string_at(credential.contents.CredentialBlob, credential.contents.CredentialBlobSize)
            return raw.decode("utf-8")
        finally:
            library.CredFree(credential)

    def write(self, target: str, value: str) -> None:
        encoded = value.encode("utf-8")
        if not encoded or len(encoded) > MAX_BLOB_BYTES:
            raise ValueError("Miro credential has an unsupported size.")
        blob = (ctypes.c_ubyte * len(encoded)).from_buffer_copy(encoded)
        credential = _Credential()
        credential.Type = _CRED_TYPE_GENERIC
        credential.TargetName = target
        credential.CredentialBlobSize = len(encoded)
        credential.CredentialBlob = blob
        credential.Persist = _CRED_PERSIST_LOCAL_MACHINE
        credential.UserName = "miro2obsidian"
        if not _advapi32().CredWriteW(ctypes.byref(credential), 0):
            raise CredentialStoreUnavailable("Windows Credential Manager could not save the Miro credentials.")

    def delete(self, target: str) -> None:
        library = _advapi32()
        if not library.CredDeleteW(target, _CRED_TYPE_GENERIC, 0):
            error = ctypes.get_last_error()
            if error != _ERROR_NOT_FOUND:
                raise CredentialStoreUnavailable("Windows Credential Manager could not remove the Miro credentials.")


def _backend() -> _Backend:
    return _WindowsBackend() if _is_windows() else _KeyringBackend()


# --- chunked JSON records -------------------------------------------------


def _split_utf8(text: str, limit: int) -> list[str]:
    parts: list[str] = []
    current: list[str] = []
    size = 0
    for char in text:
        width = len(char.encode("utf-8"))
        if size + width > limit:
            parts.append("".join(current))
            current, size = [], 0
        current.append(char)
        size += width
    if current:
        parts.append("".join(current))
    return parts


def _part_target(target: str, index: int) -> str:
    return f"{target}/part/{index}"


def _write_record(backend: _Backend, target: str, record: dict[str, Any]) -> None:
    payload = json.dumps(record, separators=(",", ":"), sort_keys=True)
    encoded = payload.encode("utf-8")
    if len(encoded) > _MAX_RECORD_BYTES:
        raise ValueError("Miro connection record has an unsupported size.")
    previous = _manifest_parts(backend, target)
    if len(encoded) <= MAX_BLOB_BYTES:
        backend.write(target, payload)
        count = 0
    else:
        parts = _split_utf8(payload, _CHUNK_BYTES)
        for index, part in enumerate(parts):
            backend.write(_part_target(target, index), part)
        manifest = {
            "chunks": len(parts),
            "sha256": hashlib.sha256(encoded).hexdigest(),
        }
        backend.write(target, json.dumps(manifest, separators=(",", ":")))
        count = len(parts)
    for index in range(count, previous):
        backend.delete(_part_target(target, index))


def _manifest_parts(backend: _Backend, target: str) -> int:
    raw = backend.read(target)
    if not raw:
        return 0
    try:
        data = json.loads(raw)
    except ValueError:
        return 0
    if isinstance(data, dict) and isinstance(data.get("chunks"), int) and "access_token" not in data:
        return max(0, min(data["chunks"], 1024))
    return 0


def _read_record(backend: _Backend, target: str) -> dict[str, Any] | None:
    raw = backend.read(target)
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(data, dict):
        return None
    if "chunks" not in data or "access_token" in data:
        return data
    count = data.get("chunks")
    digest = data.get("sha256")
    if not isinstance(count, int) or not 0 < count <= 1024 or not isinstance(digest, str):
        return None
    pieces: list[str] = []
    for index in range(count):
        piece = backend.read(_part_target(target, index))
        if piece is None:
            return None
        pieces.append(piece)
    payload = "".join(pieces).encode("utf-8")
    if hashlib.sha256(payload).hexdigest() != digest:
        return None
    try:
        record = json.loads(payload)
    except ValueError:
        return None
    return record if isinstance(record, dict) else None


def _delete_record(backend: _Backend, target: str) -> None:
    count = _manifest_parts(backend, target)
    backend.delete(target)
    for index in range(max(count, _MAX_PROBE_PARTS)):
        backend.delete(_part_target(target, index))


# --- v2 connection API ----------------------------------------------------


def save_connection(
    connection: MiroConnection, *, target_name: str = CONNECTION_TARGET_NAME
) -> None:
    """Persist the full connection (tokens, expiry, team, app credentials)."""
    if not connection.access_token or not connection.client_id:
        raise ValueError("A Miro connection needs a client id and an access token.")
    stamped = connection
    if connection.saved_at is None:
        stamped = replace(connection, saved_at=datetime.now(timezone.utc))
    _write_record(_backend(), target_name, stamped.to_record())


def load_connection(*, target_name: str = CONNECTION_TARGET_NAME) -> MiroConnection | None:
    """Return the saved connection, or None if absent or unreadable."""
    return MiroConnection.from_record(_read_record(_backend(), target_name))


def clear_connection(*, target_name: str = CONNECTION_TARGET_NAME) -> None:
    _delete_record(_backend(), target_name)


# --- legacy v1 access-token API ------------------------------------------


def save_access_token(token: str, *, target_name: str = TARGET_NAME) -> None:
    """Keep a bare token under the current OS user, outside project files.

    Saving to the default target writes the legacy v1 record and removes any v2
    connection: a token handed over on its own supersedes a managed connection
    (otherwise the older v2 record would keep shadowing it, and its refresh
    token would belong to a different grant).
    """
    encoded = token.encode("utf-8")
    if not encoded or len(encoded) > MAX_BLOB_BYTES:
        raise ValueError("Miro access token has an unsupported size.")
    backend = _backend()
    backend.write(target_name, token)
    if target_name == TARGET_NAME:
        _delete_record(backend, CONNECTION_TARGET_NAME)


def load_legacy_access_token(*, target_name: str = TARGET_NAME) -> str | None:
    """Return only the v1 bare token, ignoring the v2 connection."""
    return _backend().read(target_name)


def load_access_token(*, target_name: str = TARGET_NAME) -> str | None:
    """Return the v2 connection's access token if present, else the v1 token.

    The token may be expired; use ``miro2obsidian.miro_auth.get_access_token``
    to get one that is refreshed automatically.
    """
    if target_name == TARGET_NAME:
        connection = load_connection()
        if connection is not None:
            return connection.access_token
    return load_legacy_access_token(target_name=target_name)


def clear_access_token(*, target_name: str = TARGET_NAME) -> None:
    """Forget the saved token; for the default target, the v2 connection too."""
    backend = _backend()
    backend.delete(target_name)
    if target_name == TARGET_NAME:
        _delete_record(backend, CONNECTION_TARGET_NAME)
