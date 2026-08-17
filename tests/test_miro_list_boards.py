from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = REPO_ROOT / "scripts"

from scripts.miro_list_boards import summarize_boards  # noqa: E402


class MiroListBoardsTests(unittest.TestCase):
    def test_summarizes_boards_by_team(self) -> None:
        summary = summarize_boards(
            [
                {"id": "board-1", "name": "One", "team": {"name": "foto"}},
                {"id": "board-2", "name": "Two", "team": {"name": "foto"}},
                {"id": "board-3", "name": "Three", "team": {"name": "Dev team"}},
                {"id": "board-4", "name": "No team", "team": {}},
            ]
        )

        self.assertEqual(summary["total"], 4)
        self.assertEqual(summary["by_team"]["foto"], 2)
        self.assertEqual(summary["by_team"]["Dev team"], 1)
        self.assertEqual(summary["by_team"]["<unknown>"], 1)

    def test_cli_uses_existing_downloader(self) -> None:
        from scripts import miro_list_boards

        with patch("scripts.miro_list_boards.resolve_token_from_args", return_value="token-1"):
            with patch("scripts.miro_list_boards.get_boards", return_value=[{"id": "board-1", "team": {"name": "foto"}}]):
                with patch("scripts.miro_list_boards.write_json") as write_json:
                    with patch.object(sys, "argv", ["scripts.miro_list_boards.py", "--output", "boards.json"]):
                        self.assertEqual(miro_list_boards.main(), 0)

        write_json.assert_called_once()
        payload = write_json.call_args.args[1]
        self.assertEqual(payload["summary"]["by_team"]["foto"], 1)


if __name__ == "__main__":
    unittest.main()
