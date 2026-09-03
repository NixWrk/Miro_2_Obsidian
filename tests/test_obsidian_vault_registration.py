from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import Mock
from urllib.parse import parse_qs, urlsplit

import pytest

from tools.obsidian_oracle.open_local_vault import (
    VaultRegistration,
    build_open_uri,
    inspect_registration,
    open_registered_vault,
)


def test_existing_folder_is_not_a_registered_vault(tmp_path: Path) -> None:
    vault = tmp_path / "oracle"
    vault.mkdir()
    registry = tmp_path / "obsidian.json"
    registry.write_text('{"vaults": {}}', encoding="utf-8")
    before = registry.read_bytes()
    status = inspect_registration(vault, registry)
    assert status.status == "unregistered"
    launcher = Mock()
    with pytest.raises(ValueError, match="not unambiguously registered"):
        open_registered_vault(vault, status, launcher=launcher)
    launcher.assert_not_called()
    assert registry.read_bytes() == before


def test_uses_exact_registration_not_a_parent_or_same_named_vault(tmp_path: Path) -> None:
    vault = tmp_path / "project" / "oracle"
    vault.mkdir(parents=True)
    registry = tmp_path / "obsidian.json"
    registry.write_text(json.dumps({"vaults": {
        "0123456789abcdef": {"path": str(vault.parent)},
        "fedcba9876543210": {"path": str(tmp_path / "elsewhere" / "oracle")},
    }}), encoding="utf-8")
    assert inspect_registration(vault, registry).status == "unregistered"


def test_unicode_profile_uri_is_encoded_and_explicit_launch_only(tmp_path: Path) -> None:
    vault = tmp_path / "Тест vault"
    vault.mkdir()
    canvas = vault / "Доска & 1.canvas"
    canvas.write_text('{"nodes":[],"edges":[]}', encoding="utf-8")
    registry = tmp_path / "obsidian.json"
    registry.write_text(json.dumps({"vaults": {
        "0123456789abcdef": {"path": str(vault)},
    }}), encoding="utf-8")
    status = inspect_registration(vault, registry)
    assert status == VaultRegistration("registered", "0123456789abcdef")
    uri = build_open_uri(vault, status, canvas)
    assert parse_qs(urlsplit(uri).query) == {"vault": ["0123456789abcdef"], "file": [canvas.name]}
    assert " " not in uri
    launcher = Mock()
    assert open_registered_vault(vault, status, canvas, launcher=launcher) == uri
    launcher.assert_called_once_with(uri)


@pytest.mark.parametrize("payload", ["{broken", "[]", '{}', '{"vaults": []}'])
def test_unreadable_or_malformed_registry_is_unknown(tmp_path: Path, payload: str) -> None:
    registry = tmp_path / "obsidian.json"
    registry.write_text(payload, encoding="utf-8")
    assert inspect_registration(tmp_path, registry).status == "unknown"


def test_ambiguous_registration_and_outside_file_are_refused(tmp_path: Path) -> None:
    vault = tmp_path / "oracle"
    vault.mkdir()
    registry = tmp_path / "obsidian.json"
    registry.write_text(json.dumps({"vaults": {
        "0123456789abcdef": {"path": str(vault)},
        "fedcba9876543210": {"path": str(vault)},
    }}), encoding="utf-8")
    assert inspect_registration(vault, registry).status == "ambiguous"
    with pytest.raises(ValueError, match="escapes"):
        build_open_uri(vault, VaultRegistration("registered", "0123456789abcdef"), tmp_path / "outside.canvas")
