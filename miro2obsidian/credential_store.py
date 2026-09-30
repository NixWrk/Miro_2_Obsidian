"""Store a user-authorized Miro access token in the operating-system vault."""

from __future__ import annotations

import ctypes
import os
from ctypes import wintypes


TARGET_NAME = "miro2obsidian/oauth_access_token/v1"
ACCOUNT_NAME = "miro2obsidian"
_CRED_TYPE_GENERIC = 1
_CRED_PERSIST_LOCAL_MACHINE = 2
_ERROR_NOT_FOUND = 1168


class CredentialStoreUnavailable(RuntimeError):
    """No usable system vault is available for unattended token reuse."""


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


def save_access_token(token: str, *, target_name: str = TARGET_NAME) -> None:
    """Keep the token under the current OS user, outside project files."""
    encoded = token.encode("utf-8")
    if not encoded or len(encoded) > 2560:
        raise ValueError("Miro access token has an unsupported size.")
    if not _is_windows():
        keyring = _keyring()
        try:
            keyring.set_password(target_name, ACCOUNT_NAME, token)
        except keyring.errors.KeyringError as exc:
            raise CredentialStoreUnavailable("The OS keyring could not save the Miro token.") from exc
        return
    blob = (ctypes.c_ubyte * len(encoded)).from_buffer_copy(encoded)
    credential = _Credential()
    credential.Type = _CRED_TYPE_GENERIC
    credential.TargetName = target_name
    credential.CredentialBlobSize = len(encoded)
    credential.CredentialBlob = blob
    credential.Persist = _CRED_PERSIST_LOCAL_MACHINE
    credential.UserName = "miro2obsidian"
    if not _advapi32().CredWriteW(ctypes.byref(credential), 0):
        raise CredentialStoreUnavailable("Windows Credential Manager could not save the Miro token.")


def load_access_token(*, target_name: str = TARGET_NAME) -> str | None:
    if not _is_windows():
        keyring = _keyring()
        try:
            return keyring.get_password(target_name, ACCOUNT_NAME)
        except keyring.errors.KeyringError as exc:
            raise CredentialStoreUnavailable("The OS keyring could not read the Miro token.") from exc
    credential = ctypes.POINTER(_Credential)()
    library = _advapi32()
    if not library.CredReadW(target_name, _CRED_TYPE_GENERIC, 0, ctypes.byref(credential)):
        error = ctypes.get_last_error()
        if error == _ERROR_NOT_FOUND:
            return None
        raise CredentialStoreUnavailable("Windows Credential Manager could not read the Miro token.")
    try:
        raw = ctypes.string_at(credential.contents.CredentialBlob, credential.contents.CredentialBlobSize)
        return raw.decode("utf-8")
    finally:
        library.CredFree(credential)


def clear_access_token(*, target_name: str = TARGET_NAME) -> None:
    if not _is_windows():
        keyring = _keyring()
        try:
            keyring.delete_password(target_name, ACCOUNT_NAME)
        except keyring.errors.PasswordDeleteError:
            return
        except keyring.errors.KeyringError as exc:
            raise CredentialStoreUnavailable("The OS keyring could not remove the Miro token.") from exc
        return
    library = _advapi32()
    if not library.CredDeleteW(target_name, _CRED_TYPE_GENERIC, 0):
        error = ctypes.get_last_error()
        if error != _ERROR_NOT_FOUND:
            raise CredentialStoreUnavailable("Windows Credential Manager could not remove the Miro token.")
