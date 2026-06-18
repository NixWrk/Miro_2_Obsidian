from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = REPO_ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

from audit_web_board_pipeline import (  # noqa: E402
    BoardRef,
    audit_one_board,
    board_artifact_key,
    build_summary,
    expand_text_style_modes,
    find_local_export,
    parse_board_markdown,
)


class WebBoardPipelineAuditTests(unittest.TestCase):
    def test_parse_board_markdown_extracts_unique_miro_links(self) -> None:
        with tempfile.TemporaryDirectory(prefix="miro2obs_board_list_") as tmp:
            board_list = Path(tmp) / "boards.md"
            board_list.write_text(
                "\n".join(
                    [
                        "- [Miro: Alpha (uXjVAlpha)](https://miro.com/app/board/uXjVAlpha=/)",
                        "- [Miro: Alpha copy](https://miro.com/app/board/uXjVAlpha=/)",
                        "- [Miro: Beta](https://miro.com/app/board/uXjVBeta=/?share_link_id=1)",
                    ]
                ),
                encoding="utf-8",
            )

            refs = parse_board_markdown(board_list)

        self.assertEqual([ref.board_id for ref in refs], ["uXjVAlpha=", "uXjVBeta="])
        self.assertEqual(refs[0].label, "Miro: Alpha (uXjVAlpha)")

    def test_find_local_export_matches_board_id_in_filename(self) -> None:
        with tempfile.TemporaryDirectory(prefix="miro2obs_local_export_") as tmp:
            root = Path(tmp)
            expected = root / "Публичная_uXjVAlpha=.json"
            expected.write_text("[]", encoding="utf-8")
            (root / "other.json").write_text("[]", encoding="utf-8")

            self.assertEqual(find_local_export("uXjVAlpha=", root), expected)
            self.assertIsNone(find_local_export("missing=", root))

    def test_expand_text_style_modes_supports_both_variants(self) -> None:
        self.assertEqual(expand_text_style_modes("miro"), ["miro"])
        self.assertEqual(expand_text_style_modes("obsidian"), ["obsidian"])
        self.assertEqual(expand_text_style_modes("both"), ["miro", "obsidian"])

    def test_board_artifact_key_stays_short_and_unique(self) -> None:
        board = BoardRef(
            board_id="uXjVLongBoard=",
            label="Очень длинное название доски, которое не должно попасть в путь артефактов",
            url="https://miro.com/app/board/uXjVLongBoard=/",
        )

        self.assertEqual(board_artifact_key(board, "obsidian"), "uXjVLongBoard=_obsidian")

    def test_build_summary_counts_unique_boards_and_variant_records(self) -> None:
        board = {"board_id": "uXjVAlpha=", "label": "Alpha", "url": "https://miro.com/app/board/uXjVAlpha=/"}
        summary = build_summary(
            [
                {"board": board, "status": "ok"},
                {"board": board, "status": "needs_review"},
                {
                    "board": {
                        "board_id": "uXjVBeta=",
                        "label": "Beta",
                        "url": "https://miro.com/app/board/uXjVBeta=/",
                    },
                    "status": "no_json_export",
                },
            ]
        )

        self.assertEqual(summary["boards"], 2)
        self.assertEqual(summary["records"], 3)
        self.assertEqual(summary["ok"], 1)
        self.assertEqual(summary["needs_review"], 1)
        self.assertEqual(summary["missing_json"], 1)

    def test_audit_one_board_converts_and_reports_clean_minimal_export(self) -> None:
        with tempfile.TemporaryDirectory(prefix="miro2obs_web_pipeline_") as tmp:
            root = Path(tmp)
            source_json = root / "Публичная_uXjVAlpha=.json"
            source_json.write_text(
                json.dumps(
                    [
                        {
                            "id": "text-1",
                            "type": "text",
                            "position": {"x": 100, "y": 50, "origin": "center", "relativeTo": "canvas_center"},
                            "geometry": {"width": 240, "height": 80},
                            "style": {"fontSize": "18"},
                            "data": {"content": "<p>Hello</p>"},
                        }
                    ],
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )

            record = audit_one_board(
                BoardRef(board_id="uXjVAlpha=", label="Alpha", url="https://miro.com/app/board/uXjVAlpha=/"),
                source_json=source_json,
                out_dir=root / "out",
                scale_mode="readable",
                min_zoom=2 ** -12,
                text_style_mode="obsidian",
                min_font_px=8,
            )

        self.assertEqual(record["status"], "ok")
        self.assertEqual(record["text_style_mode"], "obsidian")
        self.assertEqual(record["source"]["items"], 1)
        self.assertEqual(record["canvas"]["nodes"], 1)
        self.assertEqual(record["missing_miro_items"]["total"], 0)
        self.assertEqual(record["mapping"]["total"], 0)
        self.assertEqual(record["overlaps"]["generated"], 0)

    def test_audit_one_board_reports_source_missing_assets(self) -> None:
        with tempfile.TemporaryDirectory(prefix="miro2obs_web_pipeline_assets_") as tmp:
            root = Path(tmp)
            source_json = root / "uXjVAssets=.json"
            source_json.write_text(
                json.dumps(
                    [
                        {
                            "id": "image-1",
                            "type": "image",
                            "local_name": "rest_uXjVAssets=_image-1.svg",
                            "position": {"x": 0, "y": 0, "origin": "center", "relativeTo": "canvas_center"},
                            "geometry": {"width": 80, "height": 60},
                            "data": {
                                "imageUrl": "https://api.miro.test/images/1?format=preview&redirect=false"
                            },
                        }
                    ],
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )

            record = audit_one_board(
                BoardRef(board_id="uXjVAssets=", label="Assets", url="https://miro.com/app/board/uXjVAssets=/"),
                source_json=source_json,
                out_dir=root / "out",
                scale_mode="readable",
                min_zoom=2 ** -12,
                text_style_mode="obsidian",
                min_font_px=8,
            )

        self.assertEqual(record["status"], "source_missing_assets")
        self.assertEqual(record["source_assets"]["local_refs"], 1)
        self.assertEqual(record["source_assets"]["missing"], 1)
        self.assertFalse(record["source_assets"]["sidecar_exists"])
        self.assertEqual(record["source_assets"]["missing_examples"][0]["id"], "image-1")
        self.assertEqual(record["canvas"]["missing_files"], 1)

    def test_audit_one_board_reports_required_image_without_local_name(self) -> None:
        with tempfile.TemporaryDirectory(prefix="miro2obs_web_pipeline_assets_") as tmp:
            root = Path(tmp)
            source_json = root / "uXjVAssets=.json"
            source_json.write_text(
                json.dumps(
                    [
                        {
                            "id": "image-without-local-name",
                            "type": "image",
                            "position": {"x": 0, "y": 0, "origin": "center", "relativeTo": "canvas_center"},
                            "geometry": {"width": 80, "height": 60},
                            "data": {
                                "imageUrl": "https://api.miro.test/images/1?format=preview&redirect=false"
                            },
                        }
                    ],
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )

            record = audit_one_board(
                BoardRef(board_id="uXjVAssets=", label="Assets", url="https://miro.com/app/board/uXjVAssets=/"),
                source_json=source_json,
                out_dir=root / "out",
                scale_mode="readable",
                min_zoom=2 ** -12,
                text_style_mode="obsidian",
                min_font_px=8,
            )

        self.assertEqual(record["status"], "source_missing_assets")
        self.assertEqual(record["source_assets"]["local_refs"], 1)
        self.assertEqual(record["source_assets"]["missing"], 1)
        self.assertEqual(record["source_assets"]["missing_examples"][0]["reason"], "missing local_name")
        self.assertEqual(record["canvas"]["missing_files"], 1)


if __name__ == "__main__":
    unittest.main()
