from __future__ import annotations

import sys
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
CONVERTER_DIR = REPO_ROOT / "Json_2_Canvas"

sys.path.insert(0, str(CONVERTER_DIR))

from Scale_engine import (  # noqa: E402
    OBSIDIAN_FONT_SIZE,
    ViewProfile,
    pick_recommended_scale,
)


def _text_node(node_id: str, x: float, y: float, width: float, height: float) -> dict:
    return {
        "id": node_id,
        "type": "text",
        "position": {
            "x": x,
            "y": y,
            "origin": "center",
            "relativeTo": "canvas_center",
        },
        "geometry": {
            "width": width,
            "height": height,
        },
        "style": {
            "fontSize": "18",
        },
        "data": {
            "content": "<p>Scale check</p>",
        },
    }


class ScaleEngineTests(unittest.TestCase):
    def test_recommended_scale_is_capped_by_fullhd_fit_for_huge_boards(self) -> None:
        profile = ViewProfile(width=1920, height=1080, min_zoom=0.12)
        miro_root = [
            _text_node("left", 0, 0, 200, 100),
            _text_node("right", 1_100_000, 548_000, 200, 100),
        ]

        scale, ctx = pick_recommended_scale(miro_root, profile, OBSIDIAN_FONT_SIZE)

        screen_w = ctx["bbox_w"] * scale * profile.min_zoom
        screen_h = ctx["bbox_h"] * scale * profile.min_zoom
        self.assertLessEqual(screen_w, profile.width)
        self.assertLessEqual(screen_h, profile.height)

    def test_recommended_scale_keeps_readability_when_board_already_fits(self) -> None:
        profile = ViewProfile(width=1920, height=1080, min_zoom=0.12)
        miro_root = [
            _text_node("a", 0, 0, 200, 100),
            _text_node("b", 900, 400, 200, 100),
        ]

        scale, ctx = pick_recommended_scale(miro_root, profile, OBSIDIAN_FONT_SIZE)

        readability_scale = max(ctx["scale_min_node"], ctx["scale_min_font"])
        self.assertAlmostEqual(scale, readability_scale)
        self.assertLessEqual(ctx["bbox_w"] * scale * profile.min_zoom, profile.width)
        self.assertLessEqual(ctx["bbox_h"] * scale * profile.min_zoom, profile.height)


if __name__ == "__main__":
    unittest.main()
