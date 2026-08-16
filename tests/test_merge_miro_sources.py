from __future__ import annotations

import json
import sys
import tempfile
import unittest
from argparse import Namespace
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = REPO_ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

from merge_miro_sources import (  # noqa: E402
    WEBSDK_CAPTURE_PROFILE,
    WEBSDK_EXPORTER_VERSION,
    finalize_merged_export,
    main,
    merge_sources,
    normalize_websdk_item,
    validate_canonical_export,
)


def websdk_export(
    items: list[dict],
    board_id: str = "board-1",
    *,
    comments: list[dict] | None = None,
    exported_at: datetime | None = None,
) -> dict:
    by_type: dict[str, int] = {}
    for item in items:
        item_type = str(item["type"])
        by_type[item_type] = by_type.get(item_type, 0) + 1
    comment_items = comments if comments is not None else None
    return {
        "schema_version": 1,
        "source_surface": "web_sdk",
        "export_scope": "board",
        "exporter_version": WEBSDK_EXPORTER_VERSION,
        "capture_profile": WEBSDK_CAPTURE_PROFILE,
        "provenance": {
            "items": {
                "method": "miro.board.get",
                "scope": "api_exposed_board_items",
                "raw_count": len(items),
                "serialized_count": len(items),
            },
            "serialization": {"issue_count": 0, "issues": []},
            **(
                {
                    "comments": {
                        "method": "test.websdk.comments",
                        "scope": "api_exposed_board_comments",
                        "raw_count": len(comment_items),
                        "serialized_count": len(comment_items),
                    }
                }
                if comment_items is not None
                else {}
            ),
        },
        "completeness": {
            "complete": True,
            "capture_complete": True,
            "board_complete": False,
            "coverage_basis": "miro.board.get_api_surface",
            "known_limitations": [
                "unsupported_item_details_unavailable",
                "unsupported_parent_children_not_enumerated",
                "comment_content_unavailable",
            ],
            "items": {
                "complete": True,
                "raw_count": len(items),
                "serialized_count": len(items),
                "serialization_errors": [],
            },
            "serialization": {"complete": True, "issues": []},
            **(
                {
                    "comments": {
                        "complete": True,
                        "raw_count": len(comment_items),
                        "serialized_count": len(comment_items),
                        "serialization_errors": [],
                    }
                }
                if comment_items is not None
                else {}
            ),
        },
        "exported_at": (exported_at or datetime.now(timezone.utc)).isoformat(),
        "board": {"id": board_id},
        "items": items,
        **({"comments": comment_items} if comment_items is not None else {}),
        "summary": {"total": len(items), "by_type": by_type},
    }


def rest_export(
    items: list[dict],
    board_id: str = "board-1",
    *,
    comments: list[dict] | None = None,
    exported_at: datetime | None = None,
) -> dict:
    source_counts: dict[str, int] = {}
    for item in items:
        source = str(item.get("source") or "unknown")
        source_counts[source] = source_counts.get(source, 0) + 1
    requirements = {
        "images": sum(item.get("type") == "image" for item in items),
        "documents": sum(item.get("type") == "document" for item in items),
        "doc_formats": sum(
            item.get("type") == "doc_format"
            and bool((item.get("data") or {}).get("html"))
            for item in items
        ),
        "embeds": sum(
            item.get("type") == "embed"
            and bool((item.get("data") or {}).get("previewUrl"))
            for item in items
        ),
        "failed": 0,
        "optional_failed": 0,
    }
    comment_items = comments or []
    return {
        "schema_version": 1,
        "source_surface": "rest",
        "export_scope": "board",
        "exporter_version": "test",
        "exported_at": (exported_at or datetime.now(timezone.utc)).isoformat(),
        "board": {"id": board_id},
        "items": items,
        "comments": comment_items,
        "provenance": {
            "board_id": board_id,
            "items": {
                "complete": True,
                "raw_count": len(items),
                "item_count": len(items),
                "sources": dict(sorted(source_counts.items())),
            },
            "comments": {
                "complete": True,
                "raw_count": len(comment_items),
                "comment_count": len(comment_items),
            },
            "assets": {"strategy": "test"},
        },
        "completeness": {
            "complete": True,
            "capture_complete": True,
            "board_complete": False,
            "coverage_basis": "rest_api_surface",
            "known_limitations": [],
            "items": {"complete": True},
            "comments": {"complete": True},
            "assets": {
                "complete": True,
                "checked": True,
                "missing": [],
                "optional_missing": [],
                "requirements": requirements,
            },
        },
    }


