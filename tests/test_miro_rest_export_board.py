from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = REPO_ROOT / "scripts"

from scripts.miro_rest_export_board import (  # noqa: E402
    build_board_source_payload,
    download_export_assets,
    export_board_comments,
    export_board_items,
    export_complete_board_source,
    main,
    summarize_export_asset_requirements,
    validate_export_assets,
    write_json,
)
from Miro_2_Json.miro_downloader import _dedupe_miro_items  # noqa: E402


PNG_BYTES = b"\x89PNG\r\n\x1a\n"


class MiroRestExportBoardTests(unittest.TestCase):
    def test_export_board_items_uses_existing_downloader_and_dedupes(self) -> None:
        raw_items = [
            {
                "id": "text-1",
                "type": "text",
                "source": "items(v2-experimental)",
                "data": {"content": "<p>Old</p>"},
            },
            {
                "id": "text-1",
                "type": "text",
                "source": "items(v2-experimental)",
                "data": {"content": "<p>New</p>"},
            },
        ]
        metadata: dict = {}

        def complete_experimental_export(*_args, **kwargs):
            kwargs["logger"](
                "загружена страница 1 (items(v2-experimental)), добавлено 2"
            )
            kwargs["metadata"].update(
                {"complete": True, "source_pages": {"items(v2-experimental)": 1}}
            )
            return raw_items

        with patch(
            "scripts.miro_rest_export_board.get_items_on_board",
            side_effect=complete_experimental_export,
        ) as get_items:
            items = export_board_items(
                board_id="board-1",
                token="token-1",
                prefer_experimental=True,
                metadata=metadata,
            )

        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["id"], "text-1")
        self.assertIn("moveToWidget=text-1", items[0]["links"]["web"])
        get_items.assert_called_once()
        self.assertTrue(get_items.call_args.kwargs["prefer_experimental_items"])
        self.assertFalse(
            get_items.call_args.kwargs["confirm_skip_source"]("tags", 403, "forbidden")
        )
        with self.assertRaisesRegex(RuntimeError, "partial and stable replacement"):
            get_items.call_args.kwargs["confirm_exp_fallback"](10)
        self.assertTrue(metadata["complete"])
        self.assertEqual(metadata["requested_items_source"], "rest_v2_experimental")

    def test_export_board_items_rejects_hidden_stable_replacement(self) -> None:
        raw_items = [{"id": "text-1", "type": "text", "source": "items(v2)"}]

        def hidden_replacement(*_args, **kwargs):
            kwargs["logger"](
                "загружена страница 1 (items(v2-experimental)), добавлено 0"
            )
            kwargs["metadata"].update(
                {"complete": True, "source_pages": {"items(v2-experimental)": 1}}
            )
            return raw_items

        with patch(
            "scripts.miro_rest_export_board.get_items_on_board", side_effect=hidden_replacement
        ):
            with self.assertRaisesRegex(RuntimeError, "Stable items were returned"):
                export_board_items(
                    board_id="board-1", token="token-1", prefer_experimental=True
                )

    def test_export_board_items_rejects_first_page_fallback_before_stable_fetch(
        self,
    ) -> None:
        def attempted_fallback(*_args, **kwargs):
            kwargs["logger"](
                "items: v2-experimental недоступен, переключаюсь на v2 (503)"
            )
            self.fail("fallback logger must abort before stable items are returned")

        with patch(
            "scripts.miro_rest_export_board.get_items_on_board", side_effect=attempted_fallback
        ):
            with self.assertRaisesRegex(
                RuntimeError, "stable item replacement is disabled"
            ):
                export_board_items(
                    board_id="board-1", token="token-1", prefer_experimental=True
                )

    def test_dedupe_preserves_all_endpoint_fields_and_raw_variants(self) -> None:
        variants = [
            {
                "id": "tag-1",
                "type": "tag",
                "source": "items(v2-experimental)",
                "data": {"title": "Urgent"},
            },
            {
                "id": "tag-1",
                "type": "tag",
                "source": "tags",
                "data": {"description": "From tags endpoint"},
            },
        ]

        item = _dedupe_miro_items(variants)[0]

        self.assertEqual(
            item["data"], {"title": "Urgent", "description": "From tags endpoint"}
        )
        self.assertEqual(item["source_surfaces"], ["items(v2-experimental)", "tags"])
        self.assertEqual(item["source_provenance"]["original_items"], variants)

    def test_dedupe_does_not_collapse_records_without_ids(self) -> None:
        records = [
            {"type": "member", "name": "One"},
            {"type": "member", "name": "Two"},
        ]

        self.assertEqual(_dedupe_miro_items(records), records)

    def test_write_json_creates_parent_directory(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "nested" / "rest_export.json"

            write_json(path, [{"id": "item-1", "type": "text"}])

            self.assertTrue(path.exists())
            self.assertIn('"item-1"', path.read_text(encoding="utf-8"))
            self.assertFalse(path.with_suffix(".json.tmp").exists())

    def test_write_json_rejects_nonfinite_values_without_replacing_output(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "rest_export.json"
            path.write_text("old-json", encoding="utf-8")

            with self.assertRaisesRegex(ValueError, "Out of range float"):
                write_json(path, {"x": float("nan")})

            self.assertEqual(path.read_text(encoding="utf-8"), "old-json")
            self.assertEqual(list(path.parent.glob(".rest_export.json.*.tmp")), [])

    def test_export_board_comments_uses_comment_probe_and_dedupes(self) -> None:
        comments = [
            {"id": "comment-1", "type": "comment", "content": "Hello"},
            {"id": "comment-1", "type": "comment", "content": "Hello again"},
        ]
        messages: list[str] = []

        with patch(
            "scripts.miro_comment_probe.run_comment_probe",
            return_value={
                "decision": "comments_available_with_items",
                "comments": comments,
                "summary": {
                    "comment_items": 2,
                    "available_paths": ["public_comments_collection"],
                },
                "completeness": {
                    "complete": True,
                    "reason": "all_available_comment_pages_fetched",
                },
            },
        ) as probe:
            metadata: dict = {}
            result = export_board_comments(
                board_id="board-1",
                token="token-1",
                logger=messages.append,
                metadata=metadata,
            )

        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["id"], "comment-1")
        probe.assert_called_once_with(board_id="board-1", token="token-1")
        self.assertTrue(any("comments=1" in message for message in messages))
        self.assertTrue(metadata["complete"])
        self.assertEqual(metadata["raw_count"], 2)
        self.assertEqual(metadata["probe"]["comments"], comments)

    def test_export_board_comments_rejects_non_object_comment(self) -> None:
        with patch(
            "scripts.miro_comment_probe.run_comment_probe",
            return_value={
                "comments": [{"id": "comment-1", "type": "comment"}, None],
                "summary": {"comment_items": 2},
                "completeness": {"complete": True},
            },
        ):
            with self.assertRaisesRegex(RuntimeError, "non-object comment"):
                export_board_comments(board_id="board-1", token="token-1")

    def test_export_board_comments_rejects_summary_count_mismatch(self) -> None:
        with patch(
            "scripts.miro_comment_probe.run_comment_probe",
            return_value={
                "comments": [{"id": "comment-1", "type": "comment"}],
                "summary": {"comment_items": 2},
                "completeness": {"complete": True},
            },
        ):
            with self.assertRaisesRegex(RuntimeError, "does not match comments length"):
                export_board_comments(board_id="board-1", token="token-1")

    def test_export_board_comments_propagates_probe_failure(self) -> None:
        with patch(
            "scripts.miro_comment_probe.run_comment_probe", side_effect=RuntimeError("boom")
        ):
            with self.assertRaisesRegex(RuntimeError, "boom"):
                export_board_comments(board_id="board-1", token="token-1")

    def test_export_board_comments_rejects_incomplete_probe(self) -> None:
        with patch(
            "scripts.miro_comment_probe.run_comment_probe",
            return_value={
                "decision": "separate_source_not_found_in_checked_rest_paths",
                "comments": [],
                "completeness": {
                    "complete": False,
                    "reason": "no_available_comment_source",
                },
            },
        ):
            with self.assertRaisesRegex(RuntimeError, "no_available_comment_source"):
                export_board_comments(board_id="board-1", token="token-1")

    def test_build_board_source_payload_keeps_items_and_comment_sidecar(self) -> None:
        items = [{"id": "text-1", "type": "text"}]
        comments = [{"id": "comment-1", "type": "comment"}]

        payload = build_board_source_payload(items, comments)

        self.assertEqual(payload, {"items": items, "comments": comments})

    def test_build_board_source_payload_records_provenance_and_completeness(
        self,
    ) -> None:
        payload = build_board_source_payload(
            [],
            [],
            provenance={"board_id": "board-1", "items": {"complete": True}},
            completeness={"complete": True},
        )

        self.assertEqual(payload["provenance"]["board_id"], "board-1")
        self.assertTrue(payload["completeness"]["complete"])

    def test_build_board_source_payload_adds_self_describing_envelope(self) -> None:
        board_item = {
            "id": "board-1",
            "type": "board",
            "name": "Production board",
            "source": "board",
        }

        payload = build_board_source_payload([board_item], [], board_id="board-1")

        self.assertEqual(payload["schema_version"], 1)
        self.assertEqual(payload["source_surface"], "rest")
        self.assertEqual(payload["export_scope"], "board")
        self.assertEqual(payload["board"], board_item)
        self.assertTrue(payload["exported_at"].endswith("+00:00"))

    def test_complete_export_keeps_experimental_items_and_preserves_stable_asset_source(
        self,
    ) -> None:
        experimental = [
            {
                "id": "image-1",
                "type": "image",
                "data": {
                    "title": "experimental",
                    "imageUrl": "https://api.miro.test/image",
                },
            }
        ]
        stable = [
            {
                "id": "image-1",
                "type": "image",
                "local_name": "image-1.png",
                "data": {"title": "stable", "imageUrl": "https://api.miro.test/image"},
            }
        ]
        batches = iter((experimental, stable))

        def complete_items(**kwargs):
            items = next(batches)
            kwargs["metadata"].update(
                {
                    "complete": True,
                    "requested_items_source": (
                        "rest_v2_experimental"
                        if kwargs.get("prefer_experimental")
                        else "rest_v2"
                    ),
                    "item_count": len(items),
                    "raw_count": len(items),
                    "sources": {"unknown": len(items)},
                }
            )
            return items

        def complete_comments(**kwargs):
            kwargs["metadata"].update(
                {"complete": True, "comment_count": 1, "raw_count": 1}
            )
            return [{"id": "comment-1", "type": "comment"}]

        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "board.json"
            with (
                patch(
                    "scripts.miro_rest_export_board.export_board_items",
                    side_effect=complete_items,
                ) as export_items,
                patch(
                    "scripts.miro_rest_export_board.export_board_comments",
                    side_effect=complete_comments,
                ),
                patch("scripts.miro_rest_export_board.download_export_assets") as assets,
                patch(
                    "scripts.miro_rest_export_board.validate_export_assets",
                    side_effect=[["image-1: missing local_name"], []],
                ),
            ):
                payload, info = export_complete_board_source(
                    board_id="board-1",
                    token="token-1",
                    output_path=output,
                    board_name="Board name",
                    board_url="https://miro.com/app/board/board-1/",
                )

        self.assertEqual(
            [
                call.kwargs["prefer_experimental"]
                for call in export_items.call_args_list
            ],
            [True, False],
        )
        self.assertEqual(assets.call_count, 2)
        self.assertEqual(payload["items"][0]["data"]["title"], "experimental")
        self.assertEqual(payload["items"][0]["local_name"], "image-1.png")
        self.assertEqual(payload["comments"][0]["id"], "comment-1")
        self.assertEqual(payload["board"]["name"], "Board name")
        self.assertEqual(
            payload["provenance"]["assets"]["strategy"],
            "experimental_items_with_stable_local_name_enrichment",
        )
        self.assertEqual(
            payload["provenance"]["assets"]["stable_enrichment"]["items"],
            stable,
        )
        self.assertTrue(payload["completeness"]["complete"])
        self.assertEqual(info["asset_stats"]["bridged"], 1)
        self.assertEqual(info["path"], str(output))

    def test_complete_export_fails_before_write_when_assets_remain_missing(
        self,
    ) -> None:
        def complete_items(**kwargs):
            kwargs["metadata"]["complete"] = True
            return [
                {
                    "id": "image-1",
                    "type": "image",
                    "data": {"imageUrl": "https://api.miro.test/image"},
                }
            ]

        def complete_comments(**kwargs):
            kwargs["metadata"]["complete"] = True
            return []

        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "board.json"
            with (
                patch(
                    "scripts.miro_rest_export_board.export_board_items",
                    side_effect=complete_items,
                ),
                patch(
                    "scripts.miro_rest_export_board.export_board_comments",
                    side_effect=complete_comments,
                ),
                patch("scripts.miro_rest_export_board.download_export_assets"),
                patch(
                    "scripts.miro_rest_export_board.validate_export_assets",
                    return_value=["image-1: missing"],
                ),
            ):
                with self.assertRaisesRegex(
                    RuntimeError, "Asset validation incomplete"
                ):
                    export_complete_board_source(
                        board_id="board-1",
                        token="token-1",
                        output_path=output,
                        prefer_experimental=False,
                    )

        self.assertFalse(output.exists())

    def test_complete_export_rejects_disabled_required_asset_downloads(self) -> None:
        def complete_items(**kwargs):
            kwargs["metadata"]["complete"] = True
            return [
                {
                    "id": "image-1",
                    "type": "image",
                    "data": {"imageUrl": "https://example.test/image"},
                }
            ]

        def complete_comments(**kwargs):
            kwargs["metadata"]["complete"] = True
            return []

        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "board.json"
            with (
                patch(
                    "scripts.miro_rest_export_board.export_board_items",
                    side_effect=complete_items,
                ),
                patch(
                    "scripts.miro_rest_export_board.export_board_comments",
                    side_effect=complete_comments,
                ),
            ):
                with self.assertRaisesRegex(RuntimeError, "asset download disabled"):
                    export_complete_board_source(
                        board_id="board-1",
                        token="token-1",
                        output_path=output,
                        download_assets=False,
                    )

        self.assertFalse(output.exists())

    def test_failed_refresh_preserves_previous_json_and_sidecar(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "board.json"
            sidecar = output.with_name("board_files")
            output.write_text("old-json", encoding="utf-8")
            sidecar.mkdir()
            (sidecar / "old.bin").write_bytes(b"old-asset")

            def fail_after_staging(*, output_path: Path, **_kwargs):
                staged_sidecar = output_path.with_name("board_files")
                staged_sidecar.mkdir()
                (staged_sidecar / "new.bin").write_bytes(b"new-asset")
                raise RuntimeError("refresh failed")

            with patch(
                "scripts.miro_rest_export_board._build_complete_board_source",
                side_effect=fail_after_staging,
            ):
                with self.assertRaisesRegex(RuntimeError, "refresh failed"):
                    export_complete_board_source(
                        board_id="board-1",
                        token="token-1",
                        output_path=output,
                    )

            self.assertEqual(output.read_text(encoding="utf-8"), "old-json")
            self.assertEqual((sidecar / "old.bin").read_bytes(), b"old-asset")
            self.assertFalse((sidecar / "new.bin").exists())

    def test_successful_refresh_replaces_sidecar_and_removes_stale_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "board.json"
            sidecar = output.with_name("board_files")
            output.write_text("old-json", encoding="utf-8")
            sidecar.mkdir()
            (sidecar / "stale.bin").write_bytes(b"stale")

            def build_staged(*, output_path: Path, **_kwargs):
                write_json(output_path, {"generation": "new"})
                staged_sidecar = output_path.with_name("board_files")
                staged_sidecar.mkdir()
                (staged_sidecar / "fresh.bin").write_bytes(b"fresh")
                return {"generation": "new"}, {"path": str(output_path)}

            with patch(
                "scripts.miro_rest_export_board._build_complete_board_source",
                side_effect=build_staged,
            ):
                export_complete_board_source(
                    board_id="board-1",
                    token="token-1",
                    output_path=output,
                )

            self.assertIn('"generation": "new"', output.read_text(encoding="utf-8"))
            self.assertEqual((sidecar / "fresh.bin").read_bytes(), b"fresh")
            self.assertFalse((sidecar / "stale.bin").exists())

    def test_success_without_assets_removes_previous_sidecar(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "board.json"
            sidecar = output.with_name("board_files")
            output.write_text("old-json", encoding="utf-8")
            sidecar.mkdir()
            (sidecar / "stale.bin").write_bytes(b"stale")

            def build_staged(*, output_path: Path, **_kwargs):
                write_json(output_path, {"generation": "without-assets"})
                return {"generation": "without-assets"}, {"path": str(output_path)}

            with patch(
                "scripts.miro_rest_export_board._build_complete_board_source",
                side_effect=build_staged,
            ):
                export_complete_board_source(
                    board_id="board-1",
                    token="token-1",
                    output_path=output,
                )

            self.assertFalse(sidecar.exists())

    def test_download_export_assets_creates_sidecar_and_sets_local_names(self) -> None:
        items = [
            {
                "id": "img-1",
                "type": "image",
                "data": {"imageUrl": "https://api.miro.test/images/1?redirect=false"},
            },
            {
                "id": "doc-1",
                "type": "document",
                "data": {
                    "documentUrl": "https://api.miro.test/documents/1?redirect=false"
                },
            },
            {
                "id": "embed-1",
                "type": "embed",
                "data": {
                    "title": "Video",
                    "previewUrl": "https://cdn.example.test/preview.png",
                },
            },
        ]

        def fake_download_all(
            resources, _save_path, _token, _safe_team, _safe_board, **kwargs
        ):
            id_to_final_path = kwargs["id_to_final_path"]
            for resource in resources:
                final_path = id_to_final_path[str(resource["id"])]
                final_path.parent.mkdir(parents=True, exist_ok=True)
                final_path.write_bytes(
                    PNG_BYTES if resource.get("type") == "image" else b"%PDF-1.7"
                )
                resource["local_name"] = final_path.name

        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "exports" / "board.json"
            embed_path = output.with_name("board_files") / "rest_board_Video.png"

            def fake_embed_download(*_args, **_kwargs):
                embed_path.parent.mkdir(parents=True, exist_ok=True)
                embed_path.write_bytes(PNG_BYTES)
                return embed_path

            with (
                patch(
                    "scripts.miro_rest_export_board.download_all", side_effect=fake_download_all
                ) as dl_all,
                patch(
                    "scripts.miro_rest_export_board.download_resource_with_redirect",
                    side_effect=fake_embed_download,
                ) as dl_embed,
            ):
                stats = download_export_assets(
                    items, output_path=output, token="token-1"
                )

        self.assertEqual(
            stats,
            {
                "images": 1,
                "documents": 1,
                "doc_formats": 0,
                "embeds": 1,
                "failed": 0,
                "optional_failed": 0,
            },
        )
        self.assertEqual(dl_all.call_count, 2)
        self.assertTrue(hasattr(dl_all.call_args_list[0].kwargs["gui_root"], "after"))
        dl_embed.assert_called_once()
        self.assertTrue(items[0]["local_name"])
        self.assertTrue(items[1]["local_name"])
        self.assertEqual(items[2]["local_name"], "rest_board_Video.png")

    def test_download_export_assets_downloads_doc_formats_with_inline_images(
        self,
    ) -> None:
        items = [
            {
                "id": "slot-image-1",
                "type": "image",
                "parent": {"id": "doc-format-1"},
                "position": {"slotId": "slot-a"},
                "data": {
                    "imageUrl": "https://api.miro.test/images/slot-image-1?redirect=false"
                },
            },
            {
                "id": "doc-format-1",
                "type": "doc_format",
                "data": {"html": '<p>Doc</p><embed data-slot-id="slot-a">'},
            },
        ]

        def fake_download_all(
            resources, _save_path, _token, _safe_team, _safe_board, **kwargs
        ):
            id_to_final_path = kwargs["id_to_final_path"]
            for resource in resources:
                final_path = id_to_final_path[str(resource["id"])]
                final_path.parent.mkdir(parents=True, exist_ok=True)
                final_path.write_bytes(
                    PNG_BYTES if resource.get("type") == "image" else b"%PDF-1.7"
                )
                resource["local_name"] = final_path.name

        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "exports" / "board.json"
            with patch(
                "scripts.miro_rest_export_board.download_all", side_effect=fake_download_all
            ) as dl_all:
                stats = download_export_assets(
                    items, output_path=output, token="token-1"
                )

        self.assertEqual(
            stats,
            {
                "images": 1,
                "documents": 0,
                "doc_formats": 1,
                "embeds": 0,
                "failed": 0,
                "optional_failed": 0,
            },
        )
        self.assertEqual(dl_all.call_count, 2)
        doc_call = dl_all.call_args_list[1]
        self.assertIn("doc-format-1", doc_call.kwargs["inline_slot_map"])
        self.assertIn("slot-a", doc_call.kwargs["inline_slot_map"]["doc-format-1"])
        self.assertTrue(items[0]["local_name"])
        self.assertTrue(items[1]["local_name"])

    def test_download_export_assets_is_strict_by_default(self) -> None:
        items = [
            {
                "id": "img-1",
                "type": "image",
                "data": {"imageUrl": "https://api.miro.test/images/1"},
            },
        ]

        def fake_download_all(
            resources, _save_path, _token, _safe_team, _safe_board, **kwargs
        ):
            id_to_final_path = kwargs["id_to_final_path"]
            for resource in resources:
                resource["local_name"] = id_to_final_path[str(resource["id"])].name

        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "exports" / "board.json"
            with patch(
                "scripts.miro_rest_export_board.download_all", side_effect=fake_download_all
            ):
                with self.assertRaisesRegex(RuntimeError, "img-1"):
                    download_export_assets(items, output_path=output, token="token-1")

    def test_download_export_assets_does_not_overwrite_name_collision(self) -> None:
        items = [
            {
                "id": "img-1",
                "type": "image",
                "data": {
                    "title": "same.png",
                    "imageUrl": "https://api.miro.test/images/1",
                },
            }
        ]

        def fake_download_all(
            resources, _save_path, _token, _safe_team, _safe_board, **kwargs
        ):
            final_path = kwargs["id_to_final_path"]["img-1"]
            final_path.write_bytes(PNG_BYTES)
            resources[0]["local_name"] = final_path.name

        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "board.json"
            sidecar = output.with_name("board_files")
            sidecar.mkdir()
            existing = sidecar / "rest_board_same.png"
            existing.write_bytes(b"existing-neighbor")
            with patch(
                "scripts.miro_rest_export_board.download_all", side_effect=fake_download_all
            ):
                stats = download_export_assets(
                    items, output_path=output, token="token-1"
                )

            self.assertEqual(existing.read_bytes(), b"existing-neighbor")
            self.assertEqual(items[0]["local_name"], "rest_board_same (1).png")
            self.assertTrue((sidecar / items[0]["local_name"]).is_file())
            self.assertEqual(stats["failed"], 0)

    def test_download_export_assets_preserves_non_object_source_data(self) -> None:
        item = {"id": "img-1", "type": "image", "data": "opaque"}

        self.assertEqual(
            summarize_export_asset_requirements([item]),
            {"images": 1, "documents": 0, "doc_formats": 0, "embeds": 0},
        )
        self.assertEqual(item["data"], "opaque")

    def test_download_export_assets_keeps_existing_valid_file(self) -> None:
        items = [
            {
                "id": "img-1",
                "type": "image",
                "data": {"imageUrl": "https://api.miro.test/images/1"},
                "local_name": "existing.png",
            }
        ]

        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "board.json"
            sidecar = output.with_name("board_files")
            sidecar.mkdir()
            (sidecar / "existing.png").write_bytes(PNG_BYTES)
            with patch("scripts.miro_rest_export_board.download_all") as download_all:
                stats = download_export_assets(
                    items, output_path=output, token="token-1"
                )

        download_all.assert_not_called()
        self.assertEqual(items[0]["local_name"], "existing.png")
        self.assertEqual(stats["failed"], 0)

    def test_asset_requirements_include_image_and_document_without_urls(self) -> None:
        items = [
            {"id": "img-1", "type": "image", "data": {}},
            {"id": "doc-1", "type": "document", "data": {}},
        ]

        self.assertEqual(
            summarize_export_asset_requirements(items),
            {"images": 1, "documents": 1, "doc_formats": 0, "embeds": 0},
        )
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "board.json"
            with self.assertRaisesRegex(RuntimeError, "img-1"):
                download_export_assets(items, output_path=output, token="token-1")

    def test_asset_validation_rejects_reference_outside_sidecar(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            output = root / "board.json"
            outside = root / "outside.png"
            outside.write_bytes(b"asset")
            items = [{"id": "img-1", "type": "image", "local_name": "../outside.png"}]

            missing = validate_export_assets(items, output_path=output)

        self.assertEqual(missing, ["img-1: invalid local_name: ../outside.png"])

    def test_asset_validation_rejects_existing_empty_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "board.json"
            sidecar = output.with_name("board_files")
            sidecar.mkdir()
            (sidecar / "empty.png").write_bytes(b"")
            items = [
                {
                    "id": "img-1",
                    "type": "image",
                    "local_name": "empty.png",
                    "data": {"imageUrl": "https://example.test/empty.png"},
                }
            ]

            missing = validate_export_assets(items, output_path=output)

        self.assertEqual(len(missing), 1)
        self.assertIn("downloaded file is empty", missing[0])

    def test_download_export_assets_retries_missing_required_assets(self) -> None:
        items = [
            {
                "id": "img-1",
                "type": "image",
                "data": {"imageUrl": "https://api.miro.test/images/1"},
            },
        ]
        calls = 0
        messages: list[str] = []

        def flaky_download_all(
            resources, _save_path, _token, _safe_team, _safe_board, **kwargs
        ):
            nonlocal calls
            calls += 1
            if calls == 1:
                return
            id_to_final_path = kwargs["id_to_final_path"]
            for resource in resources:
                final_path = id_to_final_path[str(resource["id"])]
                final_path.parent.mkdir(parents=True, exist_ok=True)
                final_path.write_bytes(
                    PNG_BYTES if resource.get("type") == "image" else b"%PDF-1.7"
                )
                resource["local_name"] = final_path.name

        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "exports" / "board.json"
            with patch(
                "scripts.miro_rest_export_board.download_all", side_effect=flaky_download_all
            ):
                stats = download_export_assets(
                    items, output_path=output, token="token-1", logger=messages.append
                )

        self.assertEqual(stats["failed"], 0)
        self.assertEqual(calls, 2)
        self.assertTrue(items[0]["local_name"])
        self.assertTrue(
            any("asset_retry label=images" in message for message in messages)
        )

    def test_download_export_assets_can_allow_missing_assets(self) -> None:
        items = [
            {
                "id": "img-1",
                "type": "image",
                "data": {"url": "https://api.miro.test/images/1"},
            },
        ]

        def fake_download_all(
            resources, _save_path, _token, _safe_team, _safe_board, **kwargs
        ):
            id_to_final_path = kwargs["id_to_final_path"]
            for resource in resources:
                resource["local_name"] = id_to_final_path[str(resource["id"])].name

        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "exports" / "board.json"
            with patch(
                "scripts.miro_rest_export_board.download_all", side_effect=fake_download_all
            ):
                stats = download_export_assets(
                    items, output_path=output, token="token-1", strict=False
                )

        self.assertEqual(stats["failed"], 1)
        self.assertEqual(items[0]["data"]["imageUrl"], "https://api.miro.test/images/1")

    def test_cli_returns_degraded_status_for_incomplete_export(self) -> None:
        args = type("Args", (), {})()
        with (
            patch("scripts.miro_rest_export_board.parse_args", return_value=args),
            patch("scripts.miro_rest_export_board.resolve_token_from_args", return_value="token"),
            patch(
                "scripts.miro_rest_export_board.export_complete_board_source",
                return_value=({}, {"items": 0, "comments": 0, "complete": False, "log_tail": []}),
            ),
        ):
            args.board_id = "board-1"
            args.output = Path("board.json")
            args.stable_items = False
            args.no_download_assets = True
            args.allow_missing_assets = True
            self.assertEqual(main(), 2)

    def test_download_export_assets_reports_missing_embed_preview_without_failing_source(
        self,
    ) -> None:
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
            with patch(
                "scripts.miro_rest_export_board.download_resource_with_redirect",
                return_value=None,
            ):
                stats = download_export_assets(
                    items,
                    output_path=output,
                    token="token-1",
                    logger=messages.append,
                )

        self.assertEqual(
            stats,
            {
                "images": 0,
                "documents": 0,
                "doc_formats": 0,
                "embeds": 1,
                "failed": 0,
                "optional_failed": 1,
            },
        )
        self.assertNotIn("local_name", items[0])
        self.assertTrue(
            any("asset_optional_failed id=embed-1" in message for message in messages)
        )
        self.assertTrue(
            any("asset_optional_missing embed-1" in message for message in messages)
        )


if __name__ == "__main__":
    unittest.main()
