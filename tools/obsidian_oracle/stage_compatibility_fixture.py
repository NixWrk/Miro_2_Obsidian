"""Stage committed M0 Canvas compatibility fixtures in the oracle vault."""

from __future__ import annotations

import argparse
import shutil
import stat
import tempfile
from pathlib import Path

try:  # Direct script execution keeps compatibility with existing oracle tools.
    from .common import load_config, require_oracle_vault, work_dir
    from .compatibility import (
        MATRIX_PATH,
        CompatibilityProfile,
        get_profile,
        load_compatibility_matrix,
    )
except ImportError:  # pragma: no cover - exercised by ``python path\tool.py``.
    from common import load_config, require_oracle_vault, work_dir
    from compatibility import (
        MATRIX_PATH,
        CompatibilityProfile,
        get_profile,
        load_compatibility_matrix,
    )


def _is_link_or_reparse(path: Path) -> bool:
    if path.is_symlink():
        return True
    try:
        attributes = path.stat(follow_symlinks=False).st_file_attributes
    except (AttributeError, FileNotFoundError, OSError):
        return False
    return bool(attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT)


def _require_directory(path: Path, *, label: str) -> None:
    if _is_link_or_reparse(path) or not path.is_dir():
        raise RuntimeError(f"{label} is not a regular directory: {path}")


def _atomic_copy(source: Path, target: Path) -> None:
    if _is_link_or_reparse(source) or not source.is_file():
        raise RuntimeError(f"Fixture source is not a regular file: {source}")
    if target.exists() or target.is_symlink():
        if _is_link_or_reparse(target) or not target.is_file():
            raise RuntimeError(f"Fixture target is not a replaceable regular file: {target}")
    target.parent.mkdir(parents=True, exist_ok=True)
    _require_directory(target.parent, label="Fixture target directory")
    with tempfile.TemporaryDirectory(prefix=f".{target.name}-stage-", dir=target.parent) as temporary:
        staged = Path(temporary) / target.name
        shutil.copy2(source, staged)
        staged.replace(target)


def staging_root(
    vault_root: Path,
    config: dict[str, object],
    *,
    create: bool = True,
) -> Path:
    """Return the guarded profile directory, optionally creating it."""

    work = work_dir(config)
    if work.exists() or work.is_symlink():
        _require_directory(work, label="Oracle work directory")
    elif create:
        work.mkdir(parents=True, exist_ok=True)
        _require_directory(work, label="Oracle work directory")
    else:
        raise RuntimeError(f"Oracle work directory is missing: {work}")
    oracle = work / str(config.get("oracle_subfolder", "_oracle"))
    if oracle.exists() or oracle.is_symlink():
        _require_directory(oracle, label="Oracle fixture directory")
    elif create:
        oracle.mkdir(parents=True, exist_ok=True)
        _require_directory(oracle, label="Oracle fixture directory")
    else:
        raise RuntimeError(f"Oracle fixture directory is missing: {oracle}")
    root = oracle / "m0-compatibility"
    try:
        root.resolve(strict=False).relative_to(vault_root.resolve(strict=False))
    except ValueError as exc:
        raise RuntimeError("Compatibility fixture staging path escapes the oracle vault") from exc
    if root.exists() or root.is_symlink():
        _require_directory(root, label="Compatibility staging directory")
    elif create:
        root.mkdir(parents=True, exist_ok=True)
    else:
        raise RuntimeError(f"Compatibility staging directory is missing: {root}")
    _require_directory(root, label="Compatibility staging directory")
    return root


def stage_profile(profile: CompatibilityProfile | str, vault_root: Path | str | None = None) -> Path:
    """Copy one committed profile into the guarded project-local vault."""

    config = load_config()
    vault = require_oracle_vault(vault_root, config)
    obsidian = vault / ".obsidian"
    if not vault.exists() or _is_link_or_reparse(obsidian) or not obsidian.is_dir():
        raise RuntimeError(f"Oracle vault is not initialized: {vault}")
    selected = get_profile(profile) if isinstance(profile, str) else profile
    target = staging_root(vault, config) / f"{selected.id}.canvas"
    _atomic_copy(selected.canvas_path, target)
    return target


def stage_all_profiles(vault_root: Path | str | None = None) -> tuple[Path, ...]:
    """Stage every matrix row and return paths in committed matrix order."""

    config = load_config()
    vault = require_oracle_vault(vault_root, config)
    target_root = staging_root(vault, config)
    paths = tuple(stage_profile(profile, vault) for profile in load_compatibility_matrix())
    _atomic_copy(MATRIX_PATH, target_root / "compatibility_matrix.json")
    return paths


def main() -> int:
    parser = argparse.ArgumentParser(description="Stage offline M0 native/Advanced compatibility fixtures.")
    parser.add_argument("profile", nargs="?", help="Profile ID, or omit to stage all four profiles.")
    parser.add_argument(
        "--vault-root",
        type=Path,
        help="Must equal the oracle_config.json vault path; arbitrary user vaults are refused.",
    )
    args = parser.parse_args()
    if args.profile:
        print(stage_profile(args.profile, args.vault_root))
    else:
        for path in stage_all_profiles(args.vault_root):
            print(path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
