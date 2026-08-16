from __future__ import annotations

import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest

from scripts.miro_export_bundle import (
    copy_referenced_sidecar,
    publish_staged_bundle,
    referenced_local_names,
    sidecar_path,
)


def test_publish_rollback_restores_previous_bundle() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        output = root / "board.json"
        output.write_text("old-json", encoding="utf-8")
        output_sidecar = sidecar_path(output)
        output_sidecar.mkdir()
        (output_sidecar / "old.bin").write_bytes(b"old")

        stage_root = root / "stage"
        stage_root.mkdir()
        staged = stage_root / "board.json"
        staged.write_text("new-json", encoding="utf-8")
        staged_sidecar = sidecar_path(staged)
        staged_sidecar.mkdir()
        (staged_sidecar / "new.bin").write_bytes(b"new")

        original_replace = Path.replace

        def fail_staged_json(path: Path, target: Path):
            if path == staged:
                raise OSError("simulated JSON publication failure")
            return original_replace(path, target)

        with patch.object(Path, "replace", autospec=True, side_effect=fail_staged_json):
            with pytest.raises(OSError, match="simulated JSON publication failure"):
                publish_staged_bundle(staged, output)

        assert output.read_text(encoding="utf-8") == "old-json"
        assert (output_sidecar / "old.bin").read_bytes() == b"old"
        assert not (output_sidecar / "new.bin").exists()


def test_publish_rollback_restores_json_when_sidecar_backup_fails() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        output = root / "board.json"
        output.write_text("old-json", encoding="utf-8")
        output_sidecar = sidecar_path(output)
        output_sidecar.mkdir()
        (output_sidecar / "old.bin").write_bytes(b"old")

        stage_root = root / "stage"
        stage_root.mkdir()
        staged = stage_root / "board.json"
        staged.write_text("new-json", encoding="utf-8")

        original_rename = Path.rename

        def fail_sidecar_backup(path: Path, target: Path):
            if path == output_sidecar:
                raise OSError("simulated sidecar backup failure")
            return original_rename(path, target)

        with patch.object(
            Path, "rename", autospec=True, side_effect=fail_sidecar_backup
        ):
            with pytest.raises(OSError, match="simulated sidecar backup failure"):
                publish_staged_bundle(staged, output)

        assert output.read_text(encoding="utf-8") == "old-json"
        assert (output_sidecar / "old.bin").read_bytes() == b"old"
        assert staged.read_text(encoding="utf-8") == "new-json"


@pytest.mark.parametrize(
    "local_name",
    [
        "../secret.txt",
        "nested/../../secret.txt",
        "/absolute.txt",
        "C:\\secret.txt",
        "asset.png:secret",
        "CON",
        "nested/NUL.txt",
        "trailing-dot.",
        "trailing-space ",
        ".",
    ],
)
def test_referenced_local_names_rejects_paths_outside_sidecar(local_name: str) -> None:
    with pytest.raises(RuntimeError, match="stay inside"):
        referenced_local_names([{"local_name": local_name}])


def test_copy_referenced_sidecar_uses_local_name_allowlist() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        source = root / "source.json"
        source.write_text("{}", encoding="utf-8")
        source_sidecar = sidecar_path(source)
        (source_sidecar / "nested").mkdir(parents=True)
        (source_sidecar / "nested" / "keep.bin").write_bytes(b"keep")
        (source_sidecar / "ignore.bin").write_bytes(b"ignore")

        staged = root / "stage" / "board.json"
        staged.parent.mkdir()
        staged.write_text("{}", encoding="utf-8")
        copy_referenced_sidecar(
            [{"local_name": "nested/keep.bin"}],
            source_json=source,
            staged_json=staged,
        )

        assert (sidecar_path(staged) / "nested" / "keep.bin").read_bytes() == b"keep"
        assert not (sidecar_path(staged) / "ignore.bin").exists()
