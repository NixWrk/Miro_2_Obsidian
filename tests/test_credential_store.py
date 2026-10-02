from __future__ import annotations

import os
import sys
import types
import unittest
from uuid import uuid4
from unittest.mock import patch

from datetime import datetime, timezone

from miro2obsidian import credential_store
from miro2obsidian.credential_store import (
    CONNECTION_TARGET_NAME,
    MAX_BLOB_BYTES,
    TARGET_NAME,
    CredentialStoreUnavailable,
    MiroConnection,
    clear_access_token,
    clear_connection,
    load_access_token,
    load_connection,
    load_legacy_access_token,
    save_access_token,
    save_connection,
)


class LimitedBackend:
    """In-memory vault that enforces the Windows 2560-byte blob limit."""

    def __init__(self) -> None:
        self.data: dict[str, str] = {}

    def read(self, target):
        return self.data.get(target)

    def write(self, target, value):
        if len(value.encode("utf-8")) > MAX_BLOB_BYTES:
            raise AssertionError("blob over the Windows limit")
        self.data[target] = value

    def delete(self, target):
        self.data.pop(target, None)


def sample_connection(**overrides) -> MiroConnection:
    values = dict(
        client_id="client-1",
        client_secret="secret-1",
        access_token="access-1",
        refresh_token="refresh-1",
        expires_at=datetime(2030, 1, 2, 3, 4, 5, tzinfo=timezone.utc),
        team_id="t-1",
        team_name="Design",
        scopes=("boards:read", "team:read"),
    )
    values.update(overrides)
    return MiroConnection(**values)


class CredentialStoreTests(unittest.TestCase):
    @unittest.skipUnless(os.name == "nt", "Windows Credential Manager is required")
    def test_round_trip_isolated_synthetic_token(self) -> None:
        target = f"miro2obsidian/test/{uuid4()}"
        try:
            self.assertIsNone(load_access_token(target_name=target))
            save_access_token("synthetic-test-token", target_name=target)
            self.assertEqual(load_access_token(target_name=target), "synthetic-test-token")
        finally:
            clear_access_token(target_name=target)
        self.assertIsNone(load_access_token(target_name=target))

    def test_rejects_empty_token(self) -> None:
        with self.assertRaisesRegex(ValueError, "unsupported size"):
            save_access_token("")

    def test_other_platform_uses_system_keyring(self) -> None:
        data = {}

        class KeyringError(Exception):
            pass

        class PasswordDeleteError(KeyringError):
            pass

        def delete(service, account):
            if (service, account) not in data:
                raise PasswordDeleteError()
            del data[service, account]

        fake = types.SimpleNamespace(
            get_keyring=lambda: types.SimpleNamespace(priority=1),
            set_password=lambda service, account, token: data.__setitem__((service, account), token),
            get_password=lambda service, account: data.get((service, account)),
            delete_password=delete,
            errors=types.SimpleNamespace(KeyringError=KeyringError, PasswordDeleteError=PasswordDeleteError),
        )
        with patch("miro2obsidian.credential_store._is_windows", return_value=False):
            with patch.dict(sys.modules, {"keyring": fake}):
                self.assertIsNone(load_access_token(target_name="test-service"))
                save_access_token("synthetic", target_name="test-service")
                self.assertEqual(load_access_token(target_name="test-service"), "synthetic")
                clear_access_token(target_name="test-service")
                clear_access_token(target_name="test-service")
                self.assertIsNone(load_access_token(target_name="test-service"))

    def test_other_platform_reports_unusable_backend(self) -> None:
        fake = types.SimpleNamespace(
            get_keyring=lambda: types.SimpleNamespace(priority=0),
            errors=types.SimpleNamespace(KeyringError=Exception),
        )
        with patch("miro2obsidian.credential_store._is_windows", return_value=False):
            with patch.dict(sys.modules, {"keyring": fake}):
                with self.assertRaises(CredentialStoreUnavailable):
                    load_access_token()


