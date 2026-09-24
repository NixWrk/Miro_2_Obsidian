"""Keep one copy of each attachment's bytes, shared across every board.

Converter.py copies a board's exported sidecar folder into the vault and
points each file node at that copy: two boards with the same picture keep
two copies, and re-importing one board copies the same bytes again. This
module runs once Converter.py has written a board. It hashes every file
node that still points inside this conversion's own sidecar folder, and
folds it into one shared store, keyed by content, so identical bytes are
kept once no matter how many boards or nodes point at them.

Ordering keeps a crash from ever half-applying: a file is copied into the
store before the board is rewritten to point at it, the board is written
before the manifest records the new copy, and the sidecar is only cleaned up
once both are safely on disk. If anything goes wrong before the board is
written, whatever this run added to the store is removed again and the
board and sidecar are left exactly as Converter.py left them.
"""

from __future__ import annotations

import hashlib
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Callable

from Json_2_Canvas.Converter import (
    _copy_file_atomic,
    _is_link_or_reparse,
    _require_regular_file,
    relpath_from_vault,
)
from Json_2_Canvas.publication import write_json_atomic
from scripts.miro_capability_probe import load_json

#: Where the shared-attachment manifest lives inside every vault this
#: pipeline writes boards into.
MANIFEST_RELATIVE_PATH = Path(".miro2obsidian") / "attachments.json"

#: The manifest's own schema version, independent of the board schema.
MANIFEST_VERSION = 1

#: A document can reference files beside it by relative name (an exported
#: .html page linking to its own images), so its sidecar is never folded
#: into the shared store.
_DOCUMENT_SUFFIXES = {".html", ".htm"}

_HASH_CHUNK_BYTES = 1024 * 1024


@dataclass
class AttachmentShareStats:
    """Counts from one `share_board_attachments` run, for logs and PipelineResult."""

    considered: int = 0
    reused_from_manifest: int = 0
    copied_to_store: int = 0
    collapsed_duplicates: int = 0
    skipped_documents: int = 0
    skipped_outside_vault: int = 0
    skipped_outside_sidecar: int = 0
    skipped_missing_or_link: int = 0
    stale_manifest_entries_dropped: int = 0
    sidecar_files_removed: int = 0

    def as_dict(self) -> dict[str, int]:
        return asdict(self)


