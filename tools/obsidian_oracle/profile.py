"""Atomic activation and verification of M0 oracle compatibility profiles."""

from __future__ import annotations

import json
import os
import re
import stat
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

try:  # Direct script execution keeps compatibility with existing oracle tools.
    from .common import load_config, require_oracle_vault, work_dir
    from .compatibility import CompatibilityProfile, get_profile
    from .stage_compatibility_fixture import stage_profile
except ImportError:  # pragma: no cover - exercised by ``python path\tool.py``.
    from common import load_config, require_oracle_vault, work_dir
    from compatibility import CompatibilityProfile, get_profile
    from stage_compatibility_fixture import stage_profile


CONTROLLED_PLUGIN_IDS = ("advanced-canvas", "miro-canvas")
PLUGIN_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
RUNTIME_ASSETS = ("manifest.json", "main.js", "styles.css")


@dataclass(frozen=True)
class ProfileActivationResult:
    profile: CompatibilityProfile
    canvas_path: Path
    enabled_plugins_before: tuple[str, ...]
    enabled_plugins_after: tuple[str, ...]


@dataclass(frozen=True)
class ProfileCheckResult:
    profile: CompatibilityProfile
    canvas_path: Path
    enabled_plugins: tuple[str, ...]
    expected_plugins: tuple[str, ...]
    runtime_missing: tuple[str, ...]


def expected_plugin_ids(profile: CompatibilityProfile) -> tuple[str, ...]:
    """Return controlled plugin IDs required by one matrix row."""

    expected: list[str] = []
    if profile.advanced_canvas:
        expected.append("advanced-canvas")
    if profile.miro_canvas:
        expected.append("miro-canvas")
    return tuple(expected)


def _is_link_or_reparse(path: Path) -> bool:
    if path.is_symlink():
        return True
    try:
        attributes = path.stat(follow_symlinks=False).st_file_attributes
    except (AttributeError, FileNotFoundError, OSError):
        return False
    return bool(attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT)


def _require_regular_directory(path: Path, *, label: str) -> None:
    if _is_link_or_reparse(path) or not path.is_dir():
        raise RuntimeError(f"{label} is not a regular directory: {path}")


def _require_regular_file(path: Path, *, label: str) -> None:
    if _is_link_or_reparse(path) or not path.is_file():
        raise RuntimeError(f"{label} is not a regular file: {path}")


def _normalise_preserved_plugin_ids(plugin_ids: Iterable[str]) -> tuple[str, ...]:
    result: list[str] = []
    for plugin_id in plugin_ids:
        if not isinstance(plugin_id, str) or not PLUGIN_ID_PATTERN.fullmatch(plugin_id):
            raise ValueError(f"Unsafe unrelated plugin ID: {plugin_id!r}")
        if plugin_id in CONTROLLED_PLUGIN_IDS:
            raise ValueError(f"Controlled plugin ID cannot be preserved as unrelated: {plugin_id}")
        if plugin_id not in result:
            result.append(plugin_id)
    return tuple(result)


def _enabled_path(vault: Path) -> Path:
    obsidian = vault / ".obsidian"
    _require_regular_directory(obsidian, label="Oracle .obsidian directory")
    return obsidian / "community-plugins.json"


