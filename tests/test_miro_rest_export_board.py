from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = REPO_ROOT / "scripts"

sys.path.insert(0, str(SCRIPTS_DIR))

from miro_rest_export_board import (  # noqa: E402
    build_board_source_payload,
    download_export_assets,
    export_board_comments,
    export_board_items,
    write_json,
)


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

    def test_export_board_comments_uses_comment_probe_and_dedupes(self) -> None:
        comments = [
            {"id": "comment-1", "type": "comment", "content": "Hello"},
            {"id": "comment-1", "type": "comment", "content": "Hello again"},
        ]
        messages: list[str] = []

        with patch(
            "miro_comment_probe.run_comment_probe",
            return_value={"decision": "comments_available_with_items", "comments": comments},
        ) as probe:
            result = export_board_comments(board_id="board-1", token="token-1", logger=messages.append)

        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["id"], "comment-1")
        probe.assert_called_once_with(board_id="board-1", token="token-1")
        self.assertTrue(any("comments=1" in message for message in messages))

    def test_export_board_comments_is_optional_when_probe_fails(self) -> None:
        messages: list[str] = []

        with patch("miro_comment_probe.run_comment_probe", side_effect=RuntimeError("boom")):
            result = export_board_comments(board_id="board-1", token="token-1", logger=messages.append)

        self.assertEqual(result, [])
        self.assertTrue(any("decision=probe_failed" in message for message in messages))

    def test_build_board_source_payload_keeps_items_and_comment_sidecar(self) -> None:
        items = [{"id": "text-1", "type": "text"}]
        comments = [{"id": "comment-1", "type": "comment"}]

        payload = build_board_source_payload(items, comments)

        self.assertEqual(payload, {"items": items, "comments": comments})

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

    def test_download_export_assets_retries_missing_required_assets(self) -> None:
        items = [
            {"id": "img-1", "type": "image", "data": {"imageUrl": "https://api.miro.test/images/1"}},
        ]
        calls = 0
        messages: list[str] = []

        def flaky_download_all(resources, _save_path, _token, _safe_team, _safe_board, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 1:
                return
            id_to_final_path = kwargs["id_to_final_path"]
            for resource in resources:
                final_path = id_to_final_path[str(resource["id"])]
                final_path.parent.mkdir(parents=True, exist_ok=True)
                final_path.write_bytes(b"asset")
                resource["local_name"] = final_path.name

        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "exports" / "board.json"
            with patch("miro_rest_export_board.download_all", side_effect=flaky_download_all):
                stats = download_export_assets(items, output_path=output, token="token-1", logger=messages.append)

        self.assertEqual(stats["failed"], 0)
        self.assertEqual(calls, 2)
        self.assertTrue(items[0]["local_name"])
        self.assertTrue(any("asset_retry label=images" in message for message in messages))

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

    def test_download_export_assets_treats_embed_preview_as_optional(self) -> None:
        items = [
            {
                "id": "embed-1",
                "type": "embed",
                "data": {
                    "title": "External video",
                    "previewUrl": "https://cdn.example.test/missing-preview.png",
                },
            },
        ]
        messages: list[str] = []

        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "exports" / "board.json"
            with patch("miro_rest_export_board.download_resource_with_redirect", return_value=None):
                stats = download_export_assets(
                    items,
                    output_path=output,
                    token="token-1",
                    logger=messages.append,
                )

        self.assertEqual(stats, {"images": 0, "documents": 0, "doc_formats": 0, "embeds": 1, "failed": 0})
        self.assertNotIn("local_name", items[0])
        self.assertTrue(any("asset_optional_failed id=embed-1" in message for message in messages))
        self.assertFalse(any("asset_missing embed-1" in message for message in messages))


if __name__ == "__main__":
    unittest.main()
