from __future__ import annotations

import unittest

from Json_2_Canvas.Json_2_Canvas_V5 import App
from Miro_2_Obsidian_GUI import MiroPipelineApp


class JsonToCanvasGuiCompatibilityTests(unittest.TestCase):
    def test_legacy_app_is_the_unified_gui(self) -> None:
        self.assertIs(App, MiroPipelineApp)


if __name__ == "__main__":
    unittest.main()