def _sha256_file(path: Path) -> str:
    """Stream the file through SHA-256 rather than loading it whole."""
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(_HASH_CHUNK_BYTES), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _inside(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _node_absolute_path(vault_root: Path, node_file: str) -> Path | None:
    """A node's vault-relative `file`, resolved - or None if it is empty or
    escapes the vault (a stray `../`, an absolute path smuggled into the
    board, and so on)."""
    if not node_file:
        return None
    resolved = (vault_root / node_file).resolve(strict=False)
    return resolved if _inside(resolved, vault_root) else None


def _manifest_path(vault_root: Path) -> Path:
    return vault_root / MANIFEST_RELATIVE_PATH


def _load_manifest_files(vault_root: Path) -> dict[str, Any]:
    path = _manifest_path(vault_root)
    if not path.is_file():
        return {}
    try:
        payload = load_json(path)
    except (OSError, ValueError):
        # An unreadable manifest is treated as empty rather than fatal: the
        # worst outcome is re-copying attachments this run, not a failed
        # conversion.
        return {}
    files = payload.get("files") if isinstance(payload, dict) else None
    return dict(files) if isinstance(files, dict) else {}


def _validated_manifest_target(vault_root: Path, digest: str, entry: Any) -> Path | None:
    """The manifest's claimed file for `digest`, trusted only if it still
    exists inside the vault, is a regular file, and still hashes to `digest`
    at the size the manifest recorded."""
    if not isinstance(entry, dict):
        return None
    relative_path = str(entry.get("path") or "").strip()
    size = entry.get("size")
    if not relative_path or not isinstance(size, int) or isinstance(size, bool):
        return None
    candidate = _node_absolute_path(vault_root, relative_path)
    if candidate is None:
        return None
    if _is_link_or_reparse(candidate) or not candidate.is_file():
        return None
    try:
        if candidate.stat().st_size != size:
            return None
    except OSError:
        return None
    return candidate if _sha256_file(candidate) == digest else None


def _store_file_name(original_name: str, digest: str) -> str:
    """`<original stem>-<first 12 hex of the hash><suffix>`, so a shared file
    still reads like the attachment it is, while its name stays unique to
    its content."""
    stem = Path(original_name).stem or "attachment"
    suffix = Path(original_name).suffix
    return f"{stem}-{digest[:12]}{suffix}"


def _rollback_store_additions(
    created_store_paths: list[Path], store_dir: Path, store_dir_preexisted: bool
) -> None:
    for path in created_store_paths:
        path.unlink(missing_ok=True)
    if store_dir_preexisted or not store_dir.is_dir():
        return
    try:
        if not any(store_dir.iterdir()):
            store_dir.rmdir()
    except OSError:
        pass


def _cleanup_sidecar(nodes: list[Any], vault_root: Path, sidecar_dir: Path) -> int:
    """Remove sidecar files no node still points at, then drop the sidecar
    folder itself once it is empty. A document kept for its own sake (an
    .html export beside its images) stays referenced, so it and its
    directory survive."""
    if not sidecar_dir.is_dir():
        return 0

    still_referenced: set[Path] = set()
    for node in nodes:
        if not isinstance(node, dict) or node.get("type") != "file":
            continue
        absolute = _node_absolute_path(vault_root, str(node.get("file") or ""))
        if absolute is not None and _inside(absolute, sidecar_dir):
            still_referenced.add(absolute)

    removed = 0
    # Deepest entries first, so a file is gone before its parent directory's
    # rmdir is attempted.
    for path in sorted(sidecar_dir.rglob("*"), key=lambda p: len(p.parts), reverse=True):
        if _is_link_or_reparse(path):
            continue
        if path.is_dir():
            try:
                path.rmdir()
            except OSError:
                pass  # still holds a referenced file or sub-directory
            continue
        if path in still_referenced:
            continue
        try:
            path.unlink()
            removed += 1
        except OSError:
            pass

    try:
        sidecar_dir.rmdir()
    except OSError:
        pass  # not empty (a kept document) or already gone
    return removed


def share_board_attachments(
    canvas_path: str | Path,
    vault_root: str | Path,
    store_dir: str | Path,
    *,
    sidecar_dir: str | Path,
    logger: Callable[[str], None] | None = None,
) -> dict[str, int]:
    """Fold this board's freshly-copied sidecar files into the shared store.

    Every `file` node pointing inside `sidecar_dir` (and inside
    `vault_root`) is hashed; a hash already in the manifest is reused, a new
    one is copied into `store_dir` and recorded. The board is rewritten to
    point at the shared copies, and only once that and the manifest are
    written does the now-unreferenced sidecar get cleaned up.
    """

    def log(message: str) -> None:
        if logger is not None:
            logger(message)

    canvas_path = Path(canvas_path)
    vault_root = Path(vault_root).resolve()
    store_dir = Path(store_dir)
    sidecar_dir = Path(sidecar_dir).resolve(strict=False)
    _require_regular_file(canvas_path, label="Board")

    board = load_json(canvas_path)
    nodes = board.get("nodes") if isinstance(board, dict) else None
    stats = AttachmentShareStats()
    if not isinstance(nodes, list):
        return stats.as_dict()

    manifest_files = _load_manifest_files(vault_root)
    manifest_changed = False
    digests_seen_this_run: set[str] = set()
    created_store_paths: list[Path] = []
    store_dir_preexisted = store_dir.is_dir()
    rewrites: dict[int, str] = {}

    try:
        for index, node in enumerate(nodes):
            if not isinstance(node, dict) or node.get("type") != "file":
                continue
            node_file = str(node.get("file") or "")
            if not node_file:
                continue

            absolute = _node_absolute_path(vault_root, node_file)
            if absolute is None:
                stats.skipped_outside_vault += 1
                continue
            if absolute.suffix.lower() in _DOCUMENT_SUFFIXES:
                stats.skipped_documents += 1
                continue
            if not _inside(absolute, sidecar_dir):
                stats.skipped_outside_sidecar += 1
                continue
            if _is_link_or_reparse(absolute) or not absolute.is_file():
                stats.skipped_missing_or_link += 1
                continue

            stats.considered += 1
            digest = _sha256_file(absolute)
            if digest in digests_seen_this_run:
                stats.collapsed_duplicates += 1
            else:
                digests_seen_this_run.add(digest)

            manifest_entry = manifest_files.get(digest)
            shared_path = (
                _validated_manifest_target(vault_root, digest, manifest_entry)
                if manifest_entry is not None
                else None
            )
            if manifest_entry is not None and shared_path is None:
                stats.stale_manifest_entries_dropped += 1
                del manifest_files[digest]
                manifest_changed = True

            if shared_path is not None:
                stats.reused_from_manifest += 1
            else:
                store_target = store_dir / _store_file_name(absolute.name, digest)
                if store_target.exists():
                    if _is_link_or_reparse(store_target) or not store_target.is_file():
                        raise ValueError(
                            f"Shared attachment path is not a regular file: {store_target}"
                        )
                    if _sha256_file(store_target) != digest:
                        raise ValueError(
                            "Shared attachment name collides with different "
                            f"content: {store_target}"
                        )
                    stats.reused_from_manifest += 1
                else:
                    store_dir.mkdir(parents=True, exist_ok=True)
                    _copy_file_atomic(absolute, store_target)
                    created_store_paths.append(store_target)
                    stats.copied_to_store += 1
                manifest_files[digest] = {
                    "path": relpath_from_vault(str(store_target), str(vault_root)),
                    "size": store_target.stat().st_size,
                }
                manifest_changed = True
                shared_path = store_target

            new_relative = relpath_from_vault(str(shared_path), str(vault_root))
            if new_relative != node_file:
                rewrites[index] = new_relative
    except Exception:
        _rollback_store_additions(created_store_paths, store_dir, store_dir_preexisted)
        raise

    if rewrites:
        for index, new_relative in rewrites.items():
            nodes[index]["file"] = new_relative
        try:
            write_json_atomic(canvas_path, board)
        except Exception:
            _rollback_store_additions(created_store_paths, store_dir, store_dir_preexisted)
            raise
        log(f"Rewrote {len(rewrites)} attachment reference(s) to the shared store.")

    if manifest_changed:
        manifest_path = _manifest_path(vault_root)
        manifest_path.parent.mkdir(parents=True, exist_ok=True)
        write_json_atomic(
            manifest_path, {"version": MANIFEST_VERSION, "files": manifest_files}
        )

    if stats.considered:
        stats.sidecar_files_removed = _cleanup_sidecar(nodes, vault_root, sidecar_dir)

    log(
        "Attachment sharing: "
        + ", ".join(f"{key}={value}" for key, value in stats.as_dict().items())
    )
    return stats.as_dict()
