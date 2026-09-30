from __future__ import annotations

import os
import sys
import types
import unittest
from uuid import uuid4
from unittest.mock import patch

from miro2obsidian.credential_store import (
    CredentialStoreUnavailable,
    clear_access_token,
    load_access_token,
    save_access_token,
)


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
