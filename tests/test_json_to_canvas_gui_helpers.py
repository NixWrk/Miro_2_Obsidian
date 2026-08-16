from __future__ import annotations

import sys
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "Json_2_Canvas"))

from Json_2_Canvas_V5 import App  # noqa: E402


class JsonToCanvasGuiHelperTests(unittest.TestCase):
    def setUp(self) -> None:
        self.app = object.__new__(App)
        self.app.S_SHOW_DECIMALS = 6
        self.app.S_STORE_DECIMALS = 9
        self.app.scale_value = 1.0

    def test_zoom_unlocked_scale_is_not_rounded_to_zero(self) -> None:
        stored = App._qS_store(self.app, 2**-12)

        self.assertGreater(stored, 0)
        self.assertAlmostEqual(stored, 2**-12, places=9)

    def test_nonfinite_manual_scale_uses_last_valid_value(self) -> None:
        self.assertEqual(App._parse_float(self.app, "nan", 0.5), 0.5)
        self.assertEqual(App._parse_float(self.app, "inf", 0.5), 0.5)
        self.assertEqual(App._parse_float(self.app, "0", 0.5), 0.5)


if __name__ == "__main__":
    unittest.main()