class ConnectionRecordTests(unittest.TestCase):
    def setUp(self) -> None:
        self.backend = LimitedBackend()
        patcher = patch.object(credential_store, "_backend", return_value=self.backend)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_round_trip_fits_one_blob(self) -> None:
        save_connection(sample_connection())
        self.assertEqual(list(self.backend.data), [CONNECTION_TARGET_NAME])
        loaded = load_connection()
        self.assertEqual(loaded.access_token, "access-1")
        self.assertEqual(loaded.refresh_token, "refresh-1")
        self.assertEqual(loaded.client_secret, "secret-1")
        self.assertEqual(loaded.expires_at, datetime(2030, 1, 2, 3, 4, 5, tzinfo=timezone.utc))
        self.assertEqual(loaded.scopes, ("boards:read", "team:read"))
        self.assertEqual((loaded.team_id, loaded.team_name), ("t-1", "Design"))
        self.assertIsNotNone(loaded.saved_at)
        self.assertNotIn("secret-1", repr(loaded))
        self.assertNotIn("access-1", repr(loaded))

    def test_oversized_record_is_chunked_and_reassembled(self) -> None:
        big = sample_connection(refresh_token="r" * 3000, team_name="Équipe é" * 200)
        save_connection(big)
        parts = [t for t in self.backend.data if "/part/" in t]
        self.assertGreaterEqual(len(parts), 2)
        self.assertEqual(load_connection(), replace_saved(big, load_connection()))
        self.assertEqual(load_connection().refresh_token, "r" * 3000)
        self.assertEqual(load_connection().team_name, "Équipe é" * 200)

    def test_shrinking_record_removes_stale_parts(self) -> None:
        save_connection(sample_connection(refresh_token="r" * 6000))
        self.assertTrue([t for t in self.backend.data if "/part/" in t])
        save_connection(sample_connection())
        self.assertEqual([t for t in self.backend.data if "/part/" in t], [])
        self.assertEqual(load_connection().refresh_token, "refresh-1")

    def test_tampered_or_missing_part_loads_as_none(self) -> None:
        save_connection(sample_connection(refresh_token="r" * 6000))
        part = f"{CONNECTION_TARGET_NAME}/part/1"
        original = self.backend.data[part]
        self.backend.data[part] = original[:-1] + ("A" if original[-1] != "A" else "B")
        self.assertIsNone(load_connection())
        del self.backend.data[part]
        self.assertIsNone(load_connection())

    def test_clear_connection_removes_every_part(self) -> None:
        save_connection(sample_connection(refresh_token="r" * 6000))
        clear_connection()
        self.assertEqual(self.backend.data, {})
        clear_connection()

    def test_corrupt_or_foreign_record_loads_as_none(self) -> None:
        self.backend.data[CONNECTION_TARGET_NAME] = "not json"
        self.assertIsNone(load_connection())
        self.backend.data[CONNECTION_TARGET_NAME] = '{"version":1,"access_token":"x"}'
        self.assertIsNone(load_connection())

    def test_load_access_token_prefers_v2_then_legacy(self) -> None:
        self.assertIsNone(load_access_token())
        save_access_token("legacy-token")
        self.assertEqual(load_access_token(), "legacy-token")
        save_connection(sample_connection())
        self.assertEqual(load_access_token(), "access-1")
        self.assertEqual(load_legacy_access_token(), "legacy-token")

    def test_save_access_token_supersedes_v2_connection(self) -> None:
        save_connection(sample_connection())
        save_access_token("bare-token")
        self.assertIsNone(load_connection())
        self.assertEqual(load_access_token(), "bare-token")

    def test_custom_target_does_not_touch_v2_connection(self) -> None:
        save_connection(sample_connection())
        save_access_token("isolated", target_name="miro2obsidian/test/x")
        self.assertEqual(load_access_token(target_name="miro2obsidian/test/x"), "isolated")
        self.assertEqual(load_connection().access_token, "access-1")

    def test_clear_access_token_clears_both_records(self) -> None:
        save_connection(sample_connection())
        self.backend.data[TARGET_NAME] = "legacy-token"
        clear_access_token()
        self.assertEqual(self.backend.data, {})
        self.assertIsNone(load_access_token())

    def test_save_connection_requires_token_and_client_id(self) -> None:
        with self.assertRaises(ValueError):
            save_connection(sample_connection(access_token=""))


def replace_saved(expected: MiroConnection, loaded: MiroConnection) -> MiroConnection:
    from dataclasses import replace

    return replace(expected, saved_at=loaded.saved_at)


class ConnectionKeyringTests(unittest.TestCase):
    def test_connection_round_trip_through_system_keyring(self) -> None:
        data: dict = {}

        class KeyringError(Exception):
            pass

        class PasswordDeleteError(KeyringError):
            pass

        def delete(service, account):
            if (service, account) not in data:
                raise PasswordDeleteError()
            del data[service, account]

        fake = types.SimpleNamespace(
            get_keyring=lambda: types.SimpleNamespace(priority=1),
            set_password=lambda service, account, value: data.__setitem__((service, account), value),
            get_password=lambda service, account: data.get((service, account)),
            delete_password=delete,
            errors=types.SimpleNamespace(KeyringError=KeyringError, PasswordDeleteError=PasswordDeleteError),
        )
        with patch("miro2obsidian.credential_store._is_windows", return_value=False):
            with patch.dict(sys.modules, {"keyring": fake}):
                self.assertIsNone(load_connection())
                save_connection(sample_connection(refresh_token="r" * 5000))
                self.assertEqual(load_connection().refresh_token, "r" * 5000)
                clear_connection()
                self.assertEqual(data, {})

    def test_windows_backend_is_selected_and_enforces_blob_limit(self) -> None:
        with patch("miro2obsidian.credential_store._is_windows", return_value=True):
            backend = credential_store._backend()
        self.assertIsInstance(backend, credential_store._WindowsBackend)
        with self.assertRaises(ValueError):
            backend.write("target", "x" * (MAX_BLOB_BYTES + 1))