class MergeMiroSourcesTests(unittest.TestCase):
    def test_preserves_rest_item_and_marks_shared_websdk_surface(self) -> None:
        rest_item = {"id": "text-1", "type": "text", "data": {"content": "<p>REST</p>"}}
        websdk = websdk_export(
            [{"id": "text-1", "type": "text", "content": "<p>SDK</p>"}]
        )

        merged = merge_sources(rest_export([rest_item]), websdk)
        item = merged["items"][0]

        self.assertEqual(item["data"]["content"], "<p>REST</p>")
        self.assertEqual(item["source_surfaces"], ["rest", "web_sdk"])
        self.assertEqual(
            item["source_provenance"]["original_items"]["web_sdk"], websdk["items"][0]
        )
        self.assertFalse(merged["completeness"]["complete"])
        self.assertFalse(merged["completeness"]["assets"]["checked"])

    def test_adds_websdk_only_tag_as_placeable_item(self) -> None:
        websdk_item = {
            "id": "tag-1",
            "type": "tag",
            "x": 10,
            "y": 20,
            "width": 80,
            "height": 24,
            "title": "Urgent",
        }

        merged = merge_sources(rest_export([]), websdk_export([websdk_item]))
        item = merged["items"][0]

        self.assertEqual(item["type"], "tag")
        self.assertEqual(item["position"], {"x": 10, "y": 20})
        self.assertEqual(item["geometry"], {"width": 80, "height": 24})
        self.assertEqual(item["data"]["title"], "Urgent")

    def test_normalizes_websdk_only_unsupported_item_for_converter_placeholder(
        self,
    ) -> None:
        item = {
            "id": "mind-1",
            "type": "mindmap",
            "x": 1,
            "y": 2,
            "width": 300,
            "height": 200,
            "title": "Mind map",
        }

        normalized = normalize_websdk_item(item)

        self.assertEqual(normalized["type"], "mindmap")
        self.assertEqual(normalized["source_surfaces"], ["web_sdk"])
        self.assertEqual(normalized["geometry"]["width"], 300)
        self.assertEqual(normalized["data"]["title"], "Mind map")

    def test_normalizes_websdk_image_and_document_urls(self) -> None:
        image = normalize_websdk_item(
            {"id": "image-1", "type": "image", "url": "https://cdn.test/a.png"}
        )
        document = normalize_websdk_item(
            {"id": "doc-1", "type": "document", "documentUrl": "https://cdn.test/a.pdf"}
        )

        self.assertEqual(image["data"]["imageUrl"], "https://cdn.test/a.png")
        self.assertEqual(document["data"]["documentUrl"], "https://cdn.test/a.pdf")

    def test_normalizes_non_object_websdk_data_without_losing_original(self) -> None:
        raw = {
            "id": "text-1",
            "type": "text",
            "content": "Visible",
            "data": "opaque-source-value",
        }

        merged = merge_sources(rest_export([]), websdk_export([raw]))
        item = merged["items"][0]

        self.assertEqual(item["data"]["content"], "Visible")
        self.assertEqual(
            item["source_provenance"]["original_items"]["web_sdk"]["data"],
            "opaque-source-value",
        )

    def test_rejects_incomplete_rest_source(self) -> None:
        rest = rest_export([])
        rest["completeness"]["complete"] = False

        with self.assertRaisesRegex(ValueError, "completeness.complete"):
            merge_sources(rest, websdk_export([]))

    def test_rejects_rest_without_complete_provenance(self) -> None:
        rest = rest_export([])
        rest["provenance"]["comments"] = {}

        with self.assertRaisesRegex(ValueError, "provenance.comments.complete"):
            merge_sources(rest, websdk_export([]))

    def test_rejects_rest_item_provenance_count_mismatch(self) -> None:
        rest = rest_export([{"id": "text-1", "type": "text"}])
        rest["provenance"]["items"]["item_count"] = 0

        with self.assertRaisesRegex(ValueError, "item counts do not match"):
            merge_sources(rest, websdk_export([]))

    def test_rejects_complete_assets_that_were_not_checked(self) -> None:
        rest = rest_export([{"id": "image-1", "type": "image"}])
        rest["completeness"]["assets"]["checked"] = False

        with self.assertRaisesRegex(ValueError, "required assets must be checked"):
            merge_sources(rest, websdk_export([]))

    def test_rejects_inconsistent_rest_asset_failure_counts(self) -> None:
        rest = rest_export([])
        rest["completeness"]["assets"]["requirements"]["optional_failed"] = 1

        with self.assertRaisesRegex(ValueError, "optional asset failure count"):
            merge_sources(rest, websdk_export([]))

    def test_rejects_mismatched_websdk_type_summary(self) -> None:
        web = websdk_export([{"id": "text-1", "type": "text"}])
        web["summary"]["by_type"] = {"shape": 1}

        with self.assertRaisesRegex(ValueError, "summary.by_type"):
            merge_sources(rest_export([]), web)

    def test_rejects_coerced_websdk_summary_counts(self) -> None:
        web = websdk_export([{"id": "text-1", "type": "text"}])
        web["summary"]["total"] = "1"
        with self.assertRaisesRegex(ValueError, "nonnegative integer"):
            merge_sources(rest_export([]), web)

        web = websdk_export([{"id": "text-1", "type": "text"}])
        web["summary"]["by_type"]["text"] = True
        with self.assertRaisesRegex(ValueError, "nonnegative integer"):
            merge_sources(rest_export([]), web)

    def test_rejects_boolean_websdk_zero_counts(self) -> None:
        web = websdk_export([], comments=[])
        web["provenance"]["serialization"]["issue_count"] = False
        with self.assertRaisesRegex(ValueError, "serialization"):
            merge_sources(rest_export([]), web)

        web = websdk_export([], comments=[])
        web["completeness"]["comments"]["raw_count"] = False
        with self.assertRaisesRegex(ValueError, "comments.raw_count"):
            merge_sources(rest_export([]), web)

    def test_rejects_duplicate_websdk_item_ids(self) -> None:
        web = websdk_export(
            [
                {"id": "same", "type": "text"},
                {"id": "same", "type": "shape"},
            ]
        )

        with self.assertRaisesRegex(ValueError, "duplicate item id"):
            merge_sources(rest_export([]), web)

    def test_rejects_websdk_without_exact_maximum_profile(self) -> None:
        web = websdk_export([])
        web["capture_profile"] = "generic_board_export"

        with self.assertRaisesRegex(ValueError, "capture_profile"):
            merge_sources(rest_export([]), web)

    def test_rejects_websdk_with_serialization_errors(self) -> None:
        web = websdk_export([])
        web["completeness"]["items"]["serialization_errors"] = ["item_0_not_object"]

        with self.assertRaisesRegex(ValueError, "serialization_errors"):
            merge_sources(rest_export([]), web)

    def test_rejects_duplicate_rest_comment_ids(self) -> None:
        comments = [
            {"id": "comment-1", "type": "comment"},
            {"id": "comment-1", "type": "comment"},
        ]

        with self.assertRaisesRegex(ValueError, "duplicate comment id"):
            merge_sources(rest_export([], comments=comments), websdk_export([]))

    def test_rejects_websdk_comments_without_capture_proof(self) -> None:
        web = websdk_export([])
        web["comments"] = [{"id": "sdk-comment", "type": "comment"}]

        with self.assertRaisesRegex(ValueError, "completeness.comments.complete"):
            merge_sources(rest_export([]), web)

    def test_comments_remain_rest_authoritative(self) -> None:
        rest_comment = {"id": "rest-comment", "type": "comment", "content": "REST"}
        web = websdk_export(
            [],
            comments=[{"id": "sdk-comment", "type": "comment", "content": "SDK"}],
        )

        merged = merge_sources(rest_export([], comments=[rest_comment]), web)

        self.assertEqual(
            [comment["id"] for comment in merged["comments"]],
            ["rest-comment", "sdk-comment"],
        )
        self.assertEqual(merged["comments"][1]["source_surfaces"], ["web_sdk"])

    def test_rejects_board_mismatch(self) -> None:
        with self.assertRaisesRegex(ValueError, "board mismatch"):
            merge_sources(rest_export([], "board-1"), websdk_export([], "board-2"))

    def test_rejects_source_snapshots_too_far_apart(self) -> None:
        now = datetime.now(timezone.utc)
        rest = rest_export([], exported_at=now - timedelta(hours=2))
        web = websdk_export([], exported_at=now)

        with self.assertRaisesRegex(ValueError, "timestamps differ"):
            merge_sources(rest, web, now=now)

    def test_rejects_nonfinite_source_skew_limit(self) -> None:
        with self.assertRaisesRegex(ValueError, "finite number"):
            merge_sources(
                rest_export([]),
                websdk_export([]),
                max_source_skew_minutes=float("nan"),
            )

    def test_canonical_validator_enforces_source_skew_limit(self) -> None:
        now = datetime.now(timezone.utc)
        rest = rest_export([], exported_at=now - timedelta(minutes=90))
        web = websdk_export([], exported_at=now)
        merged = merge_sources(
            rest,
            web,
            now=now,
            max_source_skew_minutes=120,
        )
        with tempfile.TemporaryDirectory(prefix="miro2obs_canonical_skew_") as tmp:
            root = Path(tmp)
            rest_path = root / "rest.json"
            rest_path.write_text(json.dumps(rest), encoding="utf-8")
            canonical = finalize_merged_export(
                merged,
                source_json=rest_path,
                output_json=root / "canonical.json",
                max_source_skew_minutes=120,
            )

        with self.assertRaisesRegex(ValueError, "differ by more than 60 minutes"):
            validate_canonical_export(canonical, now=now)
        validate_canonical_export(
            canonical,
            now=now,
            max_source_skew_minutes=120,
        )

    def test_canonical_validator_rejects_tampered_original_id(self) -> None:
        rest = rest_export([{"id": "text-1", "type": "text"}])
        merged = merge_sources(rest, websdk_export([]))
        with tempfile.TemporaryDirectory(prefix="miro2obs_canonical_original_") as tmp:
            root = Path(tmp)
            rest_path = root / "rest.json"
            rest_path.write_text(json.dumps(rest), encoding="utf-8")
            canonical = finalize_merged_export(
                merged,
                source_json=rest_path,
                output_json=root / "canonical.json",
            )
        canonical["items"][0]["source_provenance"]["original_items"]["rest"][
            "id"
        ] = "other-id"

        with self.assertRaisesRegex(ValueError, "original rest id mismatch"):
            validate_canonical_export(canonical)

    def test_canonical_validator_rejects_tampered_field_provenance(self) -> None:
        rest = rest_export([{"id": "text-1", "type": "text"}])
        merged = merge_sources(rest, websdk_export([]))
        with tempfile.TemporaryDirectory(prefix="miro2obs_canonical_fields_") as tmp:
            root = Path(tmp)
            rest_path = root / "rest.json"
            rest_path.write_text(json.dumps(rest), encoding="utf-8")
            canonical = finalize_merged_export(
                merged,
                source_json=rest_path,
                output_json=root / "canonical.json",
            )
        canonical["items"][0]["source_provenance"]["field_sources"] = {
            "id": ["web_sdk"]
        }

        with self.assertRaisesRegex(ValueError, "field provenance"):
            validate_canonical_export(canonical)

    def test_canonical_validator_revalidates_source_metadata(self) -> None:
        rest = rest_export([])
        merged = merge_sources(rest, websdk_export([]))
        with tempfile.TemporaryDirectory(prefix="miro2obs_canonical_metadata_") as tmp:
            root = Path(tmp)
            rest_path = root / "rest.json"
            rest_path.write_text(json.dumps(rest), encoding="utf-8")
            canonical = finalize_merged_export(
                merged,
                source_json=rest_path,
                output_json=root / "canonical.json",
            )
        canonical["source_metadata"]["web_sdk"]["summary"]["total"] = 99

        with self.assertRaisesRegex(ValueError, "summary.total"):
            validate_canonical_export(canonical)

    def test_canonical_validator_rejects_unknown_source_surface(self) -> None:
        rest = rest_export([{"id": "text-1", "type": "text"}])
        merged = merge_sources(rest, websdk_export([]))
        with tempfile.TemporaryDirectory(prefix="miro2obs_canonical_surface_") as tmp:
            root = Path(tmp)
            rest_path = root / "rest.json"
            rest_path.write_text(json.dumps(rest), encoding="utf-8")
            canonical = finalize_merged_export(
                merged,
                source_json=rest_path,
                output_json=root / "canonical.json",
            )
        canonical["items"][0]["source_surfaces"] = [{"not": "hashable"}]

        with self.assertRaisesRegex(ValueError, "invalid source_surfaces"):
            validate_canonical_export(canonical)

    def test_canonical_coverage_basis_is_rest_mode_agnostic(self) -> None:
        merged = merge_sources(rest_export([]), websdk_export([]))

        self.assertEqual(
            merged["completeness"]["coverage_basis"],
            "rest_plus_web_sdk_union",
        )

    def test_canonical_validator_rejects_string_source_counts(self) -> None:
        rest = rest_export([])
        web = websdk_export([])
        merged = merge_sources(rest, web)
        with tempfile.TemporaryDirectory(prefix="miro2obs_canonical_counts_") as tmp:
            root = Path(tmp)
            rest_path = root / "rest.json"
            rest_path.write_text(json.dumps(rest), encoding="utf-8")
            canonical = finalize_merged_export(
                merged,
                source_json=rest_path,
                output_json=root / "canonical.json",
            )
        canonical["completeness"]["rest"]["items"] = "0"
        canonical["provenance"]["counts"]["rest_items"] = "0"

        with self.assertRaisesRegex(ValueError, "nonnegative integer"):
            validate_canonical_export(canonical)

    def test_cli_copies_and_validates_asset_sidecar_before_marking_complete(
        self,
    ) -> None:
        item = {
            "id": "image-1",
            "type": "image",
            "data": {"imageUrl": "https://example.test/image.png"},
            "local_name": "asset.png",
        }
        with tempfile.TemporaryDirectory(prefix="miro2obs_merge_cli_") as tmp:
            root = Path(tmp)
            rest_path = root / "rest.json"
            web_path = root / "web.json"
            output_path = root / "out" / "merged.json"
            rest_path.write_text(json.dumps(rest_export([item])), encoding="utf-8")
            web_path.write_text(json.dumps(websdk_export([])), encoding="utf-8")
            rest_sidecar = rest_path.with_name("rest_files")
            rest_sidecar.mkdir()
            (rest_sidecar / "asset.png").write_bytes(b"\x89PNG\r\n\x1a\n")
            (rest_sidecar / "unreferenced.bin").write_bytes(b"must-not-copy")
            args = Namespace(
                rest_json=rest_path,
                websdk_json=web_path,
                board_id="board-1",
                max_age_hours=24.0,
                max_source_skew_minutes=60.0,
                output=output_path,
            )

            with patch("merge_miro_sources.parse_args", return_value=args):
                self.assertEqual(main(), 0)

            merged = json.loads(output_path.read_text(encoding="utf-8"))
            copied_exists = (
                output_path.with_name("merged_files") / "asset.png"
            ).is_file()
            extra_exists = (
                output_path.with_name("merged_files") / "unreferenced.bin"
            ).exists()

        self.assertTrue(copied_exists)
        self.assertFalse(extra_exists)
        self.assertTrue(merged["completeness"]["complete"])
        self.assertTrue(merged["completeness"]["assets"]["checked"])
        self.assertEqual(
            merged["provenance"]["assets"]["strategy"],
            "referenced_rest_assets_only",
        )
        self.assertEqual(merged["completeness"]["assets"]["optional_missing"], [])
        self.assertEqual(
            merged["completeness"]["assets"]["requirements"]["optional_failed"],
            0,
        )

    def test_finalize_preserves_referenced_stable_donor_assets(self) -> None:
        rest = rest_export([])
        donor = {
            "id": "stable-only-image",
            "type": "image",
            "local_name": "stable-only.png",
            "data": {"imageUrl": "https://example.test/stable-only.png"},
        }
        rest["provenance"]["assets"]["stable_enrichment"] = {
            "items": [donor]
        }
        merged = merge_sources(rest, websdk_export([]))

        with tempfile.TemporaryDirectory(prefix="miro2obs_stable_donor_") as tmp:
            root = Path(tmp)
            rest_path = root / "rest.json"
            rest_path.write_text(json.dumps(rest), encoding="utf-8")
            rest_sidecar = rest_path.with_name("rest_files")
            rest_sidecar.mkdir()
            (rest_sidecar / "stable-only.png").write_bytes(b"stable-donor")
            output_path = root / "canonical.json"

            finalize_merged_export(
                merged,
                source_json=rest_path,
                output_json=output_path,
            )

            copied = output_path.with_name("canonical_files") / "stable-only.png"
            self.assertEqual(copied.read_bytes(), b"stable-donor")

    def test_finalize_downloads_websdk_only_required_asset_with_token(self) -> None:
        rest = rest_export([])
        merged = merge_sources(
            rest,
            websdk_export(
                [
                    {
                        "id": "image-1",
                        "type": "image",
                        "url": "https://cdn.example.test/image.png",
                    }
                ]
            ),
        )

        def download(items, *, output_path, token, strict):
            self.assertEqual(token, "token-1")
            self.assertFalse(strict)
            image = next(item for item in items if item["id"] == "image-1")
            image["local_name"] = "image-1.png"
            sidecar = output_path.with_name(f"{output_path.stem}_files")
            sidecar.mkdir(parents=True, exist_ok=True)
            (sidecar / "image-1.png").write_bytes(b"\x89PNG\r\n\x1a\n")
            return {
                "images": 1,
                "documents": 0,
                "doc_formats": 0,
                "embeds": 0,
                "failed": 0,
                "optional_failed": 0,
            }

        with tempfile.TemporaryDirectory(prefix="miro2obs_merged_download_") as tmp:
            root = Path(tmp)
            rest_path = root / "rest.json"
            output_path = root / "canonical.json"
            rest_path.write_text(json.dumps(rest), encoding="utf-8")
            with patch(
                "merge_miro_sources.download_export_assets", side_effect=download
            ) as asset_download:
                canonical = finalize_merged_export(
                    merged,
                    source_json=rest_path,
                    output_json=output_path,
                    token="token-1",
                )
            downloaded = (
                output_path.with_name("canonical_files") / "image-1.png"
            ).is_file()

        asset_download.assert_called_once()
        self.assertTrue(downloaded)
        self.assertEqual(
            canonical["provenance"]["assets"]["strategy"],
            "referenced_rest_assets_plus_merged_downloads",
        )
        self.assertTrue(canonical["completeness"]["complete"])

    def test_finalize_records_missing_optional_embed_preview(self) -> None:
        embed = {
            "id": "embed-1",
            "type": "embed",
            "data": {
                "url": "https://example.test/video",
                "previewUrl": "https://example.test/preview.png",
            },
        }
        rest = rest_export([embed])
        merged = merge_sources(rest, websdk_export([]))

        with tempfile.TemporaryDirectory(prefix="miro2obs_optional_embed_") as tmp:
            root = Path(tmp)
            rest_path = root / "rest.json"
            rest_path.write_text(json.dumps(rest), encoding="utf-8")
            canonical = finalize_merged_export(
                merged,
                source_json=rest_path,
                output_json=root / "canonical.json",
            )

        assets = canonical["completeness"]["assets"]
        self.assertTrue(assets["complete"])
        self.assertEqual(assets["requirements"]["optional_failed"], 1)
        self.assertEqual(len(assets["optional_missing"]), 1)
        self.assertIn("embed-1", assets["optional_missing"][0])


if __name__ == "__main__":
    unittest.main()
