from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from Json_2_Canvas.attachment_store import (
    MANIFEST_RELATIVE_PATH,
    share_board_attachments,
)
from Json_2_Canvas.publication import write_json_atomic
from miro2obsidian.schema import validate_board


def _file_node(node_id: str, relative_path: str) -> dict:
    return {
        "id": node_id,
        "type": "file",
        "x": 0,
        "y": 0,
        "width": 100,
        "height": 100,
        "file": relative_path,
    }


def _write_board(path: Path, nodes: list[dict], *, extra: dict | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    board = {"nodes": nodes, "edges": []}
    if extra:
        board.update(extra)
    write_json_atomic(path, board)


def _load_board(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


class AttachmentStoreTests(unittest.TestCase):
    def test_two_boards_share_one_stored_copy(self) -> None:
        with tempfile.TemporaryDirectory(prefix="miro2obs_attach_share_") as tmp:
            root = Path(tmp)
            vault = root / "vault"
            store = vault / "Miro attachments"
            sidecar_a = vault / "Canvas" / "board_a_files"
            sidecar_b = vault / "Canvas" / "board_b_files"
            sidecar_a.mkdir(parents=True)
            sidecar_b.mkdir(parents=True)
            (sidecar_a / "pic.png").write_bytes(b"same-bytes")
            (sidecar_b / "pic.png").write_bytes(b"same-bytes")

            canvas_a = vault / "Canvas" / "board_a.canvas"
            canvas_b = vault / "Canvas" / "board_b.canvas"
            _write_board(canvas_a, [_file_node("file-1", "Canvas/board_a_files/pic.png")])
            _write_board(canvas_b, [_file_node("file-1", "Canvas/board_b_files/pic.png")])

            stats_a = share_board_attachments(canvas_a, vault, store, sidecar_dir=sidecar_a)
            stats_b = share_board_attachments(canvas_b, vault, store, sidecar_dir=sidecar_b)

            board_a = _load_board(canvas_a)
            board_b = _load_board(canvas_b)
            self.assertEqual(board_a["nodes"][0]["file"], board_b["nodes"][0]["file"])
            self.assertTrue((vault / board_a["nodes"][0]["file"]).is_file())
            self.assertEqual(stats_a["copied_to_store"], 1)
            self.assertEqual(stats_b["copied_to_store"], 0)
            self.assertEqual(stats_b["reused_from_manifest"], 1)
            # Both sidecars are now empty (their one file moved into the
            # shared store) and were removed along with them.
            self.assertFalse(sidecar_a.exists())
            self.assertFalse(sidecar_b.exists())

    def test_second_import_reuses_manifest_without_copying(self) -> None:
        with tempfile.TemporaryDirectory(prefix="miro2obs_attach_reimport_") as tmp:
            root = Path(tmp)
            vault = root / "vault"
            store = vault / "Miro attachments"
            sidecar = vault / "Canvas" / "board_files"
            sidecar.mkdir(parents=True)
            (sidecar / "pic.png").write_bytes(b"reimported-bytes")
            canvas = vault / "Canvas" / "board.canvas"
            _write_board(canvas, [_file_node("file-1", "Canvas/board_files/pic.png")])

            first = share_board_attachments(canvas, vault, store, sidecar_dir=sidecar)
            self.assertEqual(first["copied_to_store"], 1)

            # Re-import: Converter.py copies the source sidecar back in with
            # the same bytes, and the pipeline shares it again.
            sidecar.mkdir(parents=True, exist_ok=True)
            (sidecar / "pic.png").write_bytes(b"reimported-bytes")
            _write_board(canvas, [_file_node("file-1", "Canvas/board_files/pic.png")])

            second = share_board_attachments(canvas, vault, store, sidecar_dir=sidecar)

        self.assertEqual(second["copied_to_store"], 0)
        self.assertEqual(second["reused_from_manifest"], 1)

    def test_identical_content_under_two_names_collapses_to_one_file(self) -> None:
        with tempfile.TemporaryDirectory(prefix="miro2obs_attach_collapse_") as tmp:
            root = Path(tmp)
            vault = root / "vault"
            store = vault / "Miro attachments"
            sidecar = vault / "Canvas" / "board_files"
            sidecar.mkdir(parents=True)
            (sidecar / "a.png").write_bytes(b"duplicate-bytes")
            (sidecar / "b.png").write_bytes(b"duplicate-bytes")
            canvas = vault / "Canvas" / "board.canvas"
            _write_board(
                canvas,
                [
                    _file_node("file-1", "Canvas/board_files/a.png"),
                    _file_node("file-2", "Canvas/board_files/b.png"),
                ],
            )

            stats = share_board_attachments(canvas, vault, store, sidecar_dir=sidecar)

            board = _load_board(canvas)

            self.assertEqual(board["nodes"][0]["file"], board["nodes"][1]["file"])
            self.assertEqual(stats["copied_to_store"], 1)
            self.assertEqual(stats["collapsed_duplicates"], 1)
            self.assertEqual(len(list(store.iterdir())), 1)

    def test_html_document_stays_in_its_sidecar(self) -> None:
        with tempfile.TemporaryDirectory(prefix="miro2obs_attach_html_") as tmp:
            root = Path(tmp)
            vault = root / "vault"
            store = vault / "Miro attachments"
            sidecar = vault / "Canvas" / "board_files"
            sidecar.mkdir(parents=True)
            (sidecar / "doc.html").write_text("<html>hi</html>", encoding="utf-8")
            canvas = vault / "Canvas" / "board.canvas"
            _write_board(canvas, [_file_node("file-1", "Canvas/board_files/doc.html")])

            stats = share_board_attachments(canvas, vault, store, sidecar_dir=sidecar)

            board = _load_board(canvas)

            self.assertEqual(board["nodes"][0]["file"], "Canvas/board_files/doc.html")
            self.assertEqual(stats["skipped_documents"], 1)
            self.assertTrue((sidecar / "doc.html").is_file())

    def test_stale_manifest_entry_is_dropped_and_replaced(self) -> None:
        with tempfile.TemporaryDirectory(prefix="miro2obs_attach_stale_") as tmp:
            root = Path(tmp)
            vault = root / "vault"
            store = vault / "Miro attachments"
            sidecar = vault / "Canvas" / "board_files"
            sidecar.mkdir(parents=True)
            (sidecar / "pic.png").write_bytes(b"fresh-bytes")
            canvas = vault / "Canvas" / "board.canvas"
            _write_board(canvas, [_file_node("file-1", "Canvas/board_files/pic.png")])

            digest = hashlib.sha256(b"fresh-bytes").hexdigest()
            manifest_path = vault / MANIFEST_RELATIVE_PATH
            manifest_path.parent.mkdir(parents=True)
            manifest_path.write_text(
                json.dumps(
                    {
                        "version": 1,
                        "files": {
                            digest: {"path": "Miro attachments/ghost.png", "size": 5}
                        },
                    }
                ),
                encoding="utf-8",
            )

            stats = share_board_attachments(canvas, vault, store, sidecar_dir=sidecar)

        self.assertEqual(stats["stale_manifest_entries_dropped"], 1)
        self.assertEqual(stats["copied_to_store"], 1)

    def test_path_escaping_vault_is_skipped(self) -> None:
        with tempfile.TemporaryDirectory(prefix="miro2obs_attach_escape_") as tmp:
            root = Path(tmp)
            vault = root / "vault"
            store = vault / "Miro attachments"
            sidecar = vault / "Canvas" / "board_files"
            sidecar.mkdir(parents=True)
            (root / "secret.txt").write_text("secret", encoding="utf-8")
            canvas = vault / "Canvas" / "board.canvas"
            _write_board(canvas, [_file_node("file-1", "../secret.txt")])

            stats = share_board_attachments(canvas, vault, store, sidecar_dir=sidecar)

            board = _load_board(canvas)

        self.assertEqual(board["nodes"][0]["file"], "../secret.txt")
        self.assertEqual(stats["skipped_outside_vault"], 1)
        self.assertEqual(stats["considered"], 0)

    def test_link_target_is_skipped(self) -> None:
        with tempfile.TemporaryDirectory(prefix="miro2obs_attach_link_") as tmp:
            root = Path(tmp)
            vault = root / "vault"
            store = vault / "Miro attachments"
            sidecar = vault / "Canvas" / "board_files"
            sidecar.mkdir(parents=True)
            (sidecar / "pic.png").write_bytes(b"linked-bytes")
            canvas = vault / "Canvas" / "board.canvas"
            _write_board(canvas, [_file_node("file-1", "Canvas/board_files/pic.png")])

            with patch(
                "Json_2_Canvas.attachment_store._is_link_or_reparse", return_value=True
            ):
                stats = share_board_attachments(canvas, vault, store, sidecar_dir=sidecar)

        self.assertEqual(stats["skipped_missing_or_link"], 1)
        self.assertEqual(stats["considered"], 0)

    def test_failure_before_board_write_leaves_everything_as_it_was(self) -> None:
        with tempfile.TemporaryDirectory(prefix="miro2obs_attach_rollback_") as tmp:
            root = Path(tmp)
            vault = root / "vault"
            store = vault / "Miro attachments"
            sidecar = vault / "Canvas" / "board_files"
            sidecar.mkdir(parents=True)
            (sidecar / "pic.png").write_bytes(b"rollback-bytes")
            canvas = vault / "Canvas" / "board.canvas"
            _write_board(canvas, [_file_node("file-1", "Canvas/board_files/pic.png")])
            original_board_bytes = canvas.read_bytes()

            with patch(
                "Json_2_Canvas.attachment_store._copy_file_atomic",
                side_effect=OSError("disk full"),
            ):
                with self.assertRaises(OSError):
                    share_board_attachments(canvas, vault, store, sidecar_dir=sidecar)

            self.assertEqual(canvas.read_bytes(), original_board_bytes)
            self.assertTrue((sidecar / "pic.png").is_file())
            self.assertFalse(store.exists())

    def test_miro_source_is_untouched(self) -> None:
        with tempfile.TemporaryDirectory(prefix="miro2obs_attach_source_") as tmp:
            root = Path(tmp)
            vault = root / "vault"
            store = vault / "Miro attachments"
            sidecar = vault / "Canvas" / "board_files"
            sidecar.mkdir(parents=True)
            (sidecar / "pic.png").write_bytes(b"source-bytes")
            canvas = vault / "Canvas" / "board.canvas"
            miro_source = {"boardId": "board-1", "items": [{"id": "image-1"}]}
            _write_board(
                canvas,
                [_file_node("file-1", "Canvas/board_files/pic.png")],
                extra={"miroSource": miro_source},
            )

            share_board_attachments(canvas, vault, store, sidecar_dir=sidecar)

            board = _load_board(canvas)

        self.assertEqual(board["miroSource"], miro_source)

    def test_resulting_board_still_validates(self) -> None:
        with tempfile.TemporaryDirectory(prefix="miro2obs_attach_schema_") as tmp:
            root = Path(tmp)
            vault = root / "vault"
            store = vault / "Miro attachments"
            sidecar = vault / "Canvas" / "board_files"
            sidecar.mkdir(parents=True)
            (sidecar / "pic.png").write_bytes(b"schema-bytes")
            canvas = vault / "Canvas" / "board.canvas"
            _write_board(canvas, [_file_node("file-1", "Canvas/board_files/pic.png")])

            share_board_attachments(canvas, vault, store, sidecar_dir=sidecar)

            board = _load_board(canvas)

        self.assertEqual(validate_board(board), [])


if __name__ == "__main__":
    unittest.main()
