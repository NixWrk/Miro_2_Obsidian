from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = REPO_ROOT / "scripts"

sys.path.insert(0, str(SCRIPTS_DIR))

from miro_rest_export_board import download_export_assets, export_board_items, write_json  # noqa: E402


class MiroRestExportBoardTests(unittest.TestCase):
    def test_export_board_items_uses_existing_downloader_and_dedupes(self) -> None:
        raw_items = [
            {"id": "text-1", "type": "text", "source": "items(v2)", "data": {"content": "<p>Old</p>"}},
            {"id": "text-1", "type": "text", "source": "items(v2-experimental)", "data": {"content": "<p>New</p>"}},
        ]
        with patch("miro_rest_export_board.get_items_on_board", return_value=raw_items) as get_items:
            items = export_board_items(board_id="board-1", token="token-1", prefer_experimental=True)

        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["id"], "text-1")
        self.assertIn("moveToWidget=text-1", items[0]["links"]["web"])
        get_items.assert_called_once()
        self.assertTrue(get_items.call_args.kwargs["prefer_experimental_items"])
        self.assertTrue(get_items.call_args.kwargs["confirm_skip_source"]("tags", 403, "forbidden"))
        self.assertTrue(get_items.call_args.kwargs["confirm_exp_fallback"](10))

    def test_write_json_creates_parent_directory(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "nested" / "rest_export.json"

            write_json(path, [{"id": "item-1", "type": "text"}])

            self.assertTrue(path.exists())
            self.assertIn('"item-1"', path.read_text(encoding="utf-8"))

    def test_download_export_assets_creates_sidecar_and_sets_local_names(self) -> None:
        items = [
            {"id": "img-1", "type": "image", "data": {"imageUrl": "https://api.miro.test/images/1?redirect=false"}},
            {"id": "doc-1", "type": "document", "data": {"documentUrl": "https://api.miro.test/documents/1?redirect=false"}},
            {
                "id": "embed-1",
                "type": "embed",
                "data": {
                    "title": "Video",
                    "previewUrl": "https://cdn.example.test/preview.png",
                },
            },
        ]

        def fake_download_all(resources, _save_path, _token, _safe_team, _safe_board, **kwargs):
            id_to_final_path = kwargs["id_to_final_path"]
            for resource in resources:
                final_path = id_to_final_path[str(resource["id"])]
                final_path.parent.mkdir(parents=True, exist_ok=True)
                final_path.write_bytes(b"asset")
                resource["local_name"] = final_path.name

        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "exports" / "board.json"
            embed_path = output.with_name("board_files") / "rest_board_Video.png"

            def fake_embed_download(*_args, **_kwargs):
                embed_path.parent.mkdir(parents=True, exist_ok=True)
                embed_path.write_bytes(b"preview")
                return embed_path

            with (
                patch("miro_rest_export_board.download_all", side_effect=fake_download_all) as dl_all,
                patch("miro_rest_export_board.download_resource_with_redirect", side_effect=fake_embed_download) as dl_embed,
            ):
                stats = download_export_assets(items, output_path=output, token="token-1")

        self.assertEqual(stats, {"images": 1, "documents": 1, "doc_formats": 0, "embeds": 1, "failed": 0})
        self.assertEqual(dl_all.call_count, 2)
        self.assertTrue(hasattr(dl_all.call_args_list[0].kwargs["gui_root"], "after"))
        dl_embed.assert_called_once()
        self.assertTrue(items[0]["local_name"])
        self.assertTrue(items[1]["local_name"])
        self.assertEqual(items[2]["local_name"], "rest_board_Video.png")

    def test_download_export_assets_downloads_doc_formats_with_inline_images(self) -> None:
        items = [
            {
                "id": "slot-image-1",
                "type": "image",
                "parent": {"id": "doc-format-1"},
                "position": {"slotId": "slot-a"},
                "data": {"imageUrl": "https://api.miro.test/images/slot-image-1?redirect=false"},
            },
            {
                "id": "doc-format-1",
                "type": "doc_format",
                "data": {"html": '<p>Doc</p><embed data-slot-id="slot-a">'},
            },
        ]

        def fake_download_all(resources, _save_path, _token, _safe_team, _safe_board, **kwargs):
            id_to_final_path = kwargs["id_to_final_path"]
            for resource in resources:
                final_path = id_to_final_path[str(resource["id"])]
                final_path.parent.mkdir(parents=True, exist_ok=True)
                final_path.write_bytes(b"asset")
                resource["local_name"] = final_path.name

        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "exports" / "board.json"
            with patch("miro_rest_export_board.download_all", side_effect=fake_download_all) as dl_all:
                stats = download_export_assets(items, output_path=output, token="token-1")

        self.assertEqual(stats, {"images": 1, "documents": 0, "doc_formats": 1, "embeds": 0, "failed": 0})
        self.assertEqual(dl_all.call_count, 2)
        doc_call = dl_all.call_args_list[1]
        self.assertIn("doc-format-1", doc_call.kwargs["inline_slot_map"])
        self.assertIn("slot-a", doc_call.kwargs["inline_slot_map"]["doc-format-1"])
        self.assertTrue(items[0]["local_name"])
        self.assertTrue(items[1]["local_name"])

    def test_download_export_assets_is_strict_by_default(self) -> None:
        items = [
            {"id": "img-1", "type": "image", "data": {"imageUrl": "https://api.miro.test/images/1"}},
        ]

        def fake_download_all(resources, _save_path, _token, _safe_team, _safe_board, **kwargs):
            id_to_final_path = kwargs["id_to_final_path"]
            for resource in resources:
                resource["local_name"] = id_to_final_path[str(resource["id"])].name

        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "exports" / "board.json"
            with patch("miro_rest_export_board.download_all", side_effect=fake_download_all):
                with self.assertRaisesRegex(RuntimeError, "img-1"):
                    download_export_assets(items, output_path=output, token="token-1")

    def test_download_export_assets_can_allow_missing_assets(self) -> None:
        items = [
            {"id": "img-1", "type": "image", "data": {"url": "https://api.miro.test/images/1"}},
        ]

        def fake_download_all(resources, _save_path, _token, _safe_team, _safe_board, **kwargs):
            id_to_final_path = kwargs["id_to_final_path"]
            for resource in resources:
                resource["local_name"] = id_to_final_path[str(resource["id"])].name

        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "exports" / "board.json"
            with patch("miro_rest_export_board.download_all", side_effect=fake_download_all):
                stats = download_export_assets(items, output_path=output, token="token-1", strict=False)

        self.assertEqual(stats["failed"], 1)
        self.assertEqual(items[0]["data"]["imageUrl"], "https://api.miro.test/images/1")


if __name__ == "__main__":
    unittest.main()