def _read_enabled(path: Path) -> tuple[list[str], bytes | None]:
    if path.is_symlink() or _is_link_or_reparse(path):
        raise RuntimeError(f"Enabled plugins file is linked or reparse: {path}")
    if not path.exists():
        return [], None
    _require_regular_file(path, label="Enabled plugins file")
    snapshot = path.read_bytes()
    try:
        payload = json.loads(snapshot.decode("utf-8-sig"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise RuntimeError(f"Enabled plugins file is not valid JSON: {path}") from exc
    if not isinstance(payload, list) or any(
        not isinstance(plugin_id, str) or not plugin_id for plugin_id in payload
    ):
        raise RuntimeError(f"Enabled plugins must be a JSON array of non-empty strings: {path}")
    if len(set(payload)) != len(payload):
        raise RuntimeError(f"Enabled plugins must not contain duplicates: {path}")
    return list(payload), snapshot


def _atomic_write_bytes(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb",
            prefix=f".{path.name}.",
            suffix=".tmp",
            dir=path.parent,
            delete=False,
        ) as handle:
            temporary = Path(handle.name)
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        temporary.replace(path)
        temporary = None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def _atomic_write_enabled(path: Path, enabled: Iterable[str]) -> None:
    _atomic_write_bytes(
        path,
        (json.dumps(list(enabled), ensure_ascii=False, indent=2) + "\n").encode("utf-8"),
    )


def _restore_snapshot(path: Path, snapshot: bytes | None, *, label: str) -> None:
    if snapshot is None:
        if not path.exists() and not path.is_symlink():
            return
        if _is_link_or_reparse(path):
            path.unlink(missing_ok=True)
        elif path.is_file():
            path.unlink()
        else:
            raise RuntimeError(f"Cannot remove unexpected {label}: {path}")
        return
    if path.exists() or path.is_symlink():
        _require_regular_file(path, label=label)
    _atomic_write_bytes(path, snapshot)


def _profile_target_path(vault: Path, config: dict[str, Any], profile: CompatibilityProfile) -> Path:
    root = (
        work_dir(config)
        / str(config.get("oracle_subfolder", "_oracle"))
        / "m0-compatibility"
    )
    try:
        root.resolve(strict=False).relative_to(vault.resolve(strict=False))
    except ValueError as exc:
        raise RuntimeError("Compatibility profile path escapes the oracle vault") from exc
    current = root
    while current != vault:
        if current.exists() or current.is_symlink():
            if _is_link_or_reparse(current) or not current.is_dir():
                raise RuntimeError(f"Compatibility profile path is not a regular directory: {current}")
        current = current.parent
    return root / f"{profile.id}.canvas"


def _read_canvas(path: Path, profile: CompatibilityProfile) -> None:
    _require_regular_file(path, label="Staged compatibility Canvas")
    try:
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as exc:
        raise RuntimeError(f"Staged compatibility Canvas is not valid JSON: {path}") from exc
    if not isinstance(payload, dict):
        raise RuntimeError(f"Staged compatibility Canvas must be an object: {path}")
    if not isinstance(payload.get("nodes"), list) or not isinstance(payload.get("edges"), list):
        raise RuntimeError(f"Staged compatibility Canvas lacks nodes/edges arrays: {path}")
    has_metadata = "miroCanvas" in payload
    if has_metadata != profile.miro_canvas:
        raise RuntimeError(f"Staged Canvas metadata does not match profile {profile.id}: {path}")
    if has_metadata:
        metadata = payload.get("miroCanvas")
        if not isinstance(metadata, dict) or metadata.get("schemaVersion") != 1:
            raise RuntimeError(f"Staged Canvas has invalid Miro metadata: {path}")


def _runtime_error(plugin_dir: Path, plugin_id: str, expected_version: str) -> str | None:
    if _is_link_or_reparse(plugin_dir) or not plugin_dir.is_dir():
        return f"{plugin_id} runtime directory is missing or linked"
    for asset in RUNTIME_ASSETS:
        path = plugin_dir / asset
        if _is_link_or_reparse(path) or not path.is_file() or path.stat().st_size == 0:
            return f"{plugin_id} runtime asset is missing, empty, or linked: {asset}"
    try:
        manifest = json.loads((plugin_dir / "manifest.json").read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as exc:
        return f"{plugin_id} manifest is invalid: {exc}"
    if not isinstance(manifest, dict) or manifest.get("id") != plugin_id:
        return f"{plugin_id} manifest id is invalid"
    if expected_version and str(manifest.get("version", "")) != expected_version:
        return f"{plugin_id} manifest version is not {expected_version}"
    return None


def _runtime_missing(vault: Path, plugin_ids: Iterable[str], config: dict[str, Any]) -> tuple[str, ...]:
    plugins_dir = vault / ".obsidian" / "plugins"
    missing: list[str] = []
    required = config.get("required_plugins", {})
    for plugin_id in plugin_ids:
        version = str(required.get(plugin_id, "")) if isinstance(required, dict) else ""
        error = _runtime_error(plugins_dir / plugin_id, plugin_id, version)
        if error:
            missing.append(error)
    return tuple(missing)


def _prepare_vault(vault_root: Path | str | None, config: dict[str, Any]) -> Path:
    vault = require_oracle_vault(vault_root, config)
    if not vault.exists():
        raise RuntimeError(f"Oracle vault does not exist: {vault}. Run init_local_vault.py first.")
    _require_regular_directory(vault / ".obsidian", label="Oracle .obsidian directory")
    return vault


def activate_profile(
    profile: CompatibilityProfile | str,
    vault_root: Path | str | None = None,
    *,
    preserve_plugin_ids: Iterable[str] = (),
) -> ProfileActivationResult:
    """Stage a profile and atomically set its enabled plugin set.

    Controlled IDs are derived from the matrix row.  Unrelated entries are
    removed unless their exact IDs are explicitly listed in
    ``preserve_plugin_ids`` and already exist in the settings file.
    """

    config = load_config()
    vault = _prepare_vault(vault_root, config)
    selected = get_profile(profile) if isinstance(profile, str) else profile
    preserved = _normalise_preserved_plugin_ids(preserve_plugin_ids)
    enabled_path = _enabled_path(vault)
    before_enabled, enabled_snapshot = _read_enabled(enabled_path)
    target = _profile_target_path(vault, config, selected)
    canvas_snapshot: bytes | None = None
    if target.exists() or target.is_symlink():
        _require_regular_file(target, label="Existing compatibility Canvas")
        canvas_snapshot = target.read_bytes()

    canvas_path = stage_profile(selected, vault)
    desired_controlled = expected_plugin_ids(selected)
    desired_preserved = tuple(plugin_id for plugin_id in before_enabled if plugin_id in preserved)
    after_enabled = [*desired_preserved, *desired_controlled]
    try:
        _atomic_write_enabled(enabled_path, after_enabled)
        verified_enabled, _ = _read_enabled(enabled_path)
        if verified_enabled != after_enabled:
            raise RuntimeError("Profile enabled-plugin settings failed verification")
        _read_canvas(canvas_path, selected)
    except Exception:
        restore_error: Exception | None = None
        try:
            _restore_snapshot(enabled_path, enabled_snapshot, label="Enabled plugins file")
            _restore_snapshot(target, canvas_snapshot, label="Compatibility Canvas")
        except Exception as error:
            restore_error = error
        if restore_error is not None:
            raise RuntimeError(f"Profile activation failed and rollback failed: {restore_error}") from restore_error
        raise

    return ProfileActivationResult(
        profile=selected,
        canvas_path=canvas_path,
        enabled_plugins_before=tuple(before_enabled),
        enabled_plugins_after=tuple(after_enabled),
    )


def check_profile(
    profile: CompatibilityProfile | str,
    vault_root: Path | str | None = None,
    *,
    preserve_plugin_ids: Iterable[str] = (),
    require_runtime: bool = False,
) -> ProfileCheckResult:
    """Verify one active profile without changing files.

    Runtime availability is reported separately from the enabled-state check;
    callers can use ``require_runtime`` when a real Obsidian execution is
    required, while matrix/configuration checks remain useful without plugin
    binaries.
    """

    config = load_config()
    vault = _prepare_vault(vault_root, config)
    selected = get_profile(profile) if isinstance(profile, str) else profile
    preserved = _normalise_preserved_plugin_ids(preserve_plugin_ids)
    enabled_path = _enabled_path(vault)
    enabled, _ = _read_enabled(enabled_path)
    expected = expected_plugin_ids(selected)
    expected_set = set(expected)
    actual_controlled = tuple(plugin_id for plugin_id in enabled if plugin_id in CONTROLLED_PLUGIN_IDS)
    actual_unrelated = tuple(plugin_id for plugin_id in enabled if plugin_id not in CONTROLLED_PLUGIN_IDS)
    allowed_unrelated = set(preserved)
    if set(actual_controlled) != expected_set or len(actual_controlled) != len(expected):
        raise RuntimeError(
            f"Profile {selected.id} enabled plugins mismatch: expected {list(expected)}, "
            f"got {list(actual_controlled)}"
        )
    if any(plugin_id not in allowed_unrelated for plugin_id in actual_unrelated):
        raise RuntimeError(
            f"Profile {selected.id} has unapproved unrelated enabled plugins: {list(actual_unrelated)}"
        )
    target = _profile_target_path(vault, config, selected)
    _read_canvas(target, selected)
    runtime_missing = _runtime_missing(vault, expected, config)
    if require_runtime and runtime_missing:
        raise RuntimeError(
            f"Profile {selected.id} runtime check failed: {'; '.join(runtime_missing)}"
        )
    return ProfileCheckResult(
        profile=selected,
        canvas_path=target,
        enabled_plugins=tuple(enabled),
        expected_plugins=tuple([*actual_unrelated, *expected]),
        runtime_missing=runtime_missing,
    )
