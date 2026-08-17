from __future__ import annotations

import unittest

from Miro_2_Json.GUI import MiroDownloaderApp, board_choice_label
from Miro_2_Obsidian_GUI import MiroPipelineApp, board_label


class MiroJsonGuiCompatibilityTests(unittest.TestCase):
    def test_legacy_app_is_the_unified_gui(self) -> None:
        self.assertIs(MiroDownloaderApp, MiroPipelineApp)

    def test_legacy_board_label_uses_unified_helper(self) -> None:
        board = {"id": "board-1", "name": "Roadmap"}
        self.assertEqual(board_choice_label(board), board_label(board))


if __name__ == "__main__":
    unittest.main()
