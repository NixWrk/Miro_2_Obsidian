from __future__ import annotations

import os
import shutil
import stat
import tempfile
from contextlib import contextmanager
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any, Iterator


def sidecar_path(json_path: Path) -> Path:
    return json_path.with_name(f"{json_path.stem}_files")


def _is_link_or_reparse(path: Path) -> bool:
    if path.is_symlink():
        return True
    try:
        attributes = path.stat(follow_symlinks=False).st_file_attributes
    except (AttributeError, FileNotFoundError, OSError):
        return False
    return bool(attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT)


def _assert_regular_file(path: Path, *, label: str) -> None:
    if _is_link_or_reparse(path) or not path.is_file():
        raise RuntimeError(f"{label} is not a regular file: {path}")


def _assert_regular_tree(path: Path, *, label: str) -> None:
    if _is_link_or_reparse(path) or not path.is_dir():
        raise RuntimeError(f"{label} is not a regular directory: {path}")
    for root, directories, files in os.walk(path, followlinks=False):
        root_path = Path(root)
        for name in [*directories, *files]:
            candidate = root_path / name
            if _is_link_or_reparse(candidate):
                raise RuntimeError(
                    f"{label} contains a link or reparse point: {candidate}"
                )


def is_link_or_reparse(path: Path) -> bool:
    return _is_link_or_reparse(Path(path))


def require_regular_file(path: Path, *, label: str = "File") -> None:
    _assert_regular_file(Path(path), label=label)


def require_regular_directory(path: Path, *, label: str = "Directory") -> None:
    _assert_regular_tree(Path(path), label=label)


def _remove_installed_path(path: Path) -> None:
    if path.is_symlink() or _is_link_or_reparse(path):
        path.unlink(missing_ok=True)
    elif path.is_dir():
        shutil.rmtree(path)
    else:
        path.unlink(missing_ok=True)


@contextmanager
def staged_export_path(output_json: Path) -> Iterator[Path]:
    output_json.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix=f".{output_json.stem}-stage-",
        dir=output_json.parent,
    ) as temporary:
        yield Path(temporary) / output_json.name


def publish_staged_bundle(staged_json: Path, output_json: Path) -> None:
    """Publish a staged JSON and its optional sidecar, restoring the old bundle on failure."""
    _assert_regular_file(staged_json, label="Staged export JSON")
    staged_sidecar = sidecar_path(staged_json)
    output_sidecar = sidecar_path(output_json)
    if staged_sidecar.exists() or staged_sidecar.is_symlink():
        _assert_regular_tree(staged_sidecar, label="Staged asset sidecar")

    output_json.parent.mkdir(parents=True, exist_ok=True)
    if output_json.exists() or output_json.is_symlink():
        _assert_regular_file(output_json, label="Existing export JSON")
    if output_sidecar.exists() or output_sidecar.is_symlink():
        _assert_regular_tree(output_sidecar, label="Existing asset sidecar")

    with tempfile.TemporaryDirectory(
        prefix=f".{output_json.stem}-backup-",
        dir=output_json.parent,
    ) as temporary:
        backup_root = Path(temporary)
        backup_json = backup_root / output_json.name
        backup_sidecar = backup_root / output_sidecar.name
        had_json = output_json.exists()
        had_sidecar = output_sidecar.exists()
        moved_json = False
        moved_sidecar = False
        installed_json = False
        installed_sidecar = False

        try:
            if had_json:
                output_json.rename(backup_json)
                moved_json = True
            if had_sidecar:
                output_sidecar.rename(backup_sidecar)
                moved_sidecar = True
            if staged_sidecar.exists():
                staged_sidecar.rename(output_sidecar)
                installed_sidecar = True
            staged_json.replace(output_json)
            installed_json = True
        except Exception:
            if installed_json and output_json.exists():
                _remove_installed_path(output_json)
            if installed_sidecar and output_sidecar.exists():
                _remove_installed_path(output_sidecar)
            if moved_sidecar and backup_sidecar.exists():
                backup_sidecar.rename(output_sidecar)
            if moved_json and backup_json.exists():
                backup_json.rename(output_json)
            raise


def publish_staged_directory(staged_dir: Path, output_dir: Path) -> None:
    """Replace a dedicated output directory and restore its prior generation on failure."""
    _assert_regular_tree(staged_dir, label="Staged output directory")
    output_dir.parent.mkdir(parents=True, exist_ok=True)
    if output_dir.exists() or output_dir.is_symlink():
        _assert_regular_tree(output_dir, label="Existing output directory")

    with tempfile.TemporaryDirectory(
        prefix=f".{output_dir.name}-backup-",
        dir=output_dir.parent,
    ) as temporary:
        backup = Path(temporary) / output_dir.name
        had_output = output_dir.exists()
        installed = False
        if had_output:
            output_dir.rename(backup)
        try:
            staged_dir.rename(output_dir)
            installed = True
        except Exception:
            if installed and output_dir.exists():
                _remove_installed_path(output_dir)
            if had_output and backup.exists():
                backup.rename(output_dir)
            raise


_WINDOWS_RESERVED_NAMES = {
    "CON",
    "PRN",
    "AUX",
    "NUL",
    *(f"COM{index}" for index in range(1, 10)),
    *(f"LPT{index}" for index in range(1, 10)),
}


def _unsafe_portable_name_part(part: str) -> bool:
    stem = part.split(".", 1)[0].upper()
    return bool(
        not part
        or ":" in part
        or part.endswith((" ", "."))
        or any(ord(character) < 32 for character in part)
        or stem in _WINDOWS_RESERVED_NAMES
    )


def referenced_local_names(items: list[dict[str, Any]]) -> list[Path]:
    names: list[Path] = []
    seen: set[str] = set()
    for item in items:
        original_name = str(item.get("local_name") or "")
        raw_name = original_name.strip()
        if not raw_name:
            continue
        if raw_name != original_name:
            raise RuntimeError(
                f"Asset local_name must stay inside the sidecar: {original_name}"
            )
        portable_name = raw_name.replace("\\", "/")
        posix_name = PurePosixPath(portable_name)
        windows_name = PureWindowsPath(raw_name)
        if (
            not posix_name.parts
            or posix_name.is_absolute()
            or windows_name.is_absolute()
            or bool(windows_name.drive)
            or any(
                part in {".", ".."} or _unsafe_portable_name_part(part)
                for part in posix_name.parts
            )
        ):
            raise RuntimeError(
                f"Asset local_name must stay inside the sidecar: {raw_name}"
            )
        relative = Path(*posix_name.parts)
        normalized = os.path.normcase(str(relative))
        if normalized not in seen:
            seen.add(normalized)
            names.append(relative)
    return names


def copy_referenced_sidecar(
    items: list[dict[str, Any]],
    *,
    source_json: Path,
    staged_json: Path,
) -> None:
    names = referenced_local_names(items)
    if not names:
        return
    source_root = sidecar_path(source_json)
    _assert_regular_tree(source_root, label="Source asset sidecar")
    source_resolved = source_root.resolve()
    target_root = sidecar_path(staged_json)

    for relative in names:
        source = source_root / relative
        try:
            source.resolve().relative_to(source_resolved)
        except (OSError, ValueError) as exc:
            raise RuntimeError(f"Asset escapes source sidecar: {relative}") from exc
        _assert_regular_file(source, label="Referenced asset")
        target = target_root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
