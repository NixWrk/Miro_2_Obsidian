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
        self.assertEqual(record["source"]["items"], 1)
        self.assertEqual(record["canvas"]["nodes"], 1)
        self.assertEqual(record["missing_miro_items"]["total"], 0)
        self.assertEqual(record["overlaps"]["generated"], 0)


if __name__ == "__main__":
    unittest.main()
