from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[1]
MIRO_JSON_DIR = REPO_ROOT / "Miro_2_Json"

sys.path.insert(0, str(MIRO_JSON_DIR))

from miro_downloader import get_boards  # noqa: E402


class _Response:
    def __init__(self, payload: dict) -> None:
        self.payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict:
        return self.payload


class MiroDownloaderBoardsTests(unittest.TestCase):
    def test_get_boards_preserves_full_board_payload_and_pagination(self) -> None:
        responses = [
            _Response(
                {
                    "data": [
                        {
                            "id": "board-1",
                            "name": "One",
                            "team": {"name": "Team A"},
                            "project": {"name": "Project X"},
                            "createdAt": "2026-01-01T00:00:00Z",
                        }
                    ],
                    "links": {"next": "https://api.miro.com/v2/boards?cursor=next"},
                }
            ),
            _Response({"data": [{"id": "board-2", "name": "Two"}], "links": {}}),
        ]

        with patch("miro_downloader.requests.get", side_effect=responses) as request:
            with patch("miro_downloader.time.sleep"):
                boards = get_boards("token-1")

        self.assertEqual([board["id"] for board in boards], ["board-1", "board-2"])
        self.assertEqual(boards[0]["project"]["name"], "Project X")
        self.assertEqual(boards[0]["createdAt"], "2026-01-01T00:00:00Z")
        self.assertEqual(boards[1]["team"], {})
        self.assertEqual(request.call_args_list[0].args[0], "https://api.miro.com/v2/boards?limit=50")
        self.assertEqual(request.call_args_list[1].args[0], "https://api.miro.com/v2/boards?cursor=next")


if __name__ == "__main__":
    unittest.main()
