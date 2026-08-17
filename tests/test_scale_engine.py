from __future__ import annotations

import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
CONVERTER_DIR = REPO_ROOT / "Json_2_Canvas"

from Json_2_Canvas.Scale_engine import (  # noqa: E402
    OBSIDIAN_FONT_SIZE,
    ViewProfile,
    normalize_scale_mode,
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
    def test_profile_numbers_must_be_positive_and_finite(self) -> None:
        invalid_profiles = (
            ViewProfile(min_zoom=0),
            ViewProfile(min_zoom=float("nan")),
            ViewProfile(width=float("inf")),
        )
        for profile in invalid_profiles:
            with self.subTest(profile=profile):
                with self.assertRaisesRegex(ValueError, "positive finite"):
                    pick_recommended_scale([], profile, OBSIDIAN_FONT_SIZE)

    def test_balanced_scale_is_capped_by_fullhd_fit_for_huge_boards(self) -> None:
        profile = ViewProfile(
            width=1920, height=1080, min_zoom=0.12, scale_mode="balanced"
        )
        miro_root = [
            _text_node("left", 0, 0, 200, 100),
            _text_node("right", 1_100_000, 548_000, 200, 100),
        ]

        scale, ctx = pick_recommended_scale(miro_root, profile, OBSIDIAN_FONT_SIZE)

        screen_w = ctx["bbox_w"] * scale * profile.min_zoom
        screen_h = ctx["bbox_h"] * scale * profile.min_zoom
        self.assertLessEqual(screen_w, profile.width)
        self.assertLessEqual(screen_h, profile.height)
        self.assertEqual(ctx["scale_mode"], "balanced")
        self.assertEqual(ctx["scale_conflict_fit_vs_readability"], 1.0)
        self.assertEqual(ctx["scale_limited_by_fit"], 1.0)
        self.assertEqual(ctx["scale_exceeds_fit"], 0.0)

    def test_readable_scale_reports_fit_conflict_for_huge_boards(self) -> None:
        profile = ViewProfile(
            width=1920, height=1080, min_zoom=0.12, scale_mode="readable"
        )
        miro_root = [
            _text_node("left", 0, 0, 200, 100),
            _text_node("right", 1_100_000, 548_000, 200, 100),
        ]

        scale, ctx = pick_recommended_scale(miro_root, profile, OBSIDIAN_FONT_SIZE)

        self.assertAlmostEqual(scale, ctx["scale_readability"])
        self.assertGreater(ctx["bbox_w"] * scale * profile.min_zoom, profile.width)
        self.assertEqual(ctx["scale_mode"], "readable")
        self.assertEqual(ctx["scale_conflict_fit_vs_readability"], 1.0)
        self.assertEqual(ctx["scale_limited_by_fit"], 0.0)
        self.assertEqual(ctx["scale_exceeds_fit"], 1.0)

    def test_zoom_unlocked_profile_makes_readable_scale_fit_huge_boards(self) -> None:
        profile = ViewProfile(
            width=1920, height=1080, min_zoom=2**-12, scale_mode="readable"
        )
        miro_root = [
            _text_node("left", 0, 0, 200, 100),
            _text_node("right", 1_100_000, 548_000, 200, 100),
        ]

        scale, ctx = pick_recommended_scale(miro_root, profile, OBSIDIAN_FONT_SIZE)

        self.assertAlmostEqual(scale, ctx["scale_readability"])
        self.assertLessEqual(ctx["bbox_w"] * scale * profile.min_zoom, profile.width)
        self.assertLessEqual(ctx["bbox_h"] * scale * profile.min_zoom, profile.height)
        self.assertEqual(ctx["scale_mode"], "readable")
        self.assertEqual(ctx["scale_conflict_fit_vs_readability"], 0.0)
        self.assertEqual(ctx["scale_limited_by_fit"], 0.0)
        self.assertEqual(ctx["scale_exceeds_fit"], 0.0)

    def test_overview_scale_uses_fit_cap_even_when_board_already_fits(self) -> None:
        profile = ViewProfile(
            width=1920, height=1080, min_zoom=0.12, scale_mode="overview"
        )
        miro_root = [
            _text_node("a", 0, 0, 200, 100),
            _text_node("b", 900, 400, 200, 100),
        ]

        scale, ctx = pick_recommended_scale(miro_root, profile, OBSIDIAN_FONT_SIZE)

        self.assertAlmostEqual(scale, ctx["scale_fit"])
        self.assertEqual(ctx["scale_mode"], "overview")

    def test_recommended_scale_keeps_readability_when_board_already_fits(self) -> None:
        profile = ViewProfile(
            width=1920, height=1080, min_zoom=0.12, scale_mode="balanced"
        )
        miro_root = [
            _text_node("a", 0, 0, 200, 100),
            _text_node("b", 900, 400, 200, 100),
        ]

        scale, ctx = pick_recommended_scale(miro_root, profile, OBSIDIAN_FONT_SIZE)

        readability_scale = max(ctx["scale_min_node"], ctx["scale_min_font"])
        self.assertAlmostEqual(scale, readability_scale)
        self.assertLessEqual(ctx["bbox_w"] * scale * profile.min_zoom, profile.width)
        self.assertLessEqual(ctx["bbox_h"] * scale * profile.min_zoom, profile.height)
        self.assertEqual(ctx["scale_conflict_fit_vs_readability"], 0.0)

    def test_unknown_scale_mode_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            normalize_scale_mode("tiny")


if __name__ == "__main__":
    unittest.main()
